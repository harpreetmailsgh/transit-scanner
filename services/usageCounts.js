/**
 * Anonymous usage counts: totals only, never anything about a person.
 *
 * Two tables in the dedicated "Transit Scanner" Supabase project:
 *   station_checks { station_name, line_name, day_type, time_bucket }
 *     (check_date is left to the server default — never sent)
 *   app_usage { event_type, screen_name }
 *     (event_date is left to the server default — never sent)
 *
 * What is NEVER in any payload: no id of any kind (no device id, no user
 * id, no install id), no timestamp, no name, email, account, location,
 * GPS, contacts, age, or gender. Favourites and saved trips are never
 * read here and never sent. Rows are counts, not histories: nothing in
 * a row can be traced back to one phone.
 *
 * Same discipline as startupTelemetry.js:
 * - If EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY are unset,
 *   every export no-ops and makes zero network calls.
 * - Rows queue in memory and flush quietly: when the queue reaches
 *   FLUSH_SIZE rows, or on a short timer. One attempt per batch — a
 *   failed batch (including an offline attempt, which simply fails) is
 *   dropped, never retried, never held for later.
 * - Nothing here blocks loading, shows anything to the user, or ever
 *   throws: every export is fail-silent.
 * - No online-check library is used (none is installed, and no new
 *   dependency is added): the insert attempt itself is the online check.
 *   While offline the attempt fails silently and the batch is dropped.
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = (process.env.EXPO_PUBLIC_SUPABASE_URL || '').trim();
const SUPABASE_ANON_KEY = (process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '').trim();
const STATION_CHECKS_TABLE = 'station_checks';
const APP_USAGE_TABLE = 'app_usage';
const FLUSH_SIZE = 10;
const FLUSH_INTERVAL_MS = 30000;
const REPORT_TIMEOUT_MS = 8000;
const MAX_QUEUE = 200;

function isConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

/**
 * Toronto clock for the viewed moment (day_type / time_bucket), without
 * adding a date library: Intl with the America/Toronto zone, falling back
 * to the device's local clock if Intl is unavailable.
 */
function getTorontoParts(date) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Toronto',
      weekday: 'long',
      hourCycle: 'h23',
      hour: 'numeric',
    }).formatToParts(date);
    const byType = {};
    for (const part of parts) byType[part.type] = part.value;
    const hour = Number(byType.hour);
    if (byType.weekday && Number.isFinite(hour)) {
      return { weekday: String(byType.weekday), hour };
    }
  } catch {
    // Fall through to the local-clock fallback below.
  }
  const days = [
    'Sunday',
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
  ];
  return { weekday: days[date.getDay()] || 'Monday', hour: date.getHours() };
}

export function getDayType(date = new Date()) {
  const { weekday } = getTorontoParts(date);
  return weekday === 'Saturday' || weekday === 'Sunday' ? 'weekend' : 'weekday';
}

/**
 * Time buckets (Toronto time, viewed moment):
 *   morning   05:00–12:00
 *   afternoon 12:00–17:00
 *   evening   17:00–21:00
 *   night     otherwise (21:00–05:00)
 */
export function getTimeBucket(date = new Date()) {
  const { hour } = getTorontoParts(date);
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 21) return 'evening';
  return 'night';
}

let queue = [];
let flushing = false;
let flushTimer = null;

function ensureFlushTimer() {
  if (flushTimer) return;
  try {
    flushTimer = setInterval(() => {
      flushUsageCounts().catch(() => {});
    }, FLUSH_INTERVAL_MS);
  } catch {
    // No timer — the size trigger still flushes. Never throws.
  }
}

function enqueue(table, row) {
  if (!isConfigured()) return;
  if (queue.length >= MAX_QUEUE) return;
  queue.push({ table, row });
  ensureFlushTimer();
  if (queue.length >= FLUSH_SIZE) {
    flushUsageCounts().catch(() => {});
  }
}

/**
 * Flushes the queued rows: one insert per table, one attempt each.
 * The snapshot is dropped from the queue before sending, so a failure
 * can never re-send or re-queue it. Never rejects, never throws.
 */
export async function flushUsageCounts() {
  if (!isConfigured() || flushing || queue.length === 0) return null;
  flushing = true;
  const batch = queue;
  queue = [];
  try {
    const byTable = new Map();
    for (const item of batch) {
      if (!byTable.has(item.table)) byTable.set(item.table, []);
      byTable.get(item.table).push(item.row);
    }
    const attempts = [];
    for (const [table, rows] of byTable) {
      const run = (async () => {
        try {
          const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
            auth: { persistSession: false },
          });
          await client.from(table).insert(rows);
        } catch {
          // Dropped with the batch. Fail-silent by design.
        }
        return null;
      })();
      attempts.push(
        Promise.race([
          run,
          new Promise((resolve) => setTimeout(() => resolve(null), REPORT_TIMEOUT_MS)),
        ]).catch(() => null),
      );
    }
    await Promise.all(attempts);
  } catch {
    // Batch already dropped; nothing to retry.
  } finally {
    flushing = false;
  }
  return null;
}

/**
 * One station_checks row for a departures view. The caller passes what
 * the departures screen actually has: the stop name from route params
 * and the first departure's line name. If either is missing, no row is
 * recorded — a line is never invented (a station with no departures
 * shown has no line to attribute the check to).
 */
export function recordStationCheck({ stationName, lineName, viewedAt } = {}) {
  if (!isConfigured()) return;
  const station = typeof stationName === 'string' ? stationName.trim() : '';
  const line = typeof lineName === 'string' ? lineName.trim() : '';
  if (!station || !line) return;
  const when = viewedAt instanceof Date ? viewedAt : new Date();
  enqueue(STATION_CHECKS_TABLE, {
    station_name: station,
    line_name: line,
    day_type: getDayType(when),
    time_bucket: getTimeBucket(when),
  });
}

/** One app_usage row per launch. Call at ready, alongside the timings report. */
export function recordAppOpen() {
  if (!isConfigured()) return;
  enqueue(APP_USAGE_TABLE, { event_type: 'open', screen_name: null });
}

/**
 * One app_usage row per screen view. Screen names: 'home', 'search',
 * 'trip-detail', 'departures'. Hooked on focus / load only — never on
 * realtime ticks or other re-renders, so a tick is not counted as a view.
 */
export function recordScreenView(screenName) {
  if (!isConfigured()) return;
  const name = typeof screenName === 'string' ? screenName.trim() : '';
  if (!name) return;
  enqueue(APP_USAGE_TABLE, { event_type: 'screen', screen_name: name });
}
