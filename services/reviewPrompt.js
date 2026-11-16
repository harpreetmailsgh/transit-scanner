import AsyncStorage from '@react-native-async-storage/async-storage';

// NOTE: expo-store-review is NOT imported at module level on purpose.
// Its native entry calls requireNativeModule('ExpoStoreReview') at load
// time, which throws synchronously on builds that predate the module
// (e.g. the 1.1 store build). Requiring it lazily inside
// maybeAskForReview() puts that throw inside the try/catch below, so a
// missing native module degrades to "no prompt" instead of crashing the
// import of this module (and, from the search screen, every Search tap).

const VIEW_COUNT_KEY = 'ts:searchViews';
const ASKED_KEY = 'ts:reviewAsked';
// Ask once the user has seen the search screen a few times (an engaged
// user, not a first-timer). Apple additionally throttles the native prompt
// itself, so this can never spam.
const VIEWS_BEFORE_ASK = 4;

/**
 * Call when the search screen is shown (one view per focus).
 * Shows the native iOS/Android in-app review prompt at most once ever.
 */
export async function maybeAskForReview() {
  try {
    const raw = await AsyncStorage.getItem(VIEW_COUNT_KEY);
    const views = (parseInt(raw || '0', 10) || 0) + 1;
    await AsyncStorage.setItem(VIEW_COUNT_KEY, String(views));

    if (views < VIEWS_BEFORE_ASK) return;
    if (await AsyncStorage.getItem(ASKED_KEY)) return;

    // Lazy require (see note at the top of this file): throws here when
    // the native module is absent, and lands in the catch below.
    const StoreReview = require('expo-store-review');

    if (await StoreReview.isAvailableAsync()) {
      await StoreReview.requestReview();
      await AsyncStorage.setItem(ASKED_KEY, '1');
    }
  } catch {
    // A review prompt must never break the app.
  }
}
