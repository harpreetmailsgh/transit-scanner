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
const UPDATE_THROTTLE_MS = 30 * 1000;
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

/**
 * Whether Live Activities are currently enabled for the app, via the
 * patched native query (ExpoLiveActivityModule.areActivitiesEnabled).
 * Returns null when the answer is unavailable (non-iOS, or a build whose
 * native module predates the patched query) so callers can fall back to
 * the generic failure path instead of guessing.
 */
export async function isLaEnabled() {
  try {
    if (Platform.OS !== 'ios') return null;
    const fn = LiveActivity.areActivitiesEnabled;
    if (typeof fn !== 'function') return null;
    const value = fn();
    if (value === true) return true;
    if (value === false) return false;
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Activity dismissal detection: the library's onStateChange listener.
// Installed once (module lifetime) so a dismissal clears the stale live
// session even when no screen is subscribed; trip-detail subscribes for a
// re-render. Only 'dismissed'/'ended' for OUR activity id clear anything —
// 'active'/'pending'/'stale' never do. Our own stopActivity also ends the
// activity, but endCurrentActivity clears the session first (or in its
// finally), so a racing 'ended' event finds no session and is ignored.
// ---------------------------------------------------------------------------
let laListenerInstalled = false;
const laDismissalCallbacks = new Set();

async function onLaStateChange(event) {
  try {
    const state = event?.activityState;
    if (state !== 'dismissed' && state !== 'ended') return;
    const session = await readSession();
    if (!session || !session.activityId || session.activityId !== event?.activityID) return;
    await clearSession();
    resetTrackers();
    laDismissalCallbacks.forEach((cb) => {
      try {
        cb();
      } catch {
        // one bad callback must not block the rest
      }
    });
  } catch {
    // never throws
  }
}

function ensureLaListener() {
  if (laListenerInstalled || Platform.OS !== 'ios') return;
  try {
    const sub = LiveActivity.addActivityUpdatesListener((event) => {
      onLaStateChange(event);
    });
    if (sub) laListenerInstalled = true;
  } catch {
    // listener unavailable; dismissal is then picked up by re-derivation
  }
}

/**
 * Subscribes `callback` to dismissal of our own Live Activity (user swiped
 * the card away, or iOS ended it). The live session is already cleared
 * before callbacks run; the callback only needs to re-derive UI state.
 * The underlying native listener stays installed for the app lifetime —
 * removing a callback never uninstalls it, so session cleanup survives
 * unmount. Returns { remove }.
 */
export function subscribeToLaDismissal(callback) {
  ensureLaListener();
  if (typeof callback === 'function') laDismissalCallbacks.add(callback);
  return {
    remove: () => {
      laDismissalCallbacks.delete(callback);
    },
  };
}

// ---------------------------------------------------------------------------
// Change-detection trackers (module scope): updateActivity is throttled by
// iOS, so we only push when content actually changed, max once per 30s.
// ---------------------------------------------------------------------------
let lastNextStopId = null;
let lastEtaMs = null;
let lastDelaySec = null;
let lastScheduleOnly = null;
let lastProgress = null;
let lastEtaMinutes = null;
let lastUpdateMs = 0;

function resetTrackers() {
  lastNextStopId = null;
  lastEtaMs = null;
  lastDelaySec = null;
  lastScheduleOnly = null;
  lastProgress = null;
  lastEtaMinutes = null;
  lastUpdateMs = 0;
}

function initTrackers(state) {
  lastNextStopId = state.nextStopId;
  lastEtaMs = state.etaMs;
  lastDelaySec = state.delaySec;
  lastScheduleOnly = state.showScheduleOnly;
  lastProgress = state.progress;
  lastEtaMinutes = state.etaMs != null ? Math.round((state.etaMs - Date.now()) / 60000) : null;
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
  const stopCountProgress = arrived ? 1 : Math.min(1, Math.max(0, nextIndex / denom));

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
  // Time-interpolated progress: fraction of elapsed time between boarding
  // departure and destination arrival, clamped [0,1]. This moves smoothly
  // as the clock ticks instead of jumping only when a stop passes.
  // Pre-departure it is 0 (bar stays empty — correct, trip hasn't started).
  // Falls back to stop-count progress when either endpoint time is
  // missing (boarding time unknown, or no destination arrival time).
  const boardingMs = perStop[0].predictedMs;
  const timeProgress =
    Number.isFinite(boardingMs) && etaMs != null && etaMs > boardingMs
      ? Math.min(1, Math.max(0, (nowMs - boardingMs) / (etaMs - boardingMs)))
      : null;
  const progress = timeProgress ?? stopCountProgress;

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
/**
 * Formats the Lock Screen ETA line from a destination arrival epoch:
 * minutes remaining first (rounded), then the 12-hour arrival clock time
 * with NO am/pm suffix, e.g. "5 mins to arrival - 12:34". Pure and
 * exported for tests. Singular "min" at exactly 1 minute ("1 min to
 * arrival"), "mins" otherwise, so the line matches the approved mockup
 * format and reads correctly at 1 minute. Returns
 * null once the rounded minutes would go negative (ETA past) so the
 * caller omits the line instead of rendering "-1 mins to arrival"
 * (Harpreet's call, 2026-11-02).
 */
export function formatEtaLine(etaMs, nowMs) {
  const minutes = Math.round((etaMs - nowMs) / 60000);
  if (minutes < 0) return null;
  const d = new Date(etaMs);
  const hour12 = d.getHours() % 12 || 12;
  const minute = String(d.getMinutes()).padStart(2, '0');
  const unit = minutes === 1 ? 'min' : 'mins';
  return `${minutes} ${unit} to arrival - ${hour12}:${minute}`;
}

export function mapContent(state, lineName, destinationName, nowMs = Date.now()) {
  const dest = destinationName || state.destinationName || 'Destination';
  const line = lineName || 'GO';
  const title = `${line} → ${dest}`;
  let subtitle;
  if (state.nextStop) {
    const stopsWord = state.stopsRemaining === 1 ? 'stop' : 'stops';
    const remainingText = state.stopsRemaining === 0 ? 'final stop' : `${state.stopsRemaining} ${stopsWord}`;
    subtitle = `Next: ${state.nextStopName} • ${remainingText}`;
  } else {
    subtitle = `→ ${dest}`;
  }
  // ETA line + island countdown only while an arrival time exists and the
  // trip has not arrived; otherwise the card falls back to today's layout
  // (title + subtitle + progress bar, no ETA line, no timer date).
  // The ETA line additionally drops out once the ETA is past (rounded
  // minutes < 0); the island countdown keeps running to 0:00 in that
  // state, since the timer date is unchanged.
  // progressBar carries BOTH date and progress: date drives the Dynamic
  // Island countdown, progress keeps the Lock Screen bar (the patched
  // template renders progress whenever it is present, even with a date
  // set). progressViewTint (in activityConfig) makes the bar white.
  const hasEta = state.etaMs != null && !state.arrived;
  const etaLine = hasEta ? formatEtaLine(state.etaMs, nowMs) : null;
  return {
    title,
    subtitle,
    ...(etaLine != null ? { etaLine } : {}),
    progressBar: {
      ...(hasEta ? { date: state.etaMs } : {}),
      progress: state.progress,
    },
  };
}

function activityConfig(deepLinkUrl) {
  return {
    backgroundColor: GO_GREEN,
    titleColor: WHITE,
    subtitleColor: WHITE,
    progressViewTint: WHITE,
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

    const content = mapContent(state, line, dest, Date.now());
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
    // From here on, a dismissal of this activity (swipe-away / iOS end)
    // must clear the stale live session even if no screen is mounted.
    ensureLaListener();

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
 * when content changed (next stop / ETA ±60s / delay / stale flag /
 * progress ±0.01 / rounded ETA minutes) and at most once per 30s. Ends the
 * activity on arrival or backstop. Never throws.
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
    // Rounded ETA minutes: the Lock Screen ETA line shows rounded minutes,
    // so a minute tick changes visible content even when absolute etaMs is
    // unchanged (the old absolute-only gate froze the line as the clock
    // ticked). Compared against the last pushed value, so a throttled push
    // retries on the next tick rather than being swallowed.
    const etaMinutes = state.etaMs != null ? Math.round((state.etaMs - nowMs) / 60000) : null;
    const etaMinutesChanged = etaMinutes !== lastEtaMinutes;
    const progressChanged =
      lastProgress == null || Math.abs(state.progress - lastProgress) >= 0.01;
    const changed =
      state.nextStopId !== lastNextStopId ||
      etaChanged ||
      etaMinutesChanged ||
      progressChanged ||
      state.delaySec !== lastDelaySec ||
      state.showScheduleOnly !== lastScheduleOnly;

    if (!changed) return { refreshed: false, reason: 'unchanged' };
    if (nowMs - lastUpdateMs < UPDATE_THROTTLE_MS) return { refreshed: false, reason: 'throttled' };

    const content = mapContent(state, session.lineName, session.destinationName, nowMs);
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
    lastProgress = state.progress;
    lastEtaMinutes = etaMinutes;
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
