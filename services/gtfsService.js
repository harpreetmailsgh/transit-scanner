/**
 * GO Transit static GTFS loader
 * ---------------------------
 * Downloads the official GO_GTFS.zip, parses CSV files, and keeps lookups in
 * module-level Maps so screens can call getStops(), etc.
 *
 * Preferred path uses native unzip via react-native-zip-archive to avoid full
 * in-memory zip expansion. JSZip remains as a compatibility fallback.
 */

import JSZip from 'jszip';
import Papa from 'papaparse';
import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';
import { DateTime } from 'luxon';
import nearestPoint from '@turf/nearest-point';
import { point as turfPoint, featureCollection } from '@turf/helpers';
import {
  applyPendingHostedSqliteUpdate,
  checkHostedSqliteUpdate,
  clearPendingHostedSqliteUpdate,
  ensureHostedSqlite,
  ensureLocalHostedSqlite,
  getBundleMeta,
  getEffectiveCoverageEnd,
  getPendingHostedSqliteUpdate,
  isHostedSqliteConfigured,
  loadHostedCoreTables,
  loadHostedSchedulesForDates,
  setPendingHostedSqliteUpdate,
} from './gtfsSqliteService';

// --- Official GO Transit GTFS archive (schedule data, not live tracking) ---
const GTFS_ZIP_URL =
  'https://assets.metrolinx.com/raw/upload/Documents/Metrolinx/Open%20Data/GO-GTFS.zip';

// Persist parsed data so the app does not re-download on every cold start.
// v5: polylines removed from payload; shapes.txt skipped to reduce memory usage.
const CACHE_FILE = `${FileSystem.documentDirectory}gtfs-cache-v5.json`;
const CACHE_META_FILE = `${FileSystem.documentDirectory}gtfs-cache-meta-v1.json`;
const UPDATE_META_FILE = `${FileSystem.documentDirectory}gtfs-update-meta-v1.json`;
const WEEKLY_STATIC_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
const GTFS_NETWORK_TIMEOUT_MS = 30 * 1000;
const CACHE_MIN_BYTES = 100 * 1024;
const CACHE_MAX_BYTES = 250 * 1024 * 1024;
const YIELD_ROW_INTERVAL = 2500;
const YIELD_INDEX_INTERVAL = 3500;
const STAGE_UNZIP_TIMEOUT_MS = 2 * 60 * 1000;
const STAGE_PARSE_TIMEOUT_MS = 4 * 60 * 1000;
const STAGE_INDEX_TIMEOUT_MS = 3 * 60 * 1000;
const STARTUP_SCHEDULE_DAYS = 1;
const GTFS_ZIP_TEMP_FILE = `${FileSystem.cacheDirectory || FileSystem.documentDirectory}gtfs-static-download.zip`;
const GTFS_ZIP_EXTRACT_DIR = `${FileSystem.cacheDirectory || FileSystem.documentDirectory}gtfs-static-extracted`;

/** Used by the UI to detect true "first launch" vs loading from disk. */
export function getGtfsCacheFileUri() {
  if (isHostedSqliteConfigured()) {
    return 'sqlite://go-gtfs-v1.sqlite';
  }
  return CACHE_FILE;
}

/** GO green is used only for future UI hooks; schedules are neutral. */
export const GO_TRANSIT_PRIMARY = '#00853F';

// Keep a small recent-past window so realtime-delayed trips are still eligible
// after their scheduled departure time has passed.
const REALTIME_LOOKBACK_MINUTES = 120;
const TRIP_SEARCH_SCAN_LIMIT = 200;

// ---------------------------------------------------------------------------
// In-memory stores (filled after loadGtfs completes)
// ---------------------------------------------------------------------------

/** @type {Map<string, object>} */
let stopsById = new Map();
/** @type {Map<string, object>} */
let routesById = new Map();
/** @type {Map<string, object>} */
let tripsById = new Map();
/** @type {Map<string, object[]>} stop_id -> all stop_times rows at that stop */
let stopTimesByStopId = new Map();
/** @type {Map<string, object[]>} trip_id -> rows sorted by stop_sequence */
let stopTimesByTripId = new Map();
/** @type {Map<string, Set<number>>} stop_id -> served GTFS route_type values */
let routeTypesByStopId = new Map();
/** @type {object[]} */
let pathways = [];
/** @type {object[]} */
let calendarRows = [];
/** @type {object[]} */
let calendarDatesRows = [];
/** Precomputed map polylines: rail (route_type 2) vs bus (route_type 3), from shapes.txt + trips. */
/** @type {Array<Array<{ latitude: number; longitude: number }>>} */
let trainShapePolylines = [];
/** @type {Array<Array<{ latitude: number; longitude: number }>>} */
let busShapePolylines = [];

let loadPromise = null;
let backgroundRefreshPromise = null;
let isReadyFlag = false;
let schedulesReadyFlag = false;
/** Incremented when a load is abandoned (e.g. UI timeout) so late completions do not flip `isReadyFlag`. */
let loadGeneration = 0;
/** Tracks which date/mode schedule slices are in memory (`ymd:train` / `ymd:bus`). */
const loadedScheduleKeys = new Set();
/** Serializes lazy schedule loads so overlapping screens cannot append duplicate stop_times. */
let scheduleLoadQueue = Promise.resolve();
/** Cached bundle meta from hosted SQLite download. */
let cachedBundleMeta = null;
let startupPhase = 'idle';
let startupPhaseDetail = '(not started)';
let startupPhaseUpdatedAt = 0;
let startupStageDurations = {};

function setStartupPhase(phase, detail = phase) {
  startupPhase = String(phase || 'idle');
  startupPhaseDetail = String(detail || phase || 'idle');
  startupPhaseUpdatedAt = Date.now();
  logGtfs(`startup-phase:${startupPhase}`, { detail: startupPhaseDetail });
}

export function getGtfsStartupDiagnostics() {
  return {
    phase: startupPhase,
    phaseDetail: startupPhaseDetail,
    updatedAt: startupPhaseUpdatedAt,
    stageDurations: startupStageDurations,
  };
}

function logGtfs(phase, detail) {
  if (typeof __DEV__ !== 'undefined' && !__DEV__) return;
  if (detail !== undefined) {
    console.log(`[TransitScanner][gtfsService] ${phase}`, detail);
  } else {
    console.log(`[TransitScanner][gtfsService] ${phase}`);
  }
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function emitProgress(onProgress, message, percent) {
  if (!onProgress) return;
  if (Number.isFinite(percent)) {
    onProgress({ message, percent: clamp01(percent) });
    return;
  }
  onProgress(message);
}

function isLikelyOutOfMemoryError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return msg.includes('outofmemory') || msg.includes('out of memory') || msg.includes('oom');
}

async function downloadZipArrayBufferWithProgress(onProgress) {
  setStartupPhase('download', 'Downloading GO Transit archive');
  emitProgress(onProgress, 'Downloading GO Transit data...', 0.05);
  const res = await fetchWithTimeout(GTFS_ZIP_URL, {}, GTFS_NETWORK_TIMEOUT_MS);
  if (!res.ok) {
    throw new Error(`GTFS download failed: HTTP ${res.status} ${res.statusText || ''}`.trim());
  }
  const responseFingerprint = extractRemoteFingerprint(res);
  const arrayBuffer = await res.arrayBuffer();
  emitProgress(onProgress, 'Downloading GO Transit data... 100%', 0.4);
  return { arrayBuffer, responseFingerprint };
}

async function downloadZipFileWithProgress(onProgress) {
  setStartupPhase('download', 'Downloading GO Transit archive to disk');
  await FileSystem.deleteAsync(GTFS_ZIP_TEMP_FILE, { idempotent: true }).catch(() => {});

  if (typeof FileSystem.createDownloadResumable === 'function') {
    let lastBucket = -1;
    const downloadResumable = FileSystem.createDownloadResumable(
      GTFS_ZIP_URL,
      GTFS_ZIP_TEMP_FILE,
      {},
      (progressEvent) => {
        const written = Number(progressEvent?.totalBytesWritten || 0);
        const expected = Number(progressEvent?.totalBytesExpectedToWrite || 0);
        if (expected <= 0) return;
        const pct = clamp01(written / expected);
        const bucket = Math.floor(pct * 100);
        if (bucket === lastBucket) return;
        lastBucket = bucket;
        emitProgress(onProgress, `Downloading GO Transit data... ${bucket}%`, 0.02 + pct * 0.38);
      },
    );

    const result = await downloadResumable.downloadAsync();
    if (!result?.uri) {
      throw new Error('GTFS download failed: no local file was returned.');
    }

    const info = await FileSystem.getInfoAsync(result.uri);
    return {
      zipUri: result.uri,
      bytes: Number(info?.size || 0),
      responseFingerprint: {
        etag: result.headers?.etag || result.headers?.ETag || null,
        lastModified: result.headers?.['last-modified'] || result.headers?.['Last-Modified'] || null,
        contentLength: result.headers?.['content-length'] || result.headers?.['Content-Length'] || null,
      },
    };
  }

  const result = await FileSystem.downloadAsync(GTFS_ZIP_URL, GTFS_ZIP_TEMP_FILE);
  const info = await FileSystem.getInfoAsync(result.uri);
  emitProgress(onProgress, 'Downloading GO Transit data... 100%', 0.4);
  return {
    zipUri: result.uri,
    bytes: Number(info?.size || 0),
    responseFingerprint: {
      etag: result.headers?.etag || result.headers?.ETag || null,
      lastModified: result.headers?.['last-modified'] || result.headers?.['Last-Modified'] || null,
      contentLength: result.headers?.['content-length'] || result.headers?.['Content-Length'] || null,
    },
  };
}

async function getNativeUnzipFunction() {
  if (Platform.OS === 'web') return null;
  try {
    const zipModule = await import('react-native-zip-archive');
    return zipModule?.unzip || zipModule?.default?.unzip || null;
  } catch {
    return null;
  }
}

async function findFileInDirectory(rootDir, targetFileName) {
  const queue = [rootDir];
  const targetLower = String(targetFileName || '').toLowerCase();

  while (queue.length) {
    const currentDir = queue.shift();
    const entries = await FileSystem.readDirectoryAsync(currentDir);

    for (const entryName of entries) {
      const fullPath = currentDir.endsWith('/') ? `${currentDir}${entryName}` : `${currentDir}/${entryName}`;
      const info = await FileSystem.getInfoAsync(fullPath);
      if (info?.isDirectory) {
        queue.push(fullPath);
      } else if (String(entryName).toLowerCase() === targetLower) {
        return fullPath;
      }
    }
  }

  return null;
}

async function readRequiredGtfsTextsFromExtractedDirectory(rootDir) {
  const readText = async (name) => {
    const filePath = await findFileInDirectory(rootDir, name);
    if (!filePath) return null;
    return FileSystem.readAsStringAsync(filePath);
  };

  return {
    stopsTxt: await readText('stops.txt'),
    routesTxt: await readText('routes.txt'),
    tripsTxt: await readText('trips.txt'),
    stopTimesTxt: await readText('stop_times.txt'),
    pathwaysTxt: await readText('pathways.txt'),
    calendarTxt: await readText('calendar.txt'),
    calendarDatesTxt: await readText('calendar_dates.txt'),
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = GTFS_NETWORK_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (err) {
    const timedOut = err?.name === 'AbortError';
    if (timedOut) {
      throw new Error(`Network timeout after ${Math.round(timeoutMs / 1000)}s for ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function withStageTimeout(stageName, work, timeoutMs) {
  let timeoutId;
  try {
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`${stageName} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
    });
    return await Promise.race([work(), timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/**
 * Call when the UI gives up waiting (e.g. 30s timeout). Clears the in-flight
 * promise handle so a future `loadGtfs()` can start fresh; stale completions
 * are ignored via `loadGeneration`.
 */
export function invalidateActiveGtfsLoad() {
  loadGeneration += 1;
  loadPromise = null;
  isReadyFlag = false;
  schedulesReadyFlag = false;
  logGtfs('invalidateActiveGtfsLoad', { generation: loadGeneration });
}

export function isSchedulesReady() {
  return schedulesReadyFlag;
}

export function clearLoadedScheduleKeys() {
  loadedScheduleKeys.clear();
  scheduleLoadQueue = Promise.resolve();
  stopTimesByStopId = new Map();
  stopTimesByTripId = new Map();
  tripsById = new Map();
  routeTypesByStopId = new Map();
}

function addDaysYmd(ymd, days) {
  return DateTime.fromFormat(ymd, 'yyyyMMdd', { zone: 'America/Toronto' })
    .plus({ days })
    .toFormat('yyyyMMdd');
}

function getCoverageEndYmd() {
  const end = getEffectiveCoverageEnd(cachedBundleMeta);
  return end || torontoTodayYmd();
}

function getSlidingWindowDates(centerYmd, radius = 3) {
  const today = torontoTodayYmd();
  const coverageEnd = getCoverageEndYmd();
  const monthStart = cachedBundleMeta?.month?.startDate || today;
  let minYmd = addDaysYmd(centerYmd, -radius);
  let maxYmd = addDaysYmd(centerYmd, radius);
  if (minYmd < today) minYmd = today;
  if (maxYmd > coverageEnd) maxYmd = coverageEnd;
  if (minYmd < monthStart) minYmd = monthStart;

  const dates = [];
  let dt = DateTime.fromFormat(minYmd, 'yyyyMMdd', { zone: 'America/Toronto' });
  const endDt = DateTime.fromFormat(maxYmd, 'yyyyMMdd', { zone: 'America/Toronto' });
  while (dt <= endDt) {
    dates.push(dt.toFormat('yyyyMMdd'));
    dt = dt.plus({ days: 1 });
  }
  return dates;
}

export function getPlanningDateBounds() {
  const today = torontoTodayYmd();
  const coverageEnd = getCoverageEndYmd();
  let feedMax = coverageEnd;
  for (const row of calendarDatesRows) {
    const d = String(row.date || '');
    if (d > feedMax) feedMax = d;
  }
  for (const row of calendarRows) {
    const d = String(row.end_date || '');
    if (d > feedMax) feedMax = d;
  }
  const maxYmd = coverageEnd < feedMax ? coverageEnd : feedMax;
  return { minYmd: today, maxYmd: maxYmd || today };
}

function modesToScheduleFilter(modes) {
  if (!modes) return { train: true, bus: true };
  return {
    train: modes.train !== false,
    bus: modes.bus !== false,
  };
}

function markLoadedKeysForDates(dates, modes) {
  for (const ymd of dates) {
    if (modes.train) loadedScheduleKeys.add(`${ymd}:train`);
    if (modes.bus) loadedScheduleKeys.add(`${ymd}:bus`);
  }
}

function datesNeedingLoad(dates, modes) {
  const missingDates = new Set();
  for (const ymd of dates) {
    if (modes.train && !loadedScheduleKeys.has(`${ymd}:train`)) missingDates.add(ymd);
    if (modes.bus && !loadedScheduleKeys.has(`${ymd}:bus`)) missingDates.add(ymd);
  }
  return [...missingDates];
}

export async function ensureSchedulesForDate(ymd, options = {}) {
  const run = async () => {
    const modes = modesToScheduleFilter(options.modes);
    const windowDates = getSlidingWindowDates(ymd, 3);
    const toLoad = datesNeedingLoad(windowDates, modes);
    if (!toLoad.length) {
      return { ok: true, loaded: false };
    }

    const schedule = await loadHostedSchedulesForDates(
      toLoad,
      modes,
      activeServiceIdsForDate,
      options.onProgress,
    );
    await appendScheduleData(schedule.trips, schedule.stopTimes);
    await finalizeStopTimeTripIndexes();
    markLoadedKeysForDates(toLoad, modes);
    return { ok: true, loaded: true };
  };

  const next = scheduleLoadQueue.catch(() => {}).then(run);
  scheduleLoadQueue = next.catch(() => {});
  return next;
}

function extractRemoteFingerprint(res) {
  return {
    etag: res.headers?.get('etag') || null,
    lastModified: res.headers?.get('last-modified') || null,
    contentLength: res.headers?.get('content-length') || null,
  };
}

function fingerprintsMatch(a, b) {
  return !!a && !!b && a.etag === b.etag && a.lastModified === b.lastModified && a.contentLength === b.contentLength;
}

function hasFingerprintValue(fingerprint) {
  return !!(fingerprint && (fingerprint.etag || fingerprint.lastModified || fingerprint.contentLength));
}

async function readCacheMetadata() {
  try {
    const json = await FileSystem.readAsStringAsync(CACHE_META_FILE);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

async function writeCacheMetadata(meta) {
  try {
    await FileSystem.writeAsStringAsync(CACHE_META_FILE, JSON.stringify(meta));
  } catch (err) {
    logGtfs('cache-meta: write failed', {
      message: err?.message,
      stack: err?.stack,
    });
  }
}

async function readUpdateMetadata() {
  try {
    const json = await FileSystem.readAsStringAsync(UPDATE_META_FILE);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

async function writeUpdateMetadata(meta) {
  try {
    await FileSystem.writeAsStringAsync(UPDATE_META_FILE, JSON.stringify(meta));
  } catch (err) {
    logGtfs('update-meta: write failed', {
      message: err?.message,
      stack: err?.stack,
    });
  }
}

async function clearUpdateMetadata() {
  try {
    await FileSystem.deleteAsync(UPDATE_META_FILE, { idempotent: true });
  } catch {
    // ignore
  }
}

function isWeeklyRefreshDue(meta) {
  if (!meta?.checkedAt) return true;
  return Date.now() - Number(meta.checkedAt) >= WEEKLY_STATIC_REFRESH_MS;
}

async function fetchRemoteStaticFingerprint() {
  const res = await fetchWithTimeout(GTFS_ZIP_URL, { method: 'HEAD' }, GTFS_NETWORK_TIMEOUT_MS);
  if (!res.ok) {
    throw new Error(`GTFS HEAD check failed: HTTP ${res.status} ${res.statusText || ''}`.trim());
  }
  return extractRemoteFingerprint(res);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Reads a text file from the JSZip archive (case-insensitive file name).
 */
async function readZipText(zip, fileName) {
  const lower = fileName.toLowerCase();
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  const match = names.find(
    (n) => n.toLowerCase() === lower || n.toLowerCase().endsWith(`/${lower}`),
  );
  if (!match) return null;
  const entry = zip.file(match);
  return entry ? entry.async('string') : null;
}

/**
 * "HH:MM:SS" or "H:MM:SS" → seconds since *service* midnight (may exceed 86400).
 */
export function gtfsTimeToSeconds(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return 0;
  const parts = timeStr.trim().split(':');
  const h = Number(parts[0]) || 0;
  const m = Number(parts[1]) || 0;
  const s = Number(parts[2]) || 0;
  return h * 3600 + m * 60 + s;
}

/**
 * Which calendar column (monday … sunday) matches "today" in Toronto.
 */
function torontoWeekdayColumn() {
  const wd = DateTime.now().setZone('America/Toronto').weekday; // 1 = Monday (Luxon)
  const map = {
    1: 'monday',
    2: 'tuesday',
    3: 'wednesday',
    4: 'thursday',
    5: 'friday',
    6: 'saturday',
    7: 'sunday',
  };
  return map[wd];
}

/**
 * Today's calendar date in Toronto as YYYYMMDD (GTFS format).
 */
function torontoTodayYmd() {
  return DateTime.now().setZone('America/Toronto').toFormat('yyyyMMdd');
}

/**
 * Builds the set of service_ids that are allowed to run **today** in Toronto,
 * using calendar.txt + calendar_dates.txt (exceptions).
 */
function activeServiceIdsToday() {
  const today = torontoTodayYmd();

  // If calendar.txt was not present, derive active services solely from
  // calendar_dates.txt (exception_type=1 means "service runs on this date").
  // GO Transit's GTFS omits calendar.txt and uses only calendar_dates.txt.
  // Falling back to "all service IDs" caused every future/past trip to appear.
  if (!calendarRows.length) {
    const active = new Set();
    for (const row of calendarDatesRows) {
      if (row.date === today && String(row.exception_type) === '1') {
        active.add(String(row.service_id));
      }
    }
    return active;
  }

  const weekdayCol = torontoWeekdayColumn();

  /** @type {Map<string, string>} service_id -> exception_type ('1' add, '2' remove) */
  const exceptions = new Map();
  for (const row of calendarDatesRows) {
    if (row.date === today) {
      exceptions.set(String(row.service_id), String(row.exception_type));
    }
  }

  const active = new Set();

  for (const row of calendarRows) {
    const sid = String(row.service_id);
    if (exceptions.get(sid) === '2') {
      continue; // service removed for this exact date
    }
    if (today < String(row.start_date) || today > String(row.end_date)) {
      continue;
    }
    // GTFS uses 1 / empty for weekday flags — treat "1" as true
    const flag = row[weekdayCol];
    if (flag !== '1' && flag !== 1) {
      continue;
    }
    active.add(sid);
  }

  // Trips added only on this date (e.g. holiday special)
  for (const [sid, type] of exceptions) {
    if (type === '1') {
      active.add(sid);
    }
  }

  return active;
}

/**
 * Builds the set of service_ids active for a specific date (YYYYMMDD format).
 * Evaluates calendar rules and calendar_dates exceptions for that date.
 */
function activeServiceIdsForDate(ymd) {
  // If calendar.txt was not present, derive active services solely from calendar_dates.txt
  if (!calendarRows.length) {
    const active = new Set();
    for (const row of calendarDatesRows) {
      if (row.date === ymd && String(row.exception_type) === '1') {
        active.add(String(row.service_id));
      }
    }
    return active;
  }

  // Determine weekday column for the given date (1=Mon, 7=Sun in Luxon)
  const dt = DateTime.fromFormat(ymd, 'yyyyMMdd').setZone('America/Toronto');
  const weekday = dt.weekday; // 1=Monday
  const weekdayMap = {
    1: 'monday',
    2: 'tuesday',
    3: 'wednesday',
    4: 'thursday',
    5: 'friday',
    6: 'saturday',
    7: 'sunday',
  };
  const weekdayCol = weekdayMap[weekday];

  // Collect exceptions for this date
  const exceptions = new Map();
  for (const row of calendarDatesRows) {
    if (row.date === ymd) {
      exceptions.set(String(row.service_id), String(row.exception_type));
    }
  }

  const active = new Set();

  // Check calendar rules
  for (const row of calendarRows) {
    const sid = String(row.service_id);
    if (exceptions.get(sid) === '2') {
      continue; // service removed for this date
    }
    if (ymd < String(row.start_date) || ymd > String(row.end_date)) {
      continue; // outside service window
    }
    const flag = row[weekdayCol];
    if (flag !== '1' && flag !== 1) {
      continue; // not scheduled for this weekday
    }
    active.add(sid);
  }

  // Add services that are explicitly added for this date
  for (const [sid, type] of exceptions) {
    if (type === '1') {
      active.add(sid);
    }
  }

  return active;
}

/**
 * Interprets a GTFS arrival/departure time as an absolute DateTime in Toronto
 * for a specific date (YYYYMMDD format). Similar to stopTimeToDateTimeToday but
 * allows arbitrary dates rather than just today.
 */
function stopTimeToDateTimeForDate(timeStr, ymd) {
  const zone = 'America/Toronto';
  const totalSec = gtfsTimeToSeconds(timeStr);
  let dayOffset = 0;
  let remainder = totalSec;
  while (remainder >= 86400) {
    remainder -= 86400;
    dayOffset += 1;
  }
  const dt = DateTime.fromFormat(ymd, 'yyyyMMdd')
    .setZone(zone)
    .startOf('day')
    .plus({ days: dayOffset })
    .plus({ seconds: remainder });
  return dt;
}

/**
 * Interprets a GTFS arrival/departure time as an absolute DateTime in Toronto
 * for *today's* service day (beginner-friendly; ignores complex service-day cutovers).
 */
function stopTimeToDateTimeToday(timeStr) {
  const zone = 'America/Toronto';
  const totalSec = gtfsTimeToSeconds(timeStr);
  let dayOffset = 0;
  let remainder = totalSec;
  while (remainder >= 86400) {
    remainder -= 86400;
    dayOffset += 1;
  }
  let dt = DateTime.now()
    .setZone(zone)
    .startOf('day')
    .plus({ days: dayOffset })
    .plus({ seconds: remainder });
  return dt;
}

/**
 * Picks the best headsign text for a row (stop-level overrides trip-level).
 */
function pickHeadsign(stopTimeRow, tripRow) {
  const fromStop = (stopTimeRow.stop_headsign || '').trim();
  if (fromStop) return normalizeDisplayText(fromStop);
  return normalizeDisplayText((tripRow.trip_headsign || '').trim() || '');
}

function normalizeDisplayText(value) {
  return String(value || '').replace(/Kitchner/gi, 'Kitchener').trim();
}

function formatClockLabel(dateTime) {
  return dateTime.toFormat('h:mm a').toUpperCase();
}

function buildLineName(routeRow) {
  const baseRaw =
    (routeRow?.route_long_name && String(routeRow.route_long_name).trim()) ||
    (routeRow?.route_short_name && String(routeRow.route_short_name).trim()) ||
    'GO';
  const base = normalizeDisplayText(baseRaw);
  if (/\bline\b$/i.test(base)) return base;
  return `${base} Line`;
}

function inferServicePattern(stopTimeRow, tripRow, routeRow) {
  const haystack = [
    stopTimeRow?.stop_headsign,
    tripRow?.trip_headsign,
    routeRow?.route_long_name,
    routeRow?.route_short_name,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (haystack.includes('express')) return 'Express';
  return 'All Stops';
}

function getTripEndpoints(tripId) {
  const rows = stopTimesByTripId.get(String(tripId));
  if (!rows || rows.length === 0) {
    return { startStopName: '—', endStopName: '—' };
  }

  const first = rows[0];
  const last = rows[rows.length - 1];

  const startStopName = getCanonicalStopName(String(first.stop_id));
  const endStopName = getCanonicalStopName(String(last.stop_id));
  return { startStopName, endStopName };
}

// ---------------------------------------------------------------------------
// Index building
// ---------------------------------------------------------------------------

async function yieldToJsLoop() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function buildStopTimeIndexes(allRows) {
  stopTimesByStopId = new Map();
  stopTimesByTripId = new Map();

  let rowsProcessed = 0;
  for (const st of allRows) {
    const sid = String(st.stop_id);
    const tid = String(st.trip_id);

    if (!stopTimesByStopId.has(sid)) stopTimesByStopId.set(sid, []);
    stopTimesByStopId.get(sid).push(st);

    if (!stopTimesByTripId.has(tid)) stopTimesByTripId.set(tid, []);
    stopTimesByTripId.get(tid).push(st);

    rowsProcessed += 1;
    if (rowsProcessed % YIELD_INDEX_INTERVAL === 0) {
      await yieldToJsLoop();
    }
  }

  let tripsSorted = 0;
  for (const arr of stopTimesByTripId.values()) {
    arr.sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence));
    tripsSorted += 1;
    if (tripsSorted % 250 === 0) {
      await yieldToJsLoop();
    }
  }
}

function appendStopTimeRowToIndexes(st) {
  const sid = String(st.stop_id);
  const tid = String(st.trip_id);

  if (!stopTimesByStopId.has(sid)) stopTimesByStopId.set(sid, []);
  stopTimesByStopId.get(sid).push(st);

  if (!stopTimesByTripId.has(tid)) stopTimesByTripId.set(tid, []);
  stopTimesByTripId.get(tid).push(st);
}

function hasIndexedStopTimeRow(st) {
  const tid = String(st?.trip_id || '');
  if (!tid) return false;
  const rows = stopTimesByTripId.get(tid);
  if (!rows?.length) return false;
  const sid = String(st.stop_id);
  const seq = String(st.stop_sequence);
  return rows.some(
    (row) =>
      String(row.stop_id) === sid &&
      String(row.stop_sequence) === seq &&
      String(row.arrival_time || '') === String(st.arrival_time || '') &&
      String(row.departure_time || '') === String(st.departure_time || ''),
  );
}

async function finalizeStopTimeTripIndexes() {
  let tripsSorted = 0;
  for (const arr of stopTimesByTripId.values()) {
    arr.sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence));
    tripsSorted += 1;
    if (tripsSorted % 250 === 0) {
      await yieldToJsLoop();
    }
  }
}

async function rebuildRouteTypesByStopId() {
  routeTypesByStopId = new Map();

  const routeTypeByTripId = new Map();
  let tripsSeen = 0;
  for (const [tripId, trip] of tripsById.entries()) {
    const route = routesById.get(String(trip.route_id));
    const routeType = Number(route?.route_type);
    if (!Number.isNaN(routeType)) {
      routeTypeByTripId.set(String(tripId), routeType);
    }
    tripsSeen += 1;
    if (tripsSeen % 1200 === 0) {
      await yieldToJsLoop();
    }
  }

  let rowsProcessed = 0;
  for (const [tripId, rows] of stopTimesByTripId.entries()) {
    const routeType = routeTypeByTripId.get(String(tripId));
    if (routeType === undefined) continue;

    for (const st of rows) {
      const sid = String(st.stop_id);
      if (!routeTypesByStopId.has(sid)) routeTypesByStopId.set(sid, new Set());
      routeTypesByStopId.get(sid).add(routeType);
      rowsProcessed += 1;
      if (rowsProcessed % YIELD_INDEX_INTERVAL === 0) {
        await yieldToJsLoop();
      }
    }
  }
}

async function hydrateCoreData(data) {
  stopsById = new Map((data.stops || []).map((s) => [String(s.stop_id), s]));
  routesById = new Map((data.routes || []).map((r) => [String(r.route_id), r]));
  tripsById = new Map();
  stopTimesByStopId = new Map();
  stopTimesByTripId = new Map();
  routeTypesByStopId = new Map();
  pathways = data.pathways || [];
  calendarRows = data.calendar || [];
  calendarDatesRows = data.calendarDates || [];
  trainShapePolylines = Array.isArray(data.trainPolylines) ? data.trainPolylines : [];
  busShapePolylines = Array.isArray(data.busPolylines) ? data.busPolylines : [];
}

async function appendScheduleData(trips, stopTimes) {
  for (const trip of trips || []) {
    tripsById.set(String(trip.trip_id), trip);
  }
  let rowsProcessed = 0;
  for (const st of stopTimes || []) {
    if (hasIndexedStopTimeRow(st)) continue;
    appendStopTimeRowToIndexes(st);
    rowsProcessed += 1;
    if (rowsProcessed % YIELD_INDEX_INTERVAL === 0) {
      await yieldToJsLoop();
    }
  }
  await rebuildRouteTypesByStopId();
}

async function hydrateFromPlainObject(data) {
  await hydrateCoreData(data);
  await appendScheduleData(data.trips || [], data.stopTimes || []);
  await finalizeStopTimeTripIndexes();
}

/**
 * Dedupes stop_times rows when flattening from the Map (each row appears once per trip).
 */
// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

function parseStops(txt) {
  const parsed = Papa.parse(txt, { header: true, skipEmptyLines: true });
  const rows = [];
  for (const row of parsed.data) {
    rows.push({
      stop_id: String(row.stop_id ?? ''),
      stop_name: row.stop_name ?? '',
      stop_lat: row.stop_lat ?? '',
      stop_lon: row.stop_lon ?? '',
      platform_code: row.platform_code ?? '',
      parent_station: row.parent_station ?? '',
    });
  }
  return rows;
}

function parseRoutes(txt) {
  const parsed = Papa.parse(txt, { header: true, skipEmptyLines: true });
  const rows = [];
  for (const row of parsed.data) {
    rows.push({
      route_id: String(row.route_id ?? ''),
      route_short_name: row.route_short_name ?? '',
      route_long_name: row.route_long_name ?? '',
      route_type: row.route_type ?? '',
    });
  }
  return rows;
}

function parseTrips(txt) {
  const parsed = Papa.parse(txt, { header: true, skipEmptyLines: true });
  const rows = [];
  for (const row of parsed.data) {
    rows.push({
      route_id: String(row.route_id ?? ''),
      trip_id: String(row.trip_id ?? ''),
      trip_headsign: row.trip_headsign ?? '',
      direction_id: row.direction_id ?? '',
      shape_id: row.shape_id ?? '',
      service_id: String(row.service_id ?? ''),
    });
  }
  return rows;
}

function parseStopTimes(txt) {
  const parsed = Papa.parse(txt, { header: true, skipEmptyLines: true });
  const rows = [];
  for (const row of parsed.data) {
    rows.push({
      trip_id: String(row.trip_id ?? ''),
      arrival_time: row.arrival_time ?? '',
      departure_time: row.departure_time ?? '',
      stop_id: String(row.stop_id ?? ''),
      stop_sequence: row.stop_sequence ?? '',
      stop_headsign: row.stop_headsign ?? '',
    });
  }
  return rows;
}

function parseStopTimesWithProgress(txt, onProgress, options = {}) {
  const { onRow } = options;
  return new Promise((resolve, reject) => {
    const rows = [];
    let lastBucket = -1;
    let processedRows = 0;
    let lastHeartbeatAt = Date.now();

    Papa.parse(txt, {
      header: true,
      skipEmptyLines: true,
      step: (results, parser) => {
        const row = results?.data || {};
        rows.push({
          trip_id: String(row.trip_id ?? ''),
          arrival_time: row.arrival_time ?? '',
          departure_time: row.departure_time ?? '',
          stop_id: String(row.stop_id ?? ''),
          stop_sequence: row.stop_sequence ?? '',
          stop_headsign: row.stop_headsign ?? '',
        });
        if (onRow) {
          onRow(rows[rows.length - 1]);
        }
        processedRows += 1;

        // Keep the startup watchdog alive even when percentage is still 0%
        // for very large stop_times files.
        if (Date.now() - lastHeartbeatAt >= 3000) {
          lastHeartbeatAt = Date.now();
          emitProgress(onProgress, `Parsing schedules... working (${processedRows} rows)`, 0.45);
        }

        if (processedRows % YIELD_ROW_INTERVAL === 0 && parser && typeof parser.pause === 'function') {
          parser.pause();
          setTimeout(() => {
            if (typeof parser.resume === 'function') parser.resume();
          }, 0);
        }

        const cursor = Number(results?.meta?.cursor || 0);
        if (txt.length > 0 && cursor > 0) {
          const pct = clamp01(cursor / txt.length);
          const bucket = Math.floor(pct * 100);
          if (bucket !== lastBucket && bucket % 2 === 0) {
            lastBucket = bucket;
            emitProgress(onProgress, `Parsing schedules... ${bucket}%`, 0.45 + pct * 0.42);
          }
        }
      },
      complete: () => {
        emitProgress(onProgress, 'Parsing schedules... 100%', 0.87);
        resolve(rows);
      },
      error: (err) => {
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    });
  });
}

function parsePathways(txt) {
  const parsed = Papa.parse(txt, { header: true, skipEmptyLines: true });
  const rows = [];
  for (const row of parsed.data) {
    rows.push({
      pathway_id: String(row.pathway_id ?? ''),
      from_stop_id: String(row.from_stop_id ?? ''),
      to_stop_id: String(row.to_stop_id ?? ''),
      pathway_mode: String(row.pathway_mode ?? ''),
    });
  }
  return rows;
}

function parseCalendar(txt) {
  const parsed = Papa.parse(txt, { header: true, skipEmptyLines: true });
  return parsed.data.filter((r) => r.service_id);
}

function parseCalendarDates(txt) {
  const parsed = Papa.parse(txt, { header: true, skipEmptyLines: true });
  return parsed.data.filter((r) => r.service_id);
}

function parseShapes(txt) {
  const parsed = Papa.parse(txt, { header: true, skipEmptyLines: true });
  const rows = [];
  for (const row of parsed.data) {
    rows.push({
      shape_id: String(row.shape_id ?? ''),
      shape_pt_lat: row.shape_pt_lat ?? '',
      shape_pt_lon: row.shape_pt_lon ?? '',
      shape_pt_sequence: row.shape_pt_sequence ?? '',
    });
  }
  return rows;
}

/**
 * Index shape points by shape_id, sorted by sequence.
 * @param {object[]} shapeRows
 */
function buildShapePointsByShapeId(shapeRows) {
  /** @type {Map<string, Array<{ lat: number; lon: number; seq: number }>>} */
  const byShape = new Map();
  for (const row of shapeRows) {
    const sid = String(row.shape_id || '').trim();
    if (!sid) continue;
    const lat = parseFloat(row.shape_pt_lat);
    const lon = parseFloat(row.shape_pt_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const seq = Number(row.shape_pt_sequence) || 0;
    if (!byShape.has(sid)) byShape.set(sid, []);
    byShape.get(sid).push({ lat, lon, seq });
  }
  for (const arr of byShape.values()) {
    arr.sort((a, b) => a.seq - b.seq);
  }
  return byShape;
}

function downsamplePolyline(coords, maxPoints) {
  if (coords.length <= maxPoints) return coords;
  const step = Math.ceil(coords.length / maxPoints);
  const out = [];
  for (let i = 0; i < coords.length; i += step) {
    out.push(coords[i]);
  }
  const last = coords[coords.length - 1];
  const prev = out[out.length - 1];
  if (
    prev.latitude !== last.latitude ||
    prev.longitude !== last.longitude
  ) {
    out.push(last);
  }
  return out;
}

/**
 * One polyline per GTFS shape: classify by route_type via any trip that uses the shape.
 * @param {object[]} shapeRows
 */
function buildTrainBusShapePolylines(shapeRows, trips, routes) {
  const routesById = new Map(routes.map((r) => [String(r.route_id), r]));
  const byShape = buildShapePointsByShapeId(shapeRows);
  /** @type {Map<string, 'train' | 'bus'>} */
  const shapeToMode = new Map();
  for (const trip of trips) {
    const sh = String(trip.shape_id || '').trim();
    if (!sh) continue;
    const route = routesById.get(String(trip.route_id));
    const rt = Number(route?.route_type);
    if (rt === 2) shapeToMode.set(sh, 'train');
    else if (rt === 3) shapeToMode.set(sh, 'bus');
  }

  const train = [];
  const bus = [];
  for (const [shapeId, mode] of shapeToMode) {
    const pts = byShape.get(shapeId);
    if (!pts || pts.length < 2) continue;
    let coords = pts.map((p) => ({ latitude: p.lat, longitude: p.lon }));
    coords = downsamplePolyline(coords, 140);
    if (mode === 'train') train.push(coords);
    else bus.push(coords);
  }
  return { trainPolylines: train, busPolylines: bus };
}

// ---------------------------------------------------------------------------
// Download + parse pipeline
// ---------------------------------------------------------------------------

async function downloadAndParseZip(onProgress, options = {}) {
  const { remoteFingerprint: knownRemoteFingerprint = null } = options;
  const stageStartAt = Date.now();
  const stageDurations = {};
  startupStageDurations = stageDurations;
  const markStage = (stage) => {
    stageDurations[stage] = Date.now() - stageStartAt;
    setStartupPhase(stage, `${stage} (${stageDurations[stage]}ms)`);
  };
  setStartupPhase('prepare', 'Preparing GO Transit data');
  emitProgress(onProgress, 'Preparing GO Transit data...', 0.01);
  logGtfs('download: start', { url: GTFS_ZIP_URL });

  let responseFingerprint = null;
  let zipUri = null;
  let downloadedBytes = 0;
  let usedNativeUnzipPath = false;
  let usedJsZipFallback = false;
  let stopsTxt = null;
  let routesTxt = null;
  let tripsTxt = null;
  let stopTimesTxt = null;
  let pathwaysTxt = null;
  let calendarTxt = null;
  let calendarDatesTxt = null;

  const cleanupTempFiles = async () => {
    await FileSystem.deleteAsync(GTFS_ZIP_TEMP_FILE, { idempotent: true }).catch(() => {});
    await FileSystem.deleteAsync(GTFS_ZIP_EXTRACT_DIR, { idempotent: true }).catch(() => {});
  };

  try {
    const downloaded = await downloadZipFileWithProgress(onProgress);
    zipUri = downloaded.zipUri;
    downloadedBytes = Number(downloaded.bytes || 0);
    responseFingerprint = downloaded.responseFingerprint;
  } catch (err) {
    logGtfs('download: failed', {
      message: err?.message,
      stack: err?.stack,
    });
    throw err;
  }

  let remoteFingerprint = hasFingerprintValue(responseFingerprint)
    ? responseFingerprint
    : knownRemoteFingerprint;

  logGtfs('download: complete', { bytes: downloadedBytes, mb: (downloadedBytes / 1e6).toFixed(2) });
  markStage('download-complete');

  const unzipFn = await getNativeUnzipFunction();
  if (unzipFn && zipUri) {
    try {
      setStartupPhase('native-unzip', 'Using native unzip path');
      await withStageTimeout(
        'unzip archive',
        async () => {
          await FileSystem.deleteAsync(GTFS_ZIP_EXTRACT_DIR, { idempotent: true }).catch(() => {});
          await FileSystem.makeDirectoryAsync(GTFS_ZIP_EXTRACT_DIR, { intermediates: true });
          await unzipFn(zipUri, GTFS_ZIP_EXTRACT_DIR);
        },
        STAGE_UNZIP_TIMEOUT_MS,
      );
      markStage('zip-read');
      emitProgress(onProgress, 'Reading stops & routes...', 0.42);

      const extracted = await withStageTimeout(
        'read extracted GTFS files',
        () => readRequiredGtfsTextsFromExtractedDirectory(GTFS_ZIP_EXTRACT_DIR),
        STAGE_UNZIP_TIMEOUT_MS,
      );
      usedNativeUnzipPath = true;
      markStage('native-extract-read');
      stopsTxt = extracted.stopsTxt;
      routesTxt = extracted.routesTxt;
      tripsTxt = extracted.tripsTxt;
      stopTimesTxt = extracted.stopTimesTxt;
      pathwaysTxt = extracted.pathwaysTxt;
      calendarTxt = extracted.calendarTxt;
      calendarDatesTxt = extracted.calendarDatesTxt;
    } catch (err) {
      logGtfs('unzip: native extraction failed, fallback to JSZip', {
        message: err?.message,
        stack: err?.stack,
      });
    } finally {
      await cleanupTempFiles();
    }
  }

  if (!stopsTxt || !routesTxt || !tripsTxt || !stopTimesTxt) {
    let buf;
    try {
      setStartupPhase('fallback-unzip', 'Falling back to JSZip path');
      if (zipUri) {
        const localResponse = await fetch(zipUri);
        if (localResponse.ok) {
          buf = await localResponse.arrayBuffer();
          markStage('fallback-local-buffer-read');
        }
      }

      if (!buf) {
        const downloaded = await downloadZipArrayBufferWithProgress(onProgress);
        buf = downloaded.arrayBuffer;
        markStage('fallback-network-redownload');
        if (!hasFingerprintValue(remoteFingerprint) && hasFingerprintValue(downloaded.responseFingerprint)) {
          responseFingerprint = downloaded.responseFingerprint;
          remoteFingerprint = downloaded.responseFingerprint;
        }
      }
    } catch (err) {
      logGtfs('download fallback: failed', {
        message: err?.message,
        stack: err?.stack,
      });
      throw err;
    }
    usedJsZipFallback = true;

    let zip;
    try {
      zip = await withStageTimeout('unzip archive', () => JSZip.loadAsync(buf), STAGE_UNZIP_TIMEOUT_MS);
    } catch (err) {
      logGtfs('unzip: JSZip.loadAsync failed', {
        message: err?.message,
        stack: err?.stack,
      });
      throw err;
    }
    logGtfs('unzip: JSZip parsed OK');
    markStage('zip-read');

    emitProgress(onProgress, 'Reading stops & routes...', 0.42);
    stopsTxt = await readZipText(zip, 'stops.txt');
    routesTxt = await readZipText(zip, 'routes.txt');
    tripsTxt = await readZipText(zip, 'trips.txt');
    stopTimesTxt = await readZipText(zip, 'stop_times.txt');

    pathwaysTxt = await readZipText(zip, 'pathways.txt');
    calendarTxt = await readZipText(zip, 'calendar.txt');
    calendarDatesTxt = await readZipText(zip, 'calendar_dates.txt');

    zip = null;
    buf = null;
  }

  if (!stopsTxt || !routesTxt || !tripsTxt || !stopTimesTxt) {
    logGtfs('parse: missing required txt in zip', {
      hasStops: !!stopsTxt,
      hasRoutes: !!routesTxt,
      hasTrips: !!tripsTxt,
      hasStopTimes: !!stopTimesTxt,
    });
    throw new Error('GTFS zip missing required files (stops/routes/trips/stop_times).');
  }

  emitProgress(onProgress, 'Parsing schedules... 0%', 0.45);
  setStartupPhase('parse', 'Parsing GTFS schedules');
  logGtfs('parse: CSV starting (stop_times is largest)…');

  const stops = parseStops(stopsTxt); stopsTxt = null;
  const routes = parseRoutes(routesTxt); routesTxt = null;
  const trips = parseTrips(tripsTxt); tripsTxt = null;

  // Publish core stop/route/trip tables early so the map can render while
  // stop_times and indexes are still parsing in background.
  stopsById = new Map(stops.map((s) => [s.stop_id, s]));
  routesById = new Map(routes.map((r) => [r.route_id, r]));
  tripsById = new Map(trips.map((t) => [t.trip_id, t]));

  stopTimesByStopId = new Map();
  stopTimesByTripId = new Map();
  const stopTimes = await withStageTimeout(
    'parse stop_times',
    () =>
      parseStopTimesWithProgress(stopTimesTxt, onProgress, {
        onRow: appendStopTimeRowToIndexes,
      }),
    STAGE_PARSE_TIMEOUT_MS,
  );
  stopTimesTxt = null;
  await withStageTimeout('finalize stop_time indexes', () => finalizeStopTimeTripIndexes(), STAGE_INDEX_TIMEOUT_MS);
  markStage('stop-times-parsed');
  pathways = pathwaysTxt ? parsePathways(pathwaysTxt) : [];
  calendarRows = calendarTxt ? parseCalendar(calendarTxt) : []; calendarTxt = null;
  calendarDatesRows = calendarDatesTxt ? parseCalendarDates(calendarDatesTxt) : []; calendarDatesTxt = null;

  stopsById = new Map(stops.map((s) => [s.stop_id, s]));
  routesById = new Map(routes.map((r) => [r.route_id, r]));
  tripsById = new Map(trips.map((t) => [t.trip_id, t]));
  await withStageTimeout('build route type index', () => rebuildRouteTypesByStopId(), STAGE_INDEX_TIMEOUT_MS);
  markStage('indexes-built');

  // Shapes skipped — no polylines built (saves memory; route lines not shown in UI).
  trainShapePolylines = [];
  busShapePolylines = [];
  logGtfs('parse: shapes skipped (memory optimisation)');

  logGtfs('parse: indexes built', {
    stops: stops.length,
    stopTimesRows: stopTimes.length,
  });

  emitProgress(onProgress, 'Persisting cache in background...', 0.93);
  setStartupPhase('cache-write-background', 'Persisting cache in background');

  const payload = {
    version: 3,
    stops,
    routes,
    trips,
    stopTimes,
    pathways,
    calendar: calendarRows,
    calendarDates: calendarDatesRows,
    // trainPolylines and busPolylines intentionally omitted — not used in UI.
  };

  emitProgress(onProgress, 'Finalizing schedules...', 0.99);
  setStartupPhase('finalize', 'GTFS data ready in memory');

  const persistPayload = {
    checkedAt: Date.now(),
    downloadedAt: Date.now(),
    remoteFingerprint,
    cacheVersion: 3,
    sourceUrl: GTFS_ZIP_URL,
    startupPipeline: {
      nativeUnzipPath: usedNativeUnzipPath,
      jsZipFallback: usedJsZipFallback,
      stageDurations,
    },
  };

  setTimeout(() => {
    persistGtfsCacheInBackground(payload, persistPayload).catch(() => {
      // Non-fatal; startup has already succeeded with in-memory data.
    });
  }, 0);
}

async function persistGtfsCacheInBackground(payload, metaBase) {
  let cachePersisted = false;
  let cacheWriteError = null;

  try {
    const t0 = Date.now();
    const json = JSON.stringify(payload);
    logGtfs('cache: JSON ready', {
      ms: Date.now() - t0,
      chars: json.length,
      approxMb: (json.length / 1e6).toFixed(2),
    });

    await FileSystem.writeAsStringAsync(CACHE_FILE, json);
    cachePersisted = true;
    logGtfs('cache: write OK', { path: CACHE_FILE });
  } catch (err) {
    cacheWriteError = err?.message || String(err);
    logGtfs('cache: skipped (non-fatal)', {
      path: CACHE_FILE,
      likelyOom: isLikelyOutOfMemoryError(err),
      message: err?.message,
      stack: err?.stack,
    });
    try {
      await FileSystem.deleteAsync(CACHE_FILE, { idempotent: true });
    } catch {
      // Ignore cleanup failure.
    }
  }

  await writeCacheMetadata({
    ...metaBase,
    cachePersisted,
    cacheWriteError,
  });
}

async function loadFromCache(onProgress) {
  setStartupPhase('cache-load', 'Loading cached GO Transit data');
  onProgress?.('Loading cached GO Transit data...');
  logGtfs('cache: reading file…', { path: CACHE_FILE });

  const info = await FileSystem.getInfoAsync(CACHE_FILE);
  if (!info.exists) {
    throw new Error('GTFS cache file is missing.');
  }
  const cacheSize = Number(info.size || 0);
  if (cacheSize < CACHE_MIN_BYTES || cacheSize > CACHE_MAX_BYTES) {
    throw new Error(`GTFS cache size is invalid (${cacheSize} bytes).`);
  }

  let json;
  try {
    json = await FileSystem.readAsStringAsync(CACHE_FILE);
  } catch (err) {
    logGtfs('cache: read failed', {
      message: err?.message,
      stack: err?.stack,
    });
    throw err;
  }

  logGtfs('cache: read OK', { chars: json.length });

  let data;
  try {
    data = JSON.parse(json);
  } catch (err) {
    logGtfs('cache: JSON.parse failed (corrupt cache?)', {
      message: err?.message,
      stack: err?.stack,
    });
    throw err;
  }

  try {
    await hydrateFromPlainObject(data);
  } catch (err) {
    logGtfs('cache: hydrate failed', {
      message: err?.message,
      stack: err?.stack,
    });
    throw err;
  }
  logGtfs('cache: hydrate OK');

  // Sanity checks: cache must contain schedules and at least one of calendar or calendar_dates.
  const hasAnyStopTimes = stopTimesByTripId && stopTimesByTripId.size > 0;
  const hasCalendarInfo = (calendarRows && calendarRows.length) || (calendarDatesRows && calendarDatesRows.length);
  if (!hasAnyStopTimes || !hasCalendarInfo) {
    const reason = !hasAnyStopTimes ? 'no stop_times' : 'no calendar data';
    logGtfs('cache: invalid content, will refresh from network', { reason });
    throw new Error(`Invalid GTFS cache: ${reason}`);
  }
}

async function loadFromHostedSqlite(onProgress, options = {}) {
  setStartupPhase('sqlite-download', 'Preparing hosted schedules database');
  emitProgress(onProgress, 'Checking schedules database...', 0.02);

  const ensureProgress = (event) => {
    if (!event) return;
    const msg = typeof event === 'string' ? event : event.message;
    const pct = typeof event === 'object' ? Number(event.percent) : NaN;
    emitProgress(onProgress, msg || 'Downloading schedules database...', Number.isFinite(pct) ? pct : undefined);
  };

  // Local-first: use the on-device database immediately so a slow or failing
  // manifest fetch can't stall or fail startup. Version checks and downloads
  // happen in the background update flow after the app is ready.
  let ensured;
  if (options.forceDownload) {
    ensured = await ensureHostedSqlite({ force: true, onProgress: ensureProgress });
  } else {
    const local = await ensureLocalHostedSqlite().catch(() => ({
      ok: false,
      reason: 'local-ensure-failed',
    }));
    ensured = local?.ok
      ? local
      : await ensureHostedSqlite({ force: false, onProgress: ensureProgress });
  }

  if (!ensured?.ok) {
    throw new Error(`Hosted schedules database unavailable (${ensured?.reason || 'unknown reason'}).`);
  }

  cachedBundleMeta = await getBundleMeta();
  loadedScheduleKeys.clear();

  setStartupPhase('sqlite-load-core', 'Loading core schedules from SQLite');
  const core = await loadHostedCoreTables((event) => {
    if (!event) return;
    const msg = typeof event === 'string' ? event : event.message;
    const pct = typeof event === 'object' ? Number(event.percent) : NaN;
    emitProgress(onProgress, msg || 'Loading schedules database...', Number.isFinite(pct) ? pct : undefined);
  });

  await hydrateCoreData(core);
  setStartupPhase('sqlite-load-startup-schedules', 'Loading startup schedules from SQLite');
  emitProgress(onProgress, 'Loading startup schedules...', 0.55);

  const today = torontoTodayYmd();
  const startupDates = [];
  for (let i = 0; i < STARTUP_SCHEDULE_DAYS; i += 1) {
    startupDates.push(addDaysYmd(today, i));
  }

  const startupModes = { train: true, bus: true };
  const schedule = await loadHostedSchedulesForDates(
    startupDates,
    startupModes,
    activeServiceIdsForDate,
    (event) => {
      if (!event) return;
      const msg = typeof event === 'string' ? event : event.message;
      const pct = typeof event === 'object' ? Number(event.percent) : NaN;
      emitProgress(onProgress, msg || 'Loading schedules...', Number.isFinite(pct) ? pct : undefined);
    },
  );

  await appendScheduleData(schedule.trips, schedule.stopTimes);
  await finalizeStopTimeTripIndexes();
  markLoadedKeysForDates(startupDates, startupModes);

  schedulesReadyFlag = true;
  options.onSchedulesReady?.();
  emitProgress(onProgress, 'Schedules database ready', 0.99);
}

async function maybeRefreshGtfsCacheInBackground() {
  if (backgroundRefreshPromise) return backgroundRefreshPromise;

  backgroundRefreshPromise = (async () => {
    const meta = await readCacheMetadata();
    if (!isWeeklyRefreshDue(meta)) {
      logGtfs('weekly-refresh: skipped (not due)');
      return { status: 'not-due', update: null };
    }

    logGtfs('weekly-refresh: checking remote fingerprint');

    let remoteFingerprint;
    try {
      remoteFingerprint = await fetchRemoteStaticFingerprint();
    } catch (err) {
      logGtfs('weekly-refresh: check failed', {
        message: err?.message,
        stack: err?.stack,
      });
      return { status: 'check-failed', update: null };
    }

    const checkedAt = Date.now();
    if (!hasFingerprintValue(remoteFingerprint)) {
      logGtfs('weekly-refresh: remote fingerprint unavailable');
      await writeCacheMetadata({
        ...(meta || {}),
        checkedAt,
        sourceUrl: GTFS_ZIP_URL,
      });
      return { status: 'fingerprint-unavailable', update: null };
    }

    if (!meta?.remoteFingerprint) {
      logGtfs('weekly-refresh: baseline fingerprint recorded');
      await writeCacheMetadata({
        ...(meta || {}),
        checkedAt,
        remoteFingerprint,
        sourceUrl: GTFS_ZIP_URL,
      });
      return { status: 'baseline-recorded', update: null };
    }

    if (fingerprintsMatch(meta.remoteFingerprint, remoteFingerprint)) {
      logGtfs('weekly-refresh: no change detected');
      await writeCacheMetadata({
        ...meta,
        checkedAt,
        remoteFingerprint,
        sourceUrl: GTFS_ZIP_URL,
      });
      await clearUpdateMetadata();
      return { status: 'up-to-date', update: null };
    }

    const pendingUpdate = {
      status: 'available',
      detectedAt: checkedAt,
      remoteFingerprint,
      sourceUrl: GTFS_ZIP_URL,
      estimatedDurationSec: meta?.lastSuccessfulRefreshSec || null,
      snoozeUntil: null,
      lastPromptedAt: null,
    };

    logGtfs('weekly-refresh: change detected, update recorded');
    await writeCacheMetadata({
      ...meta,
      checkedAt,
      sourceUrl: GTFS_ZIP_URL,
    });
    await writeUpdateMetadata(pendingUpdate);
    return { status: 'update-available', update: pendingUpdate };
  })();

  try {
    return await backgroundRefreshPromise;
  } finally {
    backgroundRefreshPromise = null;
  }
}

export async function getPendingGtfsUpdate() {
  if (isHostedSqliteConfigured()) {
    return getPendingHostedSqliteUpdate();
  }
  return readUpdateMetadata();
}

export async function snoozePendingGtfsUpdate(snoozeUntil) {
  if (isHostedSqliteConfigured()) {
    const existing = await getPendingHostedSqliteUpdate();
    if (!existing) return null;
    const next = {
      ...existing,
      status: 'snoozed',
      snoozeUntil: Number(snoozeUntil) || null,
    };
    await setPendingHostedSqliteUpdate(next);
    return next;
  }
  const existing = await readUpdateMetadata();
  if (!existing) return null;
  const next = {
    ...existing,
    status: 'snoozed',
    snoozeUntil: Number(snoozeUntil) || null,
  };
  await writeUpdateMetadata(next);
  return next;
}

export async function markGtfsUpdatePrompted(promptedAt = Date.now()) {
  if (isHostedSqliteConfigured()) {
    const existing = await getPendingHostedSqliteUpdate();
    if (!existing) return null;
    const next = {
      ...existing,
      lastPromptedAt: promptedAt,
    };
    await setPendingHostedSqliteUpdate(next);
    return next;
  }
  const existing = await readUpdateMetadata();
  if (!existing) return null;
  const next = {
    ...existing,
    lastPromptedAt: promptedAt,
  };
  await writeUpdateMetadata(next);
  return next;
}

export async function checkForGtfsStaticUpdate() {
  if (isHostedSqliteConfigured()) {
    return checkHostedSqliteUpdate();
  }
  return maybeRefreshGtfsCacheInBackground();
}

export function usesHostedGtfsSqlite() {
  return isHostedSqliteConfigured();
}

export async function applyPendingGtfsUpdate(options = {}) {
  if (isHostedSqliteConfigured()) {
    const pending = await getPendingHostedSqliteUpdate();
    if (!pending?.version) {
      return { ok: false, reason: 'no-pending-update' };
    }
    const startedAt = Date.now();
    await applyPendingHostedSqliteUpdate({ onProgress: options.onProgress });
    await clearPendingHostedSqliteUpdate();
    const elapsedSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    return { ok: true, elapsedSec };
  }

  const pending = await readUpdateMetadata();
  if (!pending?.remoteFingerprint) {
    return { ok: false, reason: 'no-pending-update' };
  }

  const startedAt = Date.now();
  await downloadAndParseZip(options.onProgress, {
    remoteFingerprint: pending.remoteFingerprint,
  });

  const elapsedSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
  const cacheMeta = (await readCacheMetadata()) || {};
  await writeCacheMetadata({
    ...cacheMeta,
    lastSuccessfulRefreshSec: elapsedSec,
  });
  await clearUpdateMetadata();

  return { ok: true, elapsedSec };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Call once on app startup. Downloads + parses on first install; later loads
 * from disk cache for speed.
 *
 * @param {{ onProgress?: (msg: string) => void }} [options]
 */
export function loadGtfs(options = {}) {
  const { onProgress, onSchedulesReady } = options;
  if (loadPromise) return loadPromise;

  const seq = loadGeneration;
  schedulesReadyFlag = false;

  loadPromise = (async () => {
    try {
      setStartupPhase('load-begin', 'Starting GTFS startup load');
      logGtfs('loadGtfs: begin', { seq, sqliteMode: isHostedSqliteConfigured() });
      let loadedFromCache = false;

      if (isHostedSqliteConfigured()) {
        await loadFromHostedSqlite(onProgress, { onSchedulesReady });
      } else {
        const info = await FileSystem.getInfoAsync(CACHE_FILE);
        logGtfs('loadGtfs: cache check', { exists: info.exists, size: info.size });

        if (info.exists) {
          try {
            setStartupPhase('cache-check', 'Cache file found; loading from disk');
            await loadFromCache(onProgress);
            loadedFromCache = true;
          } catch (e) {
            // Corrupt or incomplete cache — re-download fresh.
            setStartupPhase('cache-refresh', 'Cache invalid; re-downloading');
            logGtfs('loadGtfs: cache invalid, redownloading', { message: e?.message });
            await downloadAndParseZip(onProgress);
          }
        } else {
          setStartupPhase('cold-download', 'No cache found; downloading GTFS data');
          await downloadAndParseZip(onProgress);
        }
      }

      if (seq !== loadGeneration) {
        logGtfs('loadGtfs: finished but superseded (ignored)', { seq, loadGeneration });
        return;
      }

      isReadyFlag = true;
      if (!schedulesReadyFlag) {
        schedulesReadyFlag = true;
        onSchedulesReady?.();
      }
      setStartupPhase('ready', 'GTFS load complete');
      logGtfs('loadGtfs: success, isReadyFlag = true');

      if (loadedFromCache) {
        maybeRefreshGtfsCacheInBackground().catch(() => {
          // Keep app usable even if weekly refresh checks fail.
        });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const stack = e instanceof Error ? e.stack : undefined;
      const stage = e?.stage || null;
      const details = e?.details || null;
      logGtfs('loadGtfs: ERROR', { message, stage, details, stack, seq, loadGeneration });

      if (seq === loadGeneration) {
        loadPromise = null;
        throw e;
      }
      // Load was invalidated (e.g. UI timeout) — do not rethrow (avoids unhandled rejection).
      logGtfs('loadGtfs: error suppressed (superseded load)');
    }
  })();

  return loadPromise;
}

export function isGtfsReady() {
  return isReadyFlag;
}

/**
 * Re-reads the already-written cache file and rebuilds all in-memory maps.
 * Safe to call after applyPendingGtfsUpdate completes — does NOT reset the
 * ready flag or show startup loading UI.
 */
export async function reloadGtfsFromCache() {
  if (isHostedSqliteConfigured()) {
    clearLoadedScheduleKeys();
    schedulesReadyFlag = false;
    await loadFromHostedSqlite(null, { forceDownload: false });
    logGtfs('reloadGtfsFromCache: refreshed from hosted SQLite database');
    return;
  }
  await loadFromCache(null);
  schedulesReadyFlag = true;
  logGtfs('reloadGtfsFromCache: in-memory stores refreshed from new cache');
}

export function getStops() {
  return [...stopsById.values()];
}

export function getStopById(stopId) {
  return stopsById.get(String(stopId)) ?? null;
}

/**
 * Case-insensitive substring match on stop_name (limited to 80 results).
 */
export function searchStops(query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return [];
  const out = [];
  for (const s of stopsById.values()) {
    if ((s.stop_name || '').toLowerCase().includes(q)) {
      out.push(s);
      if (out.length >= 80) break;
    }
  }
  return out;
}

/**
 * Finds the platform / track code for one trip at one stop using the static feed.
 */
export function getPlatformForTrip(tripId, stopId) {
  const tid = String(tripId);
  const sid = String(stopId);
  const row = stopTimesByTripId.get(tid)?.find((st) => String(st.stop_id) === sid);
  if (!row) return null;

  const stop = stopsById.get(sid);
  if (stop && (stop.platform_code || '').trim()) {
    return String(stop.platform_code).trim();
  }

  return null;
}

/**
 * Next departures from a stop (static schedule only) — up to 10 after "now" (Toronto).
 */
/**
 * Returns IDs of co-located stops at the same physical station.
 * Handles both parent_station GTFS links and GO Transit's name-based bus siblings:
 * "Meadowvale GO" ↔ "Meadowvale GO Bus", "Burlington GO" ↔ "Burlington GO Bus", etc.
 * GO's GTFS does not always link these via parent_station, so the name check bridges the gap.
 */
function getStationSiblingIds(stopId) {
  const sid = String(stopId || '').trim();
  if (!sid) return new Set();
  const stop = stopsById.get(sid);
  if (!stop) return new Set();

  const siblings = new Set();
  const stopNameLower = (stop.stop_name || '').trim().toLowerCase();
  const parentId = String(stop.parent_station || '').trim();

  // 1. parent_station links (standard GTFS)
  if (parentId) siblings.add(parentId);
  for (const s of stopsById.values()) {
    const sSid = String(s.stop_id);
    if (sSid === sid) continue;
    const sParent = String(s.parent_station || '').trim();
    if (sParent === sid || (parentId && sParent === parentId)) {
      siblings.add(sSid);
    }
  }

  // 2. Name-based bus siblings: "X Bus" / "X Bus Terminal" <-> "X"
  const busStripMatch = stopNameLower.match(/^(.+?)\s+bus(?:\s+terminal)?$/);
  const baseNameLower = busStripMatch ? busStripMatch[1].trim() : null;

  for (const s of stopsById.values()) {
    const sSid = String(s.stop_id);
    if (sSid === sid || siblings.has(sSid)) continue;
    const sNameLower = (s.stop_name || '').trim().toLowerCase();
    // Forward: current is "X", match "X Bus" / "X Bus Terminal"
    if (
      sNameLower === stopNameLower + ' bus' ||
      sNameLower === stopNameLower + ' bus terminal'
    ) {
      siblings.add(sSid);
    }
    // Reverse: current is "X Bus"/"X Bus Terminal", match "X"
    if (baseNameLower && sNameLower === baseNameLower) {
      siblings.add(sSid);
    }
  }

  return siblings;
}

/**
 * Returns the canonical display name for a stop.
 * Strips the trailing " Bus" / " Bus Terminal" suffix from bus platform stops
 * (e.g. "Meadowvale GO Bus" → "Meadowvale GO") so names match what users see on the website.
 */
function getCanonicalStopName(stopId) {
  const stop = stopsById.get(String(stopId || '').trim());
  if (!stop) return String(stopId);
  const name = normalizeDisplayText(stop.stop_name || '');
  return name.replace(/\s+Bus(?:\s+Terminal)?$/i, '').trim() || name;
}

export function getDeparturesForStop(stopId, limit = 10, options = {}) {
  const { allowRouteTimeCollapse = true, mode = null } = options;
  const sid = String(stopId);

  // Collect rows from this stop AND all co-located siblings (parent_station + name-based bus siblings).
  const siblingIds = getStationSiblingIds(sid);
  const directRows = stopTimesByStopId.get(sid) || [];
  const siblingRows = [];
  for (const sibId of siblingIds) {
    const arr = stopTimesByStopId.get(sibId);
    if (arr && arr.length) siblingRows.push(...arr);
  }
  const rows = siblingRows.length ? [...directRows, ...siblingRows] : directRows;

  if (!rows.length) return [];

  const activeServices = activeServiceIdsToday();
  const now = DateTime.now().setZone('America/Toronto');
  const lookbackCutoff = now.minus({ minutes: REALTIME_LOOKBACK_MINUTES });
  const candidates = [];

  for (const st of rows) {
    const trip = tripsById.get(String(st.trip_id));
    if (!trip) continue;
    if (!activeServices.has(String(trip.service_id))) continue;

    const depTimeStr = (st.departure_time || st.arrival_time || '').trim();
    if (!depTimeStr) continue;
    const scheduledDt = stopTimeToDateTimeToday(depTimeStr);
    if (scheduledDt < lookbackCutoff) continue;

    // Skip rows where boarding is not allowed at this stop.
    if (String(st.pickup_type) === '1') continue;

    const tripId = String(st.trip_id).trim();
    const route = routesById.get(String(trip.route_id));
    const platform = getPlatformForTrip(tripId, String(st.stop_id));
    const routeType = Number(route?.route_type);
    const { startStopName, endStopName } = getTripEndpoints(tripId);

    // Add stops array for this trip (full stop sequence)
    let stops = [];
    if (stopTimesByTripId.has(tripId)) {
      stops = stopTimesByTripId.get(tripId).map(stopRow => ({
        stop_id: stopRow.stop_id,
        stop_sequence: stopRow.stop_sequence,
        stop_name: stopsById.get(String(stopRow.stop_id))?.stop_name || '',
      }));
    }
    candidates.push({
      trip_id: tripId,
      route_id: String(trip.route_id),
      route_short_name: route?.route_short_name ?? '',
      route_long_name: route?.route_long_name ?? '',
      route_type: Number.isNaN(routeType) ? null : routeType,
      headsign: pickHeadsign(st, trip),
      lineName: buildLineName(route),
      servicePattern: inferServicePattern(st, trip, route),
      startStopName,
      endStopName,
      scheduledDateTime: scheduledDt.toISO(),
      scheduledTimeLabel: formatClockLabel(scheduledDt),
      departure_time_raw: depTimeStr,
      platformCode: platform || null,
      stop_sequence: st.stop_sequence,
      // Keep the actual stop_id used so getTripsFromTo can find the right sequence.
      _actual_stop_id: String(st.stop_id),
      stops,
    });
  }

  candidates.sort(
    (a, b) =>
      DateTime.fromISO(a.scheduledDateTime).toMillis() -
      DateTime.fromISO(b.scheduledDateTime).toMillis(),
  );

  // Pass 1: same trip at same departure_time => keep one row.
  const dedupedByTripAndTime = [];
  const seenTripAndTime = new Set();
  for (const row of candidates) {
    const key = `${row.trip_id}|${row.departure_time_raw}`;
    if (seenTripAndTime.has(key)) continue;
    seenTripAndTime.add(key);
    dedupedByTripAndTime.push(row);
  }

  // Apply optional mode filter before limiting so train-only/bus-only flows
  // are not starved by mixed-mode candidate windows.
  const modeFilteredRows = (() => {
    if (mode !== 'train' && mode !== 'bus') return dedupedByTripAndTime;
    return dedupedByTripAndTime.filter((row) => {
      const isBus = Number(row.route_type) === 3;
      return mode === 'bus' ? isBus : !isBus;
    });
  })();

  // Optional fallback collapse for board-style displays.
  // Keep disabled for accuracy-first flows (e.g. from->to trip matching), where
  // collapsing by route/time can drop a valid destination-serving trip.
  const finalRows = (() => {
    if (!allowRouteTimeCollapse) return modeFilteredRows;
    const collapsed = [];
    const seenRouteAndTime = new Set();
    for (const row of modeFilteredRows) {
      const key = `${row.route_id}|${row.departure_time_raw}`;
      if (seenRouteAndTime.has(key)) continue;
      seenRouteAndTime.add(key);
      collapsed.push(row);
    }
    return collapsed;
  })();

  // Prioritize upcoming rows so busy hubs (e.g. Union) don't fill the limit
  // with recent-past departures from the lookback window.
  const upcoming = [];
  const recentPast = [];
  for (const row of finalRows) {
    const dt = DateTime.fromISO(row.scheduledDateTime);
    if (dt >= now) upcoming.push(row);
    else recentPast.push(row);
  }

  return [...upcoming, ...recentPast].slice(0, limit).map(({ departure_time_raw, ...rest }) => rest);
}

/**
 * Returns departures for a stop on a specific date (YYYYMMDD format).
 * Uses calendar rules to determine which services run that day.
 * Filters to future departures relative to the given date.
 */
export function getDeparturesForDate(stopId, ymd, limit = 10, options = {}) {
  const { allowRouteTimeCollapse = true, mode = null } = options;
  const sid = String(stopId);

  // Collect rows from this stop AND all co-located siblings
  const siblingIds = getStationSiblingIds(sid);
  const directRows = stopTimesByStopId.get(sid) || [];
  const siblingRows = [];
  for (const sibId of siblingIds) {
    const arr = stopTimesByStopId.get(sibId);
    if (arr && arr.length) siblingRows.push(...arr);
  }
  const rows = siblingRows.length ? [...directRows, ...siblingRows] : directRows;

  if (!rows.length) return [];

  const activeServices = activeServiceIdsForDate(ymd);
  const refDate = DateTime.fromFormat(ymd, 'yyyyMMdd').setZone('America/Toronto');
  const now = refDate.startOf('day'); // compare to midnight of the given date
  const candidates = [];

  for (const st of rows) {
    const trip = tripsById.get(String(st.trip_id));
    if (!trip) continue;
    if (!activeServices.has(String(trip.service_id))) continue;

    const depTimeStr = (st.departure_time || st.arrival_time || '').trim();
    if (!depTimeStr) continue;
    const scheduledDt = stopTimeToDateTimeForDate(depTimeStr, ymd);
    if (scheduledDt < now) continue; // filter to future times within the date

    // Skip rows where boarding is not allowed
    if (String(st.pickup_type) === '1') continue;

    const tripId = String(st.trip_id).trim();
    const route = routesById.get(String(trip.route_id));
    const platform = getPlatformForTrip(tripId, String(st.stop_id));
    const routeType = Number(route?.route_type);
    const { startStopName, endStopName } = getTripEndpoints(tripId);

    candidates.push({
      trip_id: tripId,
      route_id: String(trip.route_id),
      route_short_name: route?.route_short_name ?? '',
      route_long_name: route?.route_long_name ?? '',
      route_type: Number.isNaN(routeType) ? null : routeType,
      headsign: pickHeadsign(st, trip),
      lineName: buildLineName(route),
      servicePattern: inferServicePattern(st, trip, route),
      startStopName,
      endStopName,
      scheduledDateTime: scheduledDt.toISO(),
      scheduledTimeLabel: formatClockLabel(scheduledDt),
      departure_time_raw: depTimeStr,
      platformCode: platform || null,
      stop_sequence: st.stop_sequence,
      _actual_stop_id: String(st.stop_id),
    });
  }

  // Pass 1 dedup: keep earliest scheduled time per trip_id
  const dedupedByTripAndTime = [];
  const seenTrips = new Set();
  for (const row of candidates) {
    if (seenTrips.has(row.trip_id)) continue;
    seenTrips.add(row.trip_id);
    dedupedByTripAndTime.push(row);
  }

  const modeFilteredRows = (() => {
    if (mode !== 'train' && mode !== 'bus') return dedupedByTripAndTime;
    return dedupedByTripAndTime.filter((row) => {
      const isBus = Number(row.route_type) === 3;
      return mode === 'bus' ? isBus : !isBus;
    });
  })();

  const finalRows = (() => {
    if (!allowRouteTimeCollapse) return modeFilteredRows;
    const collapsed = [];
    const seenRouteAndTime = new Set();
    for (const row of modeFilteredRows) {
      const key = `${row.route_id}|${row.departure_time_raw}`;
      if (seenRouteAndTime.has(key)) continue;
      seenRouteAndTime.add(key);
      collapsed.push(row);
    }
    return collapsed;
  })();

  return finalRows.slice(0, limit).map(({ departure_time_raw, ...rest }) => rest);
}

export function getStopRouteTypes(stopId) {
  return [...(routeTypesByStopId.get(String(stopId)) || new Set())];
}

/**
 * Precomputed GTFS shapes for map overlays: rail (green) vs bus (red).
 * Filled after load; empty arrays if cache predates v3 or shapes.txt was missing.
 */
export function getShapePolylinesForMap() {
  return {
    train: trainShapePolylines,
    bus: busShapePolylines,
  };
}

/**
 * Uses Turf to find the closest stop to a latitude / longitude (WGS84).
 */
export function findNearestStop(lat, lon) {
  const stops = getStops().filter((s) => {
    const la = parseFloat(s.stop_lat);
    const lo = parseFloat(s.stop_lon);
    return Number.isFinite(la) && Number.isFinite(lo);
  });
  if (!stops.length) return null;

  const features = stops.map((s) =>
    turfPoint([parseFloat(s.stop_lon), parseFloat(s.stop_lat)], { stop: s }),
  );
  const target = turfPoint([lon, lat]);
  const fc = featureCollection(features);
  const nearest = nearestPoint(target, fc);
  // Turf copies GeoJSON "properties"; we stored the full stop row under `stop`.
  return nearest.properties?.stop ?? null;
}

// ---------------------------------------------------------------------------
// Trip segment helpers
// ---------------------------------------------------------------------------

/**
 * Returns stop_times rows for a trip from fromStopId (inclusive) to toStopId (inclusive).
 * Uses sibling-aware family resolution so bus/train variants of the same station match.
 * @returns {object[]|null}
 */
function getTripSegmentRows(tripId, fromStopId, toStopId = null) {
  const rows = stopTimesByTripId.get(String(tripId));
  if (!rows || !rows.length) return null;

  const fromFamily = new Set([String(fromStopId), ...getStationSiblingIds(fromStopId)]);
  const fromIdx = rows.findIndex((r) => fromFamily.has(String(r.stop_id)));
  if (fromIdx === -1) return null;

  let toIdx = rows.length - 1;
  if (toStopId) {
    const toFamily = new Set([String(toStopId), ...getStationSiblingIds(toStopId)]);
    const foundToIdx = rows.findIndex((r, i) => i >= fromIdx && toFamily.has(String(r.stop_id)));
    if (foundToIdx !== -1) toIdx = foundToIdx;
  }

  if (toIdx < fromIdx) return null;
  return rows.slice(fromIdx, toIdx + 1);
}

/**
 * Trips departing from `fromStopId` that also serve `toStopId`.
 * - Uses sibling-aware stop family resolution for both from and to.
 * - Scans a larger origin departure pool than the returned result count so destination and mode
 *   filtering do not prematurely hide valid trips at mixed stations.
 * - Enriches each result with arrivalTimeAtTo, arrivalDateTime, durationMinutes, stopsCount.
 * - Returns up to `limit` results sorted by departure time.
 */
export function getTripsFromTo(fromStopId, toStopId = null, limit = 50, options = {}) {
  const { mode = null } = options;
  const departures = getDeparturesForStop(
    fromStopId,
    Math.max(limit, TRIP_SEARCH_SCAN_LIMIT),
    { allowRouteTimeCollapse: false, mode },
  );

  if (!toStopId) {
    return departures.slice(0, limit);
  }

  const toSid = String(toStopId);
  const toStopIds = new Set([toSid, ...getStationSiblingIds(toSid)]);

  const results = [];

  for (const dep of departures) {
    const tripRows = stopTimesByTripId.get(dep.trip_id);
    if (!tripRows) continue;

    const fromSeq = Number(dep.stop_sequence);

    // Find the destination row: must be at a higher sequence and allow drop-off.
    const toRow = tripRows.find((r) => {
      const seq = Number(r.stop_sequence);
      return (
        toStopIds.has(String(r.stop_id)) &&
        seq > fromSeq &&
        String(r.drop_off_type) !== '1'
      );
    });
    if (!toRow) continue;

    const arrivalTimeStr = (toRow.arrival_time || toRow.departure_time || '').trim();
    if (!arrivalTimeStr) continue;

    const arrivalDt = stopTimeToDateTimeToday(arrivalTimeStr);
    const departureDt = DateTime.fromISO(dep.scheduledDateTime);
    const durationMinutes = Math.round(arrivalDt.diff(departureDt, 'minutes').minutes);

    const toSeq = Number(toRow.stop_sequence);
    const stopsCount = tripRows.filter((r) => {
      const seq = Number(r.stop_sequence);
      return (
        seq > fromSeq &&
        seq <= toSeq &&
        String(r.pickup_type) !== '1' &&
        String(r.drop_off_type) !== '1'
      );
    }).length;

    results.push({
      ...dep,
      arrivalTimeAtTo: formatClockLabel(arrivalDt),
      arrivalDateTime: arrivalDt.toISO(),
      durationMinutes,
      stopsCount,
    });

    if (results.length >= limit) break;
  }

  return results;
}

/**
 * Date-aware variant of getTripsFromTo for a specific service date (YYYYMMDD).
 */
export function getTripsFromToForDate(fromStopId, toStopId = null, ymd, limit = 10, options = {}) {
  const { mode = null } = options;
  const departures = getDeparturesForDate(
    fromStopId,
    ymd,
    Math.max(limit, TRIP_SEARCH_SCAN_LIMIT),
    { allowRouteTimeCollapse: false, mode },
  );

  if (!toStopId) {
    return departures.slice(0, limit);
  }

  const toSid = String(toStopId);
  const toStopIds = new Set([toSid, ...getStationSiblingIds(toSid)]);

  const results = [];

  for (const dep of departures) {
    const tripRows = stopTimesByTripId.get(dep.trip_id);
    if (!tripRows) continue;

    const fromSeq = Number(dep.stop_sequence);

    const toRow = tripRows.find((r) => {
      const seq = Number(r.stop_sequence);
      return (
        toStopIds.has(String(r.stop_id)) &&
        seq > fromSeq &&
        String(r.drop_off_type) !== '1'
      );
    });
    if (!toRow) continue;

    const arrivalTimeStr = (toRow.arrival_time || toRow.departure_time || '').trim();
    if (!arrivalTimeStr) continue;

    const arrivalDt = stopTimeToDateTimeForDate(arrivalTimeStr, ymd);
    const departureDt = DateTime.fromISO(dep.scheduledDateTime);
    const durationMinutes = Math.round(arrivalDt.diff(departureDt, 'minutes').minutes);

    const toSeq = Number(toRow.stop_sequence);
    const stopsCount = tripRows.filter((r) => {
      const seq = Number(r.stop_sequence);
      return (
        seq > fromSeq &&
        seq <= toSeq &&
        String(r.pickup_type) !== '1' &&
        String(r.drop_off_type) !== '1'
      );
    }).length;

    results.push({
      ...dep,
      arrivalTimeAtTo: formatClockLabel(arrivalDt),
      arrivalDateTime: arrivalDt.toISO(),
      durationMinutes,
      stopsCount,
    });

    if (results.length >= limit) break;
  }

  return results;
}

/**
 * Returns the stop-by-stop timeline for a trip segment (fromStopId → toStopId).
 * Each item: { stop_id, stop_name, arrival_time_label, arrival_date_time, stop_sequence, isFrom, isTo }
 * Stop names are canonical (bus suffix stripped).
 */
export function getTripStops(tripId, fromStopId, toStopId = null) {
  const segmentRows = getTripSegmentRows(tripId, fromStopId, toStopId);
  if (!segmentRows || !segmentRows.length) return [];

  // Filter out pure pass-through rows (no boarding or alighting allowed).
  const stoppingRows = segmentRows.filter(
    (r) => !(String(r.pickup_type) === '1' && String(r.drop_off_type) === '1'),
  );
  if (!stoppingRows.length) return [];

  return stoppingRows.map((r, i) => {
    const sid = String(r.stop_id);
    const stopName = getCanonicalStopName(sid);
    const timeStr = (r.arrival_time || r.departure_time || '').trim();
    const dt = timeStr ? stopTimeToDateTimeToday(timeStr) : null;
    return {
      stop_id: sid,
      stop_name: stopName,
      arrival_time_label: dt ? dt.toFormat('h:mm a').toUpperCase() : '—',
      arrival_date_time: dt ? dt.toISO() : null,
      stop_sequence: r.stop_sequence,
      platformCode: getPlatformForTrip(tripId, sid) ?? null,
      isFrom: i === 0,
      isTo: i === stoppingRows.length - 1,
    };
  });
}

/**
 * Returns 'Express' if any stop in the segment is pass-through-only, otherwise 'All Stops'.
 */
export function getTripSegmentServicePattern(tripId, fromStopId, toStopId = null) {
  const segmentRows = getTripSegmentRows(tripId, fromStopId, toStopId);
  if (!segmentRows || !segmentRows.length) return 'All Stops';

  const hasPassThrough = segmentRows.some(
    (r) => String(r.pickup_type) === '1' && String(r.drop_off_type) === '1',
  );
  return hasPassThrough ? 'Express' : 'All Stops';
}
