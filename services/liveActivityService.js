/**
 * Live Activity service for Transit Scanner v1.2.
 *
 * Drives the iOS Lock Screen / Dynamic Island card for a tracked trip.
 * Display state is 100% GTFS-RT driven (trip updates + vehicle positions);
 * the phone's GPS is never used for display.
 *
 * Session persistence: active-live-activity-v1.json in documentDirectory.
 * Single-activity invariant: starting a second trip ends the first.
 * Every public entry point is try/catch-guarded and never throws.
 */

import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as LiveActivity from 'expo-live-activity';

import { getTripStops } from './gtfsService';
import {
  getDelayForStop,
  getRealtimeLastUpdatedMs,
  getVehiclePositions,
} from './gtfsRealtimeService';

const SESSION_FILE_NAME = 'active-live-activity-v1.json';
const STALE_FEED_MS = 5 * 60 * 1000;
const UPDATE_THROTTLE_MS = 60 * 1000;
const ETA_CHANGE_THRESHOLD_MS = 60 * 1000;
const VANISH_BACKSTOP_MS = 20 * 60 * 1000;
const GO_GREEN = '#00853F';
const WHITE = '#FFFFFF';
const MIN_IOS_MAJOR = 16;
const MIN_IOS_MINOR = 2;

function sessionFileUri() {
  const dir = FileSystem.documentDirectory || '';
  if (!dir) return null;
  return `${dir}${SESSION_FILE_NAME}`;
}

async function readSession() {
  try {
    const uri = sessionFileUri();
    if (!uri) return null;
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists) return null;
    const raw = await FileSystem.readAsStringAsync(uri);
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.tripId) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeSession(session) {
  const uri = sessionFileUri();
  if (!uri) throw new Error('No document directory');
  await FileSystem.writeAsStringAsync(uri, JSON.stringify(session));
}

async function clearSession() {
  try {
    const uri = sessionFileUri();
    if (uri) await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch {
    // best effort
  }
}

// ---------------------------------------------------------------------------
// Change-detection trackers (module scope): updateActivity is throttled by
// iOS, so we only push when content actually changed, max once per 60s.
// ---------------------------------------------------------------------------
let lastNextStopId = null;
let lastEtaMs = null;
let lastDelaySec = null;
let lastScheduleOnly = null;
let lastUpdateMs = 0;

function resetTrackers() {
  lastNextStopId = null;
  lastEtaMs = null;
  lastDelaySec = null;
  lastScheduleOnly = null;
  lastUpdateMs = 0;
}

function initTrackers(state) {
  lastNextStopId = state.nextStopId;
  lastEtaMs = state.etaMs;
  lastDelaySec = state.delaySec;
  lastScheduleOnly = state.showScheduleOnly;
  lastUpdateMs = Date.now();
}

function isiOSVersionSupported() {
  try {
    if (Platform.OS !== 'ios') return false;
    const m = /^(\d+)(?:\.(\d+))?/.exec(String(Platform.Version || ''));
    if (!m) return true; // unknown version string: let the native call decide
    const major = parseInt(m[1], 10);
    const minor = parseInt(m[2] || '0', 10);
    return major > MIN_IOS_MAJOR || (major === MIN_IOS_MAJOR && minor >= MIN_IOS_MINOR);
  } catch {
    return true;
  }
}

/**
 * Builds the full deep link to a trip's detail screen. Single construction
 * point for that URL: the notification flow uses the full URL as-is; the
 * Live Activity card passes its path form (see startForTrip) because the
 * widget template prepends the app scheme itself. The optional
 * departureTime / scheduledDateTime params append only when provided.
 */
export function buildTripDetailUrl({ tripId, fromStopId, toStopId, lineName, departureTime, scheduledDateTime }) {
  const parts = [
    `tripId=${encodeURIComponent(tripId)}`,
    `fromStopId=${encodeURIComponent(fromStopId)}`,
    `toStopId=${encodeURIComponent(toStopId || '')}`,
    `lineName=${encodeURIComponent(lineName || '')}`,
  ];
  if (departureTime) parts.push(`departureTime=${encodeURIComponent(departureTime)}`);
  if (scheduledDateTime) parts.push(`scheduledDateTime=${encodeURIComponent(scheduledDateTime)}`);
  return `transitscanner:///trip-detail?${parts.join('&')}`;
}

// ---------------------------------------------------------------------------
// Trip state computation — pure (no side effects), testable via deps.
// ---------------------------------------------------------------------------
/**
 * Computes the display state for a tracked trip from GTFS-RT data.
 *
 * @param {string} tripId
 * @param {string} fromStopId
 * @param {string|null} toStopId
 * @param {object} [deps] injectable for tests: {getStops, getDelaySec,
 *   getVehicles, lastUpdatedMs, nowMs}
 */
export function computeTripState(tripId, fromStopId, toStopId, deps = {}) {
  const {
    getStops = (t, f, to) => getTripStops(t, f, to),
    getDelaySec = (t, s) => getDelayForStop(t, s),
    getVehicles = () => getVehiclePositions(),
    lastUpdatedMs = getRealtimeLastUpdatedMs(),
    nowMs = Date.now(),
  } = deps;

  const staleFeed = !lastUpdatedMs || nowMs - lastUpdatedMs > STALE_FEED_MS;

  let stops = [];
  try {
    stops = getStops(tripId, fromStopId, toStopId) || [];
  } catch {
    stops = [];
  }

  if (!stops.length) {
    return {
      ok: false,
      reason: 'no-stops',
      tripId: String(tripId),
      stops: [],
      staleFeed,
      showScheduleOnly: true,
      arrived: false,
      pastBackstop: false,
    };
  }

  let vehicles = [];
  try {
    vehicles = getVehicles() || [];
  } catch {
    vehicles = [];
  }
  const vehicleSeen = vehicles.some((v) => String(v && v.trip_id) === String(tripId));

  const perStop = stops.map((s) => {
    const schedMs = s.arrival_date_time ? Date.parse(s.arrival_date_time) : NaN;
    let delaySec = null;
    try {
      const d = getDelaySec(tripId, s.stop_id);
      if (typeof d === 'number' && Number.isFinite(d)) delaySec = d;
    } catch {
      delaySec = null;
    }
    // Missing schedule time => treat as infinitely future: never mark a trip
    // arrived on the basis of missing data.
    const predictedMs = Number.isFinite(schedMs) ? schedMs + (delaySec ?? 0) * 1000 : Number.POSITIVE_INFINITY;
    return { stop: s, schedMs, delaySec, predictedMs };
  });

  const hasLiveData = perStop.some((p) => p.delaySec !== null) || vehicleSeen;
  const showScheduleOnly = staleFeed || !hasLiveData;

  let nextIndex = perStop.findIndex((p) => p.predictedMs > nowMs);
  if (nextIndex === -1) nextIndex = stops.length; // every stop is in the past
  const arrived = nextIndex >= stops.length;

  const nextStop = arrived ? null : perStop[nextIndex].stop;
  const stopsRemaining = Math.max(0, stops.length - 1 - nextIndex);
  const denom = Math.max(1, stops.length - 1);
  const progress = arrived ? 1 : Math.min(1, Math.max(0, nextIndex / denom));

  const destStop = stops[stops.length - 1];
  const destSchedMs = destStop.arrival_date_time ? Date.parse(destStop.arrival_date_time) : NaN;
  let destDelaySec = null;
  try {
    const d = getDelaySec(tripId, destStop.stop_id);
    if (typeof d === 'number' && Number.isFinite(d)) destDelaySec = d;
  } catch {
    destDelaySec = null;
  }
  const etaMs = Number.isFinite(destSchedMs) ? destSchedMs + (destDelaySec ?? 0) * 1000 : null;
  const pastBackstop = Number.isFinite(destSchedMs) && nowMs > destSchedMs + VANISH_BACKSTOP_MS;

  return {
    ok: true,
    tripId: String(tripId),
    stops,
    staleFeed,
    showScheduleOnly,
    vehicleSeen,
    nextIndex,
    nextStop,
    nextStopId: nextStop ? String(nextStop.stop_id) : null,
    nextStopName: nextStop ? nextStop.stop_name : null,
    stopsRemaining,
    progress,
    etaMs,
    delaySec: destDelaySec,
    arrived,
    pastBackstop,
    destinationName: destStop.stop_name || 'Destination',
  };
}

// ---------------------------------------------------------------------------
// Content mapping: trip state -> expo-live-activity template
// ---------------------------------------------------------------------------
function mapContent(state, lineName, destinationName) {
  const dest = destinationName || state.destinationName || 'Destination';
  const line = lineName || 'GO';
  const title = `${line} → ${dest}`;
  let subtitle;
  if (state.nextStop) {
    const stopsWord = state.stopsRemaining === 1 ? 'stop' : 'stops';
    const remainingText = state.stopsRemaining === 0 ? 'final stop' : `${state.stopsRemaining} ${stopsWord}`;
    subtitle = `Next: ${state.nextStopName} • ${remainingText}`;
    if (state.showScheduleOnly) subtitle += ' • schedule shown';
  } else {
    subtitle = `→ ${dest}`;
  }
  return {
    title,
    subtitle,
    progressBar: { progress: state.progress },
  };
}

function activityConfig(deepLinkUrl) {
  return {
    backgroundColor: GO_GREEN,
    titleColor: WHITE,
    subtitleColor: WHITE,
    timerType: 'digital',
    deepLinkUrl,
  };
}

async function endCurrentActivity(reason) {
  const session = await readSession();
  if (!session || !session.activityId) {
    await clearSession();
    resetTrackers();
    return { ended: false };
  }
  const title = `${session.lineName || 'GO'} → ${session.destinationName || 'Destination'}`;
  const subtitle =
    reason === 'arrived' ? `Arrived at ${session.destinationName || 'destination'}` : 'Trip tracking stopped';
  try {
    try {
      LiveActivity.stopActivity(session.activityId, { title, subtitle });
    } catch {
      // native side may already be gone; session cleanup still applies
    }
  } finally {
    await clearSession();
    resetTrackers();
  }
  return { ended: true };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Starts a Live Activity for a trip. Never throws.
 * Optional overrides (lineName, destinationName) let callers pass what the
 * UI already knows; otherwise derived from static GTFS data.
 * departureLabel (the departure-time label the UI displays) is stored on
 * the session; departureTime / scheduledDateTime only enrich the card's
 * tap deep link.
 */
export async function startForTrip({
  tripId,
  fromStopId,
  toStopId,
  lineName,
  destinationName,
  departureLabel,
  departureTime,
  scheduledDateTime,
} = {}) {
  try {
    if (!tripId || !fromStopId) return { started: false, reason: 'missing-trip' };
    if (Platform.OS !== 'ios') return { started: false, reason: 'unsupported-platform' };
    if (!isiOSVersionSupported()) return { started: false, reason: 'ios-version' };

    // Single-activity invariant: a new trip replaces any active one.
    await endCurrentActivity('replaced');

    const state = computeTripState(tripId, fromStopId, toStopId || null);
    if (!state.ok) return { started: false, reason: state.reason };
    if (state.arrived) return { started: false, reason: 'already-arrived' };
    if (state.pastBackstop) return { started: false, reason: 'trip-ended' };

    const line = lineName || 'GO';
    const dest = destinationName || state.destinationName;

    const session = {
      tripId: String(tripId),
      fromStopId: String(fromStopId),
      toStopId: toStopId ? String(toStopId) : null,
      lineName: line,
      destinationName: dest,
      departureLabel: departureLabel || null,
      activityId: null,
      startedAtMs: Date.now(),
    };
    await writeSession(session);

    const content = mapContent(state, line, dest);
    // The widget template prepends the app scheme to deepLinkUrl, so the
    // card carries the path form only; scheme + path stays byte-identical
    // to buildTripDetailUrl's full form.
    const deepLinkUrl = buildTripDetailUrl({
      tripId,
      fromStopId,
      toStopId,
      lineName,
      departureTime,
      scheduledDateTime,
    }).replace(/^transitscanner:\/\//, '');
    let activityId = null;
    try {
      activityId = LiveActivity.startActivity(content, activityConfig(deepLinkUrl));
    } catch {
      activityId = null;
    }
    if (!activityId || typeof activityId !== 'string') {
      await clearSession();
      return { started: false, reason: 'start-failed' };
    }

    session.activityId = activityId;
    await writeSession(session);
    initTrackers(state);

    return { started: true, activityId };
  } catch {
    try {
      await clearSession();
    } catch {
      // ignore
    }
    resetTrackers();
    return { started: false, reason: 'error' };
  }
}

/** Stops the active Live Activity, if any. Never throws. */
export async function stopTracking() {
  try {
    const res = await endCurrentActivity('stopped');
    return { stopped: res.ended };
  } catch {
    return { stopped: false };
  }
}

/** Returns the persisted live-activity session, or null. Never throws. */
export async function getActiveLiveSession() {
  return readSession();
}

/**
 * Recomputes trip state from the feed and pushes to the Live Activity only
 * when content changed (next stop / ETA ±60s / delay / stale flag) and at
 * most once per 60s. Ends the activity on arrival or backstop. Never throws.
 */
export async function refreshFromFeed() {
  try {
    const session = await readSession();
    if (!session || !session.activityId) return { refreshed: false, reason: 'no-session' };

    const state = computeTripState(session.tripId, session.fromStopId, session.toStopId);
    if (!state.ok) return { refreshed: false, reason: state.reason };

    if (state.arrived) {
      await endCurrentActivity('arrived');
      return { refreshed: true, ended: 'arrived' };
    }
    if (state.pastBackstop) {
      await endCurrentActivity('ended');
      return { refreshed: true, ended: 'backstop' };
    }

    const nowMs = Date.now();
    const etaChanged =
      (state.etaMs == null) !== (lastEtaMs == null) ||
      (state.etaMs != null && lastEtaMs != null && Math.abs(state.etaMs - lastEtaMs) >= ETA_CHANGE_THRESHOLD_MS);
    const changed =
      state.nextStopId !== lastNextStopId ||
      etaChanged ||
      state.delaySec !== lastDelaySec ||
      state.showScheduleOnly !== lastScheduleOnly;

    if (!changed) return { refreshed: false, reason: 'unchanged' };
    if (nowMs - lastUpdateMs < UPDATE_THROTTLE_MS) return { refreshed: false, reason: 'throttled' };

    const content = mapContent(state, session.lineName, session.destinationName);
    try {
      LiveActivity.updateActivity(session.activityId, content);
    } catch {
      return { refreshed: false, reason: 'update-failed' };
    }

    lastUpdateMs = nowMs;
    lastNextStopId = state.nextStopId;
    lastEtaMs = state.etaMs;
    lastDelaySec = state.delaySec;
    lastScheduleOnly = state.showScheduleOnly;
    return { refreshed: true };
  } catch {
    return { refreshed: false, reason: 'error' };
  }
}

/**
 * Launch reconcile: ends orphaned activities (the JS handle is lost across
 * restarts) and restarts a fresh one if the persisted trip is still active.
 * Never throws.
 */
export async function reconcileOnLaunch() {
  try {
    const session = await readSession();
    if (!session || !session.tripId) return { reconciled: false };

    const state = computeTripState(session.tripId, session.fromStopId, session.toStopId);
    const done = !state.ok || state.arrived || state.pastBackstop;

    if (done) {
      if (session.activityId) {
        const subtitle =
          state.ok && state.arrived
            ? `Arrived at ${session.destinationName || 'destination'}`
            : 'Trip tracking stopped';
        try {
          LiveActivity.stopActivity(session.activityId, {
            title: `${session.lineName || 'GO'} → ${session.destinationName || 'Destination'}`,
            subtitle,
          });
        } catch {
          // orphan may already be gone
        }
      }
      await clearSession();
      resetTrackers();
      return { reconciled: true, action: 'ended' };
    }

    // Trip still active: end the orphaned native activity (best effort) and
    // start a fresh one with a new handle.
    if (session.activityId) {
      try {
        LiveActivity.stopActivity(session.activityId, {
          title: `${session.lineName || 'GO'} → ${session.destinationName || 'Destination'}`,
          subtitle: 'Trip tracking stopped',
        });
      } catch {
        // orphan may already be gone
      }
    }
    await clearSession();
    resetTrackers();
    const res = await startForTrip({
      tripId: session.tripId,
      fromStopId: session.fromStopId,
      toStopId: session.toStopId,
      lineName: session.lineName,
      destinationName: session.destinationName,
      departureLabel: session.departureLabel || null,
    });
    return {
      reconciled: true,
      action: res.started ? 'restarted' : 'failed',
      reason: res.reason,
    };
  } catch {
    return { reconciled: false, reason: 'error' };
  }
}
