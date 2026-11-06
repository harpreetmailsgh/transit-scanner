
// Returns an array of tripIds that have at least one live stop update
export function getTripIdsWithLiveUpdates() {
  const ids = new Set();
  for (const key of stopDelaySeconds.keys()) {
    const [tripId] = key.split(':');
    if (tripId) ids.add(tripId);
  }
  return Array.from(ids);
}
/**
 * GO Transit GTFS-RT (real-time) feeds
 * ---------------------------------
 * These endpoints return **binary Protocol Buffer** data — not JSON.
 * We decode them with the official `gtfs-realtime-bindings` package (same
 * structure Google uses for GTFS-RT).
 *
 * Feeds are polled every 30 seconds while the app is running.
 */

import { DateTime } from 'luxon';
import GtfsRoot from 'gtfs-realtime-bindings';

import {
  getDeparturesForStop,
  getPlatformForTrip,
} from './gtfsService';

const FeedMessage = GtfsRoot.transit_realtime.FeedMessage;

const TRIP_UPDATES_URL =
  'https://api.gotrains.ca/gtfsrt/v2/GO/GTFSRt/TripUpdates';
const VEHICLE_POSITIONS_URL =
  'https://api.gotrains.ca/gtfsrt/v2/GO/GTFSRt/VehiclePosition';

/** @type {Map<string, number>} "tripId:stopId" → per-stop delay in seconds */
const stopDelaySeconds = new Map();

/** @type {Map<string, number>} tripId → trip-level delay in seconds (fallback) */
const tripFallbackDelay = new Map();

/** @type {Map<string, string>} "tripId:stopId" → platform_code from GTFS-RT */
const realtimePlatforms = new Map();

/** @type {object[]} last decoded vehicle entities */
let vehicleSnapshots = [];


/** @type {number|null} last successful realtime refresh timestamp (ms epoch) */
let realtimeLastUpdatedMs = null;

/** @type {number|null} last refresh attempt start timestamp (ms epoch) */
let realtimeLastAttemptMs = null;

/** @type {string|null} most recent feed failure message (cleared by a fully successful refresh) */
let realtimeLastError = null;

/** @type {number} consecutive fully-failed refresh attempts (reset on any success) */
let realtimeConsecutiveFailures = 0;

/** @type {Promise<void>|null} in-flight refresh, shared by overlapping callers */
let refreshInFlight = null;

/** @type {Set<Function>} diagnostics subscribers, notified once per settled refresh */
const diagnosticsListeners = new Set();

function notifyDiagnosticsListeners() {
  for (const listener of [...diagnosticsListeners]) {
    try {
      listener();
    } catch {
      // A broken subscriber must never break the poll loop.
    }
  }
}

let pollTimer = null;
let pollGeneration = 0;

// ---------------------------------------------------------------------------
// Protobuf decode helper
// ---------------------------------------------------------------------------

function decodeFeed(buffer) {
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer;
  return FeedMessage.decode(bytes);
}

/**
 * GTFS-RT "TranslatedString" holds one or more language / text pairs.
 * We grab the first text blob for simplicity.
 */
function readTranslatedField(field) {
  if (!field) return '';
  const list = field.translation;
  if (list && list.length) {
    return list[0].text || '';
  }
  return '';
}

// ---------------------------------------------------------------------------
// Ingest each feed type
// ---------------------------------------------------------------------------

function ingestTripUpdates(feed) {
  // Build into temporary maps first and only swap them in once the whole
  // feed has been read without an error. Clearing the live maps first
  // would wipe the last good data if a later entry in the same feed
  // turned out to be malformed — a failed feed must leave prior data
  // untouched, exactly like a failed fetch. (A successful feed with zero
  // entries still swaps in empty maps: no live trips is real information,
  // not a failure.)
  const nextStopDelays = new Map();
  const nextFallbackDelays = new Map();
  const nextPlatforms = new Map();
  const entities = feed.entity || [];
  for (const ent of entities) {
    // Protobuf JS uses camelCase (tripUpdate, tripId, stopTimeUpdate, …)
    const tu = ent.tripUpdate;
    if (!tu || !tu.trip || !tu.trip.tripId) continue;
    const tripId = String(tu.trip.tripId);

    // Keep a trip-wide fallback delay in case stop-level IDs are missing.
    let fallbackDelaySec =
      tu.delay !== undefined && tu.delay !== null ? Number(tu.delay) : null;

    const stus = tu.stopTimeUpdate || [];
    for (const stu of stus) {
      let stopDelaySec = null;
      if (stu.departure?.delay !== undefined && stu.departure?.delay !== null) {
        stopDelaySec = stu.departure.delay;
      } else if (stu.arrival?.delay !== undefined && stu.arrival?.delay !== null) {
        stopDelaySec = stu.arrival.delay;
      } else if (tu.delay !== undefined && tu.delay !== null) {
        stopDelaySec = tu.delay;
      }

      if (fallbackDelaySec === null && stopDelaySec !== null) {
        fallbackDelaySec = Number(stopDelaySec);
      }

      // Store per-stop delay keyed by tripId:stopId
      if (stu.stopId) {
        const stopId = String(stu.stopId);
        if (stopDelaySec !== null) {
          nextStopDelays.set(`${tripId}:${stopId}`, Number(stopDelaySec));
        }
      }
      // Extract platform_code — GTFS-RT spec allows it on StopTimeUpdate
      const pc = stu.platformCode || stu.platform_code;
      if (pc && String(pc).trim() && stu.stopId) {
        nextPlatforms.set(`${tripId}:${String(stu.stopId)}`, String(pc).trim());
      }
    }

    if (fallbackDelaySec !== null) {
      nextFallbackDelays.set(tripId, fallbackDelaySec);
    }
  }
  // Whole feed read cleanly — only now replace the live data.
  stopDelaySeconds.clear();
  tripFallbackDelay.clear();
  realtimePlatforms.clear();
  for (const [key, value] of nextStopDelays) stopDelaySeconds.set(key, value);
  for (const [key, value] of nextFallbackDelays) tripFallbackDelay.set(key, value);
  for (const [key, value] of nextPlatforms) realtimePlatforms.set(key, value);
}

function ingestVehiclePositions(feed) {
  const out = [];
  const entities = feed.entity || [];
  for (const ent of entities) {
    const v = ent.vehicle;
    if (!v || !v.position) continue;
    const lat = v.position.latitude;
    const lon = v.position.longitude;
    if (lat === undefined || lon === undefined) continue;
    out.push({
      id: ent.id ? String(ent.id) : undefined,
      trip_id: v.trip && v.trip.tripId ? String(v.trip.tripId) : null,
      route_id: v.trip && v.trip.routeId ? String(v.trip.routeId) : null,
      latitude: lat,
      longitude: lon,
      bearing: v.position.bearing !== undefined ? v.position.bearing : null,
      speed: v.position.speed !== undefined ? v.position.speed : null,
      timestamp: v.timestamp ? Number(v.timestamp) : null,
    });
  }
  vehicleSnapshots = out;
}


// ---------------------------------------------------------------------------
// Network fetch
// ---------------------------------------------------------------------------

/**
 * A hung feed must never outlive the 30s poll interval: with no timeout a
 * dead fetch stalls every later poll behind it (and, before the in-flight
 * guard below, overlapping runs raced last-writer-wins). 20s leaves room
 * for a slow cellular fetch while guaranteeing each poll cycle settles
 * inside its interval. The AbortController is best-effort — if the runtime
 * ignores the signal, the timeout race below still rejects locally and
 * the attempt's late result is discarded by the in-flight guard, so
 * correctness never depends on the abort actually cancelling the fetch.
 */
const REALTIME_FETCH_TIMEOUT_MS = 20000;

async function fetchProtobuf(url) {
  const controller =
    typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timeoutId = null;
  try {
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        try {
          controller?.abort();
        } catch {
          // Abort is best-effort; the timeout rejection below is what matters.
        }
        reject(
          new Error(
            `GTFS-RT ${url} timed out after ${REALTIME_FETCH_TIMEOUT_MS / 1000}s`,
          ),
        );
      }, REALTIME_FETCH_TIMEOUT_MS);
    });
    const fetchPromise = (async () => {
      const res = await fetch(
        url,
        controller ? { signal: controller.signal } : undefined,
      );
      if (!res.ok) {
        throw new Error(`GTFS-RT ${url} failed: HTTP ${res.status}`);
      }
      return res.arrayBuffer();
    })();
    return await Promise.race([fetchPromise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/**
 * Decodes and ingests one feed result. Returns a failure message, or null
 * on success. Decode runs BEFORE ingest, and ingest itself builds into
 * temporary maps and only swaps them in on full success — so a corrupt
 * payload (or a malformed entry mid-feed) can never clear the previous
 * good snapshot. A failed feed leaves prior data untouched, exactly like
 * a failed fetch.
 */
function ingestFeedResult(result, label, ingest) {
  if (result.status !== 'fulfilled') {
    const reason = result.reason;
    const detail = reason instanceof Error ? reason.message : String(reason);
    return `${label} failed: ${detail}`;
  }
  try {
    ingest(decodeFeed(result.value));
    return null;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return `${label} decode failed: ${detail}`;
  }
}

async function refreshAllFeeds() {
  // In-flight guard: overlapping callers (interval tick firing while a
  // previous poll is still running) share one attempt instead of racing.
  // Only the originating caller settles the guard and notifies listeners.
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    realtimeLastAttemptMs = Date.now();

    const [tripRes, vehRes] = await Promise.allSettled([
      fetchProtobuf(TRIP_UPDATES_URL),
      fetchProtobuf(VEHICLE_POSITIONS_URL),
    ]);

    // Per-feed handling: one bad feed must not kill the other, and a
    // failed feed must not clear the previous snapshot.
    const failures = [];
    const tripFailure = ingestFeedResult(tripRes, 'TripUpdates', ingestTripUpdates);
    if (tripFailure) failures.push(tripFailure);
    const vehFailure = ingestFeedResult(vehRes, 'VehiclePositions', ingestVehiclePositions);
    if (vehFailure) failures.push(vehFailure);

    if (failures.length > 0) {
      realtimeLastError = failures.join(' | ').slice(0, 200);
    } else {
      realtimeLastError = null;
    }

    if (tripFailure && vehFailure) {
      realtimeConsecutiveFailures += 1;
      throw new Error('All GTFS-RT feeds failed to refresh.');
    }

    realtimeLastUpdatedMs = Date.now();
    realtimeConsecutiveFailures = 0;
  })();

  try {
    await refreshInFlight;
  } finally {
    refreshInFlight = null;
    notifyDiagnosticsListeners();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns delay in seconds for a specific trip+stop, or `undefined` if unknown.
 * Falls back to the trip-level delay if no per-stop entry is available.
 */
export function getDelayForStop(tripId, stopId) {
  const perStop = stopDelaySeconds.get(`${String(tripId)}:${String(stopId)}`);
  if (perStop !== undefined) return perStop;
  return tripFallbackDelay.get(String(tripId));
}

/**
 * Returns delay for a trip in **whole minutes** (rounded), or `null` if unknown.
 */
export function getLiveDelay(tripId) {
  const sec = tripFallbackDelay.get(String(tripId));
  if (sec === undefined) return null;
  return Math.round(sec / 60);
}

export function getVehiclePositions() {
  return [...vehicleSnapshots];
}


export function getRealtimeLastUpdatedMs() {
  return realtimeLastUpdatedMs;
}

/**
 * Snapshot for diagnosis (splash share-log and the departures footer):
 * last successful refresh, last attempt, last failure message, consecutive
 * full failures, and how many trips currently carry live data. A count of
 * 0 with a failure message means the feed itself is down; a large count
 * while one trip still shows schedule-only points at matching, not the feed.
 */
export function getRealtimeDiagnostics() {
  return {
    lastUpdatedMs: realtimeLastUpdatedMs,
    lastAttemptMs: realtimeLastAttemptMs,
    lastError: realtimeLastError,
    consecutiveFailures: realtimeConsecutiveFailures,
    tripsWithLiveData: getTripIdsWithLiveUpdates().length,
    vehiclesSeen: vehicleSnapshots.length,
  };
}

/**
 * Subscribe to settled refreshes (success or failure). Returns an
 * unsubscribe function. Notifications are settle-only — never during
 * render — so subscribers can recompute lists without render loops, and
 * no extra network calls are made: the existing 30s poll is the only fetch.
 */
export function subscribeRealtimeDiagnostics(listener) {
  if (typeof listener !== 'function') return () => {};
  diagnosticsListeners.add(listener);
  return () => {
    diagnosticsListeners.delete(listener);
  };
}

/**
 * Static departures for the stop, merged with live delay seconds when we have them.
 * `liveDateTime` / `liveTimeLabel` reflect schedule + delay (Toronto local clock).
 */
export function getLiveDepartures(stopId, limit = 10, options = {}) {
  const { mode = null } = options;
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 10;
  const staticDeps = getDeparturesForStop(stopId, safeLimit, { mode });
  const now = DateTime.now().setZone('America/Toronto');
  const merged = staticDeps.map((row) => {
    const tid = String(row.trip_id);
    const delaySec = getDelayForStop(tid, String(row._actual_stop_id));

    let liveDt = DateTime.fromISO(row.scheduledDateTime);
    if (delaySec !== undefined) {
      liveDt = liveDt.plus({ seconds: delaySec });
    }

    return {
      ...row,
      delayMinutes:
        delaySec !== undefined ? Math.round(delaySec / 60) : null,
      liveDateTime: liveDt.toISO(),
      liveTimeLabel: liveDt.toFormat('h:mm a').toUpperCase(),
      platformCode:
        realtimePlatforms.get(`${tid}:${stopId}`) ||
        row.platformCode ||
        getPlatformForTrip(tid, stopId) ||
        null,
    };
  });

  merged.sort(
    (a, b) =>
      DateTime.fromISO(a.liveDateTime).toMillis() -
      DateTime.fromISO(b.liveDateTime).toMillis(),
  );

  return merged.filter((row) => DateTime.fromISO(row.liveDateTime) >= now).slice(0, safeLimit);
}

/**
 * Starts the 30-second polling loop. Safe to call once after static GTFS loads.
 * Overlapping ticks share one in-flight refresh (see refreshAllFeeds), and
 * each fetch carries its own 20s timeout, so a hung feed cannot stall the loop.
 */
export function startRealtimeUpdates() {
  stopRealtimeUpdates();
  const gen = ++pollGeneration;

  const run = async () => {
    if (gen !== pollGeneration) return;
    try {
      await refreshAllFeeds();
    } catch {
      // Keep previous snapshot on failure — trains may still be partially shown.
    }
  };

  run();
  pollTimer = setInterval(run, 30000);
}

/**
 * Stops polling (e.g. when the root component unmounts).
 */
export function stopRealtimeUpdates() {
  pollGeneration += 1;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
