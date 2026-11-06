import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useNavigation } from 'expo-router';
import { TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import DepartureListRow from '../../components/DepartureListRow';
import BusDownloadBanner from '../../components/BusDownloadBanner';
import { useGtfsData } from '../../contexts/GtfsDataContext';
import { ensureSchedulesForDate, isScheduleLoaded } from '../../services/gtfsService';
import {
  getBusDownloadState,
  subscribeBusDownloadState,
} from '../../services/gtfsSqliteService';
import { getLiveDepartures, getRealtimeDiagnostics, subscribeRealtimeDiagnostics } from '../../services/gtfsRealtimeService';
import { maybeAskForReview } from '../../services/reviewPrompt';
import { recordScreenView, recordStationCheck } from '../../services/usageCounts';
import { DateTime } from 'luxon';

const GO_GREEN = '#00853F';

export default function DeparturesScreen() {
  const params = useLocalSearchParams();
  const navigation = useNavigation();
  const { ready, startupTiming } = useGtfsData();
  const stopId = params.stopId ? String(params.stopId) : '';
  const stopName = params.stopName ? String(params.stopName) : 'Stop';
  const stopFilter = params.stopFilter ? String(params.stopFilter) : 'trains';
  const isBus = stopFilter === 'buses';
  const departuresMode = stopFilter === 'trains' ? 'train' : stopFilter === 'buses' ? 'bus' : null;
  // Last station view already counted, so the bus-download re-run of the
  // load effect below is not counted as a second view. A remount (back
  // out and back in, or a different station) resets it and counts again.
  const lastStationCheckRef = useRef('');
  const [departures, setDepartures] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busDownloadState, setBusDownloadState] = useState(() => getBusDownloadState());
  const [busLoadedForToday, setBusLoadedForToday] = useState(false);
  const [busEnsureDone, setBusEnsureDone] = useState(false);

  // Live-data diagnosis + refresh: the departures list used to compute once
  // and never again when realtime data landed, so the first screen after
  // launch stayed schedule-only even after the feed arrived. Subscribing
  // to settled refreshes recomputes the list on the existing 30s poll —
  // no extra network calls, no interaction to clobber (this screen has no
  // editing state), and no loop: notifications fire on poll settle only,
  // never during render, and recomputing never triggers a fetch.
  const [realtimeDiag, setRealtimeDiag] = useState(() => getRealtimeDiagnostics());
  const [realtimeVersion, setRealtimeVersion] = useState(0);

  useEffect(() => {
    const unsubscribe = subscribeRealtimeDiagnostics(() => {
      setRealtimeDiag(getRealtimeDiagnostics());
      setRealtimeVersion((v) => v + 1);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeBusDownloadState((next) => {
      setBusDownloadState(next);
    });
    return unsubscribe;
  }, []);

  const loadBusSchedules = useCallback(() => {
    if (!ready || !isBus) return;
    const today = DateTime.now().setZone('America/Toronto').toFormat('yyyyMMdd');
    setBusEnsureDone(false);
    ensureSchedulesForDate(today, { modes: { train: false, bus: true } })
      .then(() => {
        setBusLoadedForToday(isScheduleLoaded(today, 'bus'));
        setBusEnsureDone(true);
      })
      .catch(() => {
        setBusEnsureDone(true);
      });
  }, [ready, isBus]);

  // Opening the bus departures screen is a bus-schedule request: if the
  // background bus download has not finished, the on-demand fallback
  // downloads the bus week blocking and the banner below shows the live
  // time left. The list below never presents "No departures" as if there
  // were simply no bus service while bus data is still downloading or
  // failed — the banner carries the downloading state or the named error
  // with a retry.
  useEffect(() => {
    loadBusSchedules();
  }, [loadBusSchedules, busDownloadState.status === 'done' ? 'bus-done' : 'bus-not-done']);

  const showBusBanner =
    ready &&
    isBus &&
    !busLoadedForToday &&
    (busDownloadState?.status === 'downloading' ||
      busDownloadState?.status === 'error' ||
      busEnsureDone);

  useEffect(() => {
    if (!stopId) {
      setDepartures([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    const deps = getLiveDepartures(stopId, 100, { mode: departuresMode });
    setDepartures(Array.isArray(deps) ? deps : []);
    setLoading(false);
    if (Array.isArray(deps) && deps.length > 0) {
      maybeAskForReview();
      // Anonymous usage counts, once per view of this station: a
      // station_checks row (stop name from params + first departure's
      // line name) and a 'departures' screen row. Deliberately NOT in
      // the realtime-tick effect below — a 30s tick is not a new view.
      // A station with no departures shown records nothing: its line
      // is unknown and is never invented.
      const checkKey = `${stopId}|${stopFilter}`;
      if (lastStationCheckRef.current !== checkKey) {
        lastStationCheckRef.current = checkKey;
        recordStationCheck({ stationName: stopName, lineName: deps[0]?.lineName });
        recordScreenView('departures');
      }
    }
  }, [stopId, stopFilter, busLoadedForToday, departuresMode]);

  // Realtime-tick recompute only: refreshes the list when a poll settles
  // (realtimeVersion bump from the subscription above). Deliberately
  // separate from the effect above — it must NOT call maybeAskForReview
  // (that counts departure views, and a 30s tick is not a new view) and
  // must NOT touch `loading` (no spinner flash every 30s).
  useEffect(() => {
    if (realtimeVersion === 0 || !stopId) return;
    const deps = getLiveDepartures(stopId, 100, { mode: departuresMode });
    setDepartures(Array.isArray(deps) ? deps : []);
  }, [realtimeVersion, stopId, departuresMode]);

  // One-line live-data readout for the phone test: last refresh time,
  // trips carrying live times, and the last feed error. It reads:
  // "Live data updated 9:41 AM · 214 trips" when fresh, and names the
  // failure when the feed has never loaded or gone stale (>5 min, the
  // same age the live card treats as schedule-only).
  const liveFooterText = useMemo(() => {
    const updatedMs = realtimeDiag?.lastUpdatedMs || null;
    const ageMs = updatedMs ? Date.now() - updatedMs : Infinity;
    const fresh = updatedMs && ageMs <= 5 * 60 * 1000;
    const timeLabel = updatedMs
      ? DateTime.fromMillis(updatedMs).setZone('America/Toronto').toFormat('h:mm a')
      : null;
    const errorLabel = realtimeDiag?.lastError
      ? String(realtimeDiag.lastError).slice(0, 80)
      : null;
    if (!updatedMs) {
      return errorLabel
        ? `Live data not loaded yet · ${errorLabel}`
        : 'Live data not loaded yet · waiting for live feed';
    }
    if (!fresh) {
      return errorLabel
        ? `Live data last updated ${timeLabel} · ${errorLabel}`
        : `Live data last updated ${timeLabel} · feed is stale`;
    }
    const base = `Live data updated ${timeLabel} · ${realtimeDiag.tripsWithLiveData} trips`;
    return errorLabel ? `${base} · feed issue: ${errorLabel}` : base;
  }, [realtimeDiag]);

  // Last launch's timings (in-app only, no network): the same values the
  // backend report uses, kept in memory by the provider at ready. Shown
  // under the live footer; tapping it shares the timings + live line.
  const timingLine = useMemo(() => {
    if (!startupTiming) return '';
    const fmt = (ms) => {
      const s = Math.max(0, Math.round(Number(ms) / 1000));
      if (s < 60) return `${s}s`;
      return `${Math.floor(s / 60)} min ${s % 60}s`;
    };
    return `Last app start: ${fmt(startupTiming.totalMs)} in total · stops ${fmt(startupTiming.stopsMs)} · schedules ${fmt(startupTiming.schedulesMs)}`;
  }, [startupTiming]);

  const handleShareTimings = useCallback(async () => {
    if (!timingLine) return;
    try {
      await Share.share({
        message: `Transit Scanner startup timings\n${timingLine}\n${liveFooterText}`,
      });
    } catch {
      // Share sheet dismissed or unavailable — nothing to show here.
    }
  }, [timingLine, liveFooterText]);

  const subtitle = useMemo(() => {
    if (!departures.length) return 'All Departures';

    const first = departures[0];
    const lineTitle = first?.lineName || 'GO Line';

    let stopsFromHere = 0;
    if (Array.isArray(first?.stops) && first.stops.length > 0 && first.stop_sequence != null) {
      const currentIdx = first.stops.findIndex((s) => s.stop_sequence == first.stop_sequence);
      if (currentIdx !== -1) {
        stopsFromHere = first.stops.length - currentIdx;
      }
    }

    const servicePattern = stopsFromHere > 0 ? `${stopsFromHere} stop${stopsFromHere !== 1 ? 's' : ''}` : 'All Stops';
    return `${lineTitle} (${servicePattern})`;
  }, [departures]);

  if (!stopId) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <Text>No stop selected.</Text>
      </View>
    );
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.root}>
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={GO_GREEN} />
          <Text style={styles.loadingText}>Loading departures...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.headerWrap}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color={GO_GREEN} />
        </TouchableOpacity>
        <View style={styles.headerTextWrap}>
          <Text style={styles.stopName} numberOfLines={1}>{stopName}</Text>
          <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text>
        </View>
      </View>

      {showBusBanner ? (
        <View style={styles.bannerWrap}>
          <BusDownloadBanner state={busDownloadState} onRetry={loadBusSchedules} />
        </View>
      ) : null}

      <FlatList
        data={departures}
        keyExtractor={(item) => `${item.trip_id}-${item.route_id}-${item.scheduledTimeLabel || item.scheduledDateTime}`}
        renderItem={({ item }) => <DepartureListRow item={item} />}
        contentContainerStyle={styles.listContent}
        ListFooterComponent={
          <View>
            <Text style={styles.liveFooterText}>{liveFooterText}</Text>
            {timingLine ? (
              <TouchableOpacity onPress={handleShareTimings}>
                <Text style={styles.timingFooterText}>{timingLine} · tap to share</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          showBusBanner ? null : (
            <Text style={styles.emptyText}>No upcoming departures found for this stop today.</Text>
          )
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#fff',
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingText: {
    marginTop: 10,
    color: '#444',
  },
  headerWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e0e0e0',
  },
  backBtn: {
    marginRight: 10,
    padding: 2,
  },
  headerTextWrap: {
    flex: 1,
  },
  stopName: {
    fontSize: 20,
    fontWeight: '700',
    color: '#111',
  },
  subtitle: {
    marginTop: 2,
    fontSize: 14,
    color: '#666',
  },
  bannerWrap: {
    paddingTop: 4,
  },
  listContent: {
    paddingHorizontal: 20,
    paddingBottom: 28,
  },
  emptyText: {
    color: '#666',
    marginTop: 10,
  },
  liveFooterText: {
    color: '#666',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 16,
    paddingHorizontal: 12,
  },
  timingFooterText: {
    color: '#666',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 6,
    paddingHorizontal: 12,
  },
});
