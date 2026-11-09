import * as FileSystem from 'expo-file-system/legacy';

import { getTripSegmentServicePattern, getTripStops } from './gtfsService';

const SAVED_TRIPS_FILE = `${FileSystem.documentDirectory}saved-trips-v1.json`;

function normalizeMode(input) {
  const raw = String(input?.preferredMode || '').trim().toLowerCase();
  if (raw === 'bus' || raw === 'train') return raw;
  return String(input?.isBus || 'false') === 'true' ? 'bus' : 'train';
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function parseClockLabelToMinutes(label) {
  const raw = String(label || '').trim();
  const m = raw.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;

  const hour12 = Number(m[1]);
  const minute = Number(m[2]);
  const meridiem = String(m[3]).toUpperCase();
  if (!Number.isFinite(hour12) || !Number.isFinite(minute)) return null;

  let hour24 = hour12 % 12;
  if (meridiem === 'PM') hour24 += 12;
  return hour24 * 60 + minute;
}

function buildTripKey(input) {
  const fromStopId = String(input?.fromStopId || '').trim();
  const toStopId = String(input?.toStopId || '').trim();
  const mode = normalizeMode(input);
  const departureTime = String(input?.departureTime || '').trim();
  const servicePattern = normalizeText(input?.servicePattern);
  const lineName = normalizeText(input?.lineName);

  if (fromStopId && departureTime) {
    return `${fromStopId}|${toStopId}|${mode}|${departureTime}|${servicePattern}|${lineName}`;
  }

  const tripId = String(input?.tripId || '').trim();
  if (tripId) return `${tripId}|${fromStopId}|${toStopId}|${mode}`;
  return `${fromStopId}|${toStopId}|${mode}`;
}

export function getTripSaveKey(input) {
  return buildTripKey(input);
}

function normalizeSavedItem(input) {
  const tripId = String(input?.tripId || '').trim();
  const fromStopId = String(input?.fromStopId || '').trim();
  if (!fromStopId) return null;

  const toStopId = String(input?.toStopId || '').trim();
  const preferredMode = normalizeMode(input);
  const savedAt = Number(input?.savedAt) || Date.now();
  let serviceDate = String(input?.serviceDate || '').trim();
  let departureTime = String(input?.departureTime || '').trim();
  let arrivalTime = String(input?.arrivalTime || '').trim();
  let servicePattern = String(input?.servicePattern || '').trim();
  const lineName = String(input?.lineName || '').trim();
  const durationMinutes =
    input?.durationMinutes !== '' && input?.durationMinutes != null
      ? Number(input.durationMinutes)
      : null;
  const stopsCount =
    input?.stopsCount !== '' && input?.stopsCount != null
      ? Number(input.stopsCount)
      : null;

  let resolvedDuration = Number.isFinite(durationMinutes) ? durationMinutes : null;
  let resolvedStopsCount = Number.isFinite(stopsCount) ? stopsCount : null;

  if (tripId && (!departureTime || !arrivalTime || !servicePattern || resolvedDuration == null || resolvedStopsCount == null)) {
    const stops = getTripStops(tripId, fromStopId, toStopId || null);
    const first = stops[0] || null;
    const last = stops[stops.length - 1] || null;
    if (first && !departureTime) departureTime = String(first.arrival_time_label || '').trim();
    if (last && !arrivalTime) arrivalTime = String(last.arrival_time_label || '').trim();
    if (!serviceDate && first?.arrival_date_time) {
      serviceDate = String(first.arrival_date_time).slice(0, 10);
    }
    if (!servicePattern) {
      servicePattern = getTripSegmentServicePattern(tripId, fromStopId, toStopId || null);
    }
    if (resolvedStopsCount == null && stops.length) {
      resolvedStopsCount = Math.max(stops.length - 1, 0);
    }
    if (resolvedDuration == null && first && last) {
      const firstMin = parseClockLabelToMinutes(first.arrival_time_label);
      const lastMin = parseClockLabelToMinutes(last.arrival_time_label);
      if (firstMin != null && lastMin != null) {
        const diff = lastMin >= firstMin ? lastMin - firstMin : lastMin + 1440 - firstMin;
        if (diff >= 0) resolvedDuration = diff;
      }
    }
  }

  return {
    type: 'trip',
    key: buildTripKey({ tripId, fromStopId, toStopId, preferredMode, departureTime, servicePattern, lineName }),
    tripId,
    fromStopId,
    toStopId,
    fromStopName: String(input?.fromStopName || '').trim(),
    toStopName: String(input?.toStopName || '').trim(),
    preferredMode,
    lineName,
    serviceDate,
    servicePattern,
    departureTime,
    arrivalTime,
    durationMinutes: resolvedDuration,
    stopsCount: resolvedStopsCount,
    savedAt,
  };
}

function normalizeAndDedupe(items) {
  const byKey = new Map();
  for (const raw of Array.isArray(items) ? items : []) {
    const normalized = normalizeSavedItem(raw);
    if (!normalized) continue;
    const existing = byKey.get(normalized.key);
    if (!existing) {
      byKey.set(normalized.key, normalized);
      continue;
    }

    const existingDate = String(existing.serviceDate || '').trim();
    const nextDate = String(normalized.serviceDate || '').trim();
    byKey.set(normalized.key, {
      ...existing,
      savedAt: Math.max(Number(existing.savedAt) || 0, Number(normalized.savedAt) || 0),
      serviceDate:
        existingDate && nextDate
          ? existingDate < nextDate
            ? existingDate
            : nextDate
          : existingDate || nextDate,
    });
  }
  const out = [...byKey.values()];
  out.sort((a, b) => Number(b.savedAt) - Number(a.savedAt));
  return out;
}

async function readSavedTripsRaw() {
  try {
    const info = await FileSystem.getInfoAsync(SAVED_TRIPS_FILE);
    if (!info.exists) return [];

    const json = await FileSystem.readAsStringAsync(SAVED_TRIPS_FILE);
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

async function writeSavedTripsRaw(items) {
  const safeItems = Array.isArray(items) ? items : [];
  await FileSystem.writeAsStringAsync(SAVED_TRIPS_FILE, JSON.stringify(safeItems));
}

export async function getSavedTrips() {
  const current = await readSavedTripsRaw();
  const normalized = normalizeAndDedupe(current);
  await writeSavedTripsRaw(normalized);
  return normalized;
}

/**
 * Read-only saved-trips count for the launch usage row. Reads the file,
 * parses it, and counts the normalized, deduped entries in memory — it
 * NEVER writes, so a launch cannot rewrite, truncate, or race-clobber
 * the user's saved-trips file. Fail-silent: returns null on any failure
 * (missing/corrupt file, non-array content, normalize error) so the
 * caller records the open without a count. A file that simply does not
 * exist yet means zero saved trips, not a failure.
 */
export async function countSavedTrips() {
  try {
    const info = await FileSystem.getInfoAsync(SAVED_TRIPS_FILE);
    if (!info.exists) return 0;

    const json = await FileSystem.readAsStringAsync(SAVED_TRIPS_FILE);
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return null;
    return normalizeAndDedupe(parsed).length;
  } catch {
    return null;
  }
}

export async function saveTrip(input) {
  const key = buildTripKey(input);
  if (!key) return getSavedTrips();

  const savedAt = Date.now();
  const nextItem = normalizeSavedItem({ ...input, savedAt, key });
  if (!nextItem) return getSavedTrips();

  const current = await readSavedTripsRaw();
  const normalized = normalizeAndDedupe(current);
  const deduped = normalized.filter((x) => String(x?.key || '') !== key);
  const next = [nextItem, ...deduped].slice(0, 100);
  await writeSavedTripsRaw(next);
  return next;
}

export async function removeSavedTrip(key) {
  const current = normalizeAndDedupe(await readSavedTripsRaw());
  const next = current.filter((x) => String(x?.key || '') !== String(key || ''));
  await writeSavedTripsRaw(next);
  return next;
}

export async function clearSavedTrips() {
  await writeSavedTripsRaw([]);
  return [];
}

export async function isTripSaved(input) {
  const key = buildTripKey(input);
  if (!key) return false;
  const current = normalizeAndDedupe(await readSavedTripsRaw());
  return current.some((x) => String(x?.key || '') === key);
}
