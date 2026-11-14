/**
 * Anonymous install ID: one random ID per app install, used only to count
 * distinct active users from our own Supabase telemetry (usageCounts.js).
 *
 * - Random, not derived from the device, user, or account. No name,
 *   email, account, GPS/location, device ID, or advertising ID is ever
 *   involved — the ID is just a random UUID-v4-shaped string.
 * - Stored in AsyncStorage under INSTALL_ID_KEY. Deleting the app wipes
 *   AsyncStorage, so a reinstall gets a fresh ID; a reinstall is counted
 *   as a new install, which is exactly what we want.
 * - Never throws: any AsyncStorage failure returns null, and rows go out
 *   without an install_id (see usageCounts.js). Nothing here blocks
 *   startup — callers kick it off fire-and-forget at launch.
 *
 * UUID generation: Hermes (the React Native runtime) exposes
 * globalThis.crypto.getRandomValues, so that is tried first; if it is
 * absent or throws, a Math.random-based v4-format string is used.
 * Uniqueness across installs is what matters, not cryptographic
 * strength, so the fallback is fine.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const INSTALL_ID_KEY = 'transit-scanner-install-id.v1';

// In-memory cache: once loaded (or generated), every later caller gets
// the same ID without another AsyncStorage read.
let cachedInstallId = null;

// In-flight promise: concurrent callers share one load/generate cycle,
// so two calls racing on a cold store cannot each generate a different
// ID. Cleared on settle (success and failure alike).
let installIdInFlight = null;

/**
 * Generates a UUID-v4-shaped string (xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx,
 * version nibble 4, variant nibble 8/9/a/b). Pure — no storage, no
 * network — so it can be harnessed in plain node.
 */
export function generateInstallId() {
  const bytes = new Array(16).fill(0);
  let filled = false;
  try {
    const cryptoObj = globalThis.crypto;
    if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
      const randomBytes = new Uint8Array(16);
      cryptoObj.getRandomValues(randomBytes);
      for (let i = 0; i < 16; i += 1) bytes[i] = randomBytes[i];
      filled = true;
    }
  } catch {
    // Fall through to the Math.random fill below.
    filled = false;
  }
  if (!filled) {
    for (let i = 0; i < 16; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  // Version 4 (0100) in byte 6, variant 10xx in byte 8.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20, 32)}`
  );
}

/**
 * Loads the install ID from AsyncStorage, generating and storing one on
 * first launch. Returns the ID string, or null on any failure. Never
 * throws. Safe to call fire-and-forget at startup; concurrent calls
 * share one in-flight load/generate cycle, and once the ID is cached
 * every later caller gets it directly.
 */
export async function ensureInstallId() {
  if (cachedInstallId) return cachedInstallId;
  if (installIdInFlight) return installIdInFlight;
  installIdInFlight = (async () => {
    try {
      const stored = await AsyncStorage.getItem(INSTALL_ID_KEY);
      const existing = typeof stored === 'string' ? stored.trim() : '';
      if (existing) {
        cachedInstallId = existing;
        return cachedInstallId;
      }
      const generated = generateInstallId();
      await AsyncStorage.setItem(INSTALL_ID_KEY, generated);
      cachedInstallId = generated;
      return cachedInstallId;
    } catch {
      // AsyncStorage unavailable — telemetry goes out without an ID.
      return null;
    } finally {
      installIdInFlight = null;
    }
  })();
  return installIdInFlight;
}

/** Sync read of the cached ID, or null if it has not loaded yet. */
export function getInstallId() {
  return cachedInstallId;
}
