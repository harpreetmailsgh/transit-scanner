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
// Fixed notification identifier so the single buzz REPLACES any previous
// alert in the shade instead of stacking (Harpreet's 2026-10-26 call,
// kept for the 1-stop buzz). Verified against the installed
// expo-notifications 0.32.17:
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
    // F-DEST guard: the next stop last notified for. Old builds wrote
    // `sentLeadAlert` instead — that field is ignored on load, so a
    // session written by an older build fires only at F-DEST with no
    // migration.
    lastNotifiedStopId: raw.lastNotifiedStopId ? String(raw.lastNotifiedStopId) : null,
    startedAt: Number(raw.startedAt) || 0,
    updatedAt: Number(raw.updatedAt) || 0,
  };
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

// B1: ~2-second buzz (was a sub-second triple buzz). Android ignores
// vibrationPattern changes on an already-created channel, so the pattern
// is versioned on disk: when the stored version differs, the channel is
// deleted and recreated (same id) so upgraded installs get the new
// pattern too. Fresh installs have no stored version and create it once.
const RIDE_ALERTS_CHANNEL_PATTERN = [0, 2000];
const RIDE_ALERTS_CHANNEL_PATTERN_VERSION = 2;
const RIDE_ALERTS_CHANNEL_VERSION_FILE = `${FileSystem.documentDirectory}ride-alerts-channel-version.json`;

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

  let storedPatternVersion = 0;
  try {
    const raw = await FileSystem.readAsStringAsync(RIDE_ALERTS_CHANNEL_VERSION_FILE);
    storedPatternVersion = Number(JSON.parse(raw)?.patternVersion) || 0;
  } catch {}
  if (storedPatternVersion !== RIDE_ALERTS_CHANNEL_PATTERN_VERSION && Platform.OS === 'android') {
    await Notifications.deleteNotificationChannelAsync('ride-alerts').catch(() => {});
  }

  await Notifications.setNotificationChannelAsync('ride-alerts', {
    name: 'Ride Alerts',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: RIDE_ALERTS_CHANNEL_PATTERN,
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
  });

  if (storedPatternVersion !== RIDE_ALERTS_CHANNEL_PATTERN_VERSION) {
    await FileSystem.writeAsStringAsync(
      RIDE_ALERTS_CHANNEL_VERSION_FILE,
      JSON.stringify({ patternVersion: RIDE_ALERTS_CHANNEL_PATTERN_VERSION }),
    ).catch(() => {});
  }

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
      // B1: iOS plays the bundled ~2s tone (Dev-1, B2); Android keeps
      // 'default' — its buzz length comes from the channel vibration
      // pattern, not the sound. A build without the bundled tone falls
      // back to the default iOS sound.
      sound: Platform.OS === 'ios' ? 'alert_2s.caf' : 'default',
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
// Permissions — the location gate runs FIRST, notifications LAST. Never
// throws; outcomes are values. No rung may return before the gate: the
// explainer decision happens regardless of notification or foreground
// state, so a notifications/foreground denial can no longer suppress it.
// Background granted => 'on'; denied or unavailable => 'limited'
// (foreground watcher only); notifications or foreground denied => 'off'.
// ---------------------------------------------------------------------------

/**
 * Read-only permission statuses. Never prompts, never writes. Used by the
 * strip's Android 11+ branch (which needs a get-only background read
 * before deciding between explainer→Settings and the normal retry) and by
 * the gate itself. A failed read reports 'undetermined' — the safe
 * non-granted value, so callers never act as if a grant existed.
 */
export async function getLocationPermissionStatuses() {
  let background = 'undetermined';
  let foreground = 'undetermined';
  try {
    background = String((await Location.getBackgroundPermissionsAsync()).status || 'undetermined');
  } catch {}
  try {
    foreground = String((await Location.getForegroundPermissionsAsync()).status || 'undetermined');
  } catch {}
  return { background, foreground };
}

/**
 * The pre-flight location gate. Runs BEFORE any card start, any session
 * write, and any session replacement, and performs ONLY these steps, in
 * this order:
 *   1. Read-only gets for background + foreground (nothing started).
 *   2. Background already granted → 'granted': no explainer, no prompt.
 *      (Foreground is implied granted when background is granted.)
 *   3. Background not granted → the caller's explainer runs, regardless
 *      of notification or foreground state. There is NO default-proceed:
 *      a missing explainer callback aborts, it never proceeds.
 *   4. Explainer Not now (or a callback failure) → 'aborted': the caller
 *      must start nothing — no OS box, no Settings, no card, no session.
 *   5. Explainer Continue + background denied → 'needs-settings': the
 *      caller opens Settings. requestBackgroundPermissionsAsync() is
 *      NEVER called here (a re-request after a denial is a no-op on both
 *      OSs); the grant is picked up later by a get-only recheck.
 *   6. Explainer Continue + background undetermined → foreground first
 *      (get, then request only if not already granted); if foreground is
 *      denied in its own prompt → 'aborted' (no Always prompt can follow
 *      — an OS limitation). Otherwise requestBackgroundPermissionsAsync()
 *      — the iOS follow-up screen offering Always, the Android
 *      Allow-all-the-time screen — → 'allowed', with backgroundEnabled
 *      reflecting what the OS actually granted.
 * A background request that throws a device/build capability error (not a
 * user denial) yields 'allowed' with backgroundCapabilityUnavailable true,
 * so callers preserve capability-'limited' instead of rolling it back.
 * Never throws; every failure path is an outcome value.
 */
export async function runLocationGate(onBeforeBackgroundRequest) {
  const { background: bgStatus, foreground: fgStatus } = await getLocationPermissionStatuses();

  if (bgStatus === 'granted') {
    return {
      outcome: 'granted',
      explainerShown: false,
      foregroundGranted: true,
      backgroundEnabled: true,
      backgroundCapabilityUnavailable: false,
    };
  }

  // Background not granted: the explainer is mandatory, whatever the
  // notification or foreground state. A missing callback is an abort, not
  // a proceed — the old proceed=true default was a bypass and is gone.
  if (typeof onBeforeBackgroundRequest !== 'function') {
    return {
      outcome: 'aborted',
      abortReason: 'no-explainer-callback',
      explainerShown: false,
      foregroundGranted: false,
      backgroundEnabled: false,
      backgroundCapabilityUnavailable: false,
    };
  }
  let proceed = false;
  try {
    proceed = (await onBeforeBackgroundRequest()) === true;
  } catch {
    proceed = false;
  }
  if (!proceed) {
    return {
      outcome: 'aborted',
      abortReason: 'explainer-declined',
      explainerShown: true,
      foregroundGranted: false,
      backgroundEnabled: false,
      backgroundCapabilityUnavailable: false,
    };
  }

  // Continue + permanently denied: Settings, never a re-request.
  if (bgStatus === 'denied') {
    return {
      outcome: 'needs-settings',
      explainerShown: true,
      foregroundGranted: fgStatus === 'granted',
      backgroundEnabled: false,
      backgroundCapabilityUnavailable: false,
    };
  }

  // Continue + undetermined: foreground first, only if not already granted.
  let foregroundGranted = fgStatus === 'granted';
  if (!foregroundGranted) {
    try {
      foregroundGranted = (await Location.requestForegroundPermissionsAsync()).status === 'granted';
    } catch {
      foregroundGranted = false;
    }
  }
  if (!foregroundGranted) {
    return {
      outcome: 'aborted',
      abortReason: 'foreground-denied',
      explainerShown: true,
      foregroundGranted: false,
      backgroundEnabled: false,
      backgroundCapabilityUnavailable: false,
    };
  }

  let backgroundEnabled = false;
  // True ONLY when the background step threw a device/build capability
  // error (classified by isBackgroundCapabilityError) — NOT a user denial.
  // Callers use it to preserve capability-'limited' sessions that must
  // never be rolled back as if the user had denied.
  let backgroundCapabilityUnavailable = false;
  try {
    backgroundEnabled = (await Location.requestBackgroundPermissionsAsync()).status === 'granted';
  } catch (e) {
    // Any failure here (capability or otherwise) means background location
    // is unavailable on this device/build — the 'limited' outcome, never a throw.
    backgroundEnabled = false;
    backgroundCapabilityUnavailable = isBackgroundCapabilityError(e, /NSLocation|background/i);
  }
  return {
    outcome: 'allowed',
    explainerShown: true,
    foregroundGranted: true,
    backgroundEnabled,
    backgroundCapabilityUnavailable,
  };
}

/**
 * Location gate first, notifications LAST. Callers MUST check
 * gateAborted / needsSettings before mapping to an alert state or writing
 * anything: an aborted or needs-settings outcome means no session write,
 * no driver start, and (for a fresh tap) no card — the pre-flight gate in
 * the UI has already run by then, so these are safety nets for direct
 * callers, not a second explainer. A caller may pass a pre-resolved gate
 * from the same tap (preResolvedGate with outcome 'granted'/'allowed');
 * it is reused verbatim and no location prompt re-fires. A pre-resolved
 * aborted/needs-settings gate is surfaced as-is, never re-run.
 */
async function resolveAlertPermissions(onBeforeBackgroundRequest, preResolvedGate) {
  let gate = null;
  if (preResolvedGate && (preResolvedGate.outcome === 'granted' || preResolvedGate.outcome === 'allowed')) {
    gate = preResolvedGate;
  } else if (preResolvedGate && (preResolvedGate.outcome === 'aborted' || preResolvedGate.outcome === 'needs-settings')) {
    return {
      gateAborted: preResolvedGate.outcome === 'aborted',
      needsSettings: preResolvedGate.outcome === 'needs-settings',
      gateOutcome: preResolvedGate.outcome,
      abortReason: preResolvedGate.abortReason || null,
      notificationsGranted: false,
      foregroundGranted: Boolean(preResolvedGate.foregroundGranted),
      backgroundEnabled: false,
      backgroundCapabilityUnavailable: false,
    };
  } else {
    gate = await runLocationGate(onBeforeBackgroundRequest);
  }

  if (gate.outcome === 'aborted') {
    return {
      gateAborted: true,
      needsSettings: false,
      gateOutcome: 'aborted',
      abortReason: gate.abortReason || null,
      notificationsGranted: false,
      foregroundGranted: false,
      backgroundEnabled: false,
      backgroundCapabilityUnavailable: false,
    };
  }
  if (gate.outcome === 'needs-settings') {
    return {
      gateAborted: false,
      needsSettings: true,
      gateOutcome: 'needs-settings',
      abortReason: null,
      notificationsGranted: false,
      foregroundGranted: Boolean(gate.foregroundGranted),
      backgroundEnabled: false,
      backgroundCapabilityUnavailable: false,
    };
  }

  // Notifications LAST, after the gate: a denial still yields 'off' (and
  // the UI's stop-everything rollback), but it can no longer suppress the
  // explainer, because the explainer decision has already happened.
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
  return {
    gateAborted: false,
    needsSettings: false,
    gateOutcome: gate.outcome,
    abortReason: null,
    notificationsGranted,
    foregroundGranted: Boolean(gate.foregroundGranted),
    backgroundEnabled: Boolean(gate.backgroundEnabled),
    backgroundCapabilityUnavailable: Boolean(gate.backgroundCapabilityUnavailable),
  };
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

    // B1: no per-stop fires remain — the F-DEST block above is the only
    // fire in the engine. Ticks at any other next stop fire nothing.

    if (dirty) {
      session.updatedAt = nowMs();
      await writeSessionRaw(session);
    }
  } catch {}
}

/**
 * One wake tick, shared by every driver: the 30s GtfsDataContext interval,
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
 * exists (invalid trip, a stop sequence that cannot be built, or a gate
 * outcome of 'aborted'/'needs-settings' — the last two leave any existing
 * session untouched, and the UI pre-flight gate normally prevents them
 * from ever reaching this function on a fresh tap).
 */
export async function startAlertsForTrip(args = {}) {
  try {
    const tripId = String(args?.tripId || '').trim();
    const fromStopId = String(args?.fromStopId || '').trim();
    const toStopId = String(args?.toStopId || '').trim();
    debugLog('startAlertsForTrip entry', { tripId, fromStopId, toStopId });
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
      debugLog('startAlertsForTrip compute gate failed', {
        tripId,
        ok: state?.ok ?? false,
        reason: state?.reason ?? null,
        stopsCount,
      });
      return { armed: false, alertState: 'off', backgroundEnabled: false };
    }
    debugLog('startAlertsForTrip compute ok', {
      tripId,
      ok: state.ok,
      reason: state.reason ?? null,
      stopsCount,
    });

    // Gate BEFORE any session replacement: an aborted or needs-settings
    // outcome returns without touching the existing session (a Not-now
    // tap must not destroy a session that was already running). Only a
    // gate that passed reaches endAlertSession() below. A pre-resolved
    // gate from the same tap (args.preResolvedGate) is reused verbatim —
    // the explainer and location prompts never re-fire for one tap.
    await ensureNotificationConfig();
    const perms = await resolveAlertPermissions(args?.onBeforeBackgroundRequest, args?.preResolvedGate);
    if (perms.gateAborted || perms.needsSettings) {
      debugLog('startAlertsForTrip gate aborted/needs-settings, existing session untouched', {
        gateOutcome: perms.gateOutcome,
      });
      return {
        armed: false,
        alertState: perms.needsSettings ? 'needs-settings' : 'aborted',
        gateAborted: Boolean(perms.gateAborted),
        needsSettings: Boolean(perms.needsSettings),
        backgroundEnabled: false,
      };
    }

    const existing = await readSessionRaw();
    if (existing) {
      await endAlertSession();
    }

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
    return { armed: true, alertState, backgroundEnabled, backgroundCapabilityUnavailable: Boolean(perms.backgroundCapabilityUnavailable) };
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
      toStopId: session.toStopId || '',
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
 * flow). Same gate as a fresh tap: the explainer runs before any prompt
 * regardless of notification/foreground state, and an aborted or
 * needs-settings outcome leaves the persisted session byte-for-byte
 * untouched (no downgrade, no driver change) — the UI opens Settings for
 * needs-settings and does nothing for an abort. A pre-resolved gate from
 * the same tap (options.preResolvedGate) is reused verbatim.
 * Starts drivers if permissions now allow. Never throws.
 */
export async function retryAlertPermissions(options = {}) {
  try {
    const session = await loadAlertSession();
    if (!session) return { alertState: 'off' };

    const perms = await resolveAlertPermissions(options?.onBeforeBackgroundRequest, options?.preResolvedGate);
    if (perms.gateAborted || perms.needsSettings) {
      return {
        alertState: session.alertState,
        gateAborted: Boolean(perms.gateAborted),
        needsSettings: Boolean(perms.needsSettings),
        unchanged: true,
      };
    }
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
 * Get-only Settings-return pickup (the focus path). Reads background,
 * foreground (implied by a background grant), and notification status and
 * NOTHING else: no explainer, no request call, no prompt of any kind, and
 * never a downgrade. A `limited` (or `off`) session upgrades to `on` with
 * its drivers started only when background is already granted AND
 * notifications are already granted; every other state is returned
 * unchanged. Never throws.
 */
export async function recheckAlertPermissions() {
  try {
    const session = await loadAlertSession();
    if (!session) return { alertState: 'off', upgraded: false };

    let backgroundGranted = false;
    try {
      backgroundGranted = (await Location.getBackgroundPermissionsAsync()).status === 'granted';
    } catch {
      backgroundGranted = false;
    }
    if (!backgroundGranted) return { alertState: session.alertState, upgraded: false };

    let notificationsGranted = false;
    try {
      notificationsGranted = Boolean((await Notifications.getPermissionsAsync()).granted);
    } catch {
      notificationsGranted = false;
    }
    if (!notificationsGranted) return { alertState: session.alertState, upgraded: false };

    if (session.alertState === 'on' && session.backgroundEnabled) {
      return { alertState: 'on', upgraded: false };
    }
    session.alertState = 'on';
    session.backgroundEnabled = true;
    session.updatedAt = nowMs();
    await writeSessionRaw(session);
    await startDriversForState('on');
    return { alertState: 'on', upgraded: true };
  } catch {
    return { alertState: 'off', upgraded: false };
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
