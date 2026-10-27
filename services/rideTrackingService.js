/**
 * Get-off alert service for Transit Scanner v1.2 (feed-driven engine, v2).
 *
 * Progression comes from the GTFS-RT feed — the exact same computeTripState
 * the Live Activity card displays (services/liveActivityService.js) — so the
 * card and the get-off alert can never disagree. The phone's GPS is never
 * read for progression or gating: the user's tap on "Track this Trip" is
 * the check (a tapped-but-never-boarded trip costs one stray buzz —
 * accepted). GPS only wakes the app: the background location task and the
 * foreground watcher are wake drivers whose ticks re-evaluate the feed.
 *
 * Session persistence: active-ride-v1.json in documentDirectory (same file
 * as the retired GPS engine; sessions without engineVersion: 2 are legacy
 * and are ended silently on load — never guessed at).
 *
 * Every public entry point never throws (UI-8): permission outcomes are
 * reported as AlertState values, not errors.
 */

import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';

function debugLog(...args) {
  if (typeof __DEV__ !== 'undefined' && !__DEV__) return;
  try {
    // eslint-disable-next-line no-console
    console.log('[TransitScanner DEBUG]', ...args);
  } catch {}
}

import {
  computeTripState,
  getActiveLiveSession,
  refreshFromFeed as refreshLiveActivityFromFeed,
} from './liveActivityService';

const RIDE_SESSION_FILE = `${FileSystem.documentDirectory}active-ride-v1.json`;
const LOCATION_TASK_NAME = 'transitscanner-active-ride-location-task';
const ENGINE_VERSION = 2;
// Fixed notification identifier so each per-stop alert REPLACES the
// previous one in the shade instead of stacking (Harpreet's 2026-10-26
// call). Verified against the installed expo-notifications 0.32.17:
// JS passes `identifier` through (omitted => fresh UUID, which is why the
// old code stacked); Android posts with notify(tag=identifier, id=0), so
// the same tag+id replaces; iOS builds UNNotificationRequest with the
// identifier, and UNUserNotificationCenter replaces a delivered
// notification bearing the same identifier. One entry ever visible.
const RIDE_ALERT_NOTIFICATION_ID = 'ride-alert';
const DEFAULT_LEAD_STOPS = 1;
const LOCATION_TIME_INTERVAL_MS = 15000;
const LOCATION_DISTANCE_INTERVAL_M = 60;

let notificationConfigured = false;
let foregroundLocationSubscription = null;

function nowMs() {
  return Date.now();
}

// ---------------------------------------------------------------------------
// Session persistence
// ---------------------------------------------------------------------------

async function readSessionRaw() {
  try {
    const info = await FileSystem.getInfoAsync(RIDE_SESSION_FILE);
    if (!info.exists) return null;
    const json = await FileSystem.readAsStringAsync(RIDE_SESSION_FILE);
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeSessionRaw(session) {
  if (!session) {
    await FileSystem.deleteAsync(RIDE_SESSION_FILE, { idempotent: true });
    return;
  }
  await FileSystem.writeAsStringAsync(RIDE_SESSION_FILE, JSON.stringify(session));
}

/**
 * Loads the persisted alert session, normalized with defensive defaults.
 * Returns null when there is no usable session — including legacy
 * GPS-engine sessions (no engineVersion: 2), which are never guessed at.
 * Side-effect free; migration cleanup lives in resumeRideTracking.
 */
async function loadAlertSession() {
  const raw = await readSessionRaw();
  if (!raw) return null;
  if (raw.engineVersion !== ENGINE_VERSION) return null;
  const status = String(raw.status ?? 'active');
  if (status !== 'active') return null;
  const tripId = String(raw.tripId || '').trim();
  const fromStopId = String(raw.fromStopId || '').trim();
  if (!tripId || !fromStopId) return null;

  const leadRaw = Number(raw.leadStopsBefore);
  return {
    engineVersion: ENGINE_VERSION,
    status: 'active',
    tripId,
    fromStopId,
    toStopId: String(raw.toStopId || ''),
    lineName: String(raw.lineName || 'GO'),
    destinationName: String(raw.destinationName || ''),
    departureLabel: raw.departureLabel ?? null,
    leadStopsBefore:
      Number.isFinite(leadRaw) && leadRaw >= 1 ? Math.floor(leadRaw) : DEFAULT_LEAD_STOPS,
    alertState: ['setting-up', 'on', 'limited', 'off'].includes(raw.alertState)
      ? raw.alertState
      : 'off',
    backgroundEnabled: Boolean(raw.backgroundEnabled ?? false),
    staleFeed: Boolean(raw.staleFeed ?? false),
    // Per-stop dedup: the next stop last notified for. Old builds wrote
    // `sentLeadAlert` instead — that field is ignored on load, so a
    // session written by the current build fires per-stop from its current
    // next stop with no migration.
    lastNotifiedStopId: raw.lastNotifiedStopId ? String(raw.lastNotifiedStopId) : null,
    startedAt: Number(raw.startedAt) || 0,
    updatedAt: Number(raw.updatedAt) || 0,
  };
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

async function ensureNotificationConfig() {
  if (notificationConfigured) return;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });

  await Notifications.setNotificationChannelAsync('ride-alerts', {
    name: 'Ride Alerts',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 250, 250],
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
  });

  notificationConfigured = true;
}

async function sendRideNotification(title, body) {
  await ensureNotificationConfig();
  await Notifications.scheduleNotificationAsync({
    // Fixed identifier: each new alert replaces the previous one in the
    // shade (see RIDE_ALERT_NOTIFICATION_ID) — never stacking.
    identifier: RIDE_ALERT_NOTIFICATION_ID,
    content: {
      title,
      body,
      sound: 'default',
      priority: Notifications.AndroidNotificationPriority.HIGH,
    },
    // Immediate delivery routed through the 'ride-alerts' channel on Android.
    // expo-notifications only applies channelId on Android; on iOS this
    // parses to a null trigger, identical to `trigger: null`.
    trigger: { channelId: 'ride-alerts' },
  });
}

// ---------------------------------------------------------------------------
// Background-capability error classification (unchanged from the GPS era —
// it classifies expo-location start/request failures, not progression)
// ---------------------------------------------------------------------------

// expo-location's Android failures are CodedExceptions: the JS error carries a
// stable `code` inferred from the native exception class name
// (expo-modules-core CodedException.inferCode). These codes mean "background
// location capability is unavailable on this device/build" — the Android
// counterpart of the iOS NSLocation failures that the call sites below
// have always treated as non-fatal (swallow / foreground fallback).
const ANDROID_BACKGROUND_CAPABILITY_ERROR_CODES = new Set([
  'ERR_LOCATION_BACKGROUND_UNAUTHORIZED', // LocationBackgroundUnauthorizedException
  'ERR_NO_PERMISSION_IN_MANIFEST', // NoPermissionInManifestException
  'ERR_LOCATION_UNAVAILABLE', // LocationUnavailableException (location services off)
  'ERR_FOREGROUND_SERVICE_PERMISSIONS', // ForegroundServicePermissionsException
  'ERR_FOREGROUND_SERVICE_START_NOT_ALLOWED', // ForegroundServiceStartNotAllowedException
]);

// Exact messages from expo-location's Android LocationExceptions.kt — used
// only if an error arrives without its native code attached.
const ANDROID_BACKGROUND_CAPABILITY_ERROR_MESSAGES = [
  'Not authorized to use background location services',
  'Location is unavailable.',
  "Couldn't start the foreground service.",
  'ACCESS_BACKGROUND_LOCATION` to the AndroidManifest',
];

// Decides whether a location failure means "background capability
// unavailable" (swallow / foreground fallback) rather than a real error
// (rethrow). On iOS this runs the exact message test the call sites have
// always used; on Android it classifies by the native error code instead of
// matching iOS error text.
function isBackgroundCapabilityError(e, iosMessagePattern) {
  const msg = e instanceof Error ? e.message : String(e || '');
  if (Platform.OS === 'android') {
    const code = e && typeof e === 'object' ? String(e.code || '') : '';
    if (ANDROID_BACKGROUND_CAPABILITY_ERROR_CODES.has(code)) return true;
    return ANDROID_BACKGROUND_CAPABILITY_ERROR_MESSAGES.some((fragment) =>
      msg.includes(fragment),
    );
  }
  return iosMessagePattern.test(msg);
}

// ---------------------------------------------------------------------------
// Permissions — the fixed ladder. Never throws; outcomes are values.
// Notifications denied or foreground location denied => 'off' (short-circuit:
// no further prompts, no drivers). Background granted => 'on'; denied or
// unavailable => 'limited' (foreground watcher only).
// ---------------------------------------------------------------------------

async function resolveAlertPermissions() {
  let notificationsGranted = false;
  try {
    const current = await Notifications.getPermissionsAsync();
    if (current.granted) {
      notificationsGranted = true;
    } else {
      const requested = await Notifications.requestPermissionsAsync();
      notificationsGranted = Boolean(requested.granted);
    }
  } catch {
    notificationsGranted = false;
  }
  if (!notificationsGranted) {
    return { notificationsGranted: false, foregroundGranted: false, backgroundEnabled: false };
  }

  let foregroundGranted = false;
  try {
    const fg = await Location.requestForegroundPermissionsAsync();
    foregroundGranted = fg.status === 'granted';
  } catch {
    foregroundGranted = false;
  }
  if (!foregroundGranted) {
    return { notificationsGranted: true, foregroundGranted: false, backgroundEnabled: false };
  }

  let backgroundEnabled = false;
  try {
    const bg = await Location.requestBackgroundPermissionsAsync();
    backgroundEnabled = bg.status === 'granted';
  } catch {
    // Any failure here (capability or otherwise) means background location
    // is unavailable on this device/build — the 'limited' outcome, never a throw.
    backgroundEnabled = false;
  }
  return { notificationsGranted: true, foregroundGranted: true, backgroundEnabled };
}

function alertStateForPermissions(perms) {
  if (!perms.notificationsGranted || !perms.foregroundGranted) {
    return { alertState: 'off', backgroundEnabled: false };
  }
  if (perms.backgroundEnabled) {
    return { alertState: 'on', backgroundEnabled: true };
  }
  return { alertState: 'limited', backgroundEnabled: false };
}

// ---------------------------------------------------------------------------
// Wake drivers. The background location task is SHARED with the Live
// Activity card (it is the card's background refresh driver), so it is
// stopped only when no live-activity session exists. The foreground watcher
// belongs to this engine alone and always stops with the alert session.
// ---------------------------------------------------------------------------

async function startForegroundWatcher() {
  if (foregroundLocationSubscription) return;
  foregroundLocationSubscription = await Location.watchPositionAsync(
    {
      accuracy: Location.Accuracy.Balanced,
      timeInterval: LOCATION_TIME_INTERVAL_MS,
      distanceInterval: LOCATION_DISTANCE_INTERVAL_M,
    },
    () => {
      // Fixes are a wake signal only — they gate and advance nothing.
      onWakeTick().catch(() => {});
    },
  );
}

async function startLocationTask(backgroundEnabled = true) {
  if (!backgroundEnabled) {
    await startForegroundWatcher();
    return;
  }

  if (foregroundLocationSubscription) {
    foregroundLocationSubscription.remove();
    foregroundLocationSubscription = null;
  }

  const started = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
  if (started) return;

  try {
    await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
      accuracy: Location.Accuracy.Balanced,
      timeInterval: LOCATION_TIME_INTERVAL_MS,
      distanceInterval: LOCATION_DISTANCE_INTERVAL_M,
      pausesUpdatesAutomatically: true,
      showsBackgroundLocationIndicator: true,
      foregroundService: {
        notificationTitle: 'Transit Scanner ride tracking is active',
        notificationBody: 'We will notify you before your destination stop.',
        killServiceOnDestroy: false,
      },
    });
  } catch (e) {
    if (!isBackgroundCapabilityError(e, /NSLocation|background/i)) {
      throw e;
    }
    await startForegroundWatcher();
  }
}

// Starts the drivers for a resolved alert state; driver failures are
// swallowed so public entry points keep their never-throws contract.
async function startDriversForState(alertState) {
  try {
    if (alertState === 'on') {
      await startLocationTask(true);
    } else if (alertState === 'limited') {
      await startLocationTask(false);
    }
  } catch (e) {
    debugLog('startDriversForState failed', e);
  }
}

async function stopLocationTask() {
  try {
    const started = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
    if (!started) return;
    await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
  } catch {}
}

async function stopForegroundWatcher() {
  try {
    if (foregroundLocationSubscription) {
      foregroundLocationSubscription.remove();
      foregroundLocationSubscription = null;
    }
  } catch {}
}

async function hasLiveActivitySession() {
  try {
    const session = await getActiveLiveSession();
    return Boolean(session);
  } catch {
    return false;
  }
}

/**
 * Ends the alert session: clears the persisted file and stops this engine's
 * drivers. The shared background location task is stopped only when no
 * live-activity session exists (it is also the card's background driver).
 */
async function endAlertSession() {
  await writeSessionRaw(null);
  await stopForegroundWatcher();
  if (!(await hasLiveActivitySession())) {
    await stopLocationTask();
  }
}

/**
 * Self-heals the shared background location task. endAlertSession stops
 * the task only when the alert session ends last; if the card session
 * outlives it and then ends (liveActivityService never stops the task),
 * the task keeps waking the app with both engines idle. Called from the
 * no-session tick path: with neither session present, stop the task.
 * stopLocationTask is idempotent and never throws — if the stop fails,
 * hasStarted still reads true and the next tick retries.
 */
async function stopLocationTaskIfOrphaned() {
  if (await hasLiveActivitySession()) return;
  await stopLocationTask();
}

// ---------------------------------------------------------------------------
// Engine tick — the only place progression happens, read from the feed.
// ---------------------------------------------------------------------------

export async function evaluateAlertsFromFeed() {
  try {
    const session = await loadAlertSession();
    if (!session) {
      await stopLocationTaskIfOrphaned();
      return;
    }

    let state = null;
    try {
      state = computeTripState(session.tripId, session.fromStopId, session.toStopId || null);
    } catch {
      state = null;
    }
    if (!state) return;

    let dirty = false;
    const staleFeed = Boolean(state.staleFeed);
    if (session.staleFeed !== staleFeed) {
      session.staleFeed = staleFeed;
      dirty = true;
    }

    const stopsRemaining =
      state.ok && Number.isFinite(state.stopsRemaining) ? state.stopsRemaining : null;

    if (state.arrived || stopsRemaining === 0) {
      // F-DEST fix: the tick where the destination becomes the next stop is
      // exactly the stopsRemaining === 0 tick, which used to end the session
      // before the fire block below could run — so `Up next <destination>`
      // could never fire. Fire it once here under the same rule as the
      // per-stop block (name present, alert on/limited, ID differs from the
      // last notified stop), then end the session silently as before.
      // When arrived is true there is no next stop, so the name check alone
      // prevents a fire; missing data never fires, never a blank name.
      // No persist of lastNotifiedStopId is needed: endAlertSession deletes
      // the session immediately below, and later ticks find no session and
      // cannot refire.
      const finalStopId = state.ok && state.nextStopId ? String(state.nextStopId) : null;
      const finalStopName =
        state.ok && state.nextStopName ? String(state.nextStopName).trim() : '';
      if (
        stopsRemaining === 0 &&
        !state.arrived &&
        finalStopId &&
        finalStopName &&
        (session.alertState === 'on' || session.alertState === 'limited') &&
        session.lastNotifiedStopId !== finalStopId
      ) {
        await sendRideNotification('Track my Trip', `Up next ${finalStopName}`);
        session.lastNotifiedStopId = finalStopId;
        debugLog('Final-stop alert fired', { tripId: session.tripId, nextStopId: finalStopId });
      }
      // Same event as the card ending: the alert session ends with the trip.
      await endAlertSession();
      return;
    }

    // Per-stop alerts (ADDENDUM-per-stop-alerts.md §2–§8): fire once per
    // next-stop change, naming the upcoming stop. The final fire, on the
    // stopsRemaining === 0 tick, names the destination itself (see the
    // F-DEST block above — that tick ends the session, so the fire must
    // happen before the end, not in this block). Repeated ticks at the same
    // next stop never re-fire; missing next-stop data fires nothing, never
    // a blank-name notification. The old exactly-once-at-1-stop rule and
    // its sentLeadAlert gate are gone; leadStopsBefore is no longer
    // consulted for firing.
    const nextStopId = state.ok && state.nextStopId ? String(state.nextStopId) : null;
    const nextStopName =
      state.ok && state.nextStopName ? String(state.nextStopName).trim() : '';
    if (
      nextStopId &&
      nextStopName &&
      (session.alertState === 'on' || session.alertState === 'limited') &&
      session.lastNotifiedStopId !== nextStopId
    ) {
      await sendRideNotification('Track my Trip', `Up next ${nextStopName}`);
      session.lastNotifiedStopId = nextStopId;
      dirty = true;
      debugLog('Per-stop alert fired', { tripId: session.tripId, nextStopId });
    }

    if (dirty) {
      session.updatedAt = nowMs();
      await writeSessionRaw(session);
    }
  } catch {}
}

/**
 * One wake tick, shared by every driver: the 60s GtfsDataContext interval,
 * the background location task, and the foreground watcher. Refreshes the
 * card from the feed, then evaluates the alert engine from the same feed.
 */
async function onWakeTick() {
  try {
    await refreshLiveActivityFromFeed();
  } catch {}
  await evaluateAlertsFromFeed();
}

if (!TaskManager.isTaskDefined(LOCATION_TASK_NAME)) {
  TaskManager.defineTask(LOCATION_TASK_NAME, async ({ error }) => {
    if (error) return;
    // Wake driver only: the fix coordinates are ignored — progression is
    // read from the feed, never from GPS. Never throws.
    await onWakeTick();
  });
}

// ---------------------------------------------------------------------------
// Public API (fixed contracts — see TASK-SPLIT-REVISED-manual-only.md)
// ---------------------------------------------------------------------------

/**
 * Arms get-off alerts for a manually tracked trip. Replaces any active
 * alert session. Never throws.
 * → { armed, alertState, backgroundEnabled }
 * `armed` is true when a session was persisted (including state 'off',
 * whose session the strip's fix flow upgrades); false only when no session
 * exists (invalid trip or a stop sequence that cannot be built).
 */
export async function startAlertsForTrip(args = {}) {
  try {
    const tripId = String(args?.tripId || '').trim();
    const fromStopId = String(args?.fromStopId || '').trim();
    const toStopId = String(args?.toStopId || '').trim();
    if (!tripId || !fromStopId) {
      return { armed: false, alertState: 'off', backgroundEnabled: false };
    }

    // Validate the stop sequence against the single source before touching
    // any existing session: a trip that cannot produce a sequence is a data
    // failure, not a permission state — no session is persisted.
    let state = null;
    try {
      state = computeTripState(tripId, fromStopId, toStopId || null);
    } catch {
      state = null;
    }
    const stopsCount = state && Array.isArray(state.stops) ? state.stops.length : 0;
    if (!state || !state.ok || stopsCount < 2) {
      return { armed: false, alertState: 'off', backgroundEnabled: false };
    }

    const existing = await readSessionRaw();
    if (existing) {
      await endAlertSession();
    }

    await ensureNotificationConfig();
    const perms = await resolveAlertPermissions();
    const { alertState, backgroundEnabled } = alertStateForPermissions(perms);

    const session = {
      engineVersion: ENGINE_VERSION,
      status: 'active',
      tripId,
      fromStopId,
      toStopId,
      lineName: String(args?.lineName || 'GO'),
      destinationName: String(args?.destinationName || state.destinationName || ''),
      departureLabel: args?.departureLabel ?? null,
      leadStopsBefore: DEFAULT_LEAD_STOPS,
      alertState,
      backgroundEnabled,
      staleFeed: Boolean(state.staleFeed),
      lastNotifiedStopId: null,
      startedAt: nowMs(),
      updatedAt: nowMs(),
    };
    await writeSessionRaw(session);
    await startDriversForState(alertState);

    debugLog('Alerts armed', { tripId, alertState, backgroundEnabled });
    return { armed: true, alertState, backgroundEnabled };
  } catch {
    return { armed: false, alertState: 'off', backgroundEnabled: false };
  }
}

/** Ends the alert session (if any) and its drivers. Never throws. */
export async function stopAlerts(reason = 'stopped') {
  void reason;
  try {
    await endAlertSession();
  } catch {}
}

/**
 * The status strip's only data source: null when no alert session exists,
 * otherwise the persisted session's display state. Never throws.
 */
export async function getRideAlertStatus() {
  try {
    const session = await loadAlertSession();
    if (!session) return null;
    return {
      tripId: session.tripId,
      alertState: session.alertState,
      backgroundEnabled: session.backgroundEnabled,
      staleFeed: session.staleFeed,
      destinationName: session.destinationName,
      departureLabel: session.departureLabel,
    };
  } catch {
    return null;
  }
}

/**
 * Re-runs the permission ladder for the persisted session (the strip's fix
 * flow, and the Directive F return path: a background grant made in system
 * Settings is picked up here with no prompt for what is already granted).
 * Starts drivers if permissions now allow. Never throws.
 */
export async function retryAlertPermissions() {
  try {
    const session = await loadAlertSession();
    if (!session) return { alertState: 'off' };

    const perms = await resolveAlertPermissions();
    const { alertState, backgroundEnabled } = alertStateForPermissions(perms);

    session.alertState = alertState;
    session.backgroundEnabled = backgroundEnabled;
    session.updatedAt = nowMs();
    await writeSessionRaw(session);

    if (alertState === 'off') {
      await stopForegroundWatcher();
      if (!(await hasLiveActivitySession())) {
        await stopLocationTask();
      }
    } else {
      await startDriversForState(alertState);
    }
    return { alertState };
  } catch {
    return { alertState: 'off' };
  }
}

/**
 * Launch resume (imported by GtfsDataContext). Restores the persisted
 * session's alert state and restarts its drivers honoring the STORED
 * backgroundEnabled (Task D2 — the old build ignored it). Legacy GPS-engine
 * sessions (no engineVersion: 2) are ended silently. Never throws; returns
 * the normalized session, or null when there is nothing to resume.
 */
export async function resumeRideTracking() {
  try {
    const raw = await readSessionRaw();
    if (raw && raw.engineVersion !== ENGINE_VERSION) {
      await endAlertSession();
      return null;
    }

    const session = await loadAlertSession();
    if (!session) {
      await stopForegroundWatcher();
      if (!(await hasLiveActivitySession())) {
        await stopLocationTask();
      }
      return null;
    }

    await ensureNotificationConfig();
    // Task D2: drivers restart from the STORED backgroundEnabled, not a
    // fresh default. ('off' sessions deliberately have no drivers — the
    // permission matrix — so there is nothing to restart for them.)
    if (session.alertState !== 'off') {
      try {
        await startLocationTask(session.backgroundEnabled);
      } catch {}
    }
    return session;
  } catch {
    return null;
  }
}
