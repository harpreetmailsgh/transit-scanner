/**
 * Trip Detail screen - shows the stop-by-stop timeline for a selected trip.
 * Opened from the Search screen result cards.
 * Lives at the root stack level (above tabs) so pressing Back returns to the
 * originating tab (Search, Saved, etc.) rather than the default Home tab.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  Linking,
  Platform,
  ScrollView,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import TripResultCard from '../components/TripResultCard';
import { DateTime } from 'luxon';

import { useGtfsData } from '../contexts/GtfsDataContext';
import { getTripSegmentServicePattern, getTripStops } from '../services/gtfsService';
import { getPlatformMatchForStop, getStopNextService } from '../services/metrolinxApiService';
import { getDelayForStop } from '../services/gtfsRealtimeService';
import {
  getTripSaveKey,
  isTripSaved,
  removeSavedTrip,
  saveTrip,
} from '../services/savedTripsService';
import { startForTrip, stopTracking, getActiveLiveSession } from '../services/liveActivityService';
import {
  startAlertsForTrip,
  stopAlerts,
  getRideAlertStatus,
  retryAlertPermissions,
} from '../services/rideTrackingService';

const GO_GREEN = '#00853F';
const STATUS_DELAYED = '#D22F27';
const TORONTO_TZ = 'America/Toronto';

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

function formatStopLiveTimeLabel(item, delayMinutes) {
  const scheduled = String(item?.arrival_time_label || '').trim();
  if (!scheduled) return '--';

  const hasDelay = Number.isFinite(delayMinutes) && Number(delayMinutes) > 0;
  const iso = String(item?.arrival_date_time || '').trim();
  if (!hasDelay || !iso) {
    return scheduled;
  }

  const liveDt = DateTime.fromISO(iso).plus({ minutes: Number(delayMinutes) });
  if (!liveDt.isValid) {
    return scheduled;
  }
  return liveDt.toFormat('h:mm a').toUpperCase();
}

function parseMetrolinxDateTime(value) {
  const raw = String(value || '').trim();
  if (!raw) return DateTime.invalid('missing datetime');

  let dt = DateTime.fromISO(raw, { zone: TORONTO_TZ });
  if (dt.isValid) return dt;

  dt = DateTime.fromSQL(raw, { zone: TORONTO_TZ });
  if (dt.isValid) return dt;

  return DateTime.invalid('unrecognized datetime format');
}

function extractTripNumber(tripId) {
  const parts = String(tripId || '').split('-');
  return parts.length ? parts[parts.length - 1] : '';
}

function normalizeServiceName(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  return raw.replace(/\s+line\b/g, '').replace(/\s+/g, ' ').trim();
}

function resolveStatusFromDelayMinutes(delayMinutes) {
  if (delayMinutes == null) return 'unknown';
  if (Number(delayMinutes) > 0) return 'delayed';
  return 'on-time';
}

function shiftClockLabel(label, shiftMinutes) {
  const minutes = parseClockLabelToMinutes(label);
  if (minutes == null || !Number.isFinite(shiftMinutes)) return label;

  const shifted = minutes + Number(shiftMinutes);
  const totalMin = ((shifted % 1440) + 1440) % 1440;
  const h24 = Math.floor(totalMin / 60);
  const mm = totalMin % 60;

  const h12 = h24 % 12 || 12;
  const meridiem = h24 < 12 ? 'AM' : 'PM';
  return `${h12}:${String(mm).padStart(2, '0')} ${meridiem}`;
}

function formatLiveStatusLabel(status, delayMinutes, departureLabel) {
  if (status === 'unknown') return 'Live: Unavlbl';
  if (status === 'on-time') return 'On-Time';
  const safeDelay = Math.max(1, Number(delayMinutes) || 0);
  const shifted = shiftClockLabel(departureLabel, safeDelay);
  return `Delayed (+${safeDelay} min) ${shifted}`;
}

function resolveStopDateTime(item, serviceDateYmd, firstStopMinutes) {
  const stopMin = parseClockLabelToMinutes(item?.arrival_time_label);
  if (serviceDateYmd && stopMin != null) {
    const anchor = DateTime.fromISO(serviceDateYmd, { zone: TORONTO_TZ }).startOf('day');
    if (anchor.isValid) {
      let dayOffset = 0;
      if (firstStopMinutes != null && stopMin < firstStopMinutes) {
        dayOffset = 1;
      }
      const hour24 = Math.floor(stopMin / 60);
      const minute = stopMin % 60;
      return anchor.plus({ days: dayOffset }).set({
        hour: hour24,
        minute,
        second: 0,
        millisecond: 0,
      });
    }
  }

  const iso = String(item?.arrival_date_time || '').trim();
  if (!iso) return null;
  const dt = DateTime.fromISO(iso, { zone: TORONTO_TZ });
  return dt.isValid ? dt : null;
}

function computeUpcomingStopIndex(stops, serviceDateYmd, delayMinutes) {
  if (!Array.isArray(stops) || !stops.length) return -1;

  const now = DateTime.now().setZone(TORONTO_TZ);
  const firstStopMinutes = parseClockLabelToMinutes(stops[0]?.arrival_time_label);
  const delay =
    Number.isFinite(Number(delayMinutes)) && Number(delayMinutes) > 0
      ? Number(delayMinutes)
      : 0;

  const originDateTime = resolveStopDateTime(stops[0], serviceDateYmd, firstStopMinutes);
  if (!originDateTime?.isValid || originDateTime.plus({ minutes: delay }) > now) {
    return -1;
  }

  for (let i = 1; i < stops.length; i += 1) {
    const stopDateTime = resolveStopDateTime(stops[i], serviceDateYmd, firstStopMinutes);
    if (!stopDateTime?.isValid) continue;
    if (stopDateTime.plus({ minutes: delay }) > now) {
      return i;
    }
  }

  return -1;
}

function computeMetrolinxFallbackDelayMinutes(lines, tripId, lineName, scheduledDateTime) {
  if (!Array.isArray(lines) || !lines.length) return null;

  const tripNumber = String(extractTripNumber(tripId) || '').trim();
  const wantedService = normalizeServiceName(lineName);
  const scheduledTarget = scheduledDateTime
    ? DateTime.fromISO(String(scheduledDateTime), { zone: TORONTO_TZ })
    : DateTime.invalid('missing schedule');

  const normalizeTrip = (v) => String(v || '').trim();
  const serviceMatch = (line) => {
    if (!wantedService) return true;
    return normalizeServiceName(line?.LineName).includes(wantedService);
  };

  const computeDelayFromLine = (line) => {
    const scheduled = parseMetrolinxDateTime(line?.ScheduledDepartureTime);
    const computed = parseMetrolinxDateTime(line?.ComputedDepartureTime);
    if (!scheduled.isValid || !computed.isValid) return null;
    return Math.round(computed.diff(scheduled, 'minutes').minutes);
  };

  if (tripNumber) {
    const byTrip = lines.find((line) => {
      if (normalizeTrip(line?.TripNumber) !== tripNumber) return false;
      return serviceMatch(line);
    });
    if (byTrip) {
      const delay = computeDelayFromLine(byTrip);
      if (delay != null) return delay;
    }
  }

  if (!scheduledTarget.isValid) return null;

  const targetMinute = scheduledTarget.toFormat('yyyy-MM-dd HH:mm');
  const byExactMinute = lines.find((line) => {
    if (!serviceMatch(line)) return false;
    const sched = parseMetrolinxDateTime(line?.ScheduledDepartureTime);
    if (!sched.isValid) return false;
    return sched.toFormat('yyyy-MM-dd HH:mm') === targetMinute;
  });

  if (byExactMinute) {
    const delay = computeDelayFromLine(byExactMinute);
    if (delay != null) return delay;
  }

  let nearest = null;
  let nearestDelta = Infinity;
  for (const line of lines) {
    if (!serviceMatch(line)) continue;
    const sched = parseMetrolinxDateTime(line?.ScheduledDepartureTime);
    if (!sched.isValid) continue;
    const delta = Math.abs(sched.diff(scheduledTarget, 'minutes').minutes);
    if (delta < nearestDelta) {
      nearestDelta = delta;
      nearest = line;
    }
  }

  if (nearest && nearestDelta <= 5) {
    return computeDelayFromLine(nearest);
  }

  return null;
}

export default function TripDetailScreen() {
  const {
    tripId,
    fromStopId,
    toStopId,
    fromStopName,
    toStopName,
    lineName,
    servicePattern,
    durationMinutes,
    stopsCount,
    departureTime,
    scheduledDateTime: scheduledDateTimeParam,
    arrivalTime,
    delayMinutes: delayParam,
    isBus: isBusParam,
    platformCode: platformCodeParam,
    liveStatus: liveStatusParam,
  } = useLocalSearchParams();

  const isBus = isBusParam === 'true';
  const platformCode = platformCodeParam && String(platformCodeParam).trim() ? String(platformCodeParam).trim() : null;
  const scheduledDateTime =
    scheduledDateTimeParam && String(scheduledDateTimeParam).trim()
      ? String(scheduledDateTimeParam).trim()
      : null;
  const serviceDate = scheduledDateTime ? String(scheduledDateTime).slice(0, 10) : '';
  const delayMinutes = delayParam !== '' && delayParam != null ? Number(delayParam) : null;
  const [liveDelayMinutes, setLiveDelayMinutes] = useState(delayMinutes);
  const [liveStatus, setLiveStatus] = useState(
    liveStatusParam || resolveStatusFromDelayMinutes(delayMinutes),
  );

  const [refreshing, setRefreshing] = useState(false);
  const [rtTick, setRtTick] = useState(0);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const upcomingBlink = useRef(new Animated.Value(0)).current;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { ready } = useGtfsData();

  const [stops, setStops] = useState(null);
  const [livePlatformCode, setLivePlatformCode] = useState(null);
  const [liveDestinationPlatformCode, setLiveDestinationPlatformCode] = useState(null);
  const [resolvedPattern, setResolvedPattern] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [tracking, setTracking] = useState(false);
  const [trackBusy, setTrackBusy] = useState(false);
  // Get-off alert status for THIS trip (from getRideAlertStatus — the strip's
  // only data source); null when this trip has no alert session.
  const [alertStatus, setAlertStatus] = useState(null);
  // A tracking session (card or alert) belonging to a DIFFERENT trip (UI-5).
  const [otherTracking, setOtherTracking] = useState(null);

  const departureIsoForPlatform =
    scheduledDateTime || (Array.isArray(stops) && stops[0]?.arrival_date_time ? String(stops[0].arrival_date_time) : null);
  const destinationIsoForPlatform =
    Array.isArray(stops) && stops.length && stops[stops.length - 1]?.arrival_date_time
      ? String(stops[stops.length - 1].arrival_date_time)
      : null;
  const displayPlatformCode = isBus ? null : livePlatformCode || platformCode;
  const displayDestinationPlatformCode = isBus ? null : liveDestinationPlatformCode || null;

  const refreshLiveData = useCallback(async () => {
    setRtTick((n) => n + 1);
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      setRtTick((n) => n + 1);
      setNowTick(Date.now());
    }, 30000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(upcomingBlink, {
          toValue: 1,
          duration: 650,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: false,
        }),
        Animated.timing(upcomingBlink, {
          toValue: 0,
          duration: 650,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: false,
        }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [upcomingBlink]);

  useEffect(() => {
    let mounted = true;

    const resolveLiveDelay = async () => {
      if (!ready || !tripId || !fromStopId) return;

      let nextDelayMinutes = null;

      const rtDelaySeconds = getDelayForStop(tripId, fromStopId);
      if (rtDelaySeconds !== undefined) {
        nextDelayMinutes = Math.round(Number(rtDelaySeconds) / 60);
      }

      if (nextDelayMinutes == null) {
        try {
          const lines = await getStopNextService(fromStopId);
          nextDelayMinutes = computeMetrolinxFallbackDelayMinutes(
            lines,
            tripId,
            lineName,
            scheduledDateTime,
          );
        } catch {
          nextDelayMinutes = null;
        }
      }

      if (!mounted) return;

      setLiveDelayMinutes(nextDelayMinutes);
      setLiveStatus(resolveStatusFromDelayMinutes(nextDelayMinutes));
    };

    resolveLiveDelay();

    return () => {
      mounted = false;
    };
  }, [ready, tripId, fromStopId, lineName, scheduledDateTime, rtTick]);

  useEffect(() => {
    if (!ready || !tripId) return;
    const data = getTripStops(tripId, fromStopId, toStopId || null);
    const pattern = getTripSegmentServicePattern(tripId, fromStopId, toStopId || null);
    setStops(data);
    setResolvedPattern(pattern);
  }, [ready, tripId, fromStopId, toStopId]);

  useEffect(() => {
    let mounted = true;
    const checkSaved = async () => {
      if (mounted) setSaved(false);
      if (!tripId || !fromStopId) return;
      const exists = await isTripSaved({
        fromStopId,
        toStopId: toStopId || '',
        departureTime,
        lineName,
        servicePattern: resolvedPattern || servicePattern || 'All Stops',
        isBus: isBus ? 'true' : 'false',
      });
      if (mounted) {
        setSaved(exists);
      }
    };
    checkSaved();
    return () => {
      mounted = false;
    };
  }, [tripId, fromStopId, toStopId, departureTime, lineName, resolvedPattern, servicePattern, isBus]);

  // UI-7: the single session-derivation. Derives BOTH halves — button state
  // from the live-activity session, strip state from the ride-alert status —
  // plus the different-trip session behind the UI-5 line. On Android there is
  // no card, so the alert session alone drives the button there.
  const refreshTrackingState = useCallback(async () => {
    let live = null;
    let ride = null;
    try {
      live = await getActiveLiveSession();
    } catch {
      live = null;
    }
    try {
      ride = await getRideAlertStatus();
    } catch {
      ride = null;
    }

    const isThisTrip = (s) => !!(s && tripId && String(s.tripId) === String(tripId));
    setTracking(isThisTrip(live) || isThisTrip(ride));
    setAlertStatus(isThisTrip(ride) ? ride : null);

    const other = [live, ride].find((s) => s && !isThisTrip(s)) || null;
    setOtherTracking(
      other
        ? {
            departureLabel: other.departureLabel || '',
            destinationName: other.destinationName || '',
          }
        : null,
    );
  }, [tripId]);

  // UI-7: derive on mount / trip change.
  useEffect(() => {
    refreshTrackingState();
  }, [refreshTrackingState]);

  // UI-7: re-derive on every realtime tick (30s interval above).
  useEffect(() => {
    if (rtTick === 0) return;
    refreshTrackingState();
  }, [rtTick, refreshTrackingState]);

  // UI-7: re-derive on screen focus. On Android this is also the Directive F
  // return path: if the user granted "Always" location in system Settings
  // while a session sits in `limited`, pick the grant up via
  // retryAlertPermissions (starts the background drivers) before re-deriving.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        if (Platform.OS === 'android' && tripId) {
          try {
            const status = await getRideAlertStatus();
            if (
              !cancelled &&
              status &&
              String(status.tripId) === String(tripId) &&
              status.alertState === 'limited' &&
              !status.backgroundEnabled
            ) {
              await retryAlertPermissions();
            }
          } catch {
            // Best-effort pickup; the re-derive below still runs.
          }
        }
        if (!cancelled) {
          refreshTrackingState();
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [tripId, refreshTrackingState]),
  );

  useEffect(() => {
    let mounted = true;
    const loadPlatform = async () => {
      if (isBus || !fromStopId || !departureIsoForPlatform) {
        if (mounted) {
          setLivePlatformCode(null);
          setLiveDestinationPlatformCode(null);
        }
        return;
      }
      try {
        const originMatch = await getPlatformMatchForStop({
          stopCode: fromStopId,
          scheduledDateTimeIso: departureIsoForPlatform,
          serviceName: lineName || '',
        });
        if (mounted) {
          setLivePlatformCode(originMatch?.platformCode || null);
        }

        if (!toStopId || !destinationIsoForPlatform) {
          if (mounted) setLiveDestinationPlatformCode(null);
          return;
        }

        const destinationMatch = await getPlatformMatchForStop({
          stopCode: toStopId,
          scheduledDateTimeIso: destinationIsoForPlatform,
          serviceName: lineName || '',
          preferredTripNumber: originMatch?.tripNumber || null,
        });
        if (mounted) {
          setLiveDestinationPlatformCode(destinationMatch?.platformCode || null);
        }
      } catch {
        if (mounted) {
          setLivePlatformCode(null);
          setLiveDestinationPlatformCode(null);
        }
      }
    };
    loadPlatform();
    return () => {
      mounted = false;
    };
  }, [isBus, fromStopId, toStopId, departureIsoForPlatform, destinationIsoForPlatform, lineName, rtTick]);

  const summary = useMemo(() => {
    const list = Array.isArray(stops) ? stops : [];
    const first = list[0] || null;
    const last = list[list.length - 1] || null;

    const fromName = String(fromStopName || '').trim() || first?.stop_name || '--';
    const toName = String(toStopName || '').trim() || last?.stop_name || '--';

    const departure = String(departureTime || '').trim() || first?.arrival_time_label || '--';
    const arrival = String(arrivalTime || '').trim() || last?.arrival_time_label || '--';

    const explicitStopsCount = Number(stopsCount);
    const resolvedStopsCount = Number.isFinite(explicitStopsCount) && explicitStopsCount > 0
      ? explicitStopsCount
      : Math.max(list.length - 1, 0);

    const explicitDuration = Number(durationMinutes);
    let resolvedDuration =
      Number.isFinite(explicitDuration) && explicitDuration > 0 ? explicitDuration : null;

    if (resolvedDuration == null && first && last) {
      const firstMin = parseClockLabelToMinutes(first.arrival_time_label);
      const lastMin = parseClockLabelToMinutes(last.arrival_time_label);
      if (firstMin != null && lastMin != null) {
        const diff = lastMin >= firstMin ? lastMin - firstMin : lastMin + 1440 - firstMin;
        if (diff >= 0) resolvedDuration = diff;
      }
    }

    return {
      fromName,
      toName,
      departure,
      arrival,
      stopsCount: resolvedStopsCount,
      duration: resolvedDuration,
    };
  }, [stops, fromStopName, toStopName, departureTime, arrivalTime, stopsCount, durationMinutes]);

  const upcomingStopIndex = useMemo(() => {
    const dateYmd = serviceDate || (scheduledDateTime ? String(scheduledDateTime).slice(0, 10) : '');
    return computeUpcomingStopIndex(stops, dateYmd, liveDelayMinutes);
  }, [stops, serviceDate, scheduledDateTime, liveDelayMinutes, nowTick]);

  const upcomingBlinkColor = useMemo(
    () =>
      upcomingBlink.interpolate({
        inputRange: [0, 1],
        outputRange: ['#111827', STATUS_DELAYED],
      }),
    [upcomingBlink],
  );

  // Directive E (iOS): each startForTrip failure reason gets its own outcome.
  // The iOS-16.2 message appears ONLY for the actual version case.
  // 'unsupported-platform' shows nothing (unreachable on iOS; the normal
  // alerts-only path on Android, where no card message ever appears).
  const showCardFailure = useCallback((reason) => {
    if (reason === 'ios-version') {
      Alert.alert('Live trip tracking needs iOS 16.2 or later.');
    } else if (reason === 'already-arrived' || reason === 'trip-ended') {
      Alert.alert('That train has already left.');
    } else if (reason !== 'unsupported-platform') {
      Alert.alert("Couldn't start tracking. Please try again.");
    }
  }, []);

  const handleTrackTrip = useCallback(async () => {
    if (!tripId || trackBusy) return;

    if (tracking) {
      // Orchestration step 4: one stop tap ends BOTH the card and the alert
      // session, then state is re-derived rather than assumed.
      setTrackBusy(true);
      try {
        await stopTracking();
      } catch {
        // stopTracking is best-effort; stopAlerts still runs below.
      }
      try {
        await stopAlerts('stopped');
      } catch {
        // stopAlerts never throws by contract; stay defensive anyway.
      }
      await refreshTrackingState();
      setTrackBusy(false);
      return;
    }

    setTrackBusy(true);
    try {
      // Orchestration step 1: the card starts first — it is never delayed by
      // any permission prompt (alert arming happens after, and its outcomes
      // land in the strip as states, never as modals).
      let result = null;
      try {
        result = await startForTrip({
          tripId,
          fromStopId,
          toStopId: toStopId || '',
          lineName: lineName || '',
          destinationName: summary.toName,
          departureLabel: summary.departure,
          departureTime: departureTime ? String(departureTime) : undefined,
          scheduledDateTime: scheduledDateTime || undefined,
        });
      } catch {
        result = { started: false, reason: 'error' };
      }

      const cardStarted = !!(result && result.started !== false);
      if (!cardStarted && Platform.OS !== 'android') {
        // Orchestration step 2 (iOS): Directive E outcome; do NOT arm alerts.
        showCardFailure(result.reason);
      } else {
        // Orchestration step 3: iOS card started, or Android (unsupported-
        // platform — no message, ever) → arm the get-off alerts. Show the
        // transient 'setting-up' state while arming resolves.
        setAlertStatus({
          tripId,
          alertState: 'setting-up',
          backgroundEnabled: false,
          staleFeed: false,
          destinationName: summary.toName,
          departureLabel: summary.departure,
        });
        try {
          await startAlertsForTrip({
            tripId,
            fromStopId,
            toStopId: toStopId || '',
            lineName: lineName || '',
            destinationName: summary.toName,
            departureLabel: summary.departure,
          });
        } catch {
          // startAlertsForTrip never throws by contract; the re-derive below
          // renders whatever session state actually persisted.
        }
      }
      await refreshTrackingState();
    } finally {
      setTrackBusy(false);
    }
  }, [
    tripId,
    fromStopId,
    toStopId,
    lineName,
    departureTime,
    scheduledDateTime,
    summary,
    tracking,
    trackBusy,
    showCardFailure,
    refreshTrackingState,
  ]);

  // Status-strip fix flow for the tappable variants (`limited` / `off`).
  const handleAlertStripPress = useCallback(async () => {
    if (!alertStatus || trackBusy) return;
    const state = alertStatus.alertState;
    if (state !== 'limited' && state !== 'off') return;

    // Directive F (Android `limited`): Android 11+ offers no in-app popup for
    // "Always" location — the tap opens the app's system Settings page; the
    // grant is picked up on return (focus re-derive). Android ≤ 10 still
    // allows the in-app request, which retryAlertPermissions runs.
    if (
      Platform.OS === 'android' &&
      state === 'limited' &&
      Number(Platform.Version) >= 30
    ) {
      try {
        await Linking.openSettings();
      } catch {
        // Nothing sensible to fall back to; the ask stays on the strip.
      }
      return;
    }

    let nextState = null;
    try {
      const res = await retryAlertPermissions();
      nextState = res?.alertState || null;
    } catch {
      nextState = null;
    }
    await refreshTrackingState();
    // Still stuck after the in-app retry (permanently denied) → Settings.
    if (nextState && nextState === state) {
      try {
        await Linking.openSettings();
      } catch {
        // Leave the strip as-is; the user can tap again.
      }
    }
  }, [alertStatus, trackBusy, refreshTrackingState]);

  const handleSaveTrip = useCallback(async () => {
    if (!tripId || !fromStopId || isSaving) return;

    try {
      setIsSaving(true);

      if (saved) {
        const key = getTripSaveKey({
          fromStopId,
          toStopId: toStopId || '',
          departureTime: summary.departure,
          lineName: lineName || 'GO',
          servicePattern: resolvedPattern || servicePattern || 'All Stops',
          isBus: isBus ? 'true' : 'false',
        });
        if (key) {
          await removeSavedTrip(key);
        }
        setSaved(false);
        return;
      }

      await saveTrip({
        tripId,
        fromStopId,
        toStopId: toStopId || '',
        fromStopName: summary.fromName,
        toStopName: summary.toName,
        lineName: lineName || 'GO',
        serviceDate,
        servicePattern: resolvedPattern || servicePattern || 'All Stops',
        durationMinutes: summary.duration,
        stopsCount: summary.stopsCount,
        departureTime: summary.departure,
        arrivalTime: summary.arrival,
        delayMinutes: liveDelayMinutes != null ? String(liveDelayMinutes) : '',
        isBus: isBus ? 'true' : 'false',
      });
      setSaved(true);
    } catch {
      Alert.alert('Could not update saved trip', 'Please try again.');
    } finally {
      setIsSaving(false);
    }
  }, [
    fromStopId,
    isBus,
    isSaving,
    lineName,
    liveDelayMinutes,
    serviceDate,
    resolvedPattern,
    servicePattern,
    summary,
    toStopId,
    tripId,
    saved,
  ]);

  const HeaderCard = useCallback(() => {
    const cardData = {
      ...summary,
      lineName,
      scheduledDateTime,
      scheduledTimeLabel: summary.departure,
      arrivalTimeAtTo: summary.arrival,
      delayMinutes: liveDelayMinutes,
      liveStatus,
      platformCode: displayPlatformCode,
      stopsCount: summary.stopsCount,
      durationMinutes: summary.duration,
      route_type: isBus ? 3 : 2,
    };
    return (
      <TripResultCard
        item={cardData}
        fromStop={{ stop_name: summary.fromName }}
        toStop={{ stop_name: summary.toName }}
        showPlatform={true}
        fromPlatform={displayPlatformCode}
        toPlatform={displayDestinationPlatformCode}
      />
    );
  }, [summary, lineName, scheduledDateTime, liveDelayMinutes, liveStatus, displayPlatformCode, displayDestinationPlatformCode, isBus]);

  const renderStop = useCallback(({ item, index }) => {
    const isEndpoint = item.isFrom || item.isTo;
    const isLast = stops && index === stops.length - 1;
    const isPast = upcomingStopIndex >= 0 && index < upcomingStopIndex;
    const isNext = upcomingStopIndex >= 0 && index === upcomingStopIndex;
    const timeText = formatStopLiveTimeLabel(item, liveDelayMinutes);
    const timeLabel = item.isFrom ? `Departs ${timeText}` : item.isTo ? `Arrives ${timeText}` : timeText;
    const rowPlatformCode = isBus ? null : (item.platformCode || (item.isFrom ? displayPlatformCode : null) || (item.isTo ? displayDestinationPlatformCode : null));
    const stopNameStyle = [
      isEndpoint ? styles.stopNameEndpoint : styles.stopNameIntermediate,
      isPast ? styles.stopNamePast : null,
    ];
    const timeStyle = [
      styles.stopTimeLabel,
      isPast ? styles.stopTimePast : null,
      isNext ? { color: upcomingBlinkColor } : null,
    ];
    const platformStyle = [
      styles.stopPlatformLabel,
      isPast ? styles.stopTimePast : null,
      isNext ? { color: upcomingBlinkColor } : null,
    ];
    const connectorAboveStyle = [
      styles.connectorLine,
      index === 0 && styles.connectorInvisible,
      isPast ? styles.connectorPast : null,
    ];
    const connectorBelowStyle = [
      styles.connectorLine,
      isLast && styles.connectorInvisible,
      isPast ? styles.connectorPast : null,
    ];
    const StopNameText = isNext ? Animated.Text : Text;
    const StopTimeText = isNext ? Animated.Text : Text;
    const PlatformText = isNext ? Animated.Text : Text;
    const StopNumberCircle = isNext ? Animated.View : View;
    const stopNumberCircleStyle = [
      styles.stopNumberCircle,
      isPast ? styles.stopNumberCirclePast : null,
      isNext ? { backgroundColor: upcomingBlinkColor, borderColor: upcomingBlinkColor } : null,
    ];
    const stopNumberTextStyle = [
      styles.stopNumberText,
      isPast ? styles.stopNumberTextPast : null,
      isNext ? styles.stopNumberTextNext : null,
    ];

    return (
      <View style={styles.stopRow} key={`${item.stop_id}-${index}`}>
        <View style={styles.timelineCol}>
          <View style={connectorAboveStyle} />
          <StopNumberCircle style={stopNumberCircleStyle}>
            <Text style={stopNumberTextStyle}>{index}</Text>
          </StopNumberCircle>
          <View style={connectorBelowStyle} />
        </View>

        <View style={styles.stopContent}>
          <View style={styles.stopMainRow}>
            <View style={styles.stopTitleWrap}>
              <StopNameText
                style={isNext ? [...stopNameStyle, { color: upcomingBlinkColor }] : stopNameStyle}
                numberOfLines={1}
              >
                {item.stop_name}
              </StopNameText>
            </View>
            <StopTimeText style={timeStyle} numberOfLines={1}>{timeLabel}</StopTimeText>
          </View>
          {rowPlatformCode ? <PlatformText style={platformStyle}>{`Platform ${rowPlatformCode}`}</PlatformText> : null}
        </View>
      </View>
    );
  }, [
    liveDelayMinutes,
    displayDestinationPlatformCode,
    displayPlatformCode,
    isBus,
    stops,
    upcomingStopIndex,
    upcomingBlinkColor,
  ]);

  const liveStatusLabel = useMemo(() => {
    return formatLiveStatusLabel(liveStatus, liveDelayMinutes, summary.departure);
  }, [liveStatus, liveDelayMinutes, summary.departure]);

  // Status strip content (Task U1 copy table). Null when this trip has no
  // alert session — the strip renders only from getRideAlertStatus data.
  const stripContent = useMemo(() => {
    if (!alertStatus) return null;
    const destination = alertStatus.destinationName || summary.toName;
    let line = null;
    let tappable = false;
    switch (alertStatus.alertState) {
      case 'setting-up':
        line = '🔔 Get-off alert: setting up…';
        break;
      case 'on':
        line = '🔔 Get-off alert on — buzzes 1 stop before';
        break;
      case 'limited':
        // Android `limited` is the Directive F ask; iOS keeps the fix copy.
        line =
          Platform.OS === 'android'
            ? '🔔 Alerts work only while the app is open — tap to turn on "Always" location'
            : '🔔 Get-off alert on while the app is open — tap to fix';
        tappable = true;
        break;
      case 'off':
        line = '🔔 Get-off alert off — tap to turn on';
        tappable = true;
        break;
      default:
        line = null;
    }
    if (!line) return null;
    return { line, tappable, staleFeed: !!alertStatus.staleFeed };
  }, [alertStatus, summary.toName]);

  // UI-5: a session for a different trip is disclosed, not silently replaced.
  const otherTrackingLine = useMemo(() => {
    if (!otherTracking) return null;
    const { departureLabel, destinationName } = otherTracking;
    if (!departureLabel && !destinationName) return null;
    if (!departureLabel) return `You're tracking a trip to ${destinationName}.`;
    if (!destinationName) return `You're tracking the ${departureLabel} trip.`;
    return `You're tracking the ${departureLabel} to ${destinationName}.`;
  }, [otherTracking]);

  const stripBody = stripContent ? (
    <>
      <Text style={styles.alertStripText}>{stripContent.line}</Text>
      {stripContent.staleFeed ? (
        <Text style={styles.alertStripSubText}>
          Live updates paused — get-off alert may be late
        </Text>
      ) : null}
    </>
  ) : null;

  return (
    <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}> 
      <StatusBar style="dark" />
      <View pointerEvents="none" style={styles.topTint} />

      <View style={styles.topActionsRow}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <MaterialIcons name="arrow-back" size={24} color={GO_GREEN} />
          <Text style={styles.backText}>Back</Text>
        </TouchableOpacity>

        <View style={styles.rightActions}>
          {tripId ? (
            <TouchableOpacity
              style={[styles.trackBtn, tracking && styles.trackBtnActive]}
              onPress={handleTrackTrip}
              disabled={trackBusy}
              activeOpacity={0.8}
            >
              {trackBusy ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <>
                  <MaterialIcons name={tracking ? 'stop' : 'my-location'} size={20} color="#fff" />
                  <Text style={styles.trackText}>
                    {tracking ? 'Tracking ✓ — tap to stop' : 'Buzz me before my stop'}
                  </Text>
                </>
              )}
            </TouchableOpacity>
          ) : null}

          <TouchableOpacity style={styles.saveBtn} onPress={handleSaveTrip} disabled={isSaving} activeOpacity={0.8}>
            {isSaving ? (
              <ActivityIndicator size="small" color={GO_GREEN} />
            ) : (
              <>
                <MaterialIcons name={saved ? 'bookmark' : 'bookmark-border'} size={20} color={GO_GREEN} />
                <Text style={styles.saveText}>{saved ? 'Saved' : 'Save'}</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      </View>

      {stripContent ? (
        stripContent.tappable ? (
          <TouchableOpacity
            style={styles.alertStrip}
            onPress={handleAlertStripPress}
            activeOpacity={0.8}
          >
            {stripBody}
          </TouchableOpacity>
        ) : (
          <View style={styles.alertStrip}>{stripBody}</View>
        )
      ) : null}

      {otherTrackingLine ? (
        <View style={styles.otherTrackingBar}>
          <Text style={styles.otherTrackingText}>{otherTrackingLine}</Text>
        </View>
      ) : null}

      <View style={styles.liveStatusBar}>
        <Text style={styles.liveStatusText}>{liveStatusLabel}</Text>
      </View>

      {stops === null ? (
        <View style={styles.loadingBox}>
          <ActivityIndicator size="large" color={GO_GREEN} />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={async () => {
                setRefreshing(true);
                await refreshLiveData();
                setRefreshing(false);
              }}
              colors={[GO_GREEN]}
              tintColor={GO_GREEN}
            />
          }
        >
          <HeaderCard />

          <View style={styles.sectionChip}>
            <Text style={styles.sectionChipText}>{`Stops (${stops.length})`}</Text>
          </View>

          <View style={styles.stopsCard}>
            {stops.map((item, i) => renderStop({ item, index: i }))}
          </View>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f2f2f7' },
  topTint: { position: 'absolute', top: 0, left: 0, right: 0, height: 160, backgroundColor: '#eef8f2' },
  topActionsRow: { marginTop: 4, marginLeft: 12, marginRight: 12, marginBottom: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rightActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  trackBtn: { minWidth: 82, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, backgroundColor: GO_GREEN, elevation: 3, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.12, shadowRadius: 4 },
  trackBtnActive: { backgroundColor: '#B91C1C' },
  trackText: { fontSize: 14, color: '#fff', fontWeight: '600' },
  liveStatusBar: {
    marginHorizontal: 12,
    marginBottom: 10,
    backgroundColor: '#ffffff',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  liveStatusText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#111827',
  },
  alertStrip: {
    marginHorizontal: 12,
    marginBottom: 10,
    backgroundColor: '#ffffff',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    minHeight: 44,
    justifyContent: 'center',
  },
  alertStripText: { fontSize: 14, fontWeight: '600', color: '#111827' },
  alertStripSubText: { marginTop: 2, fontSize: 13, color: '#6b7280' },
  otherTrackingBar: {
    marginHorizontal: 12,
    marginBottom: 10,
    paddingHorizontal: 12,
  },
  otherTrackingText: { fontSize: 13, color: '#374151', fontWeight: '600' },
  backBtn: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, gap: 4, borderRadius: 999, backgroundColor: '#fff', elevation: 3, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.12, shadowRadius: 4 },
  backText: { fontSize: 15, color: GO_GREEN, fontWeight: '600' },
  saveBtn: { minWidth: 82, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, backgroundColor: '#fff', elevation: 3, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.12, shadowRadius: 4 },
  saveText: { fontSize: 14, color: GO_GREEN, fontWeight: '600' },
  loadingBox: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  listContent: { paddingBottom: 28 },
  headerCard: { backgroundColor: '#fff', marginHorizontal: 12, marginBottom: 12, borderRadius: 18, borderWidth: 1, borderLeftWidth: 5, borderColor: '#e6eaef', padding: 14, elevation: 7, shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.12, shadowRadius: 14 },
  cardAccentBand: { marginHorizontal: -14, marginTop: -14, marginBottom: 14, paddingHorizontal: 14, paddingVertical: 12, borderTopLeftRadius: 18, borderTopRightRadius: 18 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  modeBadge: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  cardRouteMeta: { flexDirection: 'row', alignItems: 'center', flex: 1, gap: 10, paddingRight: 12 },
  cardRouteTextWrap: { flex: 1 },
  routeText: { flex: 1, fontSize: 16, fontWeight: '800', color: '#142013' },
  cardSubRouteText: { marginTop: 2, fontSize: 12, fontWeight: '600' },
  cardDateText: { fontSize: 12, fontWeight: '700', color: '#4b5563' },
  heroRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 14 },
  heroTimeBlock: { flex: 1 },
  heroTimeBlockRight: { alignItems: 'flex-end' },
  heroTimeLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase', color: '#7a7f87', marginBottom: 3 },
  heroTimeValue: { fontSize: 24, fontWeight: '800', color: '#111827' },
  heroDividerWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10 },
  heroDivider: { width: 18, height: 2, borderRadius: 999, opacity: 0.3 },
  journeyPathRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 14 },
  journeyPathStop: { flex: 1, fontSize: 14, fontWeight: '700', color: '#1f2937' },
  journeyPathCol: { flex: 1 },
  journeyPathColRight: { alignItems: 'flex-end' },
  journeyPathStopDestination: { textAlign: 'right' },
  platformInline: { marginTop: 2, fontSize: 14, color: '#2f6d49', fontWeight: '600' },
  platformInlineRight: { textAlign: 'right' },
  cardChipRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  infoChip: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, backgroundColor: '#f3f4f6' },
  infoChipText: { fontSize: 12, fontWeight: '700', color: '#374151' },
  sectionChip: { alignSelf: 'flex-start', marginHorizontal: 16, marginBottom: 8, backgroundColor: '#e6f5ec', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 },
  sectionChipText: { fontSize: 12, fontWeight: '700', color: '#2f6d49', textTransform: 'uppercase', letterSpacing: 0.4 },
  stopsCard: { backgroundColor: '#fff', marginHorizontal: 12, borderRadius: 14, paddingVertical: 4, elevation: 3, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.1, shadowRadius: 6 },
  stopRow: { flexDirection: 'row', marginHorizontal: 14 },
  timelineCol: { width: 32, alignItems: 'center' },
  connectorLine: { width: 2, flex: 1, minHeight: 10, backgroundColor: '#ddd' },
  connectorInvisible: { backgroundColor: 'transparent' },
  stopNumberCircle: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: '#111827',
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 2,
  },
  stopNumberCirclePast: { borderColor: '#cfd5dd', backgroundColor: '#fff' },
  stopNumberText: { fontSize: 11, lineHeight: 13, fontWeight: '800', color: '#111827' },
  stopNumberTextPast: { color: '#9ca3af' },
  stopNumberTextNext: { color: '#fff' },
  connectorPast: { backgroundColor: '#cfd5dd' },
  stopContent: { flex: 1, paddingVertical: 10 },
  stopMainRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  stopTitleWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, maxWidth: '60%' },
  stopNameEndpoint: { fontSize: 15, fontWeight: '800', color: '#1f2937' },
  stopNameIntermediate: { fontSize: 15, fontWeight: '700', color: '#374151' },
  stopNamePast: { color: '#9ca3af' },
  stopTimeLabel: { fontSize: 13, fontWeight: '700', color: '#111827' },
  stopTimePast: { color: '#9ca3af' },
  stopPlatformLabel: { marginTop: 2, fontSize: 12, color: '#2f6d49', fontWeight: '700' },
});
