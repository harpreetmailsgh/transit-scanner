/**
 * Native-only map (iOS / Android). Metro picks this file instead of HomeMap.web
 * so the web bundle never imports react-native-maps.
 */

import { StyleSheet } from 'react-native';
import MapView, { Marker, Polyline, PROVIDER_DEFAULT } from 'react-native-maps';

const RAIL_ROUTE_TYPE = 2;
const BUS_ROUTE_TYPE = 3;

/**
 * @param {{
 *   mapRef: import('react').RefObject<any>;
 *   initialRegion: { latitude: number; longitude: number; latitudeDelta: number; longitudeDelta: number };
 *   locationReady: boolean;
 *   activeFilter?: 'trains' | 'buses';
 *   showRouteLines?: boolean;
 *   trainShapePolylines?: Array<Array<{ latitude: number; longitude: number }>>;
 *   busShapePolylines?: Array<Array<{ latitude: number; longitude: number }>>;
 *   stopMarkers: Array<{ stop_id: string; stop_name?: string; lat: number; lon: number; routeTypes?: number[]; stopKind?: 'train' | 'bus' | 'both'; markerKind?: 'train' | 'bus' | 'both' }>;
 *   vehicles: Array<{ trip_id?: string | null; latitude: number; longitude: number; route_id?: string | null }>;
 *   vehicleMarkerRefs: import('react').MutableRefObject<Record<string, unknown>>;
 *   onStopPress: (stop: object) => void;
 * }} props
 */
const TRAIN_LINE = '#00853F';
const BUS_LINE = '#D22F27';

export default function HomeMap({
  mapRef,
  initialRegion,
  locationReady,
  activeFilter,
  showRouteLines,
  trainShapePolylines,
  busShapePolylines,
  stopMarkers,
  vehicles,
  vehicleMarkerRefs,
  onStopPress,
}) {
  const trainLines = trainShapePolylines || [];
  const busLines = busShapePolylines || [];
  const filteredStopMarkers = (stopMarkers || []).filter((s) => {
    const routeTypes = Array.isArray(s.routeTypes)
      ? s.routeTypes.map((t) => Number(t))
      : [];

    const hasTrain =
      routeTypes.includes(RAIL_ROUTE_TYPE) ||
      s.stopKind === 'train' ||
      s.stopKind === 'both' ||
      s.markerKind === 'train' ||
      s.markerKind === 'both';
    const hasBus =
      routeTypes.includes(BUS_ROUTE_TYPE) ||
      s.stopKind === 'bus' ||
      s.stopKind === 'both' ||
      s.markerKind === 'bus' ||
      s.markerKind === 'both';

    if (activeFilter === 'buses') return hasBus;
    return hasTrain;
  });

  return (
    <MapView
      ref={mapRef}
      style={StyleSheet.absoluteFill}
      provider={PROVIDER_DEFAULT}
      initialRegion={initialRegion}
      showsUserLocation={locationReady}
      showsMyLocationButton={false}
      mapType="standard"
    >
      {showRouteLines
        ? trainLines.map((coords, i) => (
            <Polyline
              key={`shape-train-${i}`}
              coordinates={coords}
              strokeColor={TRAIN_LINE}
              strokeWidth={3}
              lineCap="round"
              lineJoin="round"
              zIndex={0}
            />
          ))
        : null}
      {showRouteLines
        ? busLines.map((coords, i) => (
            <Polyline
              key={`shape-bus-${i}`}
              coordinates={coords}
              strokeColor={BUS_LINE}
              strokeWidth={3}
              lineCap="round"
              lineJoin="round"
              zIndex={1}
            />
          ))
        : null}
      {filteredStopMarkers.map((s) => {
        return (
          <Marker
            key={`stop-${activeFilter || 'trains'}-${s.stop_id}`}
            coordinate={{ latitude: s.lat, longitude: s.lon }}
            pinColor={
              s.markerKind === 'both' ? 'purple' : s.markerKind === 'bus' ? 'red' : 'green'
            }
            tracksViewChanges={false}
            title={s.stop_name}
            onPress={() => onStopPress(s)}
          />
        );
      })}

      {vehicles.map((v) => {
        if (v.trip_id == null) return null;
        const tid = String(v.trip_id);
        return (
          <Marker
            key={`veh-${tid}`}
            ref={(r) => {
              if (r) vehicleMarkerRefs.current[tid] = r;
              else delete vehicleMarkerRefs.current[tid];
            }}
            coordinate={{
              latitude: v.latitude,
              longitude: v.longitude,
            }}
            pinColor="blue"
            tracksViewChanges={false}
            title="GO train"
            description={v.route_id ? `Route ${v.route_id}` : undefined}
          />
        );
      })}
    </MapView>
  );
}
