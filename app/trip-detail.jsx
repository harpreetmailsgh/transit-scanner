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
import { recordScreenView, recordTrackTap } from '../services/usageCounts';
import { getTripSegmentServicePattern, getTripStops } from '../services/gtfsService';
import { getPlatformMatchForStop, getStopNextService } from '../services/metrolinxApiService';
import { getDelayForStop } from '../services/gtfsRealtimeService';
import {
  getTripSaveKey,
  isTripSaved,
  removeSavedTrip,
  saveTrip,
} from '../services/savedTripsService';
import { startForTrip, stopTracking, getActiveLiveSession, subscribeToLaDismissal, isLaEnabled } from '../services/liveActivityService';
import {
  startAlertsForTrip,
  stopAlerts,
  getRideAlertStatus,
  retryAlertPermissions,
  runLocationGate,
  getLocationPermissionStatuses,
  recheckAlertPermissions,
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
  // The stop this trip is currently tracked TO ('' = the trip's final stop,
  // the old top-button target). Set alongside `tracking` below.
  const [trackedStopId, setTrackedStopId] = useState('');
  // The stop whose Track button is mid-flight (spinner); all Track buttons
  // are disabled while any tracking op runs.
  const [pendingStopId, setPendingStopId] = useState(null);
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
    const thisSession = (isThisTrip(live) ? live : null) || (isThisTrip(ride) ? ride : null);
    setTrackedStopId(thisSession ? String(thisSession.toStopId || '') : '');
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

  // Anonymous usage count: one 'trip-detail' screen row per focus.
  // No UI, no state, no effect on the screen's own work. Kept separate
  // from the focus effect below so it never disturbs it.
  useFocusEffect(
    useCallback(() => {
      recordScreenView('trip-detail');
    }, []),
  );

  // UI-7: re-derive on screen focus. On Android this is also the Directive F
  // return path: if the user granted "Always" location in system Settings
  // while a session sits in `limited`, pick the grant up via the GET-ONLY
  // recheckAlertPermissions (starts the background drivers on an upgrade,
  // never prompts, never downgrades) before re-deriving.
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
              await recheckAlertPermissions();
            }
          } catch {
            // Best-effort pickup; the re-derive below still runs.
          }
        }
        // iOS dismissal cleanup (foreground check): under stop-everything,
        // a ride session without a card is never a legitimate resting
        // state on iOS — it means the card was dismissed while this screen
        // was not mounted (the module listener already cleared the live
        // session, but alerts are a separate session). Stop the alerts so
        // the button cannot stay green and the strip cannot linger; the
        // re-derive below then renders Default / absent. A live card for
        // this trip short-circuits this entirely.
        if (Platform.OS === 'ios' && tripId && !cancelled) {
          try {
            const ride = await getRideAlertStatus();
            const live = await getActiveLiveSession();
            const rideThis = ride && String(ride.tripId) === String(tripId);
            const liveThis = live && String(live.tripId) === String(tripId);
            if (rideThis && !liveThis) {
              await stopAlerts('stopped');
            }
          } catch {
            // Best-effort cleanup; the re-derive below still runs.
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

  // iOS: when our Live Activity is dismissed (user swiped the card away, or
  // iOS ended it), the service has already cleared the live session; this
  // stops the alerts too (stop-everything) and re-derives, so the button
  // returns to Default and the strip goes absent instead of claiming
  // tracked indefinitely. The service-level listener itself outlives this
  // screen; the focus cleanup above covers dismissals that happened while
  // this screen was not mounted.
  useEffect(() => {
    if (Platform.OS !== 'ios') return undefined;
    let sub = null;
    try {
      sub = subscribeToLaDismissal(() => {
        (async () => {
          try {
            await stopAlerts('stopped');
          } catch {
            // stopAlerts never throws by contract; stay defensive anyway.
          }
          refreshTrackingState();
        })();
      });
    } catch {
      sub = null;
    }
    return () => {
      try {
        sub?.remove?.();
      } catch {
        // best effort
      }
    };
  }, [refreshTrackingState]);

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

  // LA-denial message: replaces the generic 'Couldn't start tracking'
  // for the denial case only. The card cannot show without the
  // permission; Settings is where the Live Activities toggle lives, and a
  // later Track tap retries the card (no auto-restart).
  const showLaDeniedMessage = useCallback(() => {
    Alert.alert(
      'Live Activities are off',
      'Turn on Live Activities in Settings to track this trip on your Lock Screen.',
      [
        { text: 'Not now', style: 'cancel' },
        {
          text: 'Open Settings',
          onPress: () => {
            Linking.openSettings().catch(() => {});
          },
        },
      ],
    );
  }, []);
  // Pre-permission explainer (Harpreet's spec, 2026-11-02): on a Track tap
  // the gate shows this whenever location is NOT already Always-on,
  // regardless of notification or foreground state; it is skipped only
  // when Always is already granted. Wording names the exact option on each
  // OS's screen. Continue → the OS prompt runs (or Settings opens when
  // background is permanently denied); Not now → NO OS box at all, and the
  // tap aborts before any card or session exists (the rollback block below
  // stays only as a safety net for denial outcomes that reach arming).
  const showBackgroundExplainer = useCallback(
    () =>
      new Promise((resolve) => {
        const message =
          Platform.OS === 'android'
            ? 'Select Allow all the time on the next screen to alert you before your stop.'
            : 'Select Always Allow on the next screen to alert you before your stop.';
        Alert.alert('Location access needed', message, [
          { text: 'Not now', style: 'cancel', onPress: () => resolve(false) },
          { text: 'Continue', onPress: () => resolve(true) },
        ], { cancelable: false });
      }),
    [],
  );

  // Per-stop tracking: every upcoming stop row carries its own Track button.
  // Tapping a stop tracks TO that stop (the get-off alert fires 1 stop
  // before it); tapping the tracked stop stops tracking; tapping another
  // stop replaces the session — the services already enforce a single
  // session (startForTrip ends the current activity as 'replaced',
  // startAlertsForTrip ends the existing alert session first), so the
  // replacement the UI promises is the replacement the services perform.
  const handleTrackStop = useCallback(async (stop) => {
    if (!tripId || trackBusy || !stop?.stop_id) return;
    const stopId = String(stop.stop_id);
    const lastStopId =
      Array.isArray(stops) && stops.length ? String(stops[stops.length - 1].stop_id) : '';
    // An empty session value means the trip's final stop (the old
    // top-button target); no session means nothing is tracked.
    const effectiveTrackedId = tracking ? trackedStopId || lastStopId : '';

    if (effectiveTrackedId && effectiveTrackedId === stopId) {
      // Orchestration step 4: one stop tap ends BOTH the card and the alert
      // session, then state is re-derived rather than assumed.
      setTrackBusy(true);
      setPendingStopId(stopId);
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
      setPendingStopId(null);
      return;
    }

    setTrackBusy(true);
    setPendingStopId(stopId);
    try {
      // Orchestration step 1: the LOCATION GATE runs first, before anything
      // is started or replaced. Already Always-on → no explainer, no
      // prompt, straight through. Otherwise the explainer runs (regardless
      // of notification/foreground state). Not now, or a foreground denial
      // in its own prompt → abort here: no OS Always box, no Settings, no
      // card, no alert session, button stays Default, no strip. Continue
      // with background permanently denied → Settings opens and the tap
      // aborts; the grant is picked up on return by the next tap's get-only
      // check (or, for an existing limited session, the focus recheck).
      // The gate outcome is pre-resolved for arming below, so the
      // explainer and location prompts never re-fire for this tap.
      let locationGate = null;
      try {
        locationGate = await runLocationGate(showBackgroundExplainer);
      } catch {
        locationGate = { outcome: 'aborted', explainerShown: false };
      }
      if (!locationGate || locationGate.outcome === 'aborted') {
        return;
      }
      if (locationGate.outcome === 'needs-settings') {
        try {
          await Linking.openSettings();
        } catch {
          // Nothing sensible to fall back to; the user can tap again.
        }
        return;
      }
      // Orchestration step 2: only now does the card start. (Notifications
      // are checked last, inside arming, after the gate.)
      let result = null;
      try {
        result = await startForTrip({
          tripId,
          fromStopId,
          toStopId: stopId,
          lineName: lineName || '',
          destinationName: stop.stop_name,
          departureLabel: summary.departure,
          departureTime: departureTime ? String(departureTime) : undefined,
          scheduledDateTime: scheduledDateTime || undefined,
        });
      } catch {
        result = { started: false, reason: 'error' };
      }

      const cardStarted = !!(result && result.started !== false);
      // Orchestration step 3 (iOS): Directive E outcome — EXCEPT a Live
      // Activities denial, which stops EVERYTHING (final decision). A
      // denial is a failed start ('start-failed'/'error') PLUS the patched
      // native query reporting activities disabled (iOS does not re-prompt
      // on re-tap, so a denied re-tap fails the same way). On denial: no
      // alerts are armed, and any alert session is stopped too — the
      // failed start already replaced the old card, so stopping alerts as
      // well is what makes "nothing running" true (button Default, strip
      // absent). The LA-specific message replaces the generic failure for
      // this case only. Any other failure reason, or an unavailable query
      // (null), keeps the old generic outcome and arms nothing.
      let armAlerts = cardStarted || Platform.OS === 'android';
      if (!cardStarted && Platform.OS !== 'android') {
        const laDenied =
          (result?.reason === 'start-failed' || result?.reason === 'error') &&
          (await isLaEnabled()) === false;
        if (laDenied) {
          try {
            await stopAlerts('stopped');
          } catch {
            // stopAlerts never throws by contract; stay defensive anyway.
          }
          showLaDeniedMessage();
          armAlerts = false;
        } else {
          showCardFailure(result.reason);
        }
      }
      if (armAlerts) {
        // Orchestration step 4: iOS card started, or Android (unsupported-
        // platform — no message, ever) → arm the get-off alerts on the
        // pre-resolved gate outcome (no location prompt re-fires here;
        // notifications are checked last inside arming). Show the
        // transient 'setting-up' state while arming resolves.
        setAlertStatus({
          tripId,
          alertState: 'setting-up',
          backgroundEnabled: false,
          staleFeed: false,
          destinationName: stop.stop_name,
          departureLabel: summary.departure,
        });
        let alertsRes = null;
        try {
          alertsRes = await startAlertsForTrip({
            tripId,
            fromStopId,
            toStopId: stopId,
            lineName: lineName || '',
            destinationName: stop.stop_name,
            departureLabel: summary.departure,
            preResolvedGate: locationGate,
            onBeforeBackgroundRequest: showBackgroundExplainer,
          });
        } catch {
          // startAlertsForTrip never throws by contract; the re-derive below
          // renders whatever session state actually persisted.
        }
        // Fresh-tap denial rollback (safety net — the gate above already
        // aborts explainer-Not-now and foreground-denial taps before the
        // card starts): NO denial outcome may leave the button green. An
        // armed 'off' session (notifications denied — checked last, after
        // the gate) or a denial-'limited' session (Always denied in the OS
        // prompt) rolls back BOTH the just-started card and the
        // just-written alert session, so the button returns to Default and
        // no strip renders. Capability-
        // 'limited' (background unavailable on this device/build) is NOT
        // a denial and is preserved, as is any unarmed result (a data
        // failure, not a permission outcome — the old card-only state
        // stands). This also covers a replacement tap: the services have
        // already replaced the old session before the outcome is known,
        // so a denied replacement lands at Default rather than restoring
        // the previous session (no snapshot-restore is in scope).
        // One anonymous usage-count row per tap that successfully arms
        // tracking: armed, and the denial rollback below did NOT run.
        // The rollback condition is named once so the record rule and
        // the rollback can never drift apart.
        const denialRolledBack =
          alertsRes &&
          alertsRes.armed &&
          !alertsRes.backgroundCapabilityUnavailable &&
          (alertsRes.alertState === 'off' || alertsRes.alertState === 'limited');
        if (denialRolledBack) {
          try {
            await stopTracking();
          } catch {
            // best effort
          }
          try {
            await stopAlerts('stopped');
          } catch {
            // stopAlerts never throws by contract; stay defensive anyway.
          }
        } else if (alertsRes && alertsRes.armed) {
          recordTrackTap();
        }
      }
      await refreshTrackingState();
    } finally {
      setTrackBusy(false);
      setPendingStopId(null);
    }
  }, [
    tripId,
    fromStopId,
    lineName,
    departureTime,
    scheduledDateTime,
    summary,
    stops,
    tracking,
    trackedStopId,
    trackBusy,
    showCardFailure,
    showLaDeniedMessage,
    showBackgroundExplainer,
    refreshTrackingState,
  ]);

  // Status-strip fix flow for the tappable variants (`limited` / `off`).
  const handleAlertStripPress = useCallback(async () => {
    if (!alertStatus || trackBusy) return;
    const state = alertStatus.alertState;
    if (state !== 'limited' && state !== 'off') return;

    // Directive F (Android `limited`, Android 11+): no in-app popup for
    // "Always" location exists, so this branch goes through the explainer
    // first — Continue opens Settings, Not now opens nothing — instead of
    // opening Settings directly. The grant is picked up on return (the
    // get-only focus recheck). Exception: if background is already granted
    // (get-only read), fall through to the normal gated retry below, which
    // upgrades without an explainer. Android ≤ 10 still allows the in-app
    // request, which the gated retry runs.
    if (
      Platform.OS === 'android' &&
      state === 'limited' &&
      Number(Platform.Version) >= 30
    ) {
      let backgroundGranted = false;
      try {
        const statuses = await getLocationPermissionStatuses();
        backgroundGranted = statuses.background === 'granted';
      } catch {
        backgroundGranted = false;
      }
      if (!backgroundGranted) {
        let proceed = false;
        try {
          proceed = await showBackgroundExplainer();
        } catch {
          proceed = false;
        }
        if (proceed) {
          try {
            await Linking.openSettings();
          } catch {
            // Nothing sensible to fall back to; the ask stays on the strip.
          }
        }
        return;
      }
    }

    // Strip retry, identical gate to a Track tap: explainer first
    // (whenever background is not already granted), abort leaves the
    // session untouched, needs-settings opens Settings and leaves the
    // session untouched, and only a passed gate reaches the retry — which
    // reuses the pre-resolved outcome, so no prompt re-fires.
    let locationGate = null;
    try {
      locationGate = await runLocationGate(showBackgroundExplainer);
    } catch {
      locationGate = { outcome: 'aborted', explainerShown: false };
    }
    if (!locationGate || locationGate.outcome === 'aborted') {
      return;
    }
    if (locationGate.outcome === 'needs-settings') {
      try {
        await Linking.openSettings();
      } catch {
        // Leave the strip as-is; the user can tap again.
      }
      return;
    }

    let nextState = null;
    try {
      const res = await retryAlertPermissions({
        preResolvedGate: locationGate,
        onBeforeBackgroundRequest: showBackgroundExplainer,
      });
      nextState = res?.alertState || null;
    } catch {
      nextState = null;
    }
    await refreshTrackingState();
    // Still stuck after the in-app retry (permanently denied) → Settings,
    // but ONLY when the explainer actually ran for this tap (a granted-gate
    // retry that stays stuck must not auto-open Settings).
    if (nextState && nextState === state && locationGate.explainerShown) {
      try {
        await Linking.openSettings();
      } catch {
        // Leave the strip as-is; the user can tap again.
      }
    }
  }, [alertStatus, trackBusy, showBackgroundExplainer, refreshTrackingState]);

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
    // Per-stop Track: every stop after boarding that hasn't passed yet.
    // The boarding stop itself (isFrom) is never a destination.
    const isTrackedStop =
      tracking &&
      (trackedStopId ||
        (stops?.length ? String(stops[stops.length - 1].stop_id) : '')) === String(item.stop_id);
    const showTrack = !item.isFrom && !(upcomingStopIndex >= 0 && index < upcomingStopIndex);
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
          </View>
          <View style={styles.stopBottomRow}>
            <View style={styles.stopMetaWrap}>
              <StopTimeText style={timeStyle} numberOfLines={1}>{timeLabel}</StopTimeText>
              {rowPlatformCode ? (
                <PlatformText style={platformStyle}>{`Platform ${rowPlatformCode}`}</PlatformText>
              ) : null}
            </View>
            {showTrack ? (
              <TouchableOpacity
                style={[styles.stopTrackBtn, isTrackedStop && styles.stopTrackBtnActive]}
                onPress={() => handleTrackStop(item)}
                disabled={trackBusy}
                activeOpacity={0.8}
              >
                {pendingStopId === String(item.stop_id) ? (
                  <ActivityIndicator size="small" color={isTrackedStop ? '#fff' : '#D22F27'} />
                ) : (
                  <Text style={[styles.stopTrackText, isTrackedStop && styles.stopTrackTextActive]}>{isTrackedStop ? 'Tracking' : 'Track'}</Text>
                )}
              </TouchableOpacity>
            ) : null}
          </View>
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
    tracking,
    trackedStopId,
    pendingStopId,
    trackBusy,
    handleTrackStop,
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
        line = `🔔 Get-off alert on — buzzes 1 stop before ${destination}`;
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
  // Button states (decided): Default 'Track' = light grey bg + red font;
  // Tracking = GO_GREEN bg + white font, text 'Tracking' (no checkmark).
  // Spinner follows its button: red on Default, white on Tracking.
  stopTrackBtn: { minWidth: 64, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, backgroundColor: '#E5E7EB' },
  stopTrackBtnActive: { backgroundColor: GO_GREEN },
  stopTrackText: { fontSize: 13, color: '#D22F27', fontWeight: '700' },
  stopTrackTextActive: { color: '#fff' },
  stopBottomRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 2 },
  stopMetaWrap: { flexDirection: 'column', flex: 1, paddingRight: 8 },
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
  stopTitleWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 },
  stopNameEndpoint: { fontSize: 15, fontWeight: '800', color: '#1f2937' },
  stopNameIntermediate: { fontSize: 15, fontWeight: '700', color: '#374151' },
  stopNamePast: { color: '#9ca3af' },
  stopTimeLabel: { fontSize: 13, fontWeight: '700', color: '#111827' },
  stopTimePast: { color: '#9ca3af' },
  stopPlatformLabel: { marginTop: 2, fontSize: 12, color: '#2f6d49', fontWeight: '700' },
});
