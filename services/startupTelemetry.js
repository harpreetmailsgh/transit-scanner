/**
 * Startup telemetry: one silent backend report per successful launch, plus
 * an in-memory record of the last launch's timings for in-app display
 * (no storage, no network for the display path — it only re-reads values
 * already computed at ready).
 *
 * After the GTFS startup sequence completes, reports one anonymous timing row
 * to the `startup_timings` table in the dedicated "Transit Scanner" project:
 *   { app_version, platform, total_ms, stops_ms, schedules_ms }
 * (timing_date is left to the server default — never sent.)
 *
 * There is NO id of any kind in the payload: no device id, no user id, no
 * install id. Nothing here points at any other project's table.
 *
 * Everything here is fail-silent by design:
 * - If EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY are unset,
 *   every export no-ops (returns null) and makes zero network calls.
 * - reportStartupTiming never rejects; a hanging network is cut off by an
 *   internal timeout race (~8s) so it can never block app code.
 */

import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = (process.env.EXPO_PUBLIC_SUPABASE_URL || '').trim();
const SUPABASE_ANON_KEY = (process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '').trim();
const TIMINGS_TABLE = 'startup_timings';
const REPORT_TIMEOUT_MS = 8000;

function isConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
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
 * Last launch's timings, kept in memory only. The display path (context +
 * departures footer) reads these via getLastStartupTiming — no storage,
 * no network, no recomputation. A fresh app launch overwrites them at
 * ready; before the first ready they are null.
 */
let lastStartupTiming = null;

export function recordStartupTiming({ totalMs, stopsMs, schedulesMs } = {}) {
  const next = {
    totalMs: toMs(totalMs),
    stopsMs: toMs(stopsMs),
    schedulesMs: toMs(schedulesMs),
  };
  lastStartupTiming = next;
  return { ...next };
}

export function getLastStartupTiming() {
  return lastStartupTiming ? { ...lastStartupTiming } : null;
}

/**
 * Fire-and-forget safe: inserts one timing row. Never rejects, never throws.
 * Resolves null when unconfigured, on any error, or on timeout.
 */
export async function reportStartupTiming({ totalMs, stopsMs, schedulesMs } = {}) {
  if (!isConfigured()) return null;

  const run = (async () => {
    try {
      const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: false },
      });
      const { error } = await client.from(TIMINGS_TABLE).insert({
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
