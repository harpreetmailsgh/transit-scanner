import * as FileSystem from 'expo-file-system/legacy';

import { getStops } from './gtfsService';

const STOPS_CACHE_FILE = `${FileSystem.documentDirectory}stops-bootstrap-v1.json`;
const STOPS_API_TIMEOUT_MS = 8000;
const USE_API_STOPS_BOOTSTRAP = true;
const STOPS_API_URL = process.env.EXPO_PUBLIC_STOPS_API_URL || '';

function clampStops(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => ({
      stop_id: String(row?.stop_id ?? ''),
      stop_name: String(row?.stop_name ?? ''),
      stop_lat: String(row?.stop_lat ?? ''),
      stop_lon: String(row?.stop_lon ?? ''),
      parent_station: String(row?.parent_station ?? ''),
      location_type: String(row?.location_type ?? ''),
      platform_code: String(row?.platform_code ?? ''),
    }))
    .filter((row) => row.stop_id && row.stop_name && row.stop_lat && row.stop_lon);
}

function normalizeStopsPayload(payload) {
  if (Array.isArray(payload)) return clampStops(payload);
  if (Array.isArray(payload?.stops)) return clampStops(payload.stops);
  return [];
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function readCachedStops() {
  try {
    const raw = await FileSystem.readAsStringAsync(STOPS_CACHE_FILE);
    const parsed = JSON.parse(raw);
    return normalizeStopsPayload(parsed);
  } catch {
    return [];
  }
}

async function writeCachedStops(stops) {
  try {
    await FileSystem.writeAsStringAsync(STOPS_CACHE_FILE, JSON.stringify({
      cachedAt: Date.now(),
      stops,
    }));
  } catch {
    // Best-effort cache write.
  }
}

async function fetchAndCacheApiStops(trace) {
  const fetchStartedAt = Date.now();
  try {
    trace('stops bootstrap: fetching API');
    const res = await fetchWithTimeout(STOPS_API_URL, STOPS_API_TIMEOUT_MS);
    if (!res.ok) {
      throw new Error(`Stops API failed: HTTP ${res.status}`);
    }
    const json = await res.json();
    const stops = normalizeStopsPayload(json);
    if (stops.length) {
      await writeCachedStops(stops);
      return {
        stops,
        source: 'api',
        fetchMs: Date.now() - fetchStartedAt,
      };
    }
    throw new Error('Stops API payload did not include any valid stops.');
  } catch (err) {
    trace('stops bootstrap: API unavailable', { message: err?.message });
    return null;
  }
}

export async function loadBootstrapStops(options = {}) {
  const { onTrace } = options;
  const trace = (msg, extra) => {
    if (typeof onTrace === 'function') onTrace(msg, extra);
  };

  // Cache-first: return instantly when we have saved stops; refresh the
  // cache in the background so the next launch is fresh. The API attempt
  // used to block startup for up to 8s on slow networks.
  const cachedStops = await readCachedStops();
  if (cachedStops.length) {
    if (USE_API_STOPS_BOOTSTRAP && STOPS_API_URL) {
      fetchAndCacheApiStops(trace).catch(() => {
        // Best-effort background refresh; this launch uses the cache regardless.
      });
    }
    trace('stops bootstrap: loaded from cache');
    return {
      stops: cachedStops,
      source: 'cache',
      fetchMs: 0,
    };
  }

  if (USE_API_STOPS_BOOTSTRAP && STOPS_API_URL) {
    const apiResult = await fetchAndCacheApiStops(trace);
    if (apiResult) return apiResult;
    trace('stops bootstrap: API unavailable, trying cache', { message: 'cache was empty on first read' });
    const retryCached = await readCachedStops();
    if (retryCached.length) {
      trace('stops bootstrap: loaded from cache');
      return {
        stops: retryCached,
        source: 'cache',
        fetchMs: 0,
      };
    }
  }

  const staticStops = getStops();
  if (staticStops.length) {
    trace('stops bootstrap: static fallback used');
    return {
      stops: staticStops,
      source: 'static-fallback',
      fetchMs: 0,
    };
  }

  throw new Error(
    'Unable to load stops from API, cache, or static fallback. Set EXPO_PUBLIC_STOPS_API_URL to enable API bootstrap.',
  );
}
