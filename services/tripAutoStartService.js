/**
 * Smart auto-start for Live Activities (v1.2, Task 3).
 *
 * Registers iOS geofences (300m) around saved-trip origin stations. When the
 * user enters one, the service finds the soonest matching departure within
 * 15 minutes and starts a Live Activity for it — no manual tap needed.
 *
 * Battery: geofencing is OS-level region monitoring (cell/WiFi), not
 * continuous GPS. Requires "Always" location permission; without it the
 * service skips silently and manual "Track this Trip" still works.
 *
 * Entry points: initAutoStart() (call once after GTFS data is ready),
 * refreshGeofences() (re-register, e.g. when saved trips change).
 */
import { Linking } from 'react-native';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DateTime } from 'luxon';

import { getSavedTrips } from './savedTripsService';
import { getStopById } from './gtfsService';
import { getLiveDepartures } from './gtfsRealtimeService';
import { scheduleLocalNotification } from './notificationService';
import { startForTrip } from './liveActivityService';

const GEOFENCE_TASK = 'transitscanner-geofence-task';
const GEOFENCE_RADIUS_M = 300;
const DEPARTURE_WINDOW_MIN = 15;
const MAX_REGIONS = 20; // iOS per-app region limit
const LAST_AUTO_START_KEY = 'ts:autoStartLastDates';
const TORONTO_TZ = 'America/Toronto';

let taskDefined = false;
let notificationListenerSet = false;

function todayYmd() {
  return DateTime.now().setZone(TORONTO_TZ).toFormat('yyyy-MM-dd');
}

function normalizeLineName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+line\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function savedTripMode(trip) {
  const pm = String(trip?.preferredMode || '').toLowerCase();
  if (pm === 'bus' || pm === 'train') return pm;
  return String(trip?.isBus) === 'true' ? 'bus' : 'train';
}

/**
 * Pure, unit-testable: pick the departure to auto-track.
 *
 * @param {object[]} departures rows from getLiveDepartures (liveDateTime ISO, lineName, route_type, trip_id)
 * @param {string} lineName saved trip's line name
 * @param {'bus'|'train'} mode saved trip's mode
 * @param {number} nowMs reference time (injectable for tests)
 * @param {number} windowMin how far ahead to look
 * @returns the chosen departure row, or null
 */
export function pickDepartureForTrip({
  departures,
  lineName,
  mode,
  nowMs = Date.now(),
  windowMin = DEPARTURE_WINDOW_MIN,
}) {
  const list = Array.isArray(departures) ? departures : [];
  const windowEnd = nowMs + windowMin * 60 * 1000;

  const inWindow = list.filter((d) => {
    const t = Date.parse(d?.liveDateTime);
    return Number.isFinite(t) && t >= nowMs - 60 * 1000 && t <= windowEnd;
  });
  if (!inWindow.length) return null;

  const wantLine = normalizeLineName(lineName);
  const wantBus = mode === 'bus';
  const matches = inWindow.filter((d) => {
    if ((Number(d?.route_type) === 3) !== wantBus) return false;
    if (wantLine && normalizeLineName(d?.lineName) !== wantLine) return false;
    return true;
  });

  // Fallback: soonest departure in the window regardless of line.
  const pool = matches.length ? matches : inWindow;
  const sorted = [...pool].sort(
    (a, b) => Date.parse(a.liveDateTime) - Date.parse(b.liveDateTime),
  );
  return sorted[0] || null;
}

function tripGuardKey(trip) {
  return String(
    trip?.key || `${trip?.fromStopId || ''}|${trip?.toStopId || ''}|${trip?.lineName || ''}`,
  );
}

async function readLastAutoStarts() {
  try {
    const raw = await AsyncStorage.getItem(LAST_AUTO_START_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function markAutoStarted(trip) {
  try {
    const all = await readLastAutoStarts();
    all[tripGuardKey(trip)] = todayYmd();
    await AsyncStorage.setItem(LAST_AUTO_START_KEY, JSON.stringify(all));
  } catch {
    // Guard persistence is best-effort; a missed write only risks a repeat nudge.
  }
}

function buildTripDetailUrl({ tripId, fromStopId, toStopId, lineName }) {
  const q = [
    `tripId=${encodeURIComponent(tripId)}`,
    `fromStopId=${encodeURIComponent(fromStopId)}`,
    `toStopId=${encodeURIComponent(toStopId || '')}`,
    `lineName=${encodeURIComponent(lineName || '')}`,
  ].join('&');
  return `transitscanner:///trip-detail?${q}`;
}

async function handleStationEntry(stopId) {
  try {
    const trips = (await getSavedTrips()).filter(
      (t) => String(t?.fromStopId || '') === String(stopId),
    );
    if (!trips.length) return;

    const lastStarts = await readLastAutoStarts();
    const today = todayYmd();

    for (const trip of trips) {
      // Max one auto-start per saved trip per calendar day.
      if (lastStarts[tripGuardKey(trip)] === today) continue;

      let departures = [];
      try {
        departures = getLiveDepartures(stopId, 5) || [];
      } catch {
        departures = [];
      }

      const pick = pickDepartureForTrip({
        departures,
        lineName: trip.lineName,
        mode: savedTripMode(trip),
      });
      if (!pick) continue;

      const started = await startForTrip({
        tripId: String(pick.trip_id),
        fromStopId: String(stopId),
        toStopId: String(trip.toStopId || ''),
      });
      if (!started || started.started === false) continue;

      await markAutoStarted(trip);

      const destName =
        String(trip.toStopName || trip.toStopId || '').trim() || 'your destination';
      const timeLabel = String(pick.liveTimeLabel || '').trim();
      await scheduleLocalNotification({
        title: 'Trip tracking on',
        body: `Tracking your${timeLabel ? ` ${timeLabel}` : ''} to ${destName} — tap to change`,
        data: {
          url: buildTripDetailUrl({
            tripId: String(pick.trip_id),
            fromStopId: String(stopId),
            toStopId: String(trip.toStopId || ''),
            lineName: trip.lineName,
          }),
        },
      });
      return; // one auto-start per entry event
    }
  } catch {
    // Auto-start must never break the app; failures stay silent.
  }
}

function ensureGeofenceTaskDefined() {
  if (taskDefined) return;
  TaskManager.defineTask(GEOFENCE_TASK, async ({ data, error }) => {
    if (error) return;
    const { eventType, region } = data || {};
    if (eventType !== Location.GeofencingEventType.Enter) return;
    const stopId = region?.identifier;
    if (!stopId) return;
    await handleStationEntry(String(stopId));
  });
  taskDefined = true;
}

function ensureNotificationTapHandler() {
  if (notificationListenerSet) return;
  Notifications.addNotificationResponseReceivedListener((response) => {
    try {
      const url = response?.notification?.request?.content?.data?.url;
      if (url) {
        Linking.openURL(String(url)).catch(() => {});
      }
    } catch {
      // ignore
    }
  });
  notificationListenerSet = true;
}

/**
 * Re-register geofences from the current saved trips.
 * Requires "Always" location permission; without it, skips silently
 * (manual "Track this Trip" keeps working).
 */
export async function refreshGeofences() {
  try {
    ensureGeofenceTaskDefined();

    let bg = { status: 'denied' };
    try {
      bg = await Location.getBackgroundPermissionsAsync();
    } catch {
      return { registered: false, reason: 'permission-check-failed' };
    }
    if (!bg || bg.status !== 'granted') {
      return { registered: false, reason: 'no-background-permission' };
    }

    const trips = await getSavedTrips();
    const seen = new Set();
    const regions = [];
    for (const trip of trips) {
      const stopId = String(trip?.fromStopId || '');
      if (!stopId || seen.has(stopId)) continue;
      seen.add(stopId);

      let stop = null;
      try {
        stop = getStopById(stopId);
      } catch {
        stop = null;
      }
      const lat = Number(stop?.stop_lat);
      const lon = Number(stop?.stop_lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      regions.push({
        identifier: stopId,
        latitude: lat,
        longitude: lon,
        radius: GEOFENCE_RADIUS_M,
        notifyOnEnter: true,
        notifyOnExit: false,
      });
      if (regions.length >= MAX_REGIONS) break;
    }

    try {
      await Location.stopGeofencingAsync(GEOFENCE_TASK);
    } catch {
      // Task may never have been started; ignore.
    }

    if (!regions.length) {
      return { registered: true, count: 0 };
    }
    await Location.startGeofencingAsync(GEOFENCE_TASK, regions);
    return { registered: true, count: regions.length };
  } catch {
    return { registered: false, reason: 'error' };
  }
}

/**
 * Call once after GTFS data is ready. Sets up the geofence task,
 * the notification-tap deep link handler, and registers geofences.
 * Do NOT call before GTFS is ready — stop coordinates come from getStopById.
 */
export async function initAutoStart() {
  try {
    ensureGeofenceTaskDefined();
    ensureNotificationTapHandler();
    await refreshGeofences();
  } catch {
    // Auto-start is best-effort; manual tracking is unaffected.
  }
}
