import { Platform } from 'react-native';
import SleekHeaderBar from '../../components/SleekHeaderBar';
/**
 * Search screen - find trips from a stop, optionally filtered to a destination.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialCommunityIcons, MaterialIcons } from '@expo/vector-icons';
import TripResultCard from '../../components/TripResultCard';
import { useRouter } from 'expo-router';
import { DateTime } from 'luxon';

import { useGtfsData } from '../../contexts/GtfsDataContext';
import {
  ensureSchedulesForDate,
  getTripsFromToForDate,
  searchStops,
  getDeparturesForDate,
  getStopRouteTypes,
  getPlanningDateBounds,
  getTripStops,
} from '../../services/gtfsService';
import { getLiveDepartures, getDelayForStop, getTripIdsWithLiveUpdates } from '../../services/gtfsRealtimeService';
import { getStopNextService } from '../../services/metrolinxApiService';

const GO_GREEN = '#00853F';
const STATUS_ON_TIME = '#00853F';
const STATUS_DELAYED = '#D22F27';
const STATUS_UNKNOWN = '#6B7280';
const BUS_ROUTE_TYPE = 3;
const SEARCH_CANDIDATE_LIMIT_TRAIN = 60;
const SEARCH_CANDIDATE_LIMIT_BUS = 200;

function parseMetrolinxDateTime(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  let dt = DateTime.fromISO(raw, { zone: 'America/Toronto' });
  if (dt.isValid) return dt;
  dt = DateTime.fromSQL(raw, { zone: 'America/Toronto' });
  if (dt.isValid) return dt;
  return null;
}

function extractTripNumber(tripId) {
  const parts = String(tripId || '').split('-');
  return parts.length ? parts[parts.length - 1] : '';
}

// Helpers

function StatusPill({ status, onTimeLabel = 'On-Time', delayLabel, unknownLabel = 'Live unavailable' }) {
  const isDelayed = status === 'delayed';
  const isUnknown = status === 'unknown';
  return (
    <View
      style={
        isDelayed
          ? pillStyles.pillDelayed
          : isUnknown
            ? pillStyles.pillUnknown
            : pillStyles.pillOnTime
      }
    >
      <Text style={pillStyles.pillText}>
        {isDelayed ? delayLabel : isUnknown ? unknownLabel : onTimeLabel}
      </Text>
    </View>
  );
}

const pillStyles = StyleSheet.create({
  pillOnTime: {
    backgroundColor: GO_GREEN,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  pillDelayed: {
    backgroundColor: STATUS_DELAYED,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  pillUnknown: {
    backgroundColor: STATUS_UNKNOWN,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  pillText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
  },
});

function MonthCalendar({
  visibleMonth,
  selectedYmd,
  minYmd,
  maxYmd,
  onSelect,
  onMonthChange,
}) {
  const monthStart = visibleMonth.startOf('month');
  const monthLabel = monthStart.toFormat('MMMM yyyy');
  const gridStart = monthStart.startOf('week');
  const cells = [];
  let cursor = gridStart;
  for (let i = 0; i < 42; i += 1) {
    cells.push(cursor);
    cursor = cursor.plus({ days: 1 });
  }

  const prevMonth = monthStart.minus({ months: 1 });
  const nextMonth = monthStart.plus({ months: 1 });
  const canGoPrev = prevMonth.endOf('month').toFormat('yyyyMMdd') >= minYmd;
  const canGoNext = nextMonth.startOf('month').toFormat('yyyyMMdd') <= maxYmd;

  return (
    <View>
      <View style={styles.calendarNav}>
        <TouchableOpacity
          disabled={!canGoPrev}
          onPress={() => canGoPrev && onMonthChange(prevMonth)}
          style={[styles.calendarNavBtn, !canGoPrev && styles.calendarNavBtnDisabled]}
        >
          <MaterialIcons name="chevron-left" size={22} color={canGoPrev ? GO_GREEN : '#ccc'} />
        </TouchableOpacity>
        <Text style={styles.calendarMonthLabel}>{monthLabel}</Text>
        <TouchableOpacity
          disabled={!canGoNext}
          onPress={() => canGoNext && onMonthChange(nextMonth)}
          style={[styles.calendarNavBtn, !canGoNext && styles.calendarNavBtnDisabled]}
        >
          <MaterialIcons name="chevron-right" size={22} color={canGoNext ? GO_GREEN : '#ccc'} />
        </TouchableOpacity>
      </View>

      <View style={styles.calendarWeekdays}>
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((label) => (
          <Text key={label} style={styles.calendarWeekday}>
            {label}
          </Text>
        ))}
      </View>

      <View style={styles.calendarGrid}>
        {cells.map((day) => {
          const ymd = day.toFormat('yyyyMMdd');
          const inMonth = day.month === monthStart.month;
          const selectable = inMonth && ymd >= minYmd && ymd <= maxYmd;
          const isSelected = ymd === selectedYmd;
          if (!inMonth) {
            return <View key={ymd + day.weekNumber} style={styles.calendarCellEmpty} />;
          }
          return (
            <TouchableOpacity
              key={ymd}
              disabled={!selectable}
              style={[
                styles.calendarCell,
                isSelected && styles.calendarCellSelected,
                !selectable && styles.calendarCellDisabled,
              ]}
              onPress={() => selectable && onSelect(ymd)}
              activeOpacity={selectable ? 0.85 : 1}
            >
              <Text
                style={[
                  styles.calendarCellText,
                  isSelected && styles.calendarCellTextSelected,
                  !selectable && styles.calendarCellTextDisabled,
                ]}
              >
                {day.day}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

// Main component

export default function SearchScreen() {
  const router = useRouter();
  const { ready, error } = useGtfsData();

  const [fromQuery, setFromQuery] = useState('');
  const [fromStop, setFromStop] = useState(null);
  const [fromSuggestions, setFromSuggestions] = useState([]);

  const [toQuery, setToQuery] = useState('');
  const [toStop, setToStop] = useState(null);
  const [toSuggestions, setToSuggestions] = useState([]);

  const [liveTick, setLiveTick] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [isComputing, setIsComputing] = useState(false);
  const [metrolinxByTrip, setMetrolinxByTrip] = useState({});

  // Filter state
  const [selectedModes, setSelectedModes] = useState({ train: true, bus: false });
  const [selectedDate, setSelectedDate] = useState(DateTime.now().setZone('America/Toronto').toFormat('yyyyMMdd'));
  const [tripTimeFilter, setTripTimeFilter] = useState('upcoming');
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(DateTime.now().setZone('America/Toronto').startOf('month'));
  const [schedulesForSearchReady, setSchedulesForSearchReady] = useState(true);

  const dateBounds = useMemo(() => {
    if (!ready) {
      const today = DateTime.now().setZone('America/Toronto').toFormat('yyyyMMdd');
      return { minYmd: today, maxYmd: today };
    }
    return getPlanningDateBounds();
  }, [ready, selectedDate]);

  const stopMatchesSelectedModes = useCallback((stop) => {
    const routeTypes = getStopRouteTypes(stop?.stop_id);
    const hasBus = routeTypes.some((t) => Number(t) === BUS_ROUTE_TYPE);
    const hasTrain = routeTypes.some((t) => Number(t) !== BUS_ROUTE_TYPE);
    return (selectedModes.train && hasTrain) || (selectedModes.bus && hasBus);
  }, [selectedModes]);

  // Clear isComputing once results (and stop state) have settled
  // Moved below `results` definition to avoid referencing before initialization.

  useEffect(() => {
    if (!ready) return;
    const id = setInterval(() => setLiveTick((n) => n + 1), 30000);
    return () => clearInterval(id);
  }, [ready]);

  useEffect(() => {
    if (!ready) return;
    const { minYmd, maxYmd } = dateBounds;
    setSelectedDate((current) => {
      if (current < minYmd) return minYmd;
      if (current > maxYmd) return maxYmd;
      return current;
    });
  }, [ready, dateBounds.minYmd, dateBounds.maxYmd]);

  useEffect(() => {
    if (!ready) return undefined;
    let cancelled = false;
    setSchedulesForSearchReady(false);
    ensureSchedulesForDate(selectedDate, { modes: selectedModes })
      .then(() => {
        if (!cancelled) setSchedulesForSearchReady(true);
      })
      .catch(() => {
        if (!cancelled) setSchedulesForSearchReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [ready, selectedDate, selectedModes]);

  useEffect(() => {
    let cancelled = false;

    async function loadMetrolinxFallback() {
      if (!ready || !fromStop?.stop_id) {
        if (!cancelled) setMetrolinxByTrip({});
        return;
      }

      const today = DateTime.now().setZone('America/Toronto').toFormat('yyyyMMdd');
      if (selectedDate !== today) {
        if (!cancelled) setMetrolinxByTrip({});
        return;
      }

      try {
        const lines = await getStopNextService(fromStop.stop_id);
        const byTrip = {};

        for (const line of Array.isArray(lines) ? lines : []) {
          const tripNumber = String(line?.TripNumber || '').trim();
          if (!tripNumber) continue;

          const scheduled = parseMetrolinxDateTime(line?.ScheduledDepartureTime);
          const computed = parseMetrolinxDateTime(line?.ComputedDepartureTime);
          if (!scheduled || !computed) continue;

          const delaySec = Math.round(computed.diff(scheduled, 'seconds').seconds);
          if (!Number.isFinite(delaySec)) continue;

          const existing = byTrip[tripNumber];
          if (!existing) {
            byTrip[tripNumber] = {
              delaySec,
              scheduledIso: scheduled.toISO(),
            };
            continue;
          }

          const existingDt = parseMetrolinxDateTime(existing.scheduledIso);
          if (!existingDt || scheduled < existingDt) {
            byTrip[tripNumber] = {
              delaySec,
              scheduledIso: scheduled.toISO(),
            };
          }
        }

        if (!cancelled) setMetrolinxByTrip(byTrip);
      } catch {
        if (!cancelled) setMetrolinxByTrip({});
      }
    }

    loadMetrolinxFallback();
    return () => {
      cancelled = true;
    };
  }, [ready, fromStop?.stop_id, selectedDate, liveTick]);

  // From typeahead
  useEffect(() => {
    if (fromQuery.length < 2 || (fromStop && fromQuery === fromStop.stop_name)) {
      setFromSuggestions([]);
      return;
    }
    if (!selectedModes.train && !selectedModes.bus) {
      setFromSuggestions([]);
      return;
    }

    if (!ready) {
      setFromSuggestions([]);
      return;
    }
    const matches = searchStops(fromQuery)
      .filter((stop) => stopMatchesSelectedModes(stop))
      .slice(0, 6);
    setFromSuggestions(matches);
  }, [ready, fromQuery, fromStop, selectedModes, stopMatchesSelectedModes]);

  // To typeahead
  useEffect(() => {
    if (toQuery.length < 2 || (toStop && toQuery === toStop.stop_name)) {
      setToSuggestions([]);
      return;
    }
    if (!selectedModes.train && !selectedModes.bus) {
      setToSuggestions([]);
      return;
    }

    if (!ready) {
      setToSuggestions([]);
      return;
    }
    const matches = searchStops(toQuery)
      .filter((stop) => stopMatchesSelectedModes(stop))
      .slice(0, 6);
    setToSuggestions(matches);
  }, [ready, toQuery, toStop, selectedModes, stopMatchesSelectedModes]);

  const selectFrom = useCallback((stop) => {
    setFromStop(stop);
    setFromQuery(stop.stop_name);
    setFromSuggestions([]);
    Keyboard.dismiss();
  }, []);

  const selectTo = useCallback((stop) => {
    setToStop(stop);
    setToQuery(stop.stop_name);
    setToSuggestions([]);
    Keyboard.dismiss();
  }, []);

  const clearFrom = useCallback(() => {
    setIsComputing(true);
    setFromStop(null);
    setFromQuery('');
    setFromSuggestions([]);
    Keyboard.dismiss();
  }, []);

  const clearTo = useCallback(() => {
    setIsComputing(true);
    setToStop(null);
    setToQuery('');
    setToSuggestions([]);
    Keyboard.dismiss();
  }, []);

  const handleSwap = useCallback(() => {
    setIsComputing(true);
    const prevFrom = fromStop;
    const prevFromQ = fromQuery;
    const prevTo = toStop;
    const prevToQ = toQuery;
    setFromStop(prevTo);
    setFromQuery(prevToQ);
    setToStop(prevFrom);
    setToQuery(prevFromQ);
    setFromSuggestions([]);
    setToSuggestions([]);
  }, [fromStop, fromQuery, toStop, toQuery]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    setFromStop(null);
    setFromQuery('');
    setFromSuggestions([]);
    setToStop(null);
    setToQuery('');
    setToSuggestions([]);
    setSelectedModes({ train: true, bus: false });
    setSelectedDate(DateTime.now().setZone('America/Toronto').toFormat('yyyyMMdd'));
    setTripTimeFilter('upcoming');
    setDatePickerOpen(false);
    requestAnimationFrame(() => setRefreshing(false));
  }, []);

  const toggleModeFilter = useCallback((modeKey) => {
    setSelectedModes((prev) => ({
      ...prev,
      [modeKey]: !prev[modeKey],
    }));
  }, []);

  // Build the selected day's trips once; the radio buttons only filter this list.
  const allTripResults = useMemo(() => {
    if (!ready || !fromStop || !schedulesForSearchReady) return [];
    if (!selectedModes.train && !selectedModes.bus) return [];

    const modeFilter = selectedModes.train !== selectedModes.bus
      ? selectedModes.train
        ? 'train'
        : 'bus'
      : null;

    const candidateLimit = 1000;
    const staticDeps = toStop
      ? getTripsFromToForDate(fromStop.stop_id, toStop.stop_id, selectedDate, candidateLimit, {
          mode: modeFilter,
        })
      : getDeparturesForDate(fromStop.stop_id, selectedDate, candidateLimit, {
          mode: modeFilter,
          allowRouteTimeCollapse: false,
        });

    if (!staticDeps.length) return [];

    const liveDeps = getLiveDepartures(fromStop.stop_id, candidateLimit, {
      mode: modeFilter,
    });
    const delayMap = new Map(liveDeps.map((d) => [d.trip_id, d]));
    const liveTripIds = new Set(getTripIdsWithLiveUpdates());

    const enrichedDeps = staticDeps.map((dep) => {
      const live = delayMap.get(dep.trip_id);
      const rtDelaySec = live?.delayMinutes != null ? live.delayMinutes * 60 : null;
      const tripNumber = extractTripNumber(dep.trip_id);
      const mx = tripNumber ? metrolinxByTrip[tripNumber] : null;
      const fallbackDelaySec = mx && Number.isFinite(mx.delaySec) ? Number(mx.delaySec) : null;
      const delaySec = rtDelaySec != null ? rtDelaySec : fallbackDelaySec;
      const hasGtfsTripUpdate = liveTripIds.has(dep.trip_id);

      const liveDepartDt =
        delaySec != null
          ? DateTime.fromISO(dep.scheduledDateTime).plus({ seconds: delaySec })
          : DateTime.fromISO(dep.scheduledDateTime);

      // Arrival stop may have a different delay; look it up separately.
      const arrivalDelaySec = toStop
        ? (() => {
            const sec = getDelayForStop(dep.trip_id, toStop.stop_id);
            if (sec !== undefined) return sec;
            return delaySec;
          })()
        : delaySec;

      const liveArrivalDt =
        dep.arrivalDateTime
          ? arrivalDelaySec != null
            ? DateTime.fromISO(dep.arrivalDateTime).plus({ seconds: arrivalDelaySec })
            : DateTime.fromISO(dep.arrivalDateTime)
          : null;

      // Compute durationMinutes and stopsCount if missing, using GTFS stop times
      let durationMinutes = dep.durationMinutes;
      let stopsCount = dep.stopsCount;
      if (durationMinutes == null || stopsCount == null) {
        try {
          const stopsArr = getTripStops(dep.trip_id, fromStop?.stop_id, toStop?.stop_id || null);
          if (Array.isArray(stopsArr) && stopsArr.length > 1) {
            stopsCount = stopsArr.length - 1;
            // Find first and last stop times
            const first = stopsArr[0];
            const last = stopsArr[stopsArr.length - 1];
            const parseTime = (label) => {
              const m = String(label).match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
              if (!m) return null;
              let h = parseInt(m[1], 10);
              const min = parseInt(m[2], 10);
              const pm = m[3].toUpperCase() === 'PM';
              if (pm && h !== 12) h += 12;
              if (!pm && h === 12) h = 0;
              return h * 60 + min;
            };
            const depMin = parseTime(first.arrival_time_label);
            const arrMin = parseTime(last.arrival_time_label);
            if (depMin != null && arrMin != null) {
              let diff = arrMin - depMin;
              if (diff < 0) diff += 24 * 60;
              durationMinutes = diff;
            }
          }
        } catch (e) {
          // fallback: leave as null
        }
      }

      // Always provide arrivalTimeAtTo: if no toStop, use last stop's time
      let arrivalTimeAtTo = dep.arrivalTimeAtTo;
      if (!toStop && (!arrivalTimeAtTo || arrivalTimeAtTo === '--')) {
        try {
          const stopsArr = getTripStops(dep.trip_id, fromStop?.stop_id, null);
          if (Array.isArray(stopsArr) && stopsArr.length > 1) {
            const last = stopsArr[stopsArr.length - 1];
            if (last && last.arrival_time_label) {
              arrivalTimeAtTo = last.arrival_time_label;
            }
          }
        } catch {}
      }
      return {
        ...dep,
        delayMinutes: delaySec != null ? Math.round(delaySec / 60) : null,
        hasLiveStatus: delaySec != null,
        hasGtfsTripUpdate,
        liveDateTime: liveDepartDt.toISO(),
        liveDateTimeMs: liveDepartDt.toMillis(),
        liveTimeLabel: liveDepartDt.toFormat('h:mm a').toUpperCase(),
        liveArrivalDateTime: liveArrivalDt ? liveArrivalDt.toISO() : dep.arrivalDateTime ?? null,
        liveArrivalTimeLabel: liveArrivalDt
          ? liveArrivalDt.toFormat('h:mm a').toUpperCase()
          : arrivalTimeAtTo ?? null,
        arrivalTimeAtTo,
        departurePlatformCode: null,
        arrivalPlatformCode: null,
        durationMinutes: durationMinutes != null ? durationMinutes : null,
        stopsCount: stopsCount != null ? stopsCount : null,
      };
    });

    let filtered = enrichedDeps.filter((d) => {
      const isBus = Number(d.route_type) === BUS_ROUTE_TYPE;
      return isBus ? selectedModes.bus : selectedModes.train;
    });

    // Hide self-looping trips where end stop equals origin when no destination is chosen.
    if (!toStop) {
      const norm = (s) => String(s || '').trim().toLowerCase();
      const origin = norm(fromStop.stop_name);
      filtered = filtered.filter((d) => norm(d.endStopName) !== origin);
    }

    filtered.sort(
      (a, b) =>
        Number(a.liveDateTimeMs || 0) -
        Number(b.liveDateTimeMs || 0),
    );

    return filtered;
  }, [ready, schedulesForSearchReady, fromStop, toStop, liveTick, selectedDate, selectedModes, metrolinxByTrip]);

  const results = useMemo(() => {
    if (tripTimeFilter === 'all') return allTripResults;

    const today = DateTime.now().setZone('America/Toronto').toFormat('yyyyMMdd');
    if (selectedDate !== today) return allTripResults;

    const now = DateTime.now().setZone('America/Toronto');
    const nowMs = now.toMillis();
    return allTripResults.filter((d) => Number(d.liveDateTimeMs || 0) >= nowMs);
  }, [allTripResults, selectedDate, tripTimeFilter]);

  const displayResults = results;

  const renderItem = useCallback(
    ({ item }) => (
      <TripResultCard
        item={item}
        fromStop={fromStop}
        toStop={toStop}
        showPlatform={false}
        onPress={() =>
          router.push({
            pathname: '/trip-detail',
            params: {
              tripId: item.trip_id,
              fromStopId: fromStop.stop_id,
              toStopId: toStop?.stop_id ?? '',
              fromStopName: fromStop.stop_name,
              toStopName: toStop?.stop_name ?? '',
              lineName: item.lineName ?? '',
              durationMinutes: item.durationMinutes ?? '',
              stopsCount: item.stopsCount ?? '',
              departureTime: item.scheduledTimeLabel,
              scheduledDateTime: item.scheduledDateTime ?? '',
              arrivalTime: item.arrivalTimeAtTo ?? '',
              delayMinutes: item.delayMinutes ?? '',
              isBus: Number(item.route_type) === 3 ? 'true' : 'false',
              platformCode: item.platformCode ?? '',
              liveStatus: (() => {
                if (!item.hasLiveStatus || item.delayMinutes == null) return 'unknown';
                if (item.delayMinutes > 0) return 'delayed';
                return 'on-time';
              })(),
            },
          })
        }
      />
    ),
    [fromStop, toStop, router],
  );

  // Clear isComputing once results (and stop state) have settled
  useEffect(() => {
    if (isComputing) setIsComputing(false);
  }, [displayResults, fromStop, toStop]);

  // Loading / error states
  if (!ready && !error) {
    return (
      <SafeAreaView style={styles.center} edges={['bottom', 'left', 'right']}>
        <ActivityIndicator size="large" color={GO_GREEN} />
        <Text style={styles.stateText}>Loading GO Transit data...</Text>
      </SafeAreaView>
    );
  }

  if (error) {
    return (
      <SafeAreaView style={styles.center} edges={['bottom', 'left', 'right']}>
        <Text style={styles.errorText}>Couldn't load transit schedules. Please try again.</Text>
      </SafeAreaView>
    );
  }

  const showNoFrom = !fromStop;
  const showNoResults = fromStop && !toStop && displayResults.length === 0;
  const showNoTripsBetween = fromStop && toStop && displayResults.length === 0;

  return (
    <SafeAreaView style={styles.screen} edges={['bottom', 'left', 'right']}>
      <SleekHeaderBar title="Search" icon="search" description="Find trips" />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={80}
      >
        {/* Top filters */}
        <View style={[styles.topModeSection, { marginTop: (Platform.OS === 'ios' ? 101 : 56) + 12 }]}> 
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.topFilterRow}
          >
            {[
              {
                label: 'Train',
                value: 'train',
                icon: 'train',
                activeColor: GO_GREEN,
              },
              {
                label: 'Bus',
                value: 'bus',
                icon: 'bus',
                activeColor: STATUS_DELAYED,
              },
            ].map((mode) => {
              const active = selectedModes[mode.value];
              return (
                <TouchableOpacity
                  key={mode.value}
                  style={[
                    styles.modeChip,
                    {
                      backgroundColor: active ? mode.activeColor : '#e6e6eb',
                      borderColor: active ? mode.activeColor : '#d0d0d5',
                    },
                  ]}
                  onPress={() => toggleModeFilter(mode.value)}
                  activeOpacity={0.85}
                >
                  <MaterialCommunityIcons
                    name={mode.icon}
                    size={14}
                    color={active ? '#fff' : '#555'}
                    style={styles.modeChipIcon}
                  />
                  <Text style={[styles.modeChipText, active && styles.modeChipTextActive]}>
                    {mode.label}
                  </Text>
                </TouchableOpacity>
              );
            })}

            <TouchableOpacity
              style={styles.dateChip}
              onPress={() => setDatePickerOpen(!datePickerOpen)}
              activeOpacity={0.85}
            >
              <MaterialIcons name="calendar-today" size={14} color={GO_GREEN} style={styles.modeChipIcon} />
              <Text style={styles.dateChipText}>
                {DateTime.fromFormat(selectedDate, 'yyyyMMdd')
                  .setZone('America/Toronto')
                  .toFormat('MMM d')}
              </Text>
            </TouchableOpacity>
          </ScrollView>

          {/* Date picker modal */}
          {datePickerOpen && (
            <View style={styles.datePickerOverlay}>
              <View style={styles.datePickerContent}>
                <View style={styles.datePickerHeader}>
                  <Text style={styles.datePickerTitle}>Select Date</Text>
                  <TouchableOpacity
                    onPress={() => setDatePickerOpen(false)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <MaterialIcons name="close" size={20} color="#666" />
                  </TouchableOpacity>
                </View>

                <TouchableOpacity
                  style={styles.dateQuickSelect}
                  onPress={() => {
                    setSelectedDate(DateTime.now().setZone('America/Toronto').toFormat('yyyyMMdd'));
                    setDatePickerOpen(false);
                  }}
                  activeOpacity={0.85}
                >
                  <Text style={styles.dateQuickSelectText}>Today</Text>
                </TouchableOpacity>

                <MonthCalendar
                  visibleMonth={calendarMonth}
                  selectedYmd={selectedDate}
                  minYmd={dateBounds.minYmd}
                  maxYmd={dateBounds.maxYmd}
                  onSelect={(ymd) => {
                    setSelectedDate(ymd);
                    setDatePickerOpen(false);
                  }}
                  onMonthChange={(month) => setCalendarMonth(month.startOf('month'))}
                />
              </View>
            </View>
          )}
        </View>

        {/* Search card */}
        <View style={styles.searchCard}>
          {/* From row */}
          <View style={styles.fieldRow}>
            <MaterialIcons name="train" size={20} color={GO_GREEN} style={styles.fieldIcon} />
            <TextInput
              style={styles.fieldInput}
              placeholder="From — departure stop"
              placeholderTextColor="#aaa"
              value={fromQuery}
              onChangeText={(t) => {
                setFromQuery(t);
                if (fromStop && t !== fromStop.stop_name) setFromStop(null);
              }}
              autoCorrect={false}
              autoCapitalize="words"
              returnKeyType="search"
            />
            {fromQuery.length > 0 ? (
              <TouchableOpacity onPress={clearFrom} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <MaterialIcons name="close" size={18} color="#aaa" />
              </TouchableOpacity>
            ) : null}
          </View>

          {fromSuggestions.length > 0 && (
            <ScrollView
              style={styles.dropdown}
              keyboardShouldPersistTaps="handled"
              nestedScrollEnabled
            >
              {fromSuggestions.map((s) => (
                <TouchableOpacity
                  key={s.stop_id}
                  style={styles.suggRow}
                  onPress={() => selectFrom(s)}
                >
                  <Text style={styles.suggText} numberOfLines={1}>{s.stop_name}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}

          {/* Swap divider */}
          <View style={styles.swapRow}>
            <View style={styles.swapDivider} />
            <TouchableOpacity style={styles.swapBtn} onPress={handleSwap}>
              <MaterialIcons name="swap-vert" size={20} color={GO_GREEN} />
            </TouchableOpacity>
            <View style={styles.swapDivider} />
          </View>

          {/* To row */}
          <View style={styles.fieldRow}>
            <MaterialIcons name="location-on" size={20} color="#888" style={styles.fieldIcon} />
            <TextInput
              style={styles.fieldInput}
              placeholder="To — destination (optional)"
              placeholderTextColor="#aaa"
              value={toQuery}
              onChangeText={(t) => {
                setToQuery(t);
                if (toStop && t !== toStop.stop_name) setToStop(null);
              }}
              autoCorrect={false}
              autoCapitalize="words"
              returnKeyType="search"
            />
            {toQuery.length > 0 ? (
              <TouchableOpacity onPress={clearTo} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <MaterialIcons name="close" size={18} color="#aaa" />
              </TouchableOpacity>
            ) : null}
          </View>

          {toSuggestions.length > 0 && (
            <ScrollView
              style={styles.dropdown}
              keyboardShouldPersistTaps="handled"
              nestedScrollEnabled
            >
              {toSuggestions.map((s) => (
                <TouchableOpacity
                  key={s.stop_id}
                  style={styles.suggRow}
                  onPress={() => selectTo(s)}
                >
                  <Text style={styles.suggText} numberOfLines={1}>{s.stop_name}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}
        </View>

        {/* Trip time filter */}
        <View style={styles.tripTimeFilterRow}>
          {[
            { key: 'upcoming', label: 'Upcoming Trips' },
            { key: 'all', label: 'All Trips' },
          ].map((option) => {
            const active = tripTimeFilter === option.key;
            return (
              <TouchableOpacity
                key={option.key}
                style={styles.tripTimeFilterOption}
                onPress={() => setTripTimeFilter(option.key)}
                activeOpacity={0.8}
              >
                <MaterialIcons
                  name={active ? 'radio-button-checked' : 'radio-button-unchecked'}
                  size={18}
                  color={active ? GO_GREEN : '#7a7f87'}
                />
                <Text style={[styles.tripTimeFilterText, active && styles.tripTimeFilterTextActive]}>
                  {option.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {isComputing ? (
          <View style={styles.computingBox}>
            <ActivityIndicator size="large" color={GO_GREEN} />
          </View>
        ) : (
          <FlatList
            data={displayResults}
            keyExtractor={(item, index) =>
              `${item.trip_id}-${item.route_id}-${item.scheduledTimeLabel}-${index}`
            }
            renderItem={renderItem}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={[styles.listContent, displayResults.length === 0 && styles.listContentEmpty]}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={handleRefresh}
                tintColor={GO_GREEN}
                colors={[GO_GREEN]}
              />
            }
            ListEmptyComponent={
              showNoFrom ? (
                <View style={styles.emptyBox}>
                  <MaterialIcons name="search" size={48} color="#ddd" />
                  <Text style={styles.emptyText}>Enter a departure stop to get started</Text>
                </View>
              ) : showNoResults ? (
                <View style={styles.emptyBox}>
                  <Text style={styles.emptyText}>
                    {`No upcoming departures from ${fromStop.stop_name}`}
                  </Text>
                </View>
              ) : showNoTripsBetween ? (
                <View style={styles.emptyBox}>
                  <Text style={styles.emptyText}>
                    {`No upcoming trips from ${fromStop.stop_name} to ${toStop.stop_name} right now.`}
                  </Text>
                  <TouchableOpacity style={styles.clearToBtn} onPress={clearTo}>
                    <Text style={styles.clearToBtnText}>
                      {`Show all departures from ${fromStop.stop_name}`}
                    </Text>
                  </TouchableOpacity>
                </View>
              ) : null
            }
          />
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: {
    flex: 1,
    backgroundColor: '#f2f2f7',
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f2f2f7',
    padding: 24,
  },
  stateText: {
    marginTop: 12,
    color: '#444',
    fontSize: 15,
  },
  errorText: {
    color: STATUS_DELAYED,
    fontSize: 14,
    textAlign: 'center',
  },

  // Search card
  searchCard: {
    backgroundColor: '#fff',
    marginHorizontal: 12,
    marginTop: 14,
    marginBottom: 10,
    borderRadius: 12,
    borderLeftWidth: 3,
    borderLeftColor: GO_GREEN,
    paddingHorizontal: 12,
    paddingVertical: 8,
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    zIndex: 20,
  },
  tripTimeFilterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    marginHorizontal: 18,
    marginTop: -2,
    marginBottom: 8,
  },
  tripTimeFilterOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 4,
  },
  tripTimeFilterText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#7a7f87',
  },
  tripTimeFilterTextActive: {
    color: GO_GREEN,
  },
  fieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
  },
  fieldIcon: {
    marginRight: 10,
  },
  fieldInput: {
    flex: 1,
    fontSize: 15,
    color: '#111',
    paddingVertical: 4,
  },
  swapRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 1,
  },
  swapDivider: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#e5e5e5',
  },
  swapBtn: {
    marginHorizontal: 10,
    padding: 4,
  },
  dropdown: {
    maxHeight: 180,
    borderWidth: 1,
    borderColor: '#e5e5e5',
    borderRadius: 8,
    backgroundColor: '#fff',
    marginBottom: 4,
    elevation: 3,
    zIndex: 30,
  },
  suggRow: {
    paddingVertical: 11,
    paddingHorizontal: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#eee',
  },
  suggText: {
    fontSize: 14,
    color: '#222',
  },

  // Empty states
  emptyBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  emptyText: {
    fontSize: 15,
    color: '#888',
    textAlign: 'center',
    lineHeight: 22,
    marginTop: 10,
  },
  clearToBtn: {
    marginTop: 18,
    paddingVertical: 11,
    paddingHorizontal: 22,
    backgroundColor: GO_GREEN,
    borderRadius: 8,
  },
  clearToBtnText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 14,
    textAlign: 'center',
  },

  // Result cards
  listContent: {
    paddingHorizontal: 14,
    paddingBottom: 24,
    paddingTop: 2,
  },
  listContentEmpty: {
    flexGrow: 1,
  },
  computingBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 40,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 18,
    padding: 14,
    marginBottom: 12,
    elevation: 7,
    borderWidth: 1,
    borderColor: '#e6eaef',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.12,
    shadowRadius: 14,
  },
  cardPressed: {
    transform: [{ scale: 0.985 }, { translateY: 1 }],
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 3,
  },
  cardAccentBand: {
    marginHorizontal: -14,
    marginTop: -14,
    marginBottom: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  cardRouteMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    gap: 10,
    paddingRight: 12,
  },
  modeBadge: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardRouteTextWrap: {
    flex: 1,
  },
  cardHeaderRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  routeText: {
    flex: 1,
    fontSize: 16,
    fontWeight: '800',
    color: '#142013',
  },
  cardSubRouteText: {
    marginTop: 2,
    fontSize: 12,
    fontWeight: '600',
    color: '#55705f',
  },
  heroRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14,
  },
  heroTimeBlock: {
    flex: 1,
  },
  heroTimeBlockRight: {
    alignItems: 'flex-end',
  },
  heroTimeLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    color: '#7a7f87',
    marginBottom: 3,
  },
  heroTimeValue: {
    fontSize: 24,
    fontWeight: '800',
    color: '#111827',
  },
  heroDestinationValue: {
    fontSize: 18,
    textAlign: 'right',
  },
  heroDividerWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
  },
  heroDivider: {
    width: 18,
    height: 2,
    borderRadius: 999,
    opacity: 0.3,
  },
  journeyPathRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 14,
    fontSize: 14,
    fontWeight: '700',
    color: '#1f2937',
  },
  journeyPathStop: {
    flex: 1,
    fontSize: 14,
    fontWeight: '700',
    color: '#1f2937',
  },
  journeyPathCol: {
    flex: 1,
  },
  journeyPathColRight: {
    alignItems: 'flex-end',
  },
  journeyPathStopDestination: {
    textAlign: 'right',
  },
  platformInline: {
    marginTop: 2,
    fontSize: 11,
    color: '#6b7280',
    fontWeight: '600',
  },
  platformInlineRight: {
    textAlign: 'right',
  },
  cardChipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
    marginBottom: 14,
  },
  infoChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: '#f3f4f6',
  },
  infoChipText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#374151',
  },
  cardDateText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#4b5563',
  },

  // Filters
  topModeSection: {
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 10,
    backgroundColor: '#f2f2f7',
    position: 'relative',
    zIndex: 40,
  },
  topFilterRow: {
    alignItems: 'center',
    gap: 8,
  },
  modeChip: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: '#e6e6eb',
    borderWidth: 1,
    minHeight: 32,
    justifyContent: 'center',
    alignItems: 'center',
    flexDirection: 'row',
  },
  modeChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#555',
  },
  modeChipTextActive: {
    color: '#fff',
  },
  modeChipIcon: {
    marginRight: 4,
  },
  dateChip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#d0d0d5',
    backgroundColor: '#fff',
    paddingHorizontal: 10,
    paddingVertical: 6,
    minHeight: 32,
  },
  dateChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#111',
  },
  datePickerOverlay: {
    position: 'absolute',
    top: 48,
    left: 0,
    right: 0,
    marginTop: 4,
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#d0d0d5',
    elevation: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    zIndex: 100,
    maxHeight: 350,
  },
  datePickerContent: {
    flex: 1,
  },
  datePickerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e0e0e0',
  },
  datePickerTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111',
  },
  dateQuickSelect: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 8,
  },
  dateQuickSelectText: {
    fontSize: 14,
    fontWeight: '600',
    color: GO_GREEN,
  },
  calendarNav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  calendarNavBtn: {
    padding: 4,
  },
  calendarNavBtnDisabled: {
    opacity: 0.4,
  },
  calendarMonthLabel: {
    fontSize: 15,
    fontWeight: '700',
    color: '#222',
  },
  calendarWeekdays: {
    flexDirection: 'row',
    marginBottom: 4,
  },
  calendarWeekday: {
    flex: 1,
    textAlign: 'center',
    fontSize: 11,
    fontWeight: '600',
    color: '#888',
  },
  calendarGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  calendarCell: {
    width: '14.2857%',
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
  },
  calendarCellEmpty: {
    width: '14.2857%',
    aspectRatio: 1,
  },
  calendarCellSelected: {
    backgroundColor: GO_GREEN,
  },
  calendarCellDisabled: {
    opacity: 0.35,
  },
  calendarCellText: {
    fontSize: 14,
    color: '#222',
    fontWeight: '500',
  },
  calendarCellTextSelected: {
    color: '#fff',
    fontWeight: '700',
  },
  calendarCellTextDisabled: {
    color: '#999',
  },
  datePickerList: {
    maxHeight: 250,
  },
  dateOption: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  dateOptionSelected: {
    backgroundColor: '#e6f5ec',
  },
  dateOptionText: {
    fontSize: 14,
    color: '#333',
  },
  dateOptionTextSelected: {
    color: GO_GREEN,
    fontWeight: '700',
  },
});
