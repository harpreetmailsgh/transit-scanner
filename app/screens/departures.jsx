import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useNavigation } from 'expo-router';
import { TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import DepartureListRow from '../../components/DepartureListRow';
import { getLiveDepartures } from '../../services/gtfsRealtimeService';
import { maybeAskForReview } from '../../services/reviewPrompt';

const GO_GREEN = '#00853F';

export default function DeparturesScreen() {
  const params = useLocalSearchParams();
  const navigation = useNavigation();
  const stopId = params.stopId ? String(params.stopId) : '';
  const stopName = params.stopName ? String(params.stopName) : 'Stop';
  const stopFilter = params.stopFilter ? String(params.stopFilter) : 'trains';
  const [departures, setDepartures] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!stopId) {
      setDepartures([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    let mode = null;
    if (stopFilter === 'trains') mode = 'train';
    if (stopFilter === 'buses') mode = 'bus';
    const deps = getLiveDepartures(stopId, 100, { mode });
    setDepartures(Array.isArray(deps) ? deps : []);
    setLoading(false);
    if (Array.isArray(deps) && deps.length > 0) {
      maybeAskForReview();
    }
  }, [stopId, stopFilter]);

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

      <FlatList
        data={departures}
        keyExtractor={(item) => `${item.trip_id}-${item.route_id}-${item.scheduledTimeLabel || item.scheduledDateTime}`}
        renderItem={({ item }) => <DepartureListRow item={item} />}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={<Text style={styles.emptyText}>No upcoming departures found for this stop today.</Text>}
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
  listContent: {
    paddingHorizontal: 20,
    paddingBottom: 28,
  },
  emptyText: {
    color: '#666',
    marginTop: 10,
  },
});
