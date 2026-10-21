import * as Notifications from 'expo-notifications';
import * as FileSystem from 'expo-file-system/legacy';
import Constants from 'expo-constants';

const PUSH_TOKEN_FILE = `${FileSystem.documentDirectory}push-token-v1.json`;
const NOTIFICATION_PREF_FILE = `${FileSystem.documentDirectory}notification-pref-v1.json`;

let configured = false;

function getProjectId() {
  return (
    Constants?.expoConfig?.extra?.eas?.projectId ||
    Constants?.easConfig?.projectId ||
    null
  );
}

async function writeToken(token) {
  try {
    await FileSystem.writeAsStringAsync(
      PUSH_TOKEN_FILE,
      JSON.stringify({ token, updatedAt: Date.now() }),
    );
  } catch (e) {
    console.log('[TransitScanner] push token write failed:', e?.message);
  }
}

export async function getStoredPushToken() {
  try {
    const info = await FileSystem.getInfoAsync(PUSH_TOKEN_FILE);
    if (!info.exists) return null;
    const raw = await FileSystem.readAsStringAsync(PUSH_TOKEN_FILE);
    const parsed = JSON.parse(raw);
    return parsed?.token ? String(parsed.token) : null;
  } catch {
    return null;
  }
}

export async function getNotificationPreference() {
  try {
    const info = await FileSystem.getInfoAsync(NOTIFICATION_PREF_FILE);
    if (!info.exists) return null;
    const raw = await FileSystem.readAsStringAsync(NOTIFICATION_PREF_FILE);
    const parsed = JSON.parse(raw);
    if (typeof parsed?.enabled !== 'boolean') return null;
    return parsed.enabled;
  } catch {
    return null;
  }
}

export async function setNotificationPreference(enabled) {
  try {
    await FileSystem.writeAsStringAsync(
      NOTIFICATION_PREF_FILE,
      JSON.stringify({ enabled: Boolean(enabled), updatedAt: Date.now() }),
    );
  } catch (e) {
    console.log('[TransitScanner] notification preference write failed:', e?.message);
  }
}

export async function configureNotifications() {
  if (configured) return;

  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });

  await Notifications.setNotificationChannelAsync('general', {
    name: 'General',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 250, 250],
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
  });

  configured = true;
}

export async function registerForPushNotifications() {
  await configureNotifications();

  const current = await Notifications.getPermissionsAsync();
  let finalStatus = current.status;

  if (current.status !== 'granted') {
    const requested = await Notifications.requestPermissionsAsync();
    finalStatus = requested.status;
  }

  if (finalStatus !== 'granted') {
    return { token: null, granted: false };
  }

  let token = null;
  try {
    const projectId = getProjectId();
    const tokenResponse = projectId
      ? await Notifications.getExpoPushTokenAsync({ projectId })
      : await Notifications.getExpoPushTokenAsync();
    token = tokenResponse?.data ? String(tokenResponse.data) : null;

    if (token) {
      await writeToken(token);
    }
  } catch (e) {
    // Permission can be granted even when Expo push token retrieval fails in dev setups.
    console.log('[TransitScanner] push token fetch failed:', e?.message);
  }

  return { token, granted: true };
}

export async function scheduleLocalNotification({ title, body, data = {} }) {
  await configureNotifications();
  return Notifications.scheduleNotificationAsync({
    content: {
      title: String(title || ''),
      body: String(body || ''),
      data,
      sound: 'default',
      priority: Notifications.AndroidNotificationPriority.HIGH,
    },
    // Immediate delivery routed through the 'general' channel on Android.
    // expo-notifications only applies channelId on Android; on iOS this
    // parses to a null trigger, identical to `trigger: null`.
    trigger: { channelId: 'general' },
  });
}
