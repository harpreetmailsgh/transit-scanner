import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import JSZip from 'jszip';
import Papa from 'papaparse';
import Database from 'better-sqlite3';
import {
  addDaysYmd,
  filterTripsAndStopTimes,
  torontoTodayYmd,
  unionActiveServiceIdsForDays,
} from './gtfs-active-services.mjs';

const GTFS_ZIP_URL =
  process.env.GTFS_ZIP_URL ||
  'https://assets.metrolinx.com/raw/upload/Documents/Metrolinx/Open%20Data/GO-GTFS.zip';

const OUTPUT_DIR = path.resolve(process.cwd(), 'dist', 'gtfs');
const MANIFEST_FILE_PATH = path.join(OUTPUT_DIR, 'manifest.json');
const VERSION = process.env.GTFS_VERSION || new Date().toISOString().replace(/[.:]/g, '-');
const RELEASE_BASE = (process.env.GTFS_RELEASE_BASE || '').replace(/\/$/, '');
const BUILD_DATE = process.env.BUILD_DATE || torontoTodayYmd();
const MONTH_DAY_COUNT = 30;
const WEEK_DAY_COUNT = 7;
// Phase 1 transition: the manifest still carries a 30-day `month` artifact
// (old-version phones parse it and behave as today), but the schedule
// coverage the new app uses is exactly two 7-day weeks from BUILD_DATE.
const WEEK_COUNT = 2;

const CORE_FILE_NAME = 'go-gtfs-core.sqlite';
const MONTH_FILE_NAME = 'go-gtfs-month.sqlite';

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function assetUrl(fileName) {
  if (!RELEASE_BASE) return fileName;
  return `${RELEASE_BASE}/${fileName}`;
}

async function fetchArrayBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download GTFS zip (${res.status})`);
  }
  return res.arrayBuffer();
}

function parseCsv(text) {
  const parsed = Papa.parse(text, {
    header: true,
    skipEmptyLines: true,
  });
  return Array.isArray(parsed.data) ? parsed.data : [];
}

async function readZipText(zip, fileName) {
  const lower = fileName.toLowerCase();
  const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir);
  const match = names.find((name) => {
    const n = name.toLowerCase();
    return n === lower || n.endsWith(`/${lower}`);
  });
  if (!match) return null;
  const entry = zip.file(match);
  if (!entry) return null;
  return entry.async('string');
}

function toStr(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

function createCoreSchema(db) {
  db.exec(`
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = NORMAL;

    DROP TABLE IF EXISTS stops;
    DROP TABLE IF EXISTS routes;
    DROP TABLE IF EXISTS pathways;
    DROP TABLE IF EXISTS calendar;
    DROP TABLE IF EXISTS calendar_dates;
    DROP TABLE IF EXISTS app_meta;

    CREATE TABLE stops (
      stop_id TEXT PRIMARY KEY,
      stop_name TEXT,
      stop_lat TEXT,
      stop_lon TEXT,
      platform_code TEXT,
      parent_station TEXT,
      location_type TEXT
    );

    CREATE TABLE routes (
      route_id TEXT PRIMARY KEY,
      route_short_name TEXT,
      route_long_name TEXT,
      route_type TEXT
    );

    CREATE TABLE pathways (
      pathway_id TEXT,
      from_stop_id TEXT,
      to_stop_id TEXT,
      pathway_mode TEXT
    );

    CREATE TABLE calendar (
      service_id TEXT,
      monday TEXT,
      tuesday TEXT,
      wednesday TEXT,
      thursday TEXT,
      friday TEXT,
      saturday TEXT,
      sunday TEXT,
      start_date TEXT,
      end_date TEXT
    );

    CREATE TABLE calendar_dates (
      service_id TEXT,
      date TEXT,
      exception_type TEXT
    );

    -- Stop -> served route_type pairs, derived from the FULL feed (all
    -- trips/stop_times, not just the active-service windows). The app
    -- seeds its stop classification from this table at core load, so bus
    -- stops/pins are visible before any bus schedule slice has loaded —
    -- otherwise, before the first bus week lands, no stop classifies as
    -- bus-served and the bus surfaces would hide everything. Additive
    -- only: old clients SELECT specific tables and ignore this one, so
    -- the core contract for them is unchanged.
    CREATE TABLE stop_route_types (
      stop_id TEXT,
      route_type TEXT
    );

    CREATE TABLE app_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

function createScheduleSchema(db) {
  db.exec(`
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = NORMAL;

    DROP TABLE IF EXISTS routes;
    DROP TABLE IF EXISTS trips;
    DROP TABLE IF EXISTS stop_times;
    DROP TABLE IF EXISTS app_meta;

    CREATE TABLE routes (
      route_id TEXT PRIMARY KEY,
      route_short_name TEXT,
      route_long_name TEXT,
      route_type TEXT
    );

    CREATE TABLE trips (
      trip_id TEXT PRIMARY KEY,
      route_id TEXT,
      trip_headsign TEXT,
      direction_id TEXT,
      shape_id TEXT,
      service_id TEXT
    );

    CREATE TABLE stop_times (
      trip_id TEXT,
      arrival_time TEXT,
      departure_time TEXT,
      stop_id TEXT,
      stop_sequence INTEGER,
      stop_headsign TEXT,
      pickup_type TEXT,
      drop_off_type TEXT
    );

    CREATE TABLE app_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE INDEX idx_stop_times_stop_id ON stop_times(stop_id);
    CREATE INDEX idx_stop_times_trip_id ON stop_times(trip_id);
    CREATE INDEX idx_stop_times_stop_seq ON stop_times(trip_id, stop_sequence);
    CREATE INDEX idx_trips_service_id ON trips(service_id);
  `);
}

function insertRows(db, name, rows) {
  if (!rows.length) return;

  if (name === 'stops') {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO stops (stop_id, stop_name, stop_lat, stop_lon, platform_code, parent_station, location_type)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = db.transaction((items) => {
      for (const row of items) {
        stmt.run(
          toStr(row.stop_id),
          toStr(row.stop_name),
          toStr(row.stop_lat),
          toStr(row.stop_lon),
          toStr(row.platform_code),
          toStr(row.parent_station),
          toStr(row.location_type),
        );
      }
    });
    tx(rows);
    return;
  }

  if (name === 'routes') {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO routes (route_id, route_short_name, route_long_name, route_type)
      VALUES (?, ?, ?, ?)
    `);
    const tx = db.transaction((items) => {
      for (const row of items) {
        stmt.run(
          toStr(row.route_id),
          toStr(row.route_short_name),
          toStr(row.route_long_name),
          toStr(row.route_type),
        );
      }
    });
    tx(rows);
    return;
  }

  if (name === 'trips') {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO trips (trip_id, route_id, trip_headsign, direction_id, shape_id, service_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const tx = db.transaction((items) => {
      for (const row of items) {
        stmt.run(
          toStr(row.trip_id),
          toStr(row.route_id),
          toStr(row.trip_headsign),
          toStr(row.direction_id),
          toStr(row.shape_id),
          toStr(row.service_id),
        );
      }
    });
    tx(rows);
    return;
  }

  if (name === 'stop_times') {
    const stmt = db.prepare(`
      INSERT INTO stop_times (trip_id, arrival_time, departure_time, stop_id, stop_sequence, stop_headsign, pickup_type, drop_off_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = db.transaction((items) => {
      for (const row of items) {
        stmt.run(
          toStr(row.trip_id),
          toStr(row.arrival_time),
          toStr(row.departure_time),
          toStr(row.stop_id),
          Number(row.stop_sequence || 0),
          toStr(row.stop_headsign),
          toStr(row.pickup_type),
          toStr(row.drop_off_type),
        );
      }
    });
    tx(rows);
    return;
  }

  if (name === 'pathways') {
    const stmt = db.prepare(`
      INSERT INTO pathways (pathway_id, from_stop_id, to_stop_id, pathway_mode)
      VALUES (?, ?, ?, ?)
    `);
    const tx = db.transaction((items) => {
      for (const row of items) {
        stmt.run(
          toStr(row.pathway_id),
          toStr(row.from_stop_id),
          toStr(row.to_stop_id),
          toStr(row.pathway_mode),
        );
      }
    });
    tx(rows);
    return;
  }

  if (name === 'calendar') {
    const stmt = db.prepare(`
      INSERT INTO calendar (service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = db.transaction((items) => {
      for (const row of items) {
        stmt.run(
          toStr(row.service_id),
          toStr(row.monday),
          toStr(row.tuesday),
          toStr(row.wednesday),
          toStr(row.thursday),
          toStr(row.friday),
          toStr(row.saturday),
          toStr(row.sunday),
          toStr(row.start_date),
          toStr(row.end_date),
        );
      }
    });
    tx(rows);
    return;
  }

  if (name === 'calendar_dates') {
    const stmt = db.prepare(`
      INSERT INTO calendar_dates (service_id, date, exception_type)
      VALUES (?, ?, ?)
    `);
    const tx = db.transaction((items) => {
      for (const row of items) {
        stmt.run(
          toStr(row.service_id),
          toStr(row.date),
          toStr(row.exception_type),
        );
      }
    });
    tx(rows);
  }

  if (name === 'stop_route_types') {
    const stmt = db.prepare(`
      INSERT INTO stop_route_types (stop_id, route_type)
      VALUES (?, ?)
    `);
    const tx = db.transaction((items) => {
      for (const row of items) {
        stmt.run(toStr(row.stop_id), toStr(row.route_type));
      }
    });
    tx(rows);
  }
}

// Route-type split of a service-filtered week: keep only trips whose route
// is of the given GTFS route_type (2 = train, 3 = bus), then only the
// stop_times of those surviving trips, then only routes of that type (so
// the loader's trips JOIN routes stays truthful per file). Returns the
// mode-filtered rows; the caller gates on non-emptiness.
function filterByRouteType(filtered, routes, routeType) {
  const routeTypeByRouteId = new Map(
    routes.map((r) => [String(r.route_id), Number(r.route_type)]),
  );
  const trips = filtered.trips.filter(
    (t) => routeTypeByRouteId.get(String(t.route_id)) === routeType,
  );
  const tripIds = new Set(trips.map((t) => String(t.trip_id)));
  const stopTimes = filtered.stopTimes.filter((st) => tripIds.has(String(st.trip_id)));
  const modeRoutes = routes.filter((r) => Number(r.route_type) === routeType);
  return { trips, stopTimes, routes: modeRoutes };
}

// Distinct stop -> route_type pairs over the whole feed (see the core
// schema comment on stop_route_types). Built from trip route types, not
// from the active-service windows, so classification is complete.
function buildStopRouteTypes(trips, stopTimes, routes) {
  const routeTypeByRouteId = new Map(
    routes.map((r) => [String(r.route_id), Number(r.route_type)]),
  );
  const routeTypeByTripId = new Map();
  for (const trip of trips) {
    const routeType = routeTypeByRouteId.get(String(trip.route_id));
    if (Number.isFinite(routeType)) {
      routeTypeByTripId.set(String(trip.trip_id), routeType);
    }
  }
  const pairs = new Set();
  for (const st of stopTimes) {
    const routeType = routeTypeByTripId.get(String(st.trip_id));
    if (routeType === undefined) continue;
    pairs.add(`${String(st.stop_id)}|${routeType}`);
  }
  return [...pairs].map((pair) => {
    const [stop_id, route_type] = pair.split('|');
    return { stop_id, route_type };
  });
}

function writeMeta(db, stats) {
  const insert = db.prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)');
  const tx = db.transaction(() => {
    insert.run('version', VERSION);
    insert.run('generatedAt', new Date().toISOString());
    insert.run('sourceUrl', GTFS_ZIP_URL);
    insert.run('buildDate', BUILD_DATE);
    for (const [key, value] of Object.entries(stats)) {
      insert.run(key, String(value));
    }
  });
  tx();
}

function finalizeDb(db) {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  db.exec('VACUUM;');
}

function hashesForFile(filePath) {
  // One read, both hashes. sha256 is the manifest's primary checksum;
  // md5 is ALSO published because the app can verify it natively via
  // expo-file-system's getInfoAsync({ md5: true }) without loading the
  // whole file into JS memory (sha256 has no such on-device API).
  const buf = fs.readFileSync(filePath);
  return {
    checksumSha256: crypto.createHash('sha256').update(buf).digest('hex'),
    checksumMd5: crypto.createHash('md5').update(buf).digest('hex'),
  };
}

function buildArtifact(filePath, schemaFn, writeFn) {
  if (fs.existsSync(filePath)) {
    fs.rmSync(filePath);
  }
  const db = new Database(filePath);
  try {
    schemaFn(db);
    writeFn(db);
    finalizeDb(db);
  } finally {
    db.close();
  }
  const stat = fs.statSync(filePath);
  return {
    fileName: path.basename(filePath),
    sizeBytes: stat.size,
    ...hashesForFile(filePath),
  };
}

async function main() {
  ensureDir(OUTPUT_DIR);

  console.log(`[gtfs] Downloading zip: ${GTFS_ZIP_URL}`);
  const arr = await fetchArrayBuffer(GTFS_ZIP_URL);
  const zip = await JSZip.loadAsync(arr);

  const [stopsTxt, routesTxt, tripsTxt, stopTimesTxt, pathwaysTxt, calendarTxt, calendarDatesTxt] = await Promise.all([
    readZipText(zip, 'stops.txt'),
    readZipText(zip, 'routes.txt'),
    readZipText(zip, 'trips.txt'),
    readZipText(zip, 'stop_times.txt'),
    readZipText(zip, 'pathways.txt'),
    readZipText(zip, 'calendar.txt'),
    readZipText(zip, 'calendar_dates.txt'),
  ]);

  if (!stopsTxt || !routesTxt || !tripsTxt || !stopTimesTxt) {
    throw new Error('GTFS zip missing required files: stops/routes/trips/stop_times');
  }

  console.log('[gtfs] Parsing CSV files');
  const stops = parseCsv(stopsTxt);
  const routes = parseCsv(routesTxt);
  const trips = parseCsv(tripsTxt);
  const stopTimes = parseCsv(stopTimesTxt);
  const pathways = pathwaysTxt ? parseCsv(pathwaysTxt) : [];
  const calendar = calendarTxt ? parseCsv(calendarTxt) : [];
  const calendarDates = calendarDatesTxt ? parseCsv(calendarDatesTxt) : [];

  const monthStart = BUILD_DATE;
  const monthEnd = addDaysYmd(monthStart, MONTH_DAY_COUNT - 1);

  // Exactly two consecutive 7-day weeks from BUILD_DATE: week 1 = days 1-7,
  // week 2 = days 8-14. These replace the old month + tail-week layout as
  // the app's coverage (the month artifact below is retained only for
  // old-version phones during the Phase 1 transition).
  const weekSpans = [];
  for (let i = 0; i < WEEK_COUNT; i += 1) {
    const weekStart = addDaysYmd(BUILD_DATE, i * WEEK_DAY_COUNT);
    const weekEnd = addDaysYmd(weekStart, WEEK_DAY_COUNT - 1);
    weekSpans.push({ weekStart, weekEnd });
  }

  const monthServices = unionActiveServiceIdsForDays(monthStart, MONTH_DAY_COUNT, calendar, calendarDates);
  const monthFiltered = filterTripsAndStopTimes(trips, stopTimes, monthServices);
  // Trains-only first download: each 7-day week is published twice, once
  // per mode (train = route_type 2, bus = route_type 3), under distinct
  // filenames — the old single name collided across modes. Four artifacts
  // per release: train+bus x 2 consecutive weeks.
  const MODE_WEEKS = [
    { mode: 'train', routeType: 2 },
    { mode: 'bus', routeType: 3 },
  ];
  const weekFilteredList = [];
  for (const { weekStart, weekEnd } of weekSpans) {
    const services = unionActiveServiceIdsForDays(weekStart, WEEK_DAY_COUNT, calendar, calendarDates);
    const serviceFiltered = filterTripsAndStopTimes(trips, stopTimes, services);
    for (const { mode, routeType } of MODE_WEEKS) {
      weekFilteredList.push({
        weekStart,
        weekEnd,
        mode,
        filtered: filterByRouteType(serviceFiltered, routes, routeType),
      });
    }
  }

  // Release gate: BLOCKED unless ALL FOUR mode-weeks are non-empty
  // (minimum 14 days from build date, both modes). The feed max calendar
  // date is a diagnostic only and never gates the release.
  let feedMaxDate = '';
  for (const row of calendar) {
    const d = String(row.end_date || '');
    if (d && d > feedMaxDate) feedMaxDate = d;
  }
  for (const row of calendarDates) {
    const d = String(row.date || '');
    if (d && d > feedMaxDate) feedMaxDate = d;
  }
  console.log(`[gtfs] Feed max calendar date (diagnostic only): ${feedMaxDate || '(none)'}`);
  for (const { weekStart, weekEnd, mode, filtered } of weekFilteredList) {
    if (filtered.trips.length === 0 || filtered.stopTimes.length === 0) {
      throw new Error(
        `GTFS build BLOCKED: week ${weekStart}..${weekEnd} (${mode}) is empty ` +
          `(${filtered.trips.length} trips, ${filtered.stopTimes.length} stop_times). ` +
          'All four mode-weeks must be non-empty (minimum 14 days from build date, both modes).',
      );
    }
  }

  console.log('[gtfs] Building core artifact');
  const stopRouteTypes = buildStopRouteTypes(trips, stopTimes, routes);
  const corePath = path.join(OUTPUT_DIR, CORE_FILE_NAME);
  const core = buildArtifact(
    corePath,
    createCoreSchema,
    (db) => {
      insertRows(db, 'stops', stops);
      insertRows(db, 'routes', routes);
      insertRows(db, 'pathways', pathways);
      insertRows(db, 'calendar', calendar);
      insertRows(db, 'calendar_dates', calendarDates);
      insertRows(db, 'stop_route_types', stopRouteTypes);
      writeMeta(db, {
        stopsCount: stops.length,
        routesCount: routes.length,
        stopRouteTypesCount: stopRouteTypes.length,
        artifact: 'core',
      });
    },
  );

  console.log('[gtfs] Building month artifact', { monthStart, monthEnd });
  const monthPath = path.join(OUTPUT_DIR, MONTH_FILE_NAME);
  const month = buildArtifact(
    monthPath,
    createScheduleSchema,
    (db) => {
      insertRows(db, 'routes', routes);
      insertRows(db, 'trips', monthFiltered.trips);
      insertRows(db, 'stop_times', monthFiltered.stopTimes);
      writeMeta(db, {
        tripsCount: monthFiltered.trips.length,
        stopTimesCount: monthFiltered.stopTimes.length,
        startDate: monthStart,
        endDate: monthEnd,
        artifact: 'month',
      });
    },
  );

  const weeks = weekFilteredList.map(({ weekStart, weekEnd, mode, filtered }) => {
    const weekFileName = `go-gtfs-week-${weekStart}-${mode}.sqlite`;
    const weekPath = path.join(OUTPUT_DIR, weekFileName);
    console.log('[gtfs] Building week artifact', { weekStart, weekEnd, mode });
    const week = buildArtifact(
      weekPath,
      createScheduleSchema,
      (db) => {
        insertRows(db, 'routes', filtered.routes);
        insertRows(db, 'trips', filtered.trips);
        insertRows(db, 'stop_times', filtered.stopTimes);
        writeMeta(db, {
          tripsCount: filtered.trips.length,
          stopTimesCount: filtered.stopTimes.length,
          startDate: weekStart,
          endDate: weekEnd,
          mode,
          artifact: 'week',
        });
      },
    );
    console.log(`[gtfs] Week: ${weekPath} (${week.sizeBytes} bytes)`);
    return {
      id: `${weekStart}-${mode}`,
      ...week,
      url: assetUrl(week.fileName),
      startDate: weekStart,
      endDate: weekEnd,
      mode,
    };
  });
  weeks.sort((a, b) =>
    a.startDate !== b.startDate
      ? (a.startDate < b.startDate ? -1 : 1)
      : (a.mode < b.mode ? -1 : a.mode > b.mode ? 1 : 0),
  );

  const manifest = {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    buildDate: BUILD_DATE,
    core: {
      ...core,
      url: assetUrl(core.fileName),
    },
    month: {
      ...month,
      url: assetUrl(month.fileName),
      startDate: monthStart,
      endDate: monthEnd,
    },
    weeks,
  };

  fs.writeFileSync(MANIFEST_FILE_PATH, JSON.stringify(manifest, null, 2));

  console.log('[gtfs] Done');
  console.log(`[gtfs] Core: ${corePath} (${core.sizeBytes} bytes)`);
  console.log(`[gtfs] Month (Phase 1 transition only): ${monthPath} (${month.sizeBytes} bytes)`);
  console.log(`[gtfs] Weeks: ${weeks.map((w) => `${w.startDate}..${w.endDate} (${w.mode})`).join(', ')}`);
  console.log(`[gtfs] Manifest: ${MANIFEST_FILE_PATH}`);
}

main().catch((err) => {
  console.error('[gtfs] Build failed:', err);
  process.exitCode = 1;
});
