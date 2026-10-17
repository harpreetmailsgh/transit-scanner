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

import {
  invalidateActiveGtfsLoad,
  loadGtfs,
  getGtfsStartupDiagnostics,
  getStops as getStaticStops,
} from '../services/gtfsService';
import { loadBootstrapStops } from '../services/stopsBootstrapService';
import {
  startRealtimeUpdates,
  stopRealtimeUpdates,
} from '../services/gtfsRealtimeService';
import { resumeRideTracking } from '../services/rideTrackingService';
import { reconcileOnLaunch, refreshFromFeed } from '../services/liveActivityService';

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
    invalidateActiveGtfsLoad();
    setLoadAttempt((n) => n + 1);
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
          if (liveRefreshTimer) clearInterval(liveRefreshTimer);
          liveRefreshTimer = setInterval(() => {
            refreshFromFeed().catch(() => {});
          }, 60000);
          setProgressPercent(1);
          progressPercentRef.current = 1;
          setProgressMessage('Ready');
          setLastProgressAt(Date.now());
          appendStartupTrace('100% | ready');
          setSchedulesReady(true);
          setReady(true);
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
