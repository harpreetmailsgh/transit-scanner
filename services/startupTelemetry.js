/**
 * Silent startup telemetry (backend only — no UI).
 *
 * After the GTFS startup sequence completes, reports one anonymous timing row
 * to the `transit_startup_timings` table:
 *   { device_id, app_version, platform, total_ms, stops_ms, schedules_ms }
 *
 * Everything here is fail-silent by design:
 * - If EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY are unset,
 *   every export no-ops (returns null) and makes zero network calls.
 * - reportStartupTiming never rejects; a hanging network is cut off by an
 *   internal timeout race (~8s) so it can never block app code.
 */

import { Platform } from 'react-native';
import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = (process.env.EXPO_PUBLIC_SUPABASE_URL || '').trim();
const SUPABASE_ANON_KEY = (process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '').trim();
const INSTALL_ID_KEY = 'telemetry-install-id';
const TIMINGS_TABLE = 'transit_startup_timings';
const REPORT_TIMEOUT_MS = 8000;

function isConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

function randomUuidV4() {
  // Math.random-based v4 UUID (no crypto dependency needed for an opaque id).
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Stable anonymous install id, generated once and persisted.
 * Returns null when telemetry is not configured or storage fails.
 */
export async function getInstallId() {
  if (!isConfigured()) return null;
  try {
    const existing = await AsyncStorage.getItem(INSTALL_ID_KEY);
    if (existing) return existing;
    const id = randomUuidV4();
    await AsyncStorage.setItem(INSTALL_ID_KEY, id);
    return id;
  } catch {
    return null;
  }
}

function getAppVersion() {
  try {
    const v =
      Constants?.expoConfig?.version ??
      Constants?.manifest?.version ??
      'unknown';
    return String(v || 'unknown');
  } catch {
    return 'unknown';
  }
}

function toMs(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
}

/**
 * Fire-and-forget safe: inserts one timing row. Never rejects, never throws.
 * Resolves null when unconfigured, on any error, or on timeout.
 */
export async function reportStartupTiming({ totalMs, stopsMs, schedulesMs } = {}) {
  if (!isConfigured()) return null;

  const run = (async () => {
    try {
      const deviceId = await getInstallId();
      if (!deviceId) return null;
      const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: false },
      });
      const { error } = await client.from(TIMINGS_TABLE).insert({
        device_id: deviceId,
        app_version: getAppVersion(),
        platform: String(Platform.OS || 'unknown'),
        total_ms: toMs(totalMs),
        stops_ms: toMs(stopsMs),
        schedules_ms: toMs(schedulesMs),
      });
      return error ? null : true;
    } catch {
      return null;
    }
  })();

  try {
    return await Promise.race([
      run,
      new Promise((resolve) => setTimeout(() => resolve(null), REPORT_TIMEOUT_MS)),
    ]);
  } catch {
    return null;
  }
}
