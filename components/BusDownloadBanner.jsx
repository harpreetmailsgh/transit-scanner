import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { formatBusDownloadMessage } from '../services/gtfsSqliteService';

const GO_GREEN = '#00853F';

// The bus time-left message, shared by the search mode toggle, the home
// bus filter, and the departures screen so all three show the same text.
// `state` is a getBusDownloadState() snapshot (the parent subscribes and
// re-renders on progress, which is what keeps the time-left text live).
// When status is 'error' the banner shows the named error plus a retry
// button; it never shows "No departures" or an empty list as if there
// were simply no bus service. Renders nothing for 'done'/'idle' states
// unless the parent explicitly passes a downloading state — parents own
// visibility (bus selected AND bus schedules not loaded for the date).
export default function BusDownloadBanner({ state, onRetry }) {
  const status = state?.status || 'idle';
  if (status === 'done') return null;
  const message = formatBusDownloadMessage(state);
  const isError = status === 'error';
  return (
    <View style={[styles.banner, isError && styles.bannerError]}>
      {!isError ? (
        <ActivityIndicator size="small" color={GO_GREEN} style={styles.spinner} />
      ) : null}
      <Text style={[styles.text, isError && styles.textError]}>{message}</Text>
      {isError && onRetry ? (
        <Pressable style={styles.retryBtn} onPress={onRetry} hitSlop={8}>
          <Text style={styles.retryText}>Try again</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#eef7f0',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginHorizontal: 16,
    marginTop: 8,
  },
  bannerError: {
    backgroundColor: '#fdf0ef',
  },
  spinner: {
    marginRight: 8,
  },
  text: {
    flex: 1,
    fontSize: 14,
    color: '#1a4d2e',
  },
  textError: {
    color: '#8b1e1e',
  },
  retryBtn: {
    marginLeft: 10,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: GO_GREEN,
  },
  retryText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
});
