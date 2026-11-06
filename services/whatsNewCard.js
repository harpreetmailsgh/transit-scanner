import AsyncStorage from '@react-native-async-storage/async-storage';

// Seen flag for the v1.2 what's-new card. Set when "Got it" is tapped;
// once set, the card never shows again.
const SEEN_KEY = 'ts:whatsNewSeen_v1_2';
// Set by services/reviewPrompt.js on every departures view. A fresh
// install can never have it when home first renders (departures can
// only be viewed after home renders), so its presence means this is
// an upgrading user — the only audience for the card.
const DEPARTURE_VIEWS_KEY = 'ts:departureViews';

/**
 * True only for an upgrading user who has not dismissed the card yet.
 * Never throws: any storage failure means "don't show the card".
 */
export async function shouldShowWhatsNew() {
  try {
    if (await AsyncStorage.getItem(SEEN_KEY)) return false;
    if ((await AsyncStorage.getItem(DEPARTURE_VIEWS_KEY)) == null) return false;
    return true;
  } catch {
    return false;
  }
}

/** Records that the card was dismissed. Never throws. */
export async function markWhatsNewSeen() {
  try {
    await AsyncStorage.setItem(SEEN_KEY, '1');
  } catch {
    // Card still hides for this launch; it may show again next launch.
  }
}
