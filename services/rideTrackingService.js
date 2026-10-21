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

import { getStopById, getTripStops } from './gtfsService';
import * as gtfsRealtimeService from './gtfsRealtimeService';
import { refreshFromFeed as refreshLiveActivityFromFeed } from './liveActivityService';

const RIDE_SESSION_FILE = `${FileSystem.documentDirectory}active-ride-v1.json`;
const LOCATION_TASK_NAME = 'transitscanner-active-ride-location-task';
const DEFAULT_LEAD_STOPS = 1;
const PROGRESS_ADVANCE_RADIUS_METERS = 1200;
const STARTUP_BOOTSTRAP_MAX_DISTANCE_METERS = 3000;
const CONFLICT_STREAK_TO_PAUSE = 2;
const RESUME_STREAK_TO_RESUME = 2;
const ADVANCE_STREAK_TO_PROGRESS = 2;
const LOCATION_TIME_INTERVAL_MS = 15000;
const LOCATION_DISTANCE_INTERVAL_M = 60;

let notificationConfigured = false;
let foregroundLocationSubscription = null;

function nowMs() {
  return Date.now();
}

function toRad(value) {
  return (Number(value) * Math.PI) / 180;
}

function distanceMeters(aLat, aLon, bLat, bLon) {
  const lat1 = Number(aLat);
  const lon1 = Number(aLon);
  const lat2 = Number(bLat);
  const lon2 = Number(bLon);
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return Number.POSITIVE_INFINITY;

  const earthRadius = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const p1 = toRad(lat1);
  const p2 = toRad(lat2);
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(p1) * Math.cos(p2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * earthRadius * Math.asin(Math.sqrt(h));
}

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

function normalizeActiveSession(session) {
  if (!session || typeof session !== 'object') return null;
  if (String(session.status || '') !== 'active') return null;
  if (!String(session.tripId || '').trim()) return null;
  if (!String(session.templateKey || '').trim()) return null;
  if (!Array.isArray(session.stops) || !session.stops.length) return null;
  return session;
}

function buildStopsWithCoords(tripId, fromStopId, toStopId) {
  const stops = getTripStops(tripId, fromStopId, toStopId);
  if (!Array.isArray(stops) || stops.length < 2) return [];

  const withCoords = [];
  for (let i = 0; i < stops.length; i += 1) {
    const st = stops[i];
    const stop = getStopById(st.stop_id);
    const lat = Number(stop?.stop_lat);
    const lon = Number(stop?.stop_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    withCoords.push({
      stopId: String(st.stop_id),
      stopName: String(st.stop_name || stop?.stop_name || ''),
      latitude: lat,
      longitude: lon,
      index: i,
    });
  }
  return withCoords;
}

function getNearestUpcomingStopIndex(session, latitude, longitude) {
  const destinationIndex = Number(session.destinationIndex);
  let startIndex = Number(session.progressIndex);
  if (!Number.isFinite(startIndex) || startIndex < 0) startIndex = 0;

  let best = null;
  for (const stop of session.stops) {
    const idx = Number(stop.index);
    if (!Number.isFinite(idx)) continue;
    if (idx < startIndex) continue;
    if (idx > destinationIndex) continue;

    const dist = distanceMeters(latitude, longitude, stop.latitude, stop.longitude);
    if (!Number.isFinite(dist)) continue;
    if (!best || dist < best.dist) {
      best = { idx, dist };
    }
  }
  return best;
}

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

// expo-location's Android failures are CodedExceptions: the JS error carries a
// stable `code` inferred from the native exception class name
// (expo-modules-core CodedException.inferCode). These codes mean "background
// location capability is unavailable on this device/build" — the Android
// counterpart of the iOS NSLocation failures that the two call sites below
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

async function requestTrackingPermissions() {
  const notif = await Notifications.getPermissionsAsync();
  if (!notif.granted) {
    const req = await Notifications.requestPermissionsAsync();
    if (!req.granted) {
      throw new Error('Notifications permission is required for get-off alerts.');
    }
  }

  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== 'granted') {
    throw new Error('Foreground location permission is required to start ride tracking.');
  }

  let backgroundEnabled = false;
  try {
    const bg = await Location.requestBackgroundPermissionsAsync();
    backgroundEnabled = bg.status === 'granted';
  } catch (e) {
    // Expo Go / non-rebuilt iOS clients may not include background location plist keys.
    if (!isBackgroundCapabilityError(e, /NSLocation/i)) {
      throw e;
    }
  }

  return { backgroundEnabled };
}

async function startLocationTask(backgroundEnabled = true) {
  if (!backgroundEnabled) {
    if (!foregroundLocationSubscription) {
      foregroundLocationSubscription = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.Balanced,
          timeInterval: LOCATION_TIME_INTERVAL_MS,
          distanceInterval: LOCATION_DISTANCE_INTERVAL_M,
        },
        (loc) => {
          const latitude = loc?.coords?.latitude;
          const longitude = loc?.coords?.longitude;
          if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
          processLocationUpdate(latitude, longitude).catch(() => {});
        },
      );
    }
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

    if (!foregroundLocationSubscription) {
      foregroundLocationSubscription = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.Balanced,
          timeInterval: LOCATION_TIME_INTERVAL_MS,
          distanceInterval: LOCATION_DISTANCE_INTERVAL_M,
        },
        (loc) => {
          const latitude = loc?.coords?.latitude;
          const longitude = loc?.coords?.longitude;
          if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
          processLocationUpdate(latitude, longitude).catch(() => {});
        },
      );
    }
  }
}

async function stopLocationTask() {
  const started = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
  if (!started) return;
  await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
}

async function stopForegroundWatcher() {
  if (foregroundLocationSubscription) {
    foregroundLocationSubscription.remove();
    foregroundLocationSubscription = null;
  }
}

async function processLocationUpdate(latitude, longitude) {
  const current = normalizeActiveSession(await readSessionRaw());
  if (!current) return;

  debugLog('processLocationUpdate', { latitude, longitude, progressIndex: current.progressIndex, destinationIndex: current.destinationIndex });

  const nearest = getNearestUpcomingStopIndex(current, latitude, longitude);

  debugLog('Nearest upcoming stop', nearest);

  const currentProgress = Number(current.progressIndex || 0);
  const destinationIndex = Number(current.destinationIndex || 0);
  const nextIndexCandidate = Number.isFinite(currentProgress)
    ? Math.min(currentProgress + 1, destinationIndex)
    : 1;
  const hasConflict =
    !nearest ||
    (Number.isFinite(nextIndexCandidate) && Number(nearest.idx) > nextIndexCandidate + 1);
  const hasAdvanceEvidence =
    Boolean(nearest) &&
    Number.isFinite(nextIndexCandidate) &&
    Number(nearest.idx) >= nextIndexCandidate &&
    Number(nearest.dist) <= PROGRESS_ADVANCE_RADIUS_METERS;

  const next = {
    ...current,
    updatedAt: nowMs(),
    lastKnownLatitude: Number(latitude),
    lastKnownLongitude: Number(longitude),
    lastKnownDistanceM: nearest && Number.isFinite(nearest.dist) ? Math.round(nearest.dist) : null,
    liveTrackingPaused: Boolean(current.liveTrackingPaused),
    conflictStreak: Number(current.conflictStreak || 0),
    resumeStreak: Number(current.resumeStreak || 0),
    advanceStreak: Number(current.advanceStreak || 0),
  };

  debugLog('Session after location update', next);

  if (hasConflict) {
    next.conflictStreak += 1;
    next.resumeStreak = 0;
    next.advanceStreak = 0;
  } else {
    next.conflictStreak = 0;
    if (next.liveTrackingPaused) {
      next.resumeStreak += 1;
    } else if (hasAdvanceEvidence && nextIndexCandidate > currentProgress) {
      next.advanceStreak += 1;
    } else {
      next.advanceStreak = 0;
    }
  }

  let sentPauseNotification = false;
  if (!next.liveTrackingPaused && next.conflictStreak >= CONFLICT_STREAK_TO_PAUSE) {
    next.liveTrackingPaused = true;
    next.resumeStreak = 0;
    next.advanceStreak = 0;
    sentPauseNotification = true;
  }

  let sentResumeNotification = false;
  if (next.liveTrackingPaused && !hasConflict && next.resumeStreak >= RESUME_STREAK_TO_RESUME) {
    next.liveTrackingPaused = false;
    next.conflictStreak = 0;
    next.resumeStreak = 0;
    next.advanceStreak = 0;
    sentResumeNotification = true;
  }

  if (sentPauseNotification) {
    await sendRideNotification(
      'Trip tracking paused',
      'Live position unavailable. Trip tracking paused.',
    );
  }

  if (sentResumeNotification) {
    await sendRideNotification(
      'Trip tracking resumed',
      'Live position available. Trip tracking resumed.',
    );
  }

  if (next.liveTrackingPaused) {
    await writeSessionRaw(next);
    return;
  }

  if (hasAdvanceEvidence && nextIndexCandidate > currentProgress && next.advanceStreak >= ADVANCE_STREAK_TO_PROGRESS) {
    next.progressIndex = nextIndexCandidate;
    next.advanceStreak = 0;
  } else if (!(hasAdvanceEvidence && nextIndexCandidate > currentProgress)) {
    next.advanceStreak = 0;
  }

  const remainingStops = Math.max(0, Number(next.destinationIndex) - Number(next.progressIndex || 0));

  if (!next.sentLeadAlert && remainingStops === 1) {
    await sendRideNotification(
      'Track my Trip',
      'Your destination is next stop. Prepare yourself.',
    );
    next.sentLeadAlert = true;
  }

  if (remainingStops === 0) {
    next.status = 'completed';
    next.completedAt = nowMs();
    await writeSessionRaw(null);
    await stopLocationTask();
    await stopForegroundWatcher();
    return;
  }

  await writeSessionRaw(next);
}

if (!TaskManager.isTaskDefined(LOCATION_TASK_NAME)) {
  TaskManager.defineTask(LOCATION_TASK_NAME, async ({ data, error }) => {
    if (error) return;
    // Live Activity refresh driver: a location tick is just a wakeup signal.
    // GPS coordinates are ignored for display (feed-only). Never throws.
    try {
      await refreshLiveActivityFromFeed();
    } catch {}
    const locations = data?.locations;
    if (!Array.isArray(locations) || !locations.length) return;

    const latest = locations[locations.length - 1];
    const latitude = latest?.coords?.latitude;
    const longitude = latest?.coords?.longitude;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;

    await processLocationUpdate(latitude, longitude);
  });
}

export async function getActiveRideSession() {
  return normalizeActiveSession(await readSessionRaw());
}

export async function stopActiveRide(reason = 'stopped') {
  const current = await readSessionRaw();
  await stopLocationTask();
  await stopForegroundWatcher();

  if (current) {
    const ended = {
      ...current,
      status: String(reason || 'stopped'),
      endedAt: nowMs(),
    };
    await writeSessionRaw(ended);
  }

  await writeSessionRaw(null);
}

// Helper: Find the latest stop index passed by the train using GTFS-RT Trip Updates
function getProgressIndexFromTripUpdate(tripId, stops) {
  // Use the stopDelaySeconds map as a proxy for which stops have been updated in GTFS-RT
  const feed = gtfsRealtimeService;
  if (!feed || !feed.stopDelaySeconds) return null;
  let lastPassedIndex = null;
  for (let i = 0; i < stops.length; i++) {
    const stop = stops[i];
    const key = `${tripId}:${stop.stop_id}`;
    if (feed.stopDelaySeconds.has(key)) {
      lastPassedIndex = i;
    }
  }
  return lastPassedIndex;
}

export async function startRideFromSavedTrip(template, nextTrip, options = {}) {
  const leadStopsBefore = Number(options.leadStopsBefore || DEFAULT_LEAD_STOPS);
  const templateKey = String(template?.key || '').trim();
  const fromStopId = String(template?.fromStopId || '').trim();
  const toStopId = String(template?.toStopId || '').trim();
  const tripId = String(nextTrip?.trip_id || '').trim();

  if (!templateKey || !fromStopId || !tripId) {
    throw new Error('Ride tracking needs a saved trip origin and an upcoming trip instance.');
  }

  const stops = buildStopsWithCoords(tripId, fromStopId, toStopId || null);
  if (stops.length < 2) {
    throw new Error('Could not build a stop sequence for this ride. Try again with another departure.');
  }

  const destination = stops[stops.length - 1];
  const resolvedToStopId = toStopId || String(destination.stopId || '').trim();

  await stopActiveRide('replaced');
  const permissionState = await requestTrackingPermissions();
  await ensureNotificationConfig();

  let initialProgressIndex = 0;
  let initialLatitude = null;
  let initialLongitude = null;
  let initialDistanceM = null;

  // Only use GTFS-RT Trip Updates for progress
  const stopsList = getTripStops(tripId, fromStopId, toStopId || null);
  let tripUpdateProgress = null;
  try {
    tripUpdateProgress = getProgressIndexFromTripUpdate(tripId, stopsList);
  } catch {}
  if (tripUpdateProgress !== null && tripUpdateProgress >= 0) {
    initialProgressIndex = tripUpdateProgress;
    debugLog('Startup progress from GTFS-RT', initialProgressIndex);
  } else {
    await sendRideNotification(
      'Trip tracking unavailable',
      'Live position unavailable. Trip tracking unable to continue.'
    );
    throw new Error('Live position unavailable. Trip tracking unable to continue.');
  }

  const session = {
    id: `${templateKey}:${tripId}:${nowMs()}`,
    status: 'active',
    templateKey,
    tripId,
    fromStopId,
    toStopId: resolvedToStopId,
    fromStopName: String(template?.fromStopName || stops[0]?.stopName || ''),
    destinationStopId: String(destination.stopId),
    destinationStopName: String(template?.toStopName || destination.stopName || 'your stop'),
    lineName: String(nextTrip?.lineName || template?.lineName || 'GO'),
    leadStopsBefore: Number.isFinite(leadStopsBefore) ? Math.max(1, Math.floor(leadStopsBefore)) : DEFAULT_LEAD_STOPS,
    progressIndex: initialProgressIndex,
    destinationIndex: Number(destination.index),
    sentLeadAlert: false,
    liveTrackingPaused: false,
    conflictStreak: 0,
    resumeStreak: 0,
    advanceStreak: 0,
    backgroundEnabled: Boolean(permissionState?.backgroundEnabled),
    stops,
    lastKnownLatitude: initialLatitude,
    lastKnownLongitude: initialLongitude,
    lastKnownDistanceM: initialDistanceM,
    startedAt: nowMs(),
    updatedAt: nowMs(),
  };

  debugLog('Session at startup', session);

  await writeSessionRaw(session);
  await startLocationTask(Boolean(permissionState?.backgroundEnabled));
  return session;
}

export async function resumeRideTracking() {
  const active = await getActiveRideSession();
  if (!active) {
    await stopLocationTask();
    await stopForegroundWatcher();
    return null;
  }

  await ensureNotificationConfig();
  await startLocationTask();
  return active;
}
