/**
 * Anonymous usage counts: totals only, never anything about a person.
 *
 * Two tables in the dedicated "Transit Scanner" Supabase project:
 *   station_checks { station_name, line_name, day_type, time_bucket }
 *     (check_date is left to the server default — never sent)
 *   app_usage { event_type, screen_name }
 *     (event_date is left to the server default — never sent)
 *   search_queries { query_text }
 *     (no date is sent — the row is just the typed query, counted)
 *
 * app_usage event types: 'open' (one per launch; screen_name null,
 *   saved_stops holds the saved-trips count when the caller passes one),
 * 'screen' (one per screen view), 'track_tap' (Track tapped on
 * trip-detail), 'alert_fired' (get-off alert buzzed), 'search_result_tap'
 * (a search suggestion or trip result tapped; screen_name 'station' or
 * 'trip'), 'live_fresh' / 'live_stale' (departures live data fresh or
 * stale), 'load_failed' (schedules or live data failed to load;
 * screen_name 'schedules' or 'live').
 *
 * What is NEVER in any payload: no id of any kind (no device id, no user
 * id, no install id), no timestamp, no name, email, account, location,
 * GPS, contacts, age, or gender. Favourites and saved trips are never
 * read here and never sent — only the COUNT of saved trips (a single
 * number, never which trips) is included in the 'open' row, and only
 * when the caller passes it. Search queries are the typed words only,
 * trimmed and lowercased — never who typed them. Rows are counts, not
 * histories: nothing in a row can be traced back to one phone.
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
const SEARCH_QUERIES_TABLE = 'search_queries';
const MAX_SEARCH_QUERY_LENGTH = 100;
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
 * shown has no line to attribute the check to). Optional mode
 * ('train' | 'bus') is included when given, so train and bus checks can
 * be counted separately; anything else is ignored.
 */
export function recordStationCheck({ stationName, lineName, viewedAt, mode } = {}) {
  if (!isConfigured()) return;
  const station = typeof stationName === 'string' ? stationName.trim() : '';
  const line = typeof lineName === 'string' ? lineName.trim() : '';
  if (!station || !line) return;
  const when = viewedAt instanceof Date ? viewedAt : new Date();
  const row = {
    station_name: station,
    line_name: line,
    day_type: getDayType(when),
    time_bucket: getTimeBucket(when),
  };
  if (mode === 'train' || mode === 'bus') row.mode = mode;
  enqueue(STATION_CHECKS_TABLE, row);
}

/** One app_usage row per launch. Call at ready, alongside the timings report. */
export function recordAppOpen(savedCount = null) {
  if (!isConfigured()) return;
  const row = { event_type: 'open', screen_name: null };
  if (typeof savedCount === 'number' && Number.isFinite(savedCount)) {
    row.saved_stops = savedCount;
  }
  enqueue(APP_USAGE_TABLE, row);
}

/**
 * Normalizes a typed search query for counting: trimmed, lowercased,
 * capped at 100 characters. Returns '' for empty or non-string input.
 * Pure — no config, no queue, no network — so it can be harnessed
 * in plain node.
 */
export function normalizeSearchQuery(text) {
  if (typeof text !== 'string') return '';
  return text.trim().toLowerCase().slice(0, MAX_SEARCH_QUERY_LENGTH);
}

/**
 * One search_queries row for a picked suggestion: the words the user
 * typed before picking, normalized. Only suggestion picks call this —
 * there is no submit handler for keyboard Enter. Empty after trim
 * records nothing.
 */
export function recordSearchQuery({ queryText } = {}) {
  if (!isConfigured()) return;
  const query = normalizeSearchQuery(queryText);
  if (!query) return;
  enqueue(SEARCH_QUERIES_TABLE, { query_text: query });
}

/** One app_usage row per Track tap on the trip-detail screen. */
export function recordTrackTap() {
  if (!isConfigured()) return;
  enqueue(APP_USAGE_TABLE, { event_type: 'track_tap', screen_name: 'trip-detail' });
}

/** One app_usage row per get-off alert that actually buzzed. */
export function recordAlertFired() {
  if (!isConfigured()) return;
  enqueue(APP_USAGE_TABLE, { event_type: 'alert_fired', screen_name: null });
}

/**
 * One app_usage row per search result tap: a picked station suggestion
 * ('station') or a trip result card ('trip'). Any other value records
 * nothing.
 */
export function recordSearchResultTap(resultType) {
  if (!isConfigured()) return;
  if (resultType !== 'station' && resultType !== 'trip') return;
  enqueue(APP_USAGE_TABLE, { event_type: 'search_result_tap', screen_name: resultType });
}

/** One app_usage row per departures live-data check: fresh or stale. */
export function recordLiveFreshness(isFresh) {
  if (!isConfigured()) return;
  enqueue(APP_USAGE_TABLE, {
    event_type: isFresh ? 'live_fresh' : 'live_stale',
    screen_name: 'departures',
  });
}

/**
 * One app_usage row per load failure: schedules ('schedules') or live
 * data ('live'). Any other value records nothing.
 */
export function recordLoadFailure(kind) {
  if (!isConfigured()) return;
  if (kind !== 'schedules' && kind !== 'live') return;
  enqueue(APP_USAGE_TABLE, { event_type: 'load_failed', screen_name: kind });
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
