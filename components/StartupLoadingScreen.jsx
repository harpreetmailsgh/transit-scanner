import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Pressable, Share, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Ellipse } from 'react-native-svg';

import { getRealtimeDiagnostics } from '../services/gtfsRealtimeService';
import { getLastStartupTiming } from '../services/startupTelemetry';

const GO_GREEN = '#00853F';

// Splash step progress (item 4a): plain words for each startup step.
// Unknown or missing steps fall back to the previous generic line, so a
// bad step value can never blank or crash the screen.
const STARTUP_STEP_NAMES = {
  checking: 'Checking saved schedules…',
  downloading: 'Downloading schedules…',
  loading: 'Loading trips…',
  map: 'Getting the map ready…',
  ready: 'Ready',
};

function startupStepName(step) {
  try {
    return STARTUP_STEP_NAMES[String(step || '').trim().toLowerCase()] || null;
  } catch {
    return null;
  }
}

function derivePipelinePhase(message) {
  const text = String(message || '').toLowerCase();
  if (text.includes('loading cached go transit data')) return 'cache load';
  if (text.includes('preparing go transit data')) return 'prepare download';
  if (text.includes('downloading go transit data')) return 'download archive';
  if (text.includes('native unzip') || text.includes('unzip')) return 'native unzip';
  if (text.includes('reading stops & routes')) return 'read required files';
  if (text.includes('parsing schedules')) return 'parse stop_times';
  if (text.includes('persisting cache')) return 'cache persistence';
  if (text.includes('finalizing schedules')) return 'finalize startup';
  return 'startup';
}

export default function StartupLoadingScreen({
  errorMessage = '',
  progressPercent = 0,
  progressMessage = 'Loading GO Transit data...',
  startupStep = '',
  stalled = false,
  detailText = '',
  etaText = '',
  showLogAction = false,
  loadAttempt = 1,
  loadElapsedSeconds = 0,
  secondsSinceLastUpdate = 0,
  startupTrace = [],
  stopsReady = false,
  schedulesReady = false,
  stopsSource = 'none',
  servicePhase = 'idle',
  servicePhaseDetail = '',
  debugLogCaptured = false,
  debugLogPath = '',
  onRetry,
}) {
  const pinY = useRef(new Animated.Value(0)).current;
  const [shareState, setShareState] = useState('');
  const progress = Math.max(0, Math.min(1, Number(progressPercent) || 0));
  const pipelinePhase = useMemo(
    () => servicePhaseDetail || derivePipelinePhase(progressMessage),
    [progressMessage, servicePhaseDetail],
  );
  // Once the error card is showing, the loading lines must not claim work
  // is still in progress — the load has failed and only Retry restarts it.
  // Otherwise the on-screen line is the current startup step in plain
  // words; only when no step is known yet (e.g. stops bootstrap, before
  // the schedule load starts) does it fall back to the generic line.
  const stepName = errorMessage ? null : startupStepName(startupStep);
  const userMessage = errorMessage
    ? 'Something went wrong'
    : stepName ||
      (progress >= 1
        ? 'Opening map...'
        : 'Preparing your transit map');

  const diagnosticsText = useMemo(() => {
    const traceText = startupTrace.length ? startupTrace.join('\n') : '(no recent trace lines)';
    // Read live at render: the home screen re-renders every second while
    // this splash is visible, so these lines stay fresh through the
    // startup window. Post-ready diagnosis lives on the departures footer,
    // which subscribes to the same snapshot.
    const live = getRealtimeDiagnostics();
    const lastTiming = getLastStartupTiming();
    return [
      'Transit Scanner startup diagnostics',
      `attempt=${loadAttempt}`,
      `progress=${Math.round(progress * 100)}%`,
      `elapsed=${loadElapsedSeconds}s`,
      `since_last_update=${secondsSinceLastUpdate}s`,
      `stops_ready=${stopsReady ? 'yes' : 'no'}`,
      `schedules_ready=${schedulesReady ? 'yes' : 'no'}`,
      `stops_source=${stopsSource}`,
      `service_phase=${servicePhase}`,
      `phase=${pipelinePhase}`,
      `stage=${progressMessage || 'Loading...'}`,
      `stalled=${stalled ? 'yes' : 'no'}`,
      `live_last_updated=${live.lastUpdatedMs ? new Date(live.lastUpdatedMs).toISOString() : 'never'}`,
      `live_trips_with_data=${live.tripsWithLiveData}`,
      `live_consecutive_failures=${live.consecutiveFailures}`,
      `live_last_error=${live.lastError || 'none'}`,
      // Last launch's timings when a previous ready in this session
      // recorded them (null on a first launch — lines omitted).
      lastTiming ? `launch_total_ms=${lastTiming.totalMs}` : null,
      lastTiming ? `launch_stops_ms=${lastTiming.stopsMs}` : null,
      lastTiming ? `launch_schedules_ms=${lastTiming.schedulesMs}` : null,
      debugLogPath ? `debug_log=${debugLogPath}` : null,
      '',
      'trace:',
      traceText,
      errorMessage ? ['error:', String(errorMessage)] : null,
    ]
      .flat()
      .filter(Boolean)
      .join('\n');
  }, [
    debugLogPath,
    errorMessage,
    loadAttempt,
    loadElapsedSeconds,
    progress,
    progressMessage,
    pipelinePhase,
    schedulesReady,
    servicePhase,
    secondsSinceLastUpdate,
    stopsReady,
    stopsSource,
    stalled,
    startupTrace,
  ]);

  const handleShareDiagnostics = useMemo(
    () => async () => {
      try {
        await Share.share({ message: diagnosticsText });
        setShareState('Share sheet opened.');
      } catch {
        setShareState('Unable to share log.');
      }
    },
    [diagnosticsText],
  );

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pinY, {
          toValue: -14,
          duration: 520,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pinY, {
          toValue: 0,
          duration: 520,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );

    animation.start();
    return () => animation.stop();
  }, [pinY]);

  return (
    <View style={styles.container}>
      <Animated.View style={[styles.pinWrap, { transform: [{ translateY: pinY }] }]}>
        <Svg width={84} height={104} viewBox="0 0 90 110">
          <Ellipse cx="45" cy="100" rx="18" ry="7" fill="#000" opacity="0.18" />
          <Ellipse cx="45" cy="54" rx="24" ry="32" fill="#fff" />
          <Circle cx="45" cy="44" r="14" fill={GO_GREEN} />
          <Ellipse cx="45" cy="54" rx="24" ry="32" fill="none" stroke="#006837" strokeWidth="3" />
        </Svg>
      </Animated.View>

      <Text style={styles.title}>Transit Scanner</Text>
      <View style={styles.progressBarBg}>
        <View style={[styles.progressBar, { width: `${Math.round(progress * 100)}%` }]} />
      </View>
      <Text style={styles.loadingText}>{userMessage}</Text>
      {detailText && !errorMessage ? <Text style={styles.detailText}>{detailText}</Text> : null}
      {etaText && !errorMessage ? <Text style={styles.etaText}>{etaText}</Text> : null}

      {errorMessage ? (
        <View style={styles.errorCard}>
          <Text style={styles.errorTitle}>Transit data setup failed</Text>
          <Text numberOfLines={3} style={styles.errorMessage}>
            There was a problem loading transit schedules. Please share the error log.
          </Text>
          <View style={styles.errorActions}>
            <Pressable onPress={handleShareDiagnostics} style={styles.primaryBtn}>
              <Text style={styles.primaryBtnText}>Share Error Log</Text>
            </Pressable>
            <Pressable onPress={onRetry} style={styles.secondaryBtn}>
              <Text style={styles.secondaryBtnText}>Retry</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {showLogAction && !errorMessage ? (
        <View style={styles.logActionWrap}>
          <Pressable onPress={handleShareDiagnostics} style={styles.logActionBtn}>
            <Text style={styles.logActionBtnText}>Share Log</Text>
          </Pressable>
          {shareState ? <Text style={styles.shareStatus}>{shareState}</Text> : null}
        </View>
      ) : null}

      {stalled && !errorMessage ? (
        <Text style={styles.helperText}>Still working — this can take a while.</Text>
      ) : null}
      {debugLogCaptured ? (
        <Text style={styles.debugText}>
          Startup snapshot saved{debugLogPath ? `: ${debugLogPath}` : '.'}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: GO_GREEN,
    paddingHorizontal: 28,
    width: '100%',
    height: '100%',
  },
  pinWrap: {
    height: 112,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    color: '#fff',
    fontSize: 31,
    fontWeight: '800',
    marginTop: 20,
    marginBottom: 18,
  },
  progressBarBg: {
    width: 168,
    height: 8,
    borderRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.22)',
    overflow: 'hidden',
  },
  progressBar: {
    height: 8,
    borderRadius: 4,
    backgroundColor: '#fff',
  },
  loadingText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
    opacity: 0.94,
    marginTop: 16,
    textAlign: 'center',
  },
  detailText: {
    color: '#fff',
    fontSize: 13,
    opacity: 0.78,
    marginTop: 8,
    textAlign: 'center',
    maxWidth: 300,
  },
  etaText: {
    color: '#fff',
    fontSize: 12,
    opacity: 0.82,
    marginTop: 6,
    textAlign: 'center',
  },
  helperText: {
    color: '#fff',
    fontSize: 12,
    opacity: 0.72,
    marginTop: 12,
    textAlign: 'center',
    maxWidth: 300,
  },
  logActionWrap: {
    marginTop: 18,
    alignItems: 'center',
    minHeight: 56,
  },
  logActionBtn: {
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.72)',
    borderRadius: 8,
    paddingVertical: 9,
    paddingHorizontal: 18,
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  logActionBtnText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },
  shareStatus: {
    color: 'rgba(255,255,255,0.84)',
    fontSize: 11,
    marginTop: 8,
  },
  debugText: {
    color: '#fff',
    fontSize: 11,
    opacity: 0.82,
    marginTop: 10,
    textAlign: 'center',
    maxWidth: 320,
  },
  errorCard: {
    marginTop: 20,
    width: '100%',
    maxWidth: 360,
    backgroundColor: 'rgba(0,0,0,0.22)',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  errorTitle: {
    color: '#fff',
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 8,
  },
  errorMessage: {
    color: 'rgba(255,255,255,0.94)',
    fontSize: 13,
    textAlign: 'center',
    marginBottom: 12,
  },
  errorActions: {
    marginTop: 10,
    gap: 8,
  },
  primaryBtn: {
    backgroundColor: '#fff',
    borderRadius: 8,
    paddingVertical: 9,
    alignItems: 'center',
  },
  primaryBtnText: {
    color: GO_GREEN,
    fontWeight: '700',
  },
  secondaryBtn: {
    borderColor: 'rgba(255,255,255,0.7)',
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 9,
    alignItems: 'center',
  },
  secondaryBtnText: {
    color: '#fff',
    fontWeight: '700',
  },
});
