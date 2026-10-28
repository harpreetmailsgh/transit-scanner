/**
 * Loads static GO GTFS once when the app opens (download or disk cache),
 * then starts the GTFS-RT polling loop. Screens read `ready` / `error` /
 * `progressMessage` from this context.
 *
 * Uses both a global timeout and a no-progress watchdog so startup stalls
 * surface as actionable errors instead of spinning indefinitely.
 */

import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import * as FileSystem from 'expo-file-system/legacy';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DateTime } from 'luxon';

import {
  invalidateActiveGtfsLoad,
  loadGtfs,
  getGtfsStartupDiagnostics,
  getStops as getStaticStops,
} from '../services/gtfsService';
import { ensureHostedSqlite } from '../services/gtfsSqliteService';
import { loadBootstrapStops } from '../services/stopsBootstrapService';
import {
  startRealtimeUpdates,
  stopRealtimeUpdates,
} from '../services/gtfsRealtimeService';
import { evaluateAlertsFromFeed, resumeRideTracking } from '../services/rideTrackingService';
import { reconcileOnLaunch, refreshFromFeed } from '../services/liveActivityService';
import { reportStartupTiming } from '../services/startupTelemetry';

/**
 * If loading takes longer than this, we fail with a visible error.
 * First run (fresh GTFS download + cache write) can take several minutes on
 * slower networks/devices, especially in release builds.
 */
const GTFS_LOAD_TIMEOUT_MS = 8 * 60 * 1000;
const GTFS_DEBUG_TIMEOUT_MS = 2 * 60 * 1000;
const GTFS_STALL_TIMEOUT_MS = 75 * 1000;
const GTFS_STALL_CHECK_INTERVAL_MS = 10 * 1000;
const GTFS_DEBUG_LOG_FILE = `${FileSystem.documentDirectory}gtfs-startup-debug-last.txt`;

const AUTOSTART_GEOFENCE_CLEANUP_KEY = 'autostart-geofence-cleanup-v1';
// Exact task name the removed auto-start service registered its geofences
// under (was its GEOFENCE_TASK constant).
const LEGACY_GEOFENCE_TASK = 'transitscanner-geofence-task';

/**
 * One-time cleanup for the scrapped auto-start feature: preview builds
 * registered station geofences on some devices, and those native regions
 * outlive the JS that defined their task. Unregister them once, at startup.
 * Best-effort by design — the flag is set before the native call so this
 * stays a true one-shot even when stopGeofencingAsync rejects (e.g. nothing
 * was ever registered on this device), and nothing here may throw.
 */
async function cleanupLegacyAutoStartGeofences() {
  try {
    const done = await AsyncStorage.getItem(AUTOSTART_GEOFENCE_CLEANUP_KEY);
    if (done) return;
    await AsyncStorage.setItem(AUTOSTART_GEOFENCE_CLEANUP_KEY, '1');
    await Location.stopGeofencingAsync(LEGACY_GEOFENCE_TASK);
  } catch {
    // Never let a legacy cleanup break or block startup.
  }
}

const GtfsDataContext = createContext({
  ready: false,
  stopsReady: false,
  schedulesReady: false,
  error: null,
  progressMessage: '',
  progressPercent: 0,
  loadStartAt: 0,
  lastProgressAt: 0,
  loadAttempt: 0,
  startupTrace: [],
  startupStops: [],
  stopsSource: 'none',
  debugLogPath: null,
  debugLogCaptured: false,
  retryLoad: () => {},
});

function mapProgressMessageToPercent(message, currentPercent) {
  const msg = String(message || '').toLowerCase();

  const stagedPercentages = [
    { includes: 'loading cached go transit data', value: 0.2 },
    { includes: 'loading go transit data', value: 0.1 },
    { includes: 'reading stops & routes', value: 0.35 },
    { includes: 'parsing schedules', value: 0.6 },
    { includes: 'parsing route shapes', value: 0.72 },
    { includes: 'saving cache', value: 0.9 },
  ];

  for (const stage of stagedPercentages) {
    if (msg.includes(stage.includes)) {
      return Math.max(currentPercent, stage.value);
    }
  }

  // Unknown message: nudge forward a little while keeping room for completion.
  return Math.min(0.95, Math.max(currentPercent, currentPercent + 0.03));
}

export function useGtfsData() {
  return useContext(GtfsDataContext);
}

export function GtfsDataProvider({ children }) {
  const [ready, setReady] = useState(false);
  const [stopsReady, setStopsReady] = useState(false);
  const [schedulesReady, setSchedulesReady] = useState(false);
  const [error, setError] = useState(null);
  const [progressMessage, setProgressMessage] = useState('');
  const [progressPercent, setProgressPercent] = useState(0);
  const [loadStartAt, setLoadStartAt] = useState(0);
  const [lastProgressAt, setLastProgressAt] = useState(0);
  const [startupTrace, setStartupTrace] = useState([]);
  const [startupStops, setStartupStops] = useState([]);
  const [stopsSource, setStopsSource] = useState('none');
  const [servicePhase, setServicePhase] = useState('idle');
  const [servicePhaseDetail, setServicePhaseDetail] = useState('(not started)');
  const [debugLogPath, setDebugLogPath] = useState(null);
  const [debugLogCaptured, setDebugLogCaptured] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const lastProgressRef = useRef('(starting)');
  const progressPercentRef = useRef(0);
  const startupTraceRef = useRef([]);
  const finishedRef = useRef(false);
  const telemetryReportedRef = useRef(false);
  const recoveryInFlightRef = useRef(false);

  const appendStartupTrace = React.useCallback((line) => {
    const timestamp = new Date().toISOString();
    const full = `${timestamp} | ${line}`;
    const next = [...startupTraceRef.current, full];
    // Keep only the most recent entries so error text stays readable.
    startupTraceRef.current = next.slice(-45);
    // Keep a short visible trace feed for startup diagnostics UI.
    setStartupTrace(startupTraceRef.current.slice(-8));
  }, []);

  const syncServiceDiagnostics = React.useCallback(() => {
    const diag = getGtfsStartupDiagnostics();
    if (!diag) return;
    setServicePhase(diag.phase || 'idle');
    setServicePhaseDetail(diag.phaseDetail || '(not started)');
  }, []);

  const retryLoad = React.useCallback(() => {
    // B5 recovery: a retry from the error screen must not just re-run the
    // local-first load. On an existing install past a month boundary the
    // local core/month DBs are valid but lack the covering week, so the
    // load throws the loud zero-trips error again and the user is trapped
    // until reinstall. Run a manifest-backed ensure FIRST (best-effort):
    // with today as a requested date it downloads the covering week when
    // the month span does not cover today, without re-downloading
    // core/month. The load below then finds the week locally and succeeds.
    // If the ensure fails (offline, manifest unavailable), proceed to the
    // load anyway — it throws the real error again, never a silent
    // 0-stops screen. Taps while a recovery ensure is in flight are
    // ignored, so rapid taps cannot stack ensures or loads; each tap is
    // one ensure + one load, and nothing retries automatically.
    if (recoveryInFlightRef.current) return;
    recoveryInFlightRef.current = true;
    invalidateActiveGtfsLoad();
    // Same Toronto-date computation as gtfsService's torontoTodayYmd
    // (same library, zone, and format), so the requested date matches the
    // load path's startup dates exactly.
    const today = DateTime.now().setZone('America/Toronto').toFormat('yyyyMMdd');
    ensureHostedSqlite({ requestedDates: [today] })
      .catch(() => {})
      .finally(() => {
        recoveryInFlightRef.current = false;
        setLoadAttempt((n) => n + 1);
      });
  }, []);

  useEffect(() => {
    let cancelled = false;
    let liveRefreshTimer = null;
    const startedAt = Date.now();

    setReady(false);
    setStopsReady(false);
    setSchedulesReady(false);
    setError(null);
    setProgressPercent(0);
    progressPercentRef.current = 0;
    setProgressMessage('Loading stops...');
    setLoadStartAt(startedAt);
    setLastProgressAt(startedAt);
    setStartupTrace([]);
    setStartupStops([]);
    setStopsSource('none');
    setDebugLogPath(null);
    setDebugLogCaptured(false);
    finishedRef.current = false;
    telemetryReportedRef.current = false;
    startupTraceRef.current = [];
    appendStartupTrace('load started');
    syncServiceDiagnostics();

    const run = async () => {
      resumeRideTracking().catch(() => {
        // Keep app usable even if background ride tracking resume fails.
      });

      let localStopsReady = false;
      let lastProgressTickMs = Date.now();
      let loadTimeoutId = null;
      let stallMonitorId = null;
      let stalledRejected = false;
      let phasePollId = null;

      try {
        try {
          const bootstrap = await loadBootstrapStops({
            onTrace: (message) => {
              appendStartupTrace(`-- | ${message}`);
            },
          });

          if (!cancelled) {
            setStartupStops(Array.isArray(bootstrap?.stops) ? bootstrap.stops : []);
            setStopsSource(bootstrap?.source || 'none');
            setStopsReady(true);
            localStopsReady = true;
            setProgressPercent((prev) => Math.max(prev, 0.1));
            progressPercentRef.current = Math.max(progressPercentRef.current, 0.1);
            setProgressMessage('Stops ready. Syncing schedules in background...');
            setLastProgressAt(Date.now());
            appendStartupTrace(`10% | stops ready (${bootstrap?.source || 'unknown'})`);
          }
        } catch (bootstrapErr) {
          appendStartupTrace(`-- | stops bootstrap unavailable (${bootstrapErr?.message || 'unknown error'})`);
        }

        // Telemetry: stops phase done (silent, backend only).
        const stopsDoneAt = Date.now();

        phasePollId = setInterval(() => {
          if (!cancelled) syncServiceDiagnostics();
        }, 1000);

        const globalTimeoutPromise = new Promise((_, reject) => {
          loadTimeoutId = setTimeout(() => {
            reject(
              new Error(
                `Timed out after ${Math.round(GTFS_LOAD_TIMEOUT_MS / 60000)} minutes while loading GO Transit data.\n\n` +
                  `Last progress: ${lastProgressRef.current}\n\n` +
                  `Open the Metro terminal (or Expo dev tools) and search logs for "[TransitScanner][gtfsService]" ` +
                  `to see download / unzip / parse steps.`,
              ),
            );
          }, GTFS_LOAD_TIMEOUT_MS);
        });

        const stallPromise = new Promise((_, reject) => {
          stallMonitorId = setInterval(() => {
            if (cancelled || finishedRef.current || stalledRejected) return;
            const stalledForMs = Date.now() - lastProgressTickMs;
            if (stalledForMs < GTFS_STALL_TIMEOUT_MS) return;
            stalledRejected = true;
            reject(
              new Error(
                `Loading appears stalled for ${Math.round(stalledForMs / 1000)}s at: ${lastProgressRef.current}. ` +
                  `Please retry. If this keeps happening, check logs for "[TransitScanner][gtfsService]".`,
              ),
            );
          }, GTFS_STALL_CHECK_INTERVAL_MS);
        });

        await Promise.race([
          loadGtfs({
            onSchedulesReady: () => {
              if (!cancelled) {
                setSchedulesReady(true);
                appendStartupTrace('75% | startup schedules ready');
              }
            },
            onProgress: (update) => {
              const m =
                (typeof update === 'string' ? update : update?.message) ||
                lastProgressRef.current;
              const rawPercent = typeof update === 'object' ? Number(update?.percent) : NaN;
              const hasRawPercent = Number.isFinite(rawPercent);
              const tracePercent = hasRawPercent
                ? `${Math.round(Math.max(0, Math.min(1, rawPercent)) * 100)}%`
                : '--';
              lastProgressRef.current = m;
              appendStartupTrace(`${tracePercent} | ${m}`);
              if (!cancelled) {
                if (!localStopsReady) {
                  const warmStops = getStaticStops();
                  if (Array.isArray(warmStops) && warmStops.length) {
                    localStopsReady = true;
                    setStartupStops(warmStops);
                    setStopsSource('static-warmup');
                    setStopsReady(true);
                    appendStartupTrace(`10% | stops ready (static-warmup)`);
                  }
                }

                lastProgressTickMs = Date.now();
                setProgressMessage(m);
                setLastProgressAt(Date.now());
                setProgressPercent((prev) => {
                  if (hasRawPercent) {
                    const clamped = Math.max(0, Math.min(1, rawPercent));
                    progressPercentRef.current = Math.max(prev, clamped);
                    return Math.max(prev, clamped);
                  }
                  const next = mapProgressMessageToPercent(m, prev);
                  progressPercentRef.current = next;
                  return next;
                });
              }
            },
          }),
          globalTimeoutPromise,
          stallPromise,
        ]);

        // Telemetry: schedules phase done (silent, backend only).
        const schedulesDoneAt = Date.now();

        if (!cancelled) {
          if (!localStopsReady) {
            const scheduleStops = getStaticStops();
            setStartupStops(scheduleStops);
            setStopsSource('static-schedule');
            setStopsReady(true);
            localStopsReady = true;
          }
          startRealtimeUpdates();
          // Live Activity: reconcile any orphaned activity from a previous
          // run, then keep the active one fresh on a 60s tick (the service
          // itself throttles native updates to max once per 60s).
          reconcileOnLaunch().catch(() => {});
          // Auto-start was removed in v1.2: one-time cleanup unregisters
          // any station geofences it left registered on this device.
          cleanupLegacyAutoStartGeofences().catch(() => {});
          if (liveRefreshTimer) clearInterval(liveRefreshTimer);
          liveRefreshTimer = setInterval(() => {
            refreshFromFeed().catch(() => {});
            evaluateAlertsFromFeed().catch(() => {});
          }, 60000);
          setProgressPercent(1);
          progressPercentRef.current = 1;
          setProgressMessage('Ready');
          setLastProgressAt(Date.now());
          appendStartupTrace('100% | ready');
          setSchedulesReady(true);
          setReady(true);
          // Telemetry: one silent backend report per successful ready (no UI).
          if (!telemetryReportedRef.current) {
            telemetryReportedRef.current = true;
            const readyAt = Date.now();
            reportStartupTiming({
              totalMs: readyAt - startedAt,
              stopsMs: stopsDoneAt - startedAt,
              schedulesMs: schedulesDoneAt - stopsDoneAt,
            }).catch(() => {});
          }
          finishedRef.current = true;
        }
      } catch (e) {
        if (!cancelled) {
          invalidateActiveGtfsLoad();
          const message = e instanceof Error ? e.message : String(e);
          const details =
            e && typeof e === 'object' && e.details
              ? `\n\nError details:\n${JSON.stringify(e.details, null, 2)}`
              : '';
          const traceDump = startupTraceRef.current.length
            ? `\n\nStartup trace (newest last):\n${startupTraceRef.current.join('\n')}`
            : '';
          const stack = e instanceof Error && e.stack ? `\n\n---\n${e.stack}` : '';
          setProgressMessage(localStopsReady ? 'Schedules sync failed' : 'Load failed');
          setLastProgressAt(Date.now());
          setError(message + details + traceDump + stack);
          finishedRef.current = !localStopsReady;
        }
      } finally {
        if (loadTimeoutId) clearTimeout(loadTimeoutId);
        if (stallMonitorId) clearInterval(stallMonitorId);
        if (phasePollId) clearInterval(phasePollId);
      }
    };

    const debugTimer = setTimeout(() => {
      if (cancelled || finishedRef.current) return;
      const snapshot = startupTraceRef.current.length
        ? startupTraceRef.current.join('\n')
        : '(no trace lines recorded)';
      const body = [
        'Transit Scanner GTFS startup watchdog snapshot',
        `capturedAt=${new Date().toISOString()}`,
        `loadAttempt=${loadAttempt}`,
        `lastProgress=${lastProgressRef.current}`,
        `progressPercent=${Math.round((Number(progressPercentRef.current) || 0) * 100)}%`,
        '',
        'trace:',
        snapshot,
      ].join('\n');

      FileSystem.writeAsStringAsync(GTFS_DEBUG_LOG_FILE, body)
        .then(() => {
          if (!cancelled) {
            setDebugLogPath(GTFS_DEBUG_LOG_FILE);
            setDebugLogCaptured(true);
            setProgressMessage('Startup is taking longer than expected. Debug log captured.');
            setLastProgressAt(Date.now());
          }
        })
        .catch(() => {
          if (!cancelled) {
            setDebugLogCaptured(true);
            setProgressMessage('Startup is taking longer than expected. Debug log capture failed.');
            setLastProgressAt(Date.now());
          }
        });
    }, GTFS_DEBUG_TIMEOUT_MS);

    run();

    return () => {
      cancelled = true;
      clearTimeout(debugTimer);
      if (liveRefreshTimer) clearInterval(liveRefreshTimer);
      stopRealtimeUpdates();
    };
  }, [appendStartupTrace, loadAttempt, syncServiceDiagnostics]);

  const value = useMemo(
    () => ({
      ready,
      stopsReady,
      schedulesReady,
      error,
      progressMessage,
      progressPercent,
      loadStartAt,
      lastProgressAt,
      loadAttempt,
      startupTrace,
      startupStops,
      stopsSource,
      servicePhase,
      servicePhaseDetail,
      debugLogPath,
      debugLogCaptured,
      retryLoad,
    }),
    [
      ready,
      stopsReady,
      schedulesReady,
      error,
      progressMessage,
      progressPercent,
      loadStartAt,
      lastProgressAt,
      loadAttempt,
      startupTrace,
      startupStops,
      stopsSource,
      servicePhase,
      servicePhaseDetail,
      debugLogPath,
      debugLogCaptured,
      retryLoad,
    ],
  );

  return (
    <GtfsDataContext.Provider value={value}>{children}</GtfsDataContext.Provider>
  );
}
