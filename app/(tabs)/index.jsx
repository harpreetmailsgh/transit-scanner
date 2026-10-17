/**
 * Home — GO Transit map
 * ----------------------
 * 1) Brief GO green splash, then show map while GTFS continues syncing.
 * 2) Map centred on the user (asks for location permission once).
 * 3) Green pins for every stop from gtfsService.
 * 4) Blue pins for live trains; positions refresh every 30s and pins animate.
 * 5) Tapping a stop opens a bottom sheet with the next 5 departures (live).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Platform } from 'react-native';
import SleekHeaderBar from '../../components/SleekHeaderBar';
import * as Location from 'expo-location';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetScrollView,
  TouchableOpacity,
} from '@gorhom/bottom-sheet';

import HomeMap from '../../components/HomeMap';
import StartupLoadingScreen from '../../components/StartupLoadingScreen';
import DepartureListRow from '../../components/DepartureListRow';
import { useGtfsData } from '../../contexts/GtfsDataContext';
import { useLoading } from '../../contexts/LoadingContext';
import { getShapePolylinesForMap, getStopRouteTypes, getStops } from '../../services/gtfsService';
import {
  getLiveDepartures,
  getVehiclePositions,
} from '../../services/gtfsRealtimeService';

const GO_GREEN = '#00853F';
const RAIL_ROUTE_TYPE = 2;
const BUS_ROUTE_TYPE = 3;

/** Greater Toronto area fallback if GPS is unavailable. */
const DEFAULT_REGION = {
  latitude: 43.645,
  longitude: -79.38,
  latitudeDelta: 0.35,
  longitudeDelta: 0.35,
};

const STALLED_HINT_DELAY_MS = 10000;

function formatEtaLabel(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return `About ${seconds}s left`;
  const minutes = Math.ceil(seconds / 60);
  return `About ${minutes} min left`;
}

export default function HomeScreen() {
  const router = useRouter();
  const {
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
  } = useGtfsData();
  const { setLoading } = useLoading ? useLoading() : { setLoading: () => {} };

  const [locationReady, setLocationReady] = useState(false);
  const [hasLocationPermission, setHasLocationPermission] = useState(false);
  const [currentRegion, setCurrentRegion] = useState(null);
  const [stopFilter, setStopFilter] = useState('trains');
  const mapRef = useRef(null);
  /** Opens sheet after React applies selectedStop (BottomSheet needs fresh data). */
  const openSheetAfterSelectRef = useRef(false);

  /** Live vehicle list — updated on an interval so markers move. */
  const [vehicles, setVehicles] = useState([]);
  /** Bumps every 30s so bottom-sheet departure times re-query live delays. */
  const [liveTick, setLiveTick] = useState(0);

  /** Stop row chosen from a map pin (opens bottom sheet). */
  const [selectedStop, setSelectedStop] = useState(null);
  const [startupClock, setStartupClock] = useState(() => Date.now());

  const sheetRef = useRef(null);
  /** One ref per train trip_id so we can call animateMarkerToCoordinate. */
  const vehicleMarkerRefs = useRef({});

  // Ask for location immediately; GTFS may still be syncing in background.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (cancelled) return;
      const granted = status === 'granted';
      setHasLocationPermission(granted);

      if (!granted) {
        setLocationReady(true);
        return;
      }

      try {
        const pos = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        if (cancelled) return;
        const { latitude, longitude } = pos.coords;
        const next = {
          latitude,
          longitude,
          latitudeDelta: 0.12,
          longitudeDelta: 0.12,
        };
        setCurrentRegion(next);
        // MapView may not have mounted the ref yet — short delay avoids a race.
        setTimeout(() => {
          mapRef.current?.animateToRegion(next, 900);
        }, 250);
      } catch {
        // Keep DEFAULT_REGION
      } finally {
        if (!cancelled) setLocationReady(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const handleLocateMe = useCallback(async () => {
    if (Platform.OS === 'web') return;
    if (currentRegion) {
      mapRef.current?.animateToRegion(currentRegion, 700);
      return;
    }

    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') return;
      setHasLocationPermission(true);
      setLocationReady(true);
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const next = {
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        latitudeDelta: 0.12,
        longitudeDelta: 0.12,
      };
      setCurrentRegion(next);
      mapRef.current?.animateToRegion(next, 700);
    } catch {
      // Keep current map position if location cannot be fetched right now.
    }
  }, [currentRegion]);

  // --- Poll vehicle positions every 30 seconds (matches gtfsRealtimeService cadence) ---
  useEffect(() => {
    const tick = () => {
      const next = getVehiclePositions();
      setVehicles(next);
      setLiveTick((n) => n + 1);
    };

    tick();
    const id = setInterval(tick, 30000);
    return () => clearInterval(id);
  }, [ready]);

  // --- Smoothly move blue train pins when coordinates change ---
  useEffect(() => {
    vehicles.forEach((v) => {
      if (v.trip_id == null) return;
      const key = String(v.trip_id);
      const ref = vehicleMarkerRefs.current[key];
      if (ref && typeof ref.animateMarkerToCoordinate === 'function') {
        ref.animateMarkerToCoordinate(
          { latitude: v.latitude, longitude: v.longitude },
          900,
        );
      }
    });
  }, [vehicles]);

  // --- Next 5 live departures for the sheet ---
  const sheetDepartures = useMemo(() => {
    if (!selectedStop) return [];
    let mode = null;
    if (stopFilter === 'trains') mode = 'train';
    if (stopFilter === 'buses') mode = 'bus';
    return getLiveDepartures(String(selectedStop.stop_id), 5, { mode });
  }, [selectedStop, liveTick, stopFilter]);

  const openSheet = useCallback((stop) => {
    setSelectedStop(stop);
    openSheetAfterSelectRef.current = true;
  }, []);

  useEffect(() => {
    if (!selectedStop || !openSheetAfterSelectRef.current) return;
    openSheetAfterSelectRef.current = false;
    const t = requestAnimationFrame(() => {
      sheetRef.current?.present();
    });
    return () => cancelAnimationFrame(t);
  }, [selectedStop]);

  const renderBackdrop = useCallback(
    (props) => (
      <BottomSheetBackdrop
        {...props}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        pressBehavior="close"
      />
    ),
    [],
  );

  const goViewAllDepartures = useCallback(() => {
    if (!selectedStop) return;
    sheetRef.current?.dismiss();
    router.push({
      pathname: '/screens/departures',
      params: {
        stopId: String(selectedStop.stop_id),
        stopName: String(selectedStop.stop_name || 'Stop'),
        stopFilter,
      },
    });
  }, [router, selectedStop, stopFilter]);

  const mapStops = useMemo(() => {
    if (Array.isArray(startupStops) && startupStops.length) return startupStops;
    if (ready) return getStops();
    return [];
  }, [ready, startupStops]);

  const stopMetadata = useMemo(() => {
    if (!stopsReady) return [];

    if (!ready) {
      return mapStops
        .map((s) => {
          const lat = parseFloat(s.stop_lat);
          const lon = parseFloat(s.stop_lon);
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
          return {
            ...s,
            lat,
            lon,
            stopKind: 'both',
            routeTypes: [RAIL_ROUTE_TYPE, BUS_ROUTE_TYPE],
          };
        })
        .filter(Boolean);
    }

    return mapStops
      .map((s) => {
        const lat = parseFloat(s.stop_lat);
        const lon = parseFloat(s.stop_lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

        const routeTypes = getStopRouteTypes(s.stop_id)
          .map((t) => Number(t))
          .filter((t) => t === RAIL_ROUTE_TYPE || t === BUS_ROUTE_TYPE);
        const includesRail = routeTypes.includes(RAIL_ROUTE_TYPE);
        const includesBus = routeTypes.includes(BUS_ROUTE_TYPE);
        if (!includesRail && !includesBus) return null;
        const stopKind = includesRail && includesBus ? 'both' : includesBus ? 'bus' : 'train';
        return { ...s, lat, lon, stopKind, routeTypes };
      })
      .filter(Boolean);
  }, [mapStops, ready, stopsReady]);

  const trainMarkers = useMemo(
    () =>
      stopMetadata
        .filter((s) => s.routeTypes.includes(RAIL_ROUTE_TYPE))
        .map((s) => ({ ...s, markerKind: 'train' })),
    [stopMetadata],
  );

  const busMarkers = useMemo(
    () =>
      stopMetadata
        .filter((s) => s.routeTypes.includes(BUS_ROUTE_TYPE))
        .map((s) => ({ ...s, markerKind: 'bus' })),
    [stopMetadata],
  );

  const stopMarkers = stopFilter === 'buses' ? busMarkers : trainMarkers;

  const { train: trainShapePolylines, bus: busShapePolylines } = useMemo(
    () => getShapePolylinesForMap(),
    [ready],
  );

  const renderFilterChip = useCallback(
    (value, label) => {
      const active = stopFilter === value;
      const trainsActive = active && value === 'trains';
      const busesActive = active && value === 'buses';
      return (
        <Pressable
          key={value}
          onPress={() => {
            if (value === stopFilter) return;
            setStopFilter(value);
          }}
          style={[
            styles.filterChip,
            active && styles.filterChipActiveBase,
            trainsActive && styles.filterChipActiveTrain,
            busesActive && styles.filterChipActiveBus,
          ]}
        >
          <Text style={[styles.filterText, active && styles.filterTextActive]}>{label}</Text>
        </Pressable>
      );
    },
    [stopFilter],
  );

  useEffect(() => {
    if (ready) return undefined;
    const id = setInterval(() => setStartupClock(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ready]);

  const nowTick = startupClock;
  const shouldShowStartup = Boolean(error) || !ready;
  const msSinceLastProgress = nowTick - (lastProgressAt || loadStartAt || nowTick);
  const stalled = shouldShowStartup && msSinceLastProgress >= STALLED_HINT_DELAY_MS;
  const loadingFromCache = /loading cached go transit data/i.test(progressMessage || '');
  const stopsSourceLabel =
    (
      {
        api: 'live',
        cache: 'saved',
        'static-fallback': 'bundled',
        'static-warmup': 'bundled',
        'static-schedule': 'bundled',
      }[stopsSource]
    ) || 'startup';
  const startupDetailText = loadingFromCache
    ? 'Loading schedules already saved on this phone.'
    : 'Downloading or rebuilding GO Transit schedules on this phone.';
  const loadElapsedMs = Math.max(0, nowTick - (loadStartAt || nowTick));
  const etaSeconds =
    progressPercent >= 0.08 && progressPercent < 0.99
      ? Math.min(
          120,
          Math.max(
            5,
            Math.ceil((loadElapsedMs * (1 - progressPercent)) / Math.max(progressPercent, 0.08) / 1000),
          ),
        )
      : 0;
  const startupEtaText = stalled ? '' : formatEtaLabel(etaSeconds);
  const startupElapsedSeconds = Math.round(loadElapsedMs / 1000);
  const startupSinceUpdateSeconds = Math.max(0, Math.round(msSinceLastProgress / 1000));
  const showStartupLogAction = Boolean(error) || startupElapsedSeconds >= 10;

  useEffect(() => {
    setLoading && setLoading(shouldShowStartup);
  }, [setLoading, shouldShowStartup]);

  if (shouldShowStartup) {
    return (
      <StartupLoadingScreen
        errorMessage={error || ''}
        progressPercent={progressPercent}
        progressMessage={progressMessage}
        stalled={stalled}
        detailText={startupElapsedSeconds >= 10 ? startupDetailText : ''}
        etaText={startupEtaText}
        showLogAction={showStartupLogAction}
        loadAttempt={loadAttempt + 1}
        loadElapsedSeconds={startupElapsedSeconds}
        secondsSinceLastUpdate={startupSinceUpdateSeconds}
        startupTrace={startupTrace}
        stopsReady={stopsReady}
        schedulesReady={schedulesReady}
        stopsSource={stopsSource}
        servicePhase={servicePhase}
        servicePhaseDetail={servicePhaseDetail}
        debugLogCaptured={debugLogCaptured}
        debugLogPath={debugLogPath || ''}
        onRetry={retryLoad}
      />
    );
  }

  return (
    <View style={styles.mapShell}>
      <SleekHeaderBar title="Stops" icon="place" description="Stops and Departures" />
      {/*
        Platform-specific implementation:
        - .native.jsx → full react-native-maps (phone)
        - .web.jsx → green placeholder (no react-native-maps import on web)
      */}
      <HomeMap
        mapRef={mapRef}
        initialRegion={DEFAULT_REGION}
        locationReady={hasLocationPermission}
        activeFilter={stopFilter}
        showRouteLines={false}
        trainShapePolylines={trainShapePolylines}
        busShapePolylines={busShapePolylines}
        stopMarkers={stopMarkers}
        vehicles={vehicles}
        vehicleMarkerRefs={vehicleMarkerRefs}
        onStopPress={openSheet}
      />

      <View style={[styles.filterWrap, { marginTop: (Platform.OS === 'ios' ? 74 : 41) + 8 }]}> 
        <View style={[styles.filterRow, { paddingTop: 8 }]}> 
          {renderFilterChip('trains', 'Trains')}
          {renderFilterChip('buses', 'Buses')}
        </View>
      </View>

      {error ? (
        <View style={styles.syncBanner}>
          <View style={styles.syncBannerRow}>
            <Text style={styles.syncBannerText}>
              Offline schedule build failed. Map is still usable.
            </Text>
          </View>
          <Pressable style={styles.syncRetryBtn} onPress={retryLoad}>
            <Text style={styles.syncRetryBtnText}>
              Retry Sync
            </Text>
          </Pressable>
        </View>
      ) : null}

      {!schedulesReady && !error ? (
        <View style={styles.syncBanner}>
          <View style={styles.syncBannerRow}>
            <Text style={styles.syncBannerText}>
              Stops are ready from {stopsSourceLabel} data. Schedules are syncing in background.
            </Text>
          </View>
        </View>
      ) : null}

      {Platform.OS !== 'web' ? (
        <Pressable
          onPress={handleLocateMe}
          style={[
            styles.locateBtn,
            {
              bottom: Platform.OS === 'ios' ? 140 : 130, // Ensure well above nav bar and home indicator
              // Optionally, add left/right for spacing if needed
            },
          ]}
        >
          <MaterialIcons name="near-me" size={22} color="#fff" />
        </Pressable>
      ) : null}

      {Platform.OS !== 'web' && !locationReady ? (
        <View style={styles.locBanner} pointerEvents="none">
          <Text style={styles.locBannerText}>Finding your location…</Text>
        </View>
      ) : null}

      {Platform.OS === 'web' ? null : (
      <BottomSheetModal
        ref={sheetRef}
        index={0}
        snapPoints={['45%', '72%']}
        enablePanDownToClose
        onDismiss={() => setSelectedStop(null)}
        backdropComponent={renderBackdrop}
        handleIndicatorStyle={styles.sheetHandle}
        backgroundStyle={styles.sheetBg}
      >
        <BottomSheetScrollView contentContainerStyle={styles.sheetContent}>
          <Text style={styles.sheetTitle}>
            {selectedStop?.stop_name || 'Stop'}
          </Text>

          {sheetDepartures.length === 0 ? (
            <Text style={styles.sheetEmpty}>
              No upcoming departures found for this stop today.
            </Text>
          ) : (
            sheetDepartures.map((item) => {
              return (
                <DepartureListRow
                  key={`${item.trip_id}-${item.route_id}-${item.scheduledTimeLabel}`}
                  item={item}
                />
              );
            })
          )}

          <TouchableOpacity style={styles.viewAllBtn} onPress={goViewAllDepartures}>
            <Text style={styles.viewAllText}>View all departures</Text>
          </TouchableOpacity>
        </BottomSheetScrollView>
      </BottomSheetModal>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  loadingRoot: {
    flex: 1,
    backgroundColor: GO_GREEN,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  logoWord: {
    color: '#fff',
    fontSize: 32,
    fontWeight: '800',
    letterSpacing: 0.5,
    marginBottom: 28,
  },
  spinner: {
    marginBottom: 20,
  },
  loadingTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
  },
  loadingSub: {
    color: 'rgba(255,255,255,0.9)',
    fontSize: 14,
    marginTop: 10,
    textAlign: 'center',
  },
  errorHeading: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 8,
  },
  errorSubheading: {
    color: 'rgba(255,255,255,0.95)',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 12,
  },
  retryBtn: {
    backgroundColor: '#fff',
    borderRadius: 10,
    paddingVertical: 11,
    paddingHorizontal: 22,
    marginBottom: 12,
  },
  retryBtnText: {
    color: GO_GREEN,
    fontSize: 15,
    fontWeight: '700',
  },
  errorScroll: {
    flexGrow: 1,
    flexShrink: 1,
    maxHeight: 420,
    width: '100%',
    marginTop: 8,
  },
  errorScrollContent: {
    paddingHorizontal: 12,
    paddingBottom: 24,
  },
  errorText: {
    color: '#fff',
    fontSize: 13,
    lineHeight: 20,
    textAlign: 'left',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  mapShell: {
    flex: 1,
    backgroundColor: '#000',
    paddingTop: Platform.OS === 'ios' ? 18 : 12, // extra top padding for label
  },
  locBanner: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 86 : 80,
    left: 12,
    right: 12,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  locBannerText: {
    color: '#fff',
    fontSize: 13,
    textAlign: 'center',
  },
  filterWrap: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 28 : 22, // more vertical spacing
    left: 12,
    right: 12,
    alignItems: 'center',
    zIndex: 10,
  },
  filterRow: {
    flexDirection: 'row',
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderRadius: 18, // more rounded
    padding: 4,
    gap: 6,
    borderWidth: 1.5,
    borderColor: 'rgba(0,133,63,0.18)', // subtle green border
  },
  filterChip: {
    position: 'relative',
    overflow: 'hidden',
    borderRadius: 14, // more rounded
    paddingVertical: 7,
    paddingHorizontal: 16,
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
  },
  filterChipActiveBase: {
    borderWidth: 0,
  },
  filterChipActiveTrain: {
    backgroundColor: GO_GREEN,
  },
  filterChipActiveBus: {
    backgroundColor: '#D22F27',
  },
  filterText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 13,
    fontFamily: 'System',
  },
  filterTextActive: {
    color: '#fff',
    fontFamily: 'System',
  },
  syncBanner: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 130 : 98,
    left: 12,
    right: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.96)',
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  syncBannerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  syncBannerText: {
    flex: 1,
    color: '#111827',
    fontSize: 13,
    fontWeight: '600',
  },
  syncProgressTrack: {
    marginTop: 8,
    height: 8,
    borderRadius: 999,
    backgroundColor: '#E5E7EB',
    overflow: 'hidden',
  },
  syncProgressFill: {
    height: '100%',
    backgroundColor: GO_GREEN,
  },
  syncProgressMeta: {
    marginTop: 6,
    color: '#4B5563',
    fontSize: 12,
    fontWeight: '600',
  },
  syncRetryBtn: {
    alignSelf: 'flex-start',
    marginTop: 8,
    backgroundColor: GO_GREEN,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  syncRetryBtnText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
  },
  locateBtn: {
    position: 'absolute',
    right: 22,
    bottom: 48,
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: GO_GREEN,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.28,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  sheetHandle: {
    backgroundColor: '#ccc',
  },
  sheetBg: {
    backgroundColor: '#fff',
  },
  sheetContent: {
    paddingHorizontal: 20,
    paddingBottom: 28,
  },
  sheetTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#111',
    marginBottom: 16,
  },
  sheetEmpty: {
    color: '#666',
    marginBottom: 20,
  },
  viewAllBtn: {
    marginTop: 20,
    backgroundColor: GO_GREEN,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  viewAllText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
});
