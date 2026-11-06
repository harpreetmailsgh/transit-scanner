import * as FileSystem from 'expo-file-system/legacy';
import * as SQLite from 'expo-sqlite';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { DateTime } from 'luxon';

const DEFAULT_TIMEOUT_MS = 30000;
const CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const TORONTO = 'America/Toronto';

const CORE_DB_NAME = 'go-gtfs-core.sqlite';
const MONTH_DB_NAME = 'go-gtfs-month.sqlite';
const LEGACY_DB_NAME = 'go-gtfs-v1.sqlite';

const DB_OPEN_DIR = String(SQLite.defaultDatabaseDirectory || '').replace(/[\\/]+$/, '');
const DB_DIR = `${DB_OPEN_DIR}/`;
const CORE_DB_FILE = joinPath(DB_OPEN_DIR, CORE_DB_NAME);
const MONTH_DB_FILE = joinPath(DB_OPEN_DIR, MONTH_DB_NAME);
const LEGACY_DB_FILE = joinPath(DB_OPEN_DIR, LEGACY_DB_NAME);

// expo-file-system APIs take file:// URIs; DB_OPEN_DIR is a bare path, which
// Android's native module rejects outright (iOS converts it silently). Keep
// the bare *_DB_FILE paths ONLY for SQLite.openDatabaseAsync and diagnostics;
// every FileSystem call uses these URI forms of the same real locations.
const DB_FS_DIR = toFileUri(DB_DIR);
const CORE_DB_URI = joinUri(DB_FS_DIR, CORE_DB_NAME);
const MONTH_DB_URI = joinUri(DB_FS_DIR, MONTH_DB_NAME);
const LEGACY_DB_URI = joinUri(DB_FS_DIR, LEGACY_DB_NAME);

const BUNDLE_META_FILE = `${FileSystem.documentDirectory}go-gtfs-bundle-meta.json`;
const LEGACY_META_FILE = `${FileSystem.documentDirectory}go-gtfs-v1-meta.json`;
const SQLITE_UPDATE_FILE = `${FileSystem.documentDirectory}go-gtfs-v1-update.json`;

// Default GTFS SQLite asset URLs are still hosted from the existing GitHub release repo path.
const DEFAULT_MANIFEST_URL =
  'https://github.com/harpreetmailsgh/transit-scanner/releases/download/gtfs-data/manifest.json';
const DEFAULT_DB_URL =
  'https://github.com/harpreetmailsgh/transit-scanner/releases/download/gtfs-data/go-gtfs-v1.sqlite';

const MANIFEST_URL = (process.env.EXPO_PUBLIC_GTFS_SQLITE_MANIFEST_URL || DEFAULT_MANIFEST_URL).trim();
const FALLBACK_DB_URL = (process.env.EXPO_PUBLIC_GTFS_SQLITE_DB_URL || DEFAULT_DB_URL).trim();

const TRIP_BATCH_SIZE = 400;
const STOP_TIME_BATCH_SIZE = 500;

function joinPath(base, name) {
  const safeBase = String(base || '').replace(/[\\/]+$/, '');
  const safeName = String(name || '').replace(/^[\\/]+/, '');
  return `${safeBase}/${safeName}`;
}

function joinUri(base, name) {
  const safeBase = String(base || '').replace(/\/?$/, '/');
  const safeName = String(name || '').replace(/^\/+/, '');
  return `${safeBase}${safeName}`;
}

function toFileUri(fsPath) {
  const raw = String(fsPath || '');
  if (!raw) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw;
  return `file://${raw.startsWith('/') ? '' : '/'}${raw}`;
}

function hasAnyUrl() {
  return Boolean(MANIFEST_URL || FALLBACK_DB_URL);
}

function torontoTodayYmd() {
  return DateTime.now().setZone(TORONTO).toFormat('yyyyMMdd');
}

function addDaysYmd(ymd, days) {
  return DateTime.fromFormat(ymd, 'yyyyMMdd', { zone: TORONTO }).plus({ days }).toFormat('yyyyMMdd');
}

function resolveAssetUrl(url, baseUrl = MANIFEST_URL) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  if (!baseUrl) return raw;
  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return raw;
  }
}

async function fetchWithTimeout(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function readJson(path) {
  try {
    const raw = await FileSystem.readAsStringAsync(path);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeJson(path, value) {
  await FileSystem.writeAsStringAsync(path, JSON.stringify(value));
}

async function getFileInfo(filePath) {
  try {
    return await FileSystem.getInfoAsync(filePath);
  } catch {
    return { exists: false };
  }
}

function normalizeAsset(asset, baseUrl) {
  if (!asset || typeof asset !== 'object') return null;
  const fileName = String(asset.fileName || '').trim();
  const url = resolveAssetUrl(asset.url || fileName, baseUrl);
  if (!url) return null;
  const mode = String(asset.mode || '').trim() || null;
  return {
    fileName: fileName || url.split('/').pop(),
    url,
    sizeBytes: Number(asset.sizeBytes || asset.size || 0) || 0,
    checksumSha256: String(asset.checksumSha256 || asset.sha256 || '').trim() || null,
    // MD5 is the on-device verifiable checksum (expo-file-system computes
    // it natively); sha256 stays the manifest's primary checksum.
    checksumMd5: String(asset.checksumMd5 || asset.md5 || '').trim().toLowerCase() || null,
    startDate: String(asset.startDate || '').trim() || null,
    endDate: String(asset.endDate || '').trim() || null,
    // Mode is part of the identity now: without it, train and bus weeks
    // for the same span collapse onto one id/filename. Legacy entries
    // (no mode) are both-modes files and keep mode null.
    mode: mode === 'train' || mode === 'bus' ? mode : null,
    id: String(asset.id || (mode ? `${asset.startDate}-${mode}` : asset.startDate) || '').trim() || null,
  };
}

function normalizeManifest(payload) {
  if (!payload || typeof payload !== 'object') return null;

  if (payload.core && payload.month) {
    const core = normalizeAsset(payload.core, MANIFEST_URL);
    const month = normalizeAsset(payload.month, MANIFEST_URL);
    if (!core?.url || !month?.url) return null;
    const weeks = Array.isArray(payload.weeks)
      ? payload.weeks.map((w) => normalizeAsset(w, MANIFEST_URL)).filter(Boolean)
      : [];
    return {
      format: 'v2',
      version: String(payload.version || payload.generatedAt || Date.now()),
      generatedAt: String(payload.generatedAt || '').trim() || null,
      buildDate: String(payload.buildDate || month.startDate || '').trim() || null,
      core,
      month,
      weeks,
    };
  }

  let dbUrl = String(payload.dbUrl || payload.db_url || FALLBACK_DB_URL || '').trim();
  dbUrl = resolveAssetUrl(dbUrl);
  if (!dbUrl) return null;
  return {
    format: 'v1',
    version: String(payload.version || payload.generatedAt || payload.updatedAt || Date.now()),
    dbUrl,
    sizeBytes: Number(payload.sizeBytes || payload.size || 0) || 0,
    checksumSha256: String(payload.checksumSha256 || payload.sha256 || '').trim() || null,
    generatedAt: String(payload.generatedAt || '').trim() || null,
  };
}

function logHostedSqlite(phase, detail) {
  if (typeof __DEV__ !== 'undefined' && !__DEV__) return;
  if (detail !== undefined) {
    console.log(`[TransitScanner][gtfsSqliteService] ${phase}`, detail);
  } else {
    console.log(`[TransitScanner][gtfsSqliteService] ${phase}`);
  }
}

function getRuntimeDiagnostics() {
  const expoConfig = Constants?.expoConfig || {};
  const iosConfig = expoConfig?.ios || {};
  const androidConfig = expoConfig?.android || {};
  return {
    platform: Platform.OS,
    osVersion: String(Platform.Version || ''),
    executionEnvironment: Constants?.executionEnvironment || null,
    app: {
      name: expoConfig?.name || null,
      slug: expoConfig?.slug || null,
      version: expoConfig?.version || null,
      runtimeVersion: expoConfig?.runtimeVersion || null,
      iosBuildNumber: iosConfig?.buildNumber || null,
      androidVersionCode: androidConfig?.versionCode || null,
    },
    paths: {
      documentDirectory: FileSystem.documentDirectory || null,
      cacheDirectory: FileSystem.cacheDirectory || null,
      sqliteDefaultDatabaseDirectory: DB_OPEN_DIR || null,
      sqliteInstallDirectory: DB_DIR || null,
    },
    config: {
      manifestUrl: MANIFEST_URL || null,
      fallbackDbUrl: FALLBACK_DB_URL || null,
    },
  };
}

async function getStorageDiagnostics() {
  const out = {};
  try {
    out.freeDiskStorageBytes = await FileSystem.getFreeDiskStorageAsync();
  } catch (err) {
    out.freeDiskStorageError = err?.message || String(err || '');
  }
  try {
    out.totalDiskCapacityBytes = await FileSystem.getTotalDiskCapacityAsync();
  } catch (err) {
    out.totalDiskCapacityError = err?.message || String(err || '');
  }
  return out;
}

function createHostedSqliteError(stage, message, details = {}) {
  const error = new Error(`[hosted-sqlite:${stage}] ${message}`);
  error.stage = String(stage || 'unknown');
  error.details = {
    stage: error.stage,
    runtime: getRuntimeDiagnostics(),
    ...(details || {}),
  };
  return error;
}

async function fetchRemoteManifest(timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (MANIFEST_URL) {
    const res = await fetchWithTimeout(MANIFEST_URL, timeoutMs);
    if (!res.ok) {
      throw createHostedSqliteError('manifest-fetch', 'GTFS manifest fetch failed.', {
        url: MANIFEST_URL,
        status: res.status,
        statusText: res.statusText || null,
      });
    }
    const payload = await res.json();
    const manifest = normalizeManifest(payload);
    if (!manifest) {
      throw createHostedSqliteError('manifest-parse', 'GTFS manifest is invalid.', {
        url: MANIFEST_URL,
      });
    }
    return manifest;
  }

  if (FALLBACK_DB_URL) {
    return normalizeManifest({
      dbUrl: FALLBACK_DB_URL,
      version: 'fallback-db-url',
    });
  }

  return null;
}

async function ensureDbDirectory() {
  await FileSystem.makeDirectoryAsync(DB_FS_DIR, { intermediates: true }).catch((err) => {
    logHostedSqlite('ensureDbDirectory:mkdir-failed', {
      dir: DB_FS_DIR,
      error: err?.message || String(err),
    });
  });
  // Stray files an old build created by concatenating the DB name directly
  // onto DB_OPEN_DIR with no separator (e.g. ".../SQLitego-gtfs-core.sqlite").
  // Same target locations as before, in URI form so the delete actually runs
  // on Android — these are NOT the real DB files, which live inside DB_FS_DIR.
  const malformedLegacyFiles = [
    `${toFileUri(DB_OPEN_DIR)}${CORE_DB_NAME}`,
    `${toFileUri(DB_OPEN_DIR)}${MONTH_DB_NAME}`,
    `${toFileUri(DB_OPEN_DIR)}${LEGACY_DB_NAME}`,
  ];
  for (const path of malformedLegacyFiles) {
    await FileSystem.deleteAsync(path, { idempotent: true }).catch(() => {});
  }
}

async function downloadFile(dbUrl, destPath, onProgress, label = 'schedules', expectedTotalBytes = 0) {
  const destFileName = String(destPath || '').replace(/^.*[\\/]/, '');
  const tempPath = Platform.OS === 'ios'
    ? joinUri(FileSystem.documentDirectory, `${destFileName}.download`)
    : `${destPath}.download`;
  await FileSystem.deleteAsync(tempPath, { idempotent: true }).catch(() => {});
  await ensureDbDirectory();
  const storageBeforeDownload = await getStorageDiagnostics();

  let lastBucket = -1;
  let result = null;
  let downloadError = null;
  const downloadMode = Platform.OS === 'ios' ? 'downloadAsync' : 'createDownloadResumable';
  logHostedSqlite('download:start', {
    label,
    dbUrl,
    destPath,
    tempPath,
    downloadMode,
    platform: Platform.OS,
  });
  // Every progress event carries bytesWritten/totalBytes so callers can
  // report REAL progress (bytes vs the manifest's sizeBytes) instead of
  // a spinner. expectedTotalBytes is the manifest size when known.
  const expectedTotal = Number(expectedTotalBytes || 0) || 0;
  // Use a non-resumable download on iOS to avoid known corruption with resumable API.
  // downloadAsync reports NO progress, so poll the temp file's size while
  // it runs — this keeps the iOS download mechanism unchanged while still
  // giving the bus time-left message real bytes to work with.
  if (Platform.OS === 'ios') {
    onProgress?.({ message: `Downloading ${label}...`, percent: 0.05, bytesWritten: 0, totalBytes: expectedTotal });
    let pollId = null;
    if (onProgress) {
      pollId = setInterval(() => {
        getFileInfo(tempPath)
          .then((info) => {
            if (!info?.exists) return;
            const written = Number(info.size || 0);
            const pct = expectedTotal > 0 ? Math.max(0, Math.min(1, written / expectedTotal)) : 0;
            onProgress({
              message: `Downloading ${label}...`,
              percent: 0.05 + pct * 0.5,
              bytesWritten: written,
              totalBytes: expectedTotal,
            });
          })
          .catch(() => {});
      }, 500);
    }
    try {
      result = await FileSystem.downloadAsync(dbUrl, tempPath).catch((err) => {
        downloadError = err;
        logHostedSqlite('download:error', { label, dbUrl, tempPath, error: err?.message || String(err) });
        return null;
      });
    } finally {
      if (pollId) clearInterval(pollId);
    }
    if (!result?.uri) {
      throw createHostedSqliteError('download-failed', `Failed to download ${label}.`, {
        label,
        dbUrl,
        destPath,
        tempPath,
        downloadMode,
        platform: Platform.OS,
        storageBeforeDownload,
        downloadErrorMessage: downloadError?.message || null,
        downloadError: String(downloadError || ''),
      });
    }
  } else {
    const download = FileSystem.createDownloadResumable(
      dbUrl,
      tempPath,
      {},
      (event) => {
        if (!onProgress) return;
        const written = Number(event?.totalBytesWritten || 0);
        const expected = Number(event?.totalBytesExpectedToWrite || 0);
        if (expected <= 0 && expectedTotal <= 0) return;
        const total = expected > 0 ? expected : expectedTotal;
        const pct = total > 0 ? Math.max(0, Math.min(1, written / total)) : 0;
        const bucket = Math.floor(pct * 100);
        if (bucket === lastBucket) return;
        lastBucket = bucket;
        onProgress({
          message: `Downloading ${label}... ${bucket}%`,
          percent: 0.05 + pct * 0.5,
          bytesWritten: written,
          totalBytes: total,
        });
      },
    );
    result = await download.downloadAsync().catch((err) => {
      downloadError = err;
      logHostedSqlite('download:error', { label, dbUrl, tempPath, error: err?.message || String(err) });
      return null;
    });
    if (!result?.uri) {
      throw createHostedSqliteError('download-failed', `Failed to download ${label}.`, {
        label,
        dbUrl,
        destPath,
        tempPath,
        downloadMode,
        platform: Platform.OS,
        storageBeforeDownload,
        downloadErrorMessage: downloadError?.message || null,
        downloadError: String(downloadError || ''),
      });
    }
  }

  const tempInfo = await getFileInfo(result.uri);
  const storageAfterDownload = await getStorageDiagnostics();
  await FileSystem.deleteAsync(destPath, { idempotent: true }).catch(() => {});
  try {
    await FileSystem.moveAsync({ from: result.uri, to: destPath });
  } catch (err) {
    throw createHostedSqliteError('move-failed', `Failed to install downloaded ${label}.`, {
      label,
      dbUrl,
      from: result.uri,
      to: destPath,
      tempPath,
      tempFile: {
        exists: !!tempInfo?.exists,
        sizeBytes: Number(tempInfo?.size || 0),
        uri: tempInfo?.uri || result.uri,
      },
      platform: Platform.OS,
      storageBeforeDownload,
      storageAfterDownload,
      moveErrorMessage: err?.message || null,
      moveError: String(err || ''),
    });
  }

  return destPath;
}

async function validateDbTables(dbName, requiredTables, stopsRequired = false, integrityRequired = false) {
  const dbFile = joinPath(DB_OPEN_DIR, dbName);
  const dbUri = toFileUri(dbFile);
  const beforeOpenInfo = await getFileInfo(dbUri);
  if (!beforeOpenInfo?.exists || Number(beforeOpenInfo?.size || 0) <= 0) {
    return {
      ok: false,
      reason: `Database file is missing or empty: ${dbName}`,
      missingTables: requiredTables,
      foundTables: [],
      dbFile,
      fileExists: !!beforeOpenInfo?.exists,
      fileSizeBytes: Number(beforeOpenInfo?.size || 0),
      integrityCheck: '(not opened)',
    };
  }

  const db = await SQLite.openDatabaseAsync(dbName, { useNewConnection: true }, DB_OPEN_DIR);
  try {
    const rows = await db.getAllAsync("SELECT name FROM sqlite_master WHERE type = 'table'");
    const tableNames = new Set((rows || []).map((row) => String(row?.name || '')));
    const dbFileInfo = await getFileInfo(dbUri);
    const missing = requiredTables.filter((table) => !tableNames.has(table));
    logHostedSqlite('validate: tables', {
      dbName,
      dbFile,
      requiredTables,
      stopsRequired: !!stopsRequired,
      fileExists: !!dbFileInfo?.exists,
      fileSizeBytes: Number(dbFileInfo?.size || 0),
      foundCount: tableNames.size,
      foundSample: [...tableNames].slice(0, 24),
      missingTables: missing,
    });
    if (missing.length) {
      let integrity = null;
      try {
        const integrityRow = await db.getFirstAsync('PRAGMA integrity_check;');
        integrity = integrityRow?.integrity_check ?? integrityRow?.integrity_check?.toString?.() ?? null;
      } catch {
        integrity = null;
      }
      return {
        ok: false,
        reason: `Missing tables: ${missing.join(', ')}`,
        missingTables: missing,
        foundTables: Array.from(tableNames),
        dbFile,
        fileExists: !!dbFileInfo?.exists,
        fileSizeBytes: Number(dbFileInfo?.size || 0),
        integrityCheck: integrity ?? '(unknown)',
      };
    }
    // Fresh-download gate only (integrityRequired): a truncated file can
    // still list its tables, so PRAGMA integrity_check is the corruption
    // backstop behind the MD5 gate. Installed-file validation stays
    // table-only so startup is not slowed by a full scan.
    if (integrityRequired) {
      let integrityRows = null;
      try {
        integrityRows = await db.getAllAsync('PRAGMA integrity_check;');
      } catch {
        integrityRows = null;
      }
      const integrityValues = (integrityRows || []).map(
        (row) => String(row?.integrity_check ?? Object.values(row || {})[0] ?? ''),
      );
      if (!integrityValues.length || !integrityValues.every((v) => v === 'ok')) {
        return {
          ok: false,
          reason: `Integrity check failed: ${integrityValues.join('; ') || '(unknown)'}`,
          missingTables: [],
          foundTables: Array.from(tableNames),
          dbFile,
          fileExists: !!dbFileInfo?.exists,
          fileSizeBytes: Number(dbFileInfo?.size || 0),
          integrityCheck: integrityValues.join('; ') || '(unknown)',
        };
      }
    }
    if (stopsRequired) {
      const stopCountRow = await db.getFirstAsync('SELECT COUNT(*) AS count FROM stops');
      const stopCount = Number(stopCountRow?.count || 0);
      if (!Number.isFinite(stopCount) || stopCount <= 0) {
        return {
          ok: false,
          reason: 'Stops table is empty.',
          missingTables: [],
          foundTables: Array.from(tableNames),
          dbFile,
          fileExists: !!dbFileInfo?.exists,
          fileSizeBytes: Number(dbFileInfo?.size || 0),
          integrityCheck: 'stops table empty',
          stopCount,
        };
      }
      return {
        ok: true,
        foundTables: Array.from(tableNames),
        dbFile,
        fileExists: !!dbFileInfo?.exists,
        fileSizeBytes: Number(dbFileInfo?.size || 0),
        stopCount,
      };
    }
    return {
      ok: true,
      foundTables: Array.from(tableNames),
      dbFile,
      fileExists: !!dbFileInfo?.exists,
      fileSizeBytes: Number(dbFileInfo?.size || 0),
    };
  } finally {
    await db.closeAsync().catch(() => {});
  }
}

function weekDbName(startDate, mode) {
  // Mode-suffixed names for split weeks; a missing mode keeps the legacy
  // both-modes name so old installed files still resolve.
  if (mode === 'train' || mode === 'bus') {
    return `go-gtfs-week-${startDate}-${mode}.sqlite`;
  }
  return `go-gtfs-week-${startDate}.sqlite`;
}

// The stored entry's own fileName wins (it is what the manifest named);
// otherwise construct from span + mode (legacy entries have neither a
// fileName nor a mode, so they fall back to the legacy name).
function weekDbNameForEntry(entry) {
  const fileName = String(entry?.fileName || '').trim();
  if (fileName) return fileName;
  return weekDbName(entry?.startDate, entry?.mode);
}

function weekDbFile(startDate, mode) {
  return joinPath(DB_OPEN_DIR, weekDbName(startDate, mode));
}

function weekDbUri(startDate, mode) {
  return joinUri(DB_FS_DIR, weekDbName(startDate, mode));
}

function weekDbFileForEntry(entry) {
  return joinPath(DB_OPEN_DIR, weekDbNameForEntry(entry));
}

function weekDbUriForEntry(entry) {
  return joinUri(DB_FS_DIR, weekDbNameForEntry(entry));
}

// A stored week covers a requested mode when it IS that mode, or when it
// is a legacy both-modes file (mode null/undefined).
function weekCoversMode(week, mode) {
  if (!mode) return true;
  const entryMode = week?.mode;
  if (!entryMode) return true;
  return entryMode === mode;
}

function weekEntryFromManifest(week) {
  return {
    id: String(week.id || (week.mode ? `${week.startDate}-${week.mode}` : week.startDate) || ''),
    startDate: week.startDate,
    endDate: week.endDate,
    mode: week.mode === 'train' || week.mode === 'bus' ? week.mode : null,
    fileName: week.fileName,
    checksumSha256: week.checksumSha256 || null,
    checksumMd5: week.checksumMd5 || null,
    sizeBytes: week.sizeBytes || 0,
  };
}

// ---------------------------------------------------------------------------
// Bus download progress (first-class, shared by every bus surface)
// ---------------------------------------------------------------------------
// Module-level state + pub/sub: the bus week can be downloading from the
// post-ready prefetch, the on-demand fallback, or a version-bump sync, and
// the search toggle, home bus filter, and departures screen all need the
// same live time-left text. State is updated only from REAL byte counts
// (download progress events); the formatter never invents a time.
const busDownloadListeners = new Set();
let busDownloadState = {
  status: 'idle',
  weekStart: null,
  fileName: null,
  bytesWritten: 0,
  totalBytes: 0,
  speedBytesPerSec: 0,
  startedAtMs: null,
  lastSampleAtMs: null,
  errorMessage: null,
};
let busDownloadLastBytes = null;
let busDownloadLastBytesAtMs = null;

function notifyBusDownloadListeners() {
  const snapshot = getBusDownloadState();
  for (const listener of [...busDownloadListeners]) {
    try {
      listener(snapshot);
    } catch {
      // A broken subscriber must never break the download.
    }
  }
}

function updateBusDownloadState(patch) {
  busDownloadState = { ...busDownloadState, ...(patch || {}) };
  notifyBusDownloadListeners();
}

function updateBusDownloadFromEvent(event) {
  const written = Number(event?.bytesWritten || 0);
  const total = Number(event?.totalBytes || busDownloadState.totalBytes || 0);
  if (!written || written < 0) return;
  const now = Date.now();
  let speed = busDownloadState.speedBytesPerSec || 0;
  // Smoothed speed: exponential moving average over samples at least
  // 200 ms apart, so a single fast/slow chunk cannot swing the estimate.
  // Only a bytes INCREASE refreshes the sample clock — a stall ages the
  // sample out (see the formatter's 10 s freshness rule) instead of
  // freezing a stale time on screen.
  if (
    busDownloadLastBytes !== null &&
    busDownloadLastBytesAtMs !== null &&
    written > busDownloadLastBytes &&
    now - busDownloadLastBytesAtMs >= 200
  ) {
    const instant = (written - busDownloadLastBytes) / ((now - busDownloadLastBytesAtMs) / 1000);
    speed = speed > 0 ? 0.3 * instant + 0.7 * speed : instant;
    busDownloadLastBytes = written;
    busDownloadLastBytesAtMs = now;
    updateBusDownloadState({
      bytesWritten: written,
      totalBytes: total,
      speedBytesPerSec: speed,
      lastSampleAtMs: now,
    });
  } else if (busDownloadLastBytes === null) {
    busDownloadLastBytes = written;
    busDownloadLastBytesAtMs = now;
    updateBusDownloadState({ bytesWritten: written, totalBytes: total });
  } else {
    updateBusDownloadState({ bytesWritten: written, totalBytes: total });
  }
}

export function getBusDownloadState() {
  const state = { ...busDownloadState };
  state.message = formatBusDownloadMessage(state);
  return state;
}

export function subscribeBusDownloadState(listener) {
  if (typeof listener !== 'function') return () => {};
  busDownloadListeners.add(listener);
  return () => {
    busDownloadListeners.delete(listener);
  };
}

// Plain-words time left from remaining bytes / smoothed speed. Returns the
// bare downloading line whenever no time is estimable yet (no sample, no
// total, or a sample older than 10 s) — never a fake, zero, or frozen time.
export function formatBusDownloadMessage(state) {
  const s = state || busDownloadState;
  if (s?.status === 'error') return 'Bus schedules not downloaded — try again';
  if (s?.status === 'done') return '';
  const total = Number(s?.totalBytes || 0);
  const bytes = Number(s?.bytesWritten || 0);
  const speed = Number(s?.speedBytesPerSec || 0);
  const sampleFresh =
    !!s?.lastSampleAtMs && Date.now() - Number(s.lastSampleAtMs) <= 10000;
  if (total > bytes && speed > 0 && sampleFresh) {
    const seconds = (total - bytes) / speed;
    if (Number.isFinite(seconds) && seconds > 0) {
      if (seconds < 60) {
        return `Downloading bus schedules… about ${Math.max(1, Math.ceil(seconds))} seconds left`;
      }
      const minutes = Math.max(1, Math.round(seconds / 60));
      return `Downloading bus schedules… about ${minutes} min left`;
    }
  }
  return 'Downloading bus schedules…';
}

// Content-addressed comparison: true only when the manifest and the stored
// entry PROVE different content (both checksums known and unequal, or both
// sizes known/nonzero and unequal). Unknown on either side means "cannot
// prove a change" — keep the installed file and adopt the manifest's
// checksum/size in meta, so the next bump compares exactly. A manifest
// version bump alone must never force a re-download.
function assetContentChanged(manifestAsset, storedAsset) {
  if (!manifestAsset || !storedAsset) return false;
  const manifestSum = String(manifestAsset.checksumSha256 || '');
  const storedSum = String(storedAsset.checksumSha256 || '');
  if (manifestSum && storedSum && manifestSum !== storedSum) return true;
  const manifestSize = Number(manifestAsset.sizeBytes || 0);
  const storedSize = Number(storedAsset.sizeBytes || 0);
  if (manifestSize > 0 && storedSize > 0 && manifestSize !== storedSize) return true;
  return false;
}

// Drop installed weeks whose endDate is before today, deleting their files.
// Callers persist the returned list into bundle meta.
async function pruneExpiredWeeks(entries, today) {
  const kept = [];
  const deletedIds = [];
  let changed = false;
  for (const week of entries || []) {
    const endDate = String(week?.endDate || '');
    if (endDate && endDate < today) {
      const startDate = String(week?.startDate || '');
      if (startDate) {
        await FileSystem.deleteAsync(weekDbUriForEntry(week), { idempotent: true }).catch(() => {});
      }
      deletedIds.push(String(week.id || week.startDate || ''));
      changed = true;
    } else {
      kept.push(week);
    }
  }
  if (deletedIds.length) {
    logHostedSqlite('bundle:prune-expired-weeks', { deletedIds, today });
  }
  return { installedWeeks: kept, deletedIds, changed };
}

// Keep only installed weeks whose file exists and whose tables validate.
// Invalid files are deleted so schedule resolution never opens them.
async function validateInstalledWeekEntries(entries) {
  const valid = [];
  let changed = false;
  for (const week of entries || []) {
    const startDate = String(week?.startDate || '');
    if (!startDate) {
      changed = true;
      continue;
    }
    const weekFile = weekDbUriForEntry(week);
    const weekInfo = await getFileInfo(weekFile);
    if (!weekInfo?.exists) {
      changed = true;
      continue;
    }
    const weekValidation = await validateDbTables(weekDbNameForEntry(week), ['trips', 'stop_times']).catch(
      (error) => ({ ok: false, reason: error?.message }),
    );
    if (weekValidation.ok) {
      valid.push(week);
    } else {
      logHostedSqlite('bundle:v2:existing-week-invalid', {
        weekFile,
        validation: weekValidation,
      });
      await FileSystem.deleteAsync(weekFile, { idempotent: true }).catch(() => {});
      changed = true;
    }
  }
  return { installedWeeks: valid, changed };
}

// Single-flight guard for week downloads, keyed by (week, mode): the
// post-ready prefetch and the on-demand fallback can race for the same bus
// week, and downloading it twice would corrupt the time-left accounting
// (two writers, one temp file). A waiter awaits the owner's promise and
// still sees live progress via the shared bus download state.
const weekDownloadInFlight = new Map();

// Download + validate one manifest week; throws on failure (callers decide
// whether that is fatal). A failed validation deletes the partial file.
// Partial/corrupt downloads never load: the file is only recorded in meta
// after validation passes, and a failed download/validation deletes it.
async function downloadAndValidateWeek(manifestWeek, onProgress) {
  const weekId = String(manifestWeek.id || manifestWeek.startDate || '');
  const mode = manifestWeek.mode === 'train' || manifestWeek.mode === 'bus' ? manifestWeek.mode : null;
  const flightKey = `${weekId}|${mode || 'both'}`;
  const existing = weekDownloadInFlight.get(flightKey);
  if (existing) return existing;

  const task = (async () => {
    const isBus = mode === 'bus';
    const dest = weekDbUriForEntry(manifestWeek);
    const dbName = weekDbNameForEntry(manifestWeek);
    if (isBus) {
      busDownloadLastBytes = null;
      busDownloadLastBytesAtMs = null;
      updateBusDownloadState({
        status: 'downloading',
        weekStart: String(manifestWeek.startDate || ''),
        fileName: dbName,
        bytesWritten: 0,
        totalBytes: Number(manifestWeek.sizeBytes || 0) || 0,
        speedBytesPerSec: 0,
        startedAtMs: Date.now(),
        lastSampleAtMs: null,
        errorMessage: null,
      });
    }
    // Bus progress is tracked centrally even when the caller passed no
    // onProgress (prefetch): the banner subscribes to the shared state,
    // not to any one caller's callback.
    const progressHandler = (event) => {
      if (isBus && event && typeof event === 'object') updateBusDownloadFromEvent(event);
      onProgress?.(event);
    };
    try {
      progressHandler({ message: `Downloading week ${manifestWeek.startDate}...`, percent: 0.55 });
      await downloadBundleAsset(
        manifestWeek,
        dest,
        progressHandler,
        `week ${manifestWeek.startDate}${mode ? ` ${mode}` : ''}`,
      );
      const weekValidation = await validateDbTables(
        dbName,
        ['trips', 'stop_times'],
        false,
        true,
      ).catch((error) => ({ ok: false, reason: error?.message }));
      if (!weekValidation.ok) {
        await FileSystem.deleteAsync(dest, { idempotent: true }).catch(() => {});
        logHostedSqlite('bundle:v2:week-validation-failed', {
          weekId,
          weekFile: dest,
          validation: weekValidation,
        });
        throw createHostedSqliteError('week-validation', `Week database invalid: ${weekValidation.reason}`, {
          weekId,
          weekFile: dest,
          validation: weekValidation,
        });
      }
      if (isBus) {
        updateBusDownloadState({
          status: 'done',
          bytesWritten: Number(manifestWeek.sizeBytes || 0) || busDownloadState.bytesWritten,
          errorMessage: null,
        });
      }
      return weekEntryFromManifest(manifestWeek);
    } catch (err) {
      if (isBus) {
        updateBusDownloadState({
          status: 'error',
          errorMessage: err?.message || String(err),
        });
      }
      throw err;
    }
  })();
  weekDownloadInFlight.set(flightKey, task);
  // Detach the cleanup chain's rejection so it never surfaces as unhandled;
  // the original task still rejects to every awaiter.
  task.catch(() => {}).finally(() => {
    if (weekDownloadInFlight.get(flightKey) === task) weekDownloadInFlight.delete(flightKey);
  });
  return task;
}

// Month migration, shared by ensure + prefetch. The gate is BOTH modes:
// once TRAIN and BUS weeks cover today, the ~106 MB month DB is dead
// weight: record monthRemoved (so no later force/version change ever
// re-downloads it) and delete the file. A train week covering today must
// NOT delete the month while bus weeks are still missing, or migrated bus
// users lose their only bus data. A legacy both-modes week counts for
// both modes. Delete failure is non-fatal and retried on the next call,
// because monthRemoved stays true while monthInstalled stays true until
// the file is actually gone. When weeks do NOT cover today, the month
// file (if any) stays untouched as fallback coverage and monthRemoved is
// left as-is.
async function applyMonthMigration(meta, today) {
  const weeks = meta?.installedWeeks || [];
  const trainCoversToday = weeks.some(
    (w) => dateInSpan(today, w.startDate, w.endDate) && weekCoversMode(w, 'train'),
  );
  const busCoversToday = weeks.some(
    (w) => dateInSpan(today, w.startDate, w.endDate) && weekCoversMode(w, 'bus'),
  );
  const coversToday = trainCoversToday && busCoversToday;
  const monthInfo = await getFileInfo(MONTH_DB_URI);
  const monthExists = !!monthInfo?.exists;
  if (!coversToday) {
    return { ...meta, monthInstalled: monthExists };
  }
  let stillExists = monthExists;
  if (monthExists) {
    await FileSystem.deleteAsync(MONTH_DB_URI, { idempotent: true }).catch((err) => {
      logHostedSqlite('bundle:month-delete-failed', {
        error: err?.message || String(err),
      });
    });
    stillExists = !!(await getFileInfo(MONTH_DB_URI))?.exists;
    if (stillExists) {
      logHostedSqlite('bundle:month-delete-retry-next-launch', { monthFile: MONTH_DB_FILE });
    } else {
      logHostedSqlite('bundle:month-migrated', { monthFile: MONTH_DB_FILE, monthRemoved: true });
    }
  }
  return { ...meta, monthRemoved: true, monthInstalled: stillExists };
}

function installedWeekCoverageEnd(installedWeeks) {
  let maxEnd = null;
  for (const week of installedWeeks || []) {
    const end = String(week?.endDate || '');
    if (end && (!maxEnd || end > maxEnd)) maxEnd = end;
  }
  return maxEnd;
}

// Contiguous coverage from today: walk forward while the next day is covered
// by an installed week. A bare max() would jump over a gap and claim coverage
// the phone does not actually hold, which would stall prefetch early.
function contiguousCoverageEnd(installedWeeks, today) {
  const weeks = (installedWeeks || []).filter((w) => w?.startDate && w?.endDate);
  if (!weeks.some((w) => dateInSpan(today, w.startDate, w.endDate))) return null;
  let end = String(weeks.find((w) => dateInSpan(today, w.startDate, w.endDate)).endDate);
  for (;;) {
    const nextDay = addDaysYmd(end, 1);
    const extension = weeks.find(
      (w) => dateInSpan(nextDay, w.startDate, w.endDate) && String(w.endDate) > end,
    );
    if (!extension) return end;
    end = String(extension.endDate);
  }
}

// Per-mode contiguous coverage: same walk as contiguousCoverageEnd, but
// only over weeks covering the requested mode (legacy both-modes weeks
// count for both). The month file is NOT counted here — it is a legacy
// fallback, not week coverage; callers that need it add the month span.
function contiguousCoverageEndForMode(installedWeeks, today, mode) {
  const weeks = (installedWeeks || []).filter(
    (w) => w?.startDate && w?.endDate && weekCoversMode(w, mode),
  );
  if (!weeks.some((w) => dateInSpan(today, w.startDate, w.endDate))) return null;
  let end = String(weeks.find((w) => dateInSpan(today, w.startDate, w.endDate)).endDate);
  for (;;) {
    const nextDay = addDaysYmd(end, 1);
    const extension = weeks.find(
      (w) => dateInSpan(nextDay, w.startDate, w.endDate) && String(w.endDate) > end,
    );
    if (!extension) return end;
    end = String(extension.endDate);
  }
}

export function getModeCoverageEnd(meta, mode) {
  const m = meta || null;
  const today = torontoTodayYmd();
  const weekEnd = contiguousCoverageEndForMode(m?.installedWeeks, today, mode);
  // Month fallback while the month file is installed (monthInstalled is
  // false only after migration/deletion, so this can never inflate
  // coverage after the month file is gone). The month span is one
  // contiguous block, so when it covers today the union with contiguous
  // week coverage is contiguous to the later end.
  if (
    m?.monthInstalled !== false &&
    dateInSpan(today, m?.month?.startDate, m?.month?.endDate)
  ) {
    const monthEnd = String(m.month.endDate);
    return !weekEnd || monthEnd > weekEnd ? monthEnd : weekEnd;
  }
  return weekEnd;
}

// Single-flight guard for prefetch: week ids currently being downloaded by
// an in-flight ensureUpcomingWeekCoverage() call. A concurrent call skips
// those weeks instead of downloading them twice. Keys are (week, mode):
// the same span in the other mode is a different file.
const prefetchInFlightWeekIds = new Set();

function computeEffectiveCoverageEnd(meta) {
  // meta.month is a manifest reference (span), not proof of installation.
  // Count it only when the month file has not been verified absent: fresh
  // and migrated installs set monthInstalled=false, so the month span can
  // never inflate coverage after the month file is gone.
  const monthEnd = meta?.monthInstalled === false ? '' : String(meta?.month?.endDate || '');
  let maxEnd = monthEnd;
  for (const week of meta?.installedWeeks || []) {
    const end = String(week?.endDate || '');
    if (end && (!maxEnd || end > maxEnd)) {
      maxEnd = end;
    }
  }
  return maxEnd || monthEnd || null;
}

function isCheckDue(meta) {
  const last = Number(meta?.lastCheckAt || meta?.checkedAt || 0);
  if (!last) return true;
  return Date.now() - last >= CHECK_INTERVAL_MS;
}

function dateInSpan(ymd, startDate, endDate) {
  if (!startDate || !endDate) return false;
  return ymd >= startDate && ymd <= endDate;
}

export function resolveScheduleDbForDate(ymd, meta, mode) {
  // Month branch ONLY when the month file is actually installed. monthInstalled
  // is maintained by the ensure flows (false after migration/deletion, true
  // when the file was verified present). Meta written by older builds has no
  // flag and keeps the previous assumption (installed) so legacy installs
  // don't regress; the load layer additionally checks file existence, so a
  // stale entry can surface a date as unavailable but never yield a missing
  // path to a caller that opens it. The month file holds BOTH modes, so it
  // is a valid fallback for either mode while it is installed.
  if (
    meta?.monthInstalled !== false &&
    dateInSpan(ymd, meta?.month?.startDate, meta?.month?.endDate)
  ) {
    return { dbName: MONTH_DB_NAME, dbFile: MONTH_DB_FILE };
  }
  for (const week of meta?.installedWeeks || []) {
    if (dateInSpan(ymd, week.startDate, week.endDate) && weekCoversMode(week, mode)) {
      return { dbName: weekDbNameForEntry(week), dbFile: weekDbFileForEntry(week) };
    }
  }
  return null;
}

async function downloadLegacyDb(manifest, onProgress) {
  logHostedSqlite('legacy:download-start', {
    dbUrl: manifest.dbUrl,
    expectedSizeBytes: manifest.sizeBytes,
    checksumSha256: manifest.checksumSha256,
  });
  await downloadFile(manifest.dbUrl, LEGACY_DB_URI, onProgress, 'schedules database');
  if (manifest.sizeBytes > 0) {
    const info = await FileSystem.getInfoAsync(LEGACY_DB_URI);
    const localSize = Number(info?.size || 0);
    const delta = Math.abs(localSize - manifest.sizeBytes);
    if (!info?.exists || delta > Math.max(4096, manifest.sizeBytes * 0.001)) {
      await FileSystem.deleteAsync(LEGACY_DB_URI, { idempotent: true }).catch(() => {});
      throw createHostedSqliteError('legacy-download-size-mismatch', 'Downloaded schedules database size mismatch.', {
        expectedSizeBytes: manifest.sizeBytes,
        actualSizeBytes: localSize,
        dbPath: LEGACY_DB_FILE,
      });
    }
  }
  const validation = await validateDbTables(
    LEGACY_DB_NAME,
    ['stops', 'routes', 'trips', 'stop_times'],
    true,
  ).catch((error) => ({ ok: false, reason: error?.message || 'Validation failed.' }));
  if (!validation.ok) {
    await FileSystem.deleteAsync(LEGACY_DB_URI, { idempotent: true }).catch(() => {});
    throw createHostedSqliteError('legacy-validation', `Downloaded schedules database is invalid. ${validation.reason}`, {
      dbPath: LEGACY_DB_FILE,
      validation,
    });
  }
  await writeJson(LEGACY_META_FILE, {
    format: 'v1',
    version: manifest.version,
    dbUrl: manifest.dbUrl,
    generatedAt: manifest.generatedAt,
    installedAt: Date.now(),
    sizeBytes: manifest.sizeBytes,
    checksumSha256: manifest.checksumSha256,
    checkedAt: Date.now(),
    lastCheckAt: Date.now(),
  });
  return { ok: true, changed: true, format: 'v1' };
}

async function downloadBundleAsset(asset, destPath, onProgress, label) {
  await downloadFile(asset.url, destPath, onProgress, label, asset.sizeBytes || 0);
  if (asset.sizeBytes > 0) {
    const info = await FileSystem.getInfoAsync(destPath);
    const localSize = Number(info?.size || 0);
    const delta = Math.abs(localSize - asset.sizeBytes);
    if (!info?.exists || delta > Math.max(4096, asset.sizeBytes * 0.001)) {
      await FileSystem.deleteAsync(destPath, { idempotent: true }).catch(() => {});
      throw createHostedSqliteError('download-size-mismatch', `Downloaded ${label} size mismatch.`, {
        label,
        destPath,
        expectedSizeBytes: asset.sizeBytes,
        actualSizeBytes: localSize,
      });
    }
  }
  // CHECKSUM GATE: a partial or corrupt download never loads. The MD5 is
  // verified natively (no whole file in JS memory); a mismatch deletes
  // the file and throws, so meta never records it. Manifests without an
  // MD5 (older publishes) skip this gate and keep the size + table /
  // integrity gates below; a platform that cannot report an MD5 likewise
  // skips rather than failing a good download.
  const expectedMd5 = String(asset.checksumMd5 || '').trim().toLowerCase();
  if (expectedMd5) {
    const md5Info = await FileSystem.getInfoAsync(destPath, { md5: true }).catch(() => null);
    const actualMd5 = String(md5Info?.md5 || '').trim().toLowerCase();
    if (actualMd5 && actualMd5 !== expectedMd5) {
      await FileSystem.deleteAsync(destPath, { idempotent: true }).catch(() => {});
      throw createHostedSqliteError('download-checksum-mismatch', `Downloaded ${label} checksum mismatch.`, {
        label,
        destPath,
        expectedChecksumMd5: expectedMd5,
        actualChecksumMd5: actualMd5,
      });
    }
    if (!actualMd5) {
      logHostedSqlite('download:md5-unavailable-skipped', { label, destPath });
    }
  }
}

async function ensureHostedBundleV2(manifest, options = {}) {
  const { force = false, onProgress } = options;
  // Missing-week installs here are TRAIN-ONLY by default: a fresh install
  // downloads core + the train week covering today, and the bus week
  // arrives later via the post-ready prefetch (or the on-demand fallback).
  // Installed weeks still sync content-addressed regardless of mode, so a
  // version bump never drops an installed bus week. Callers that need
  // both modes here pass modes explicitly.
  const ensureModes = options.modes || { train: true, bus: false };
  const weekMatchesEnsureModes = (week) => {
    if (!week?.mode) return true; // Legacy both-modes manifest week.
    return !!ensureModes[week.mode];
  };
  let meta = (await readJson(BUNDLE_META_FILE)) || {};
  const today = torontoTodayYmd();
  const localVersion = String(meta?.version || '');
  // versionChanged is informational only. Downloads are driven by content
  // (checksum/size) + coverage, never by the version string alone — the old
  // "any version change forces a full re-download" trap must not survive.
  const versionChanged = force || !localVersion || localVersion !== manifest.version;

  // Expired weeks never count toward coverage.
  const prunedExpired = await pruneExpiredWeeks(meta.installedWeeks || [], today);
  meta.installedWeeks = prunedExpired.installedWeeks;
  let weeksChanged = prunedExpired.changed;

  // Core re-downloads only when forced, missing, invalid, or content-changed.
  // A missing stored core fingerprint is treated as changed: the core file
  // is only ~112 KB and correctness-critical, so an unverifiable core is
  // re-downloaded rather than trusted. (Weeks keep the lenient rule — a
  // legacy week entry without a checksum must not force a 25 MB download.)
  const coreInfo = await getFileInfo(CORE_DB_URI);
  let needsCore =
    force || !coreInfo?.exists || !meta.core || assetContentChanged(manifest.core, meta.core);

  if (!needsCore) {
    const existingCoreValidation = await validateDbTables(
      CORE_DB_NAME,
      ['stops', 'routes', 'calendar_dates'],
      true,
    ).catch((error) => ({ ok: false, reason: error?.message }));
    if (!existingCoreValidation.ok) {
      logHostedSqlite('bundle:v2:existing-core-invalid', {
        coreFile: CORE_DB_FILE,
        validation: existingCoreValidation,
      });
      needsCore = true;
    }
  }

  logHostedSqlite('bundle:v2:start', {
    manifestVersion: manifest.version,
    coreUrl: manifest.core.url,
    monthUrl: manifest.month.url,
    needsCore,
    versionChanged,
  });

  if (needsCore) {
    onProgress?.({ message: 'Downloading core schedules data...', percent: 0.06 });
    logHostedSqlite('bundle:v2:download-core', { coreUrl: manifest.core.url, coreFile: CORE_DB_FILE });
    await downloadBundleAsset(manifest.core, CORE_DB_URI, onProgress, 'core data');
    const coreValidation = await validateDbTables(
      CORE_DB_NAME,
      ['stops', 'routes', 'calendar_dates'],
      true,
      true,
    ).catch((error) => ({ ok: false, reason: error?.message }));
    if (!coreValidation.ok) {
      await FileSystem.deleteAsync(CORE_DB_URI, { idempotent: true }).catch(() => {});
      logHostedSqlite('bundle:v2:core-validation-failed', { coreValidation, coreFile: CORE_DB_FILE });
      throw createHostedSqliteError('core-validation', `Core database invalid: ${coreValidation.reason}`, {
        coreFile: CORE_DB_FILE,
        validation: coreValidation,
      });
    }
  }

  // WEEK-ONLY: the month DB is NEVER downloaded here — not on fresh install,
  // not on version bump, not on force. Fresh installs get core + the week
  // containing today; migrated installs never re-download the month (see
  // applyMonthMigration). manifest.month is kept in meta only as a span
  // reference for legacy installs whose month file is still on disk.
  logHostedSqlite('bundle:v2:month-skipped-week-only', {
    monthUrl: manifest.month.url,
    reason: 'week-only install; month file is never downloaded, migrated installs never re-download it',
  });

  // Installed weeks: validate, then sync content-addressed against the
  // manifest. A week whose checksum/size matches survives a version bump;
  // a week whose content changed (or whose span changed) is re-downloaded.
  const validated = await validateInstalledWeekEntries(meta.installedWeeks || []);
  meta.installedWeeks = validated.installedWeeks;
  weeksChanged = weeksChanged || validated.changed;

  const manifestWeeksById = new Map(
    (manifest.weeks || []).map((w) => [String(w.id || w.startDate || ''), w]),
  );
  const syncedWeeks = [];
  for (const installed of meta.installedWeeks) {
    const manifestWeek = manifestWeeksById.get(String(installed.id || installed.startDate));
    if (
      !manifestWeek ||
      (String(installed.startDate) === String(manifestWeek.startDate) &&
        String(installed.endDate) === String(manifestWeek.endDate) &&
        !assetContentChanged(manifestWeek, installed))
    ) {
      // Survives: adopt the manifest checksum/size when the stored entry
      // lacks them, so the next bump compares exactly.
      syncedWeeks.push(
        manifestWeek
          ? {
              ...installed,
              checksumSha256: manifestWeek.checksumSha256 || installed.checksumSha256 || null,
              checksumMd5: manifestWeek.checksumMd5 || installed.checksumMd5 || null,
              sizeBytes: manifestWeek.sizeBytes || installed.sizeBytes || 0,
              fileName: manifestWeek.fileName || installed.fileName,
            }
          : installed,
      );
      continue;
    }
    logHostedSqlite('bundle:v2:download-week-content-changed', {
      weekId: String(installed.id || installed.startDate),
      startDate: manifestWeek.startDate,
      endDate: manifestWeek.endDate,
    });
    const newEntry = await downloadAndValidateWeek(manifestWeek, onProgress);
    // A span/mode change renames the file: drop the orphaned old file so
    // it cannot be resolved later (its meta entry is gone).
    if (String(installed.fileName || '') && String(installed.fileName) !== String(newEntry.fileName || '')) {
      await FileSystem.deleteAsync(weekDbUriForEntry(installed), { idempotent: true }).catch(() => {});
    }
    syncedWeeks.push(newEntry);
    weeksChanged = true;
  }
  meta.installedWeeks = syncedWeeks;

  // Missing weeks: install only weeks covering today or a requested date.
  // Startup passes requestedDates=[today] (STARTUP_SCHEDULE_DAYS = 1), so a
  // fresh install downloads exactly core + the week containing today.
  // Rolling extension to today+7 is ensureUpcomingWeekCoverage's job, not
  // this function's — background calls without requestedDates no longer pull
  // every missing manifest week on a periodic gate.
  const requestedDates = [
    ...new Set(
      [...(options.requestedDates || []).map((d) => String(d)).filter(Boolean), today],
    ),
  ];
  const installedWeekIds = new Set(
    (meta.installedWeeks || []).map((w) => String(w.id || w.startDate)),
  );
  for (const week of manifest.weeks || []) {
    const weekId = String(week.id || week.startDate || '');
    if (!weekId || installedWeekIds.has(weekId)) continue;
    if (!weekMatchesEnsureModes(week)) continue;
    if (!requestedDates.some((ymd) => dateInSpan(ymd, week.startDate, week.endDate))) continue;
    logHostedSqlite('bundle:v2:download-week', {
      weekId,
      startDate: week.startDate,
      endDate: week.endDate,
      reason: 'covers today or a requested date',
    });
    meta.installedWeeks = [...(meta.installedWeeks || []), await downloadAndValidateWeek(week, onProgress)];
    installedWeekIds.add(weekId);
    weeksChanged = true;
  }

  // Migration: once installed weeks cover today, drop the month file.
  meta = await applyMonthMigration(meta, today);

  meta = {
    ...meta,
    format: 'v2',
    version: manifest.version,
    generatedAt: manifest.generatedAt,
    buildDate: manifest.buildDate,
    core: {
      fileName: manifest.core.fileName,
      url: manifest.core.url,
      sizeBytes: manifest.core.sizeBytes,
      checksumSha256: manifest.core.checksumSha256 || null,
    },
    month: {
      fileName: manifest.month.fileName,
      url: manifest.month.url,
      sizeBytes: manifest.month.sizeBytes,
      startDate: manifest.month.startDate,
      endDate: manifest.month.endDate,
    },
    installedAt: meta.installedAt || Date.now(),
    checkedAt: Date.now(),
    lastCheckAt: Date.now(),
  };
  meta.effectiveCoverageEnd = computeEffectiveCoverageEnd(meta);
  await writeJson(BUNDLE_META_FILE, meta);

  const todayCovered =
    (meta.monthInstalled &&
      dateInSpan(today, meta.month?.startDate, meta.month?.endDate)) ||
    (meta.installedWeeks || []).some(
      (w) => dateInSpan(today, w.startDate, w.endDate) && weekCoversMode(w, 'train'),
    );
  if (!todayCovered) {
    logHostedSqlite('bundle:v2:today-uncovered', {
      today,
      reason: 'no installed month or week file covers today; schedule loads will report today as unavailable',
    });
  }

  return {
    ok: true,
    changed: needsCore || weeksChanged,
    format: 'v2',
    manifest,
    meta,
  };
}

export function isHostedSqliteConfigured() {
  return hasAnyUrl();
}

export async function getHostedSqlitePath() {
  const bundleMeta = await readJson(BUNDLE_META_FILE);
  if (bundleMeta?.format === 'v2') {
    const core = await getFileInfo(CORE_DB_URI);
    return core?.exists ? CORE_DB_FILE : null;
  }
  const legacy = await getFileInfo(LEGACY_DB_URI);
  return legacy?.exists ? LEGACY_DB_FILE : null;
}

export async function getBundleMeta() {
  const bundle = await readJson(BUNDLE_META_FILE);
  if (bundle) return bundle;
  const legacy = await readJson(LEGACY_META_FILE);
  if (legacy) return { ...legacy, format: legacy.format || 'v1' };
  return null;
}

export function getEffectiveCoverageEnd(meta = null) {
  const m = meta || null;
  if (m?.effectiveCoverageEnd) return m.effectiveCoverageEnd;
  return computeEffectiveCoverageEnd(m);
}

export function getMonthDateSpan(meta = null) {
  const month = meta?.month;
  if (!month?.startDate || !month?.endDate) return null;
  return { startDate: month.startDate, endDate: month.endDate };
}

/**
 * Local-only variant of ensureHostedSqlite: validates the on-device schedule
 * database(s) WITHOUT any network access. Used on the startup critical path
 * so a slow/unreachable manifest fetch can't stall or fail app launch.
 * Version checks and downloads stay in the background update flow.
 * The month file is NOT hard-required: pass needs a valid core plus today
 * covered by an installed month or week file (a missing month with
 * monthRemoved set passes when weeks cover today).
 * Never throws: returns {ok:false, reason} naming what's missing/invalid.
 * NOTE: deliberately does NOT stamp checkedAt/lastCheckAt — that would reset
 * the background update throttle in GtfsUpdateContext.
 */
export async function ensureLocalHostedSqlite() {
  if (!hasAnyUrl()) {
    return { ok: false, reason: 'not-configured' };
  }

  const validate = (dbName, tables, stopsRequired = false) =>
    validateDbTables(dbName, tables, stopsRequired).catch((error) => ({
      ok: false,
      reason: error?.message || String(error),
    }));

  const bundleMeta = await readJson(BUNDLE_META_FILE);
  if (bundleMeta?.format === 'v2') {
    const localVersion = String(bundleMeta?.version || '');
    if (!localVersion) {
      return { ok: false, reason: 'local-version-missing' };
    }
    const coreInfo = await getFileInfo(CORE_DB_URI);
    if (!coreInfo?.exists) {
      return { ok: false, reason: 'local-core-missing' };
    }
    const coreValidation = await validate(CORE_DB_NAME, ['stops', 'routes', 'calendar_dates'], true);
    if (!coreValidation.ok) {
      return { ok: false, reason: `local-core-invalid: ${coreValidation.reason || 'unknown'}` };
    }
    // The month file is NO LONGER hard-required: a missing month is fine
    // when monthRemoved is set (migrated/skipped) and, in general, whenever
    // installed weeks cover today. What fails startup is today being
    // uncovered by every installed file — that stays a loud not-ok, never
    // a silent empty load. This function still never migrates (no month
    // deletion here); migration lives in the network ensure + prefetch.
    const today = torontoTodayYmd();
    const prunedExpired = await pruneExpiredWeeks(bundleMeta.installedWeeks || [], today);
    const validatedWeeks = await validateInstalledWeekEntries(prunedExpired.installedWeeks);
    const validInstalledWeeks = validatedWeeks.installedWeeks;
    const monthInfo = await getFileInfo(MONTH_DB_URI);
    let monthInstalled = false;
    let monthCoversToday = false;
    if (monthInfo?.exists) {
      const monthValidation = await validate(MONTH_DB_NAME, ['trips', 'stop_times']);
      if (monthValidation.ok) {
        monthInstalled = true;
        // A valid month file with no recorded span keeps the old behavior
        // (pass); the startup zero-trips throw remains the backstop.
        const spanStart = String(bundleMeta.month?.startDate || '');
        const spanEnd = String(bundleMeta.month?.endDate || '');
        monthCoversToday =
          !spanStart || !spanEnd || dateInSpan(today, spanStart, spanEnd);
      } else {
        // Corrupt month file: unusable, so drop it rather than failing a
        // startup that installed weeks can serve.
        await FileSystem.deleteAsync(MONTH_DB_URI, { idempotent: true }).catch(() => {});
      }
    }
    const weekCoversToday = validInstalledWeeks.some((w) =>
      dateInSpan(today, w.startDate, w.endDate),
    );
    if (!monthCoversToday && !weekCoversToday) {
      return { ok: false, reason: 'local-today-uncovered' };
    }
    const nextMeta = {
      ...bundleMeta,
      installedWeeks: validInstalledWeeks,
      monthInstalled,
    };
    nextMeta.effectiveCoverageEnd = computeEffectiveCoverageEnd(nextMeta);
    if (
      prunedExpired.changed ||
      validatedWeeks.changed ||
      bundleMeta.monthInstalled !== monthInstalled ||
      bundleMeta.effectiveCoverageEnd !== nextMeta.effectiveCoverageEnd ||
      validInstalledWeeks.length !== (bundleMeta.installedWeeks || []).length
    ) {
      await writeJson(BUNDLE_META_FILE, nextMeta);
    }
    return { ok: true, changed: false, format: 'v2' };
  }

  const legacyMeta = await readJson(LEGACY_META_FILE);
  const legacyVersion = String(legacyMeta?.version || '');
  if (!legacyVersion) {
    return { ok: false, reason: 'no-local-db' };
  }
  const legacyInfo = await getFileInfo(LEGACY_DB_URI);
  if (!legacyInfo?.exists) {
    return { ok: false, reason: 'no-local-db' };
  }
  const legacyValidation = await validate(
    LEGACY_DB_NAME,
    ['stops', 'routes', 'trips', 'stop_times'],
    true,
  );
  if (!legacyValidation.ok) {
    return { ok: false, reason: `local-db-invalid: ${legacyValidation.reason || 'unknown'}` };
  }
  return { ok: true, changed: false, format: 'v1', dbPath: LEGACY_DB_FILE };
}

export async function ensureHostedSqlite(options = {}) {
  if (!hasAnyUrl()) {
    return { ok: false, reason: 'not-configured' };
  }

  const { force = false, onProgress, requestedDates, modes } = options;
  onProgress?.({ message: 'Checking schedules database version...', percent: 0.02 });
  const manifest = await fetchRemoteManifest();
  if (!manifest) {
    return { ok: false, reason: 'manifest-unavailable' };
  }

  if (manifest.format === 'v2') {
    return ensureHostedBundleV2(manifest, { force, onProgress, requestedDates, modes });
  }

  const localMeta = await readJson(LEGACY_META_FILE);
  const localInfo = await getFileInfo(LEGACY_DB_URI);
  const localVersion = String(localMeta?.version || '');
  const hasLocalDb = !!localInfo?.exists;
  let needsDownload =
    force || !hasLocalDb || !localVersion || localVersion !== manifest.version;

  if (!needsDownload && hasLocalDb) {
    const validation = await validateDbTables(
      LEGACY_DB_NAME,
      ['stops', 'routes', 'trips', 'stop_times'],
      true,
    ).catch((error) => ({ ok: false, reason: error?.message }));
    if (!validation.ok) needsDownload = true;
  }

  if (needsDownload) {
    await downloadLegacyDb(manifest, onProgress);
    return { ok: true, changed: true, format: 'v1', manifest, dbPath: LEGACY_DB_FILE };
  }

  await writeJson(LEGACY_META_FILE, {
    ...(localMeta || {}),
    checkedAt: Date.now(),
    lastCheckAt: Date.now(),
    version: localMeta?.version || manifest.version,
  });

  return { ok: true, changed: false, format: 'v1', manifest, dbPath: LEGACY_DB_FILE };
}

export async function checkHostedSqliteUpdate() {
  if (!hasAnyUrl()) {
    return { status: 'not-configured', update: null };
  }

  const manifest = await fetchRemoteManifest(4000);
  const bundleMeta = await readJson(BUNDLE_META_FILE);
  const legacyMeta = await readJson(LEGACY_META_FILE);
  const localMeta = bundleMeta || legacyMeta;
  const localVersion = String(localMeta?.version || '');

  if (!localVersion) {
    return { status: 'baseline-missing', update: null };
  }

  if (localVersion !== manifest.version) {
    const pending = {
      status: 'available',
      detectedAt: Date.now(),
      version: manifest.version,
      format: manifest.format,
      remoteFingerprint: {
        contentLength: manifest.month?.sizeBytes || manifest.sizeBytes || null,
        etag: manifest.version,
        lastModified: manifest.generatedAt,
      },
      estimatedDurationSec: null,
      snoozeUntil: null,
      lastPromptedAt: null,
    };
    await writeJson(SQLITE_UPDATE_FILE, pending);
    return { status: 'update-available', update: pending };
  }

  // Rolling weeks are owned by ensureUpcomingWeekCoverage (prefetch), NOT by
  // prompts: a missing next week must never raise an update prompt. The
  // prompt flow stays for manifest version / core changes only (above).

  await FileSystem.deleteAsync(SQLITE_UPDATE_FILE, { idempotent: true }).catch(() => {});
  return { status: 'up-to-date', update: null };
}

export async function getPendingHostedSqliteUpdate() {
  return readJson(SQLITE_UPDATE_FILE);
}

export async function setPendingHostedSqliteUpdate(value) {
  await writeJson(SQLITE_UPDATE_FILE, value);
  return value;
}

export async function clearPendingHostedSqliteUpdate() {
  await FileSystem.deleteAsync(SQLITE_UPDATE_FILE, { idempotent: true }).catch(() => {});
}

export async function applyPendingHostedSqliteUpdate(options = {}) {
  const pending = await readJson(SQLITE_UPDATE_FILE);
  const meta = await readJson(BUNDLE_META_FILE);
  const forceFull =
    pending?.format !== 'v2-week-extension' && String(pending?.format || '') !== 'v2-week-extension';

  if (!forceFull && meta) {
    await writeJson(BUNDLE_META_FILE, { ...meta, lastCheckAt: 0 });
  }

  const result = await ensureHostedSqlite({
    force: forceFull,
    onProgress: options.onProgress,
  });
  return { ok: !!result?.ok, changed: !!result?.changed };
}

/**
 * Rolling-week prefetch: while installed contiguous coverage ends before
 * today+7 and the manifest has a further contiguous week, silently download
 * the next week. Stops the moment coverage reaches today+7, even if the
 * manifest lists more weeks. NEVER throws: a stale manifest (no further
 * week), a failed manifest fetch, or a failed week download all resolve
 * gracefully with coverage simply staying short until the next launch.
 * Single-flight guarded per week id, so concurrent callers never download
 * the same week twice. Never downloads the month, never prompts.
 */
export async function ensureUpcomingWeekCoverage(modeArg) {
  // Per-mode rolling prefetch. The context runs this for BOTH modes
  // post-ready: trains first, then buses, so bus rollover is identical to
  // trains and the bus picker never contracts for lack of a download. A
  // one-shot bus download is not enough — without the per-mode run, bus
  // coverage would expire after week 1. modeArg is 'train' | 'bus' (or
  // { mode }); a missing arg keeps the old train-only behaviour.
  const mode =
    typeof modeArg === 'string' ? modeArg : String(modeArg?.mode || 'train');
  const prefetchMode = mode === 'bus' ? 'bus' : 'train';
  try {
    let meta = await readJson(BUNDLE_META_FILE);
    if (!meta || meta.format !== 'v2') {
      return { ok: false, reason: 'no-local-bundle', downloaded: [], coverageEnd: null, mode: prefetchMode };
    }
    const today = torontoTodayYmd();
    const target = addDaysYmd(today, 7);

    const prunedExpired = await pruneExpiredWeeks(meta.installedWeeks || [], today);
    let installedWeeks = prunedExpired.installedWeeks;
    // Drop entries whose file is gone (cheap existence check, no DB open):
    // coverage must reflect files actually on disk, not stale meta.
    const existingWeeks = [];
    let existenceChanged = false;
    for (const week of installedWeeks) {
      const startDate = String(week?.startDate || '');
      if (!startDate) {
        existenceChanged = true;
        continue;
      }
      const info = await getFileInfo(weekDbUriForEntry(week));
      if (info?.exists) {
        existingWeeks.push(week);
      } else {
        existenceChanged = true;
      }
    }
    installedWeeks = existingWeeks;
    if (prunedExpired.changed || existenceChanged) {
      meta = { ...meta, installedWeeks };
      meta.effectiveCoverageEnd = computeEffectiveCoverageEnd(meta);
      await writeJson(BUNDLE_META_FILE, meta);
    }

    let manifest;
    try {
      manifest = await fetchRemoteManifest();
    } catch (err) {
      logHostedSqlite('prefetch:manifest-failed', { mode: prefetchMode, error: err?.message || String(err) });
      return {
        ok: false,
        reason: 'manifest-unavailable',
        downloaded: [],
        coverageEnd: contiguousCoverageEndForMode(installedWeeks, today, prefetchMode),
        mode: prefetchMode,
      };
    }
    if (!manifest || manifest.format !== 'v2') {
      return {
        ok: false,
        reason: 'manifest-has-no-weeks',
        downloaded: [],
        coverageEnd: contiguousCoverageEndForMode(installedWeeks, today, prefetchMode),
        mode: prefetchMode,
      };
    }

    const manifestWeeks = [...(manifest.weeks || [])]
      .filter((w) => weekCoversMode(w, prefetchMode) && (w?.mode ? w.mode === prefetchMode : true))
      .sort((a, b) =>
        String(a.startDate || '').localeCompare(String(b.startDate || '')),
      );
    const installedIds = new Set(installedWeeks.map((w) => String(w.id || w.startDate)));
    const downloaded = [];
    let coverageEnd = contiguousCoverageEndForMode(installedWeeks, today, prefetchMode);
    // Each successful iteration strictly extends contiguous coverage (the
    // candidate covers coverageEnd+1), so this guard is belt-and-braces.
    let guard = manifestWeeks.length + 1;
    while ((!coverageEnd || coverageEnd < target) && guard-- > 0) {
      const nextDay = coverageEnd ? addDaysYmd(coverageEnd, 1) : today;
      const candidate = manifestWeeks.find((w) => {
        const id = String(w.id || w.startDate || '');
        if (!id || installedIds.has(id)) return false;
        const flightKey = `${id}|${prefetchMode}`;
        if (prefetchInFlightWeekIds.has(flightKey)) return false;
        return dateInSpan(nextDay, w.startDate, w.endDate);
      });
      // No contiguous further week in the manifest (stale manifest): stop
      // gracefully, no error — coverage simply stays short to next launch.
      if (!candidate) break;
      const candidateId = String(candidate.id || candidate.startDate);
      const flightKey = `${candidateId}|${prefetchMode}`;
      prefetchInFlightWeekIds.add(flightKey);
      try {
        const entry = await downloadAndValidateWeek(candidate, undefined);
        installedWeeks = [...installedWeeks, entry];
        installedIds.add(candidateId);
        downloaded.push(candidateId);
        coverageEnd = contiguousCoverageEndForMode(installedWeeks, today, prefetchMode);
        meta = { ...meta, installedWeeks };
        meta.effectiveCoverageEnd = computeEffectiveCoverageEnd(meta);
        await writeJson(BUNDLE_META_FILE, meta);
      } catch (err) {
        logHostedSqlite('prefetch:week-failed', {
          mode: prefetchMode,
          weekId: candidateId,
          error: err?.message || String(err),
        });
        break;
      } finally {
        prefetchInFlightWeekIds.delete(flightKey);
      }
    }

    // Prefetch completing today coverage also completes migration — but
    // only when BOTH modes cover today (see applyMonthMigration).
    meta = await applyMonthMigration({ ...meta, installedWeeks }, today);
    meta.effectiveCoverageEnd = computeEffectiveCoverageEnd(meta);
    await writeJson(BUNDLE_META_FILE, meta);

    return {
      ok: true,
      downloaded,
      coverageEnd: contiguousCoverageEndForMode(meta.installedWeeks, today, prefetchMode) ||
        installedWeekCoverageEnd(meta.installedWeeks.filter((w) => weekCoversMode(w, prefetchMode))),
      target,
      mode: prefetchMode,
    };
  } catch (err) {
    logHostedSqlite('prefetch:failed', { mode: prefetchMode, error: err?.message || String(err) });
    return { ok: false, reason: err?.message || 'prefetch-failed', downloaded: [], coverageEnd: null, mode: prefetchMode };
  }
}

// Blocking on-demand bus download: downloads the manifest bus weeks
// covering the given dates (if not already installed), validates them, and
// records them in meta. Used when bus schedules are requested but their
// week is missing — e.g. the background download was killed or failed.
// Never throws for a manifest failure (returns stillMissing instead, so
// the caller can show the named error + retry); a single week download
// failure is likewise reported, not thrown, after the other weeks try.
export async function ensureBusWeeksForDates(dates, onProgress) {
  const requestedDates = [...new Set((dates || []).map((d) => String(d)).filter(Boolean))];
  if (!requestedDates.length) {
    return { ok: true, downloaded: [], stillMissing: [] };
  }
  let meta = await readJson(BUNDLE_META_FILE);
  if (!meta || meta.format !== 'v2') {
    return { ok: false, downloaded: [], stillMissing: requestedDates, error: 'no-local-bundle' };
  }
  const today = torontoTodayYmd();
  let manifest;
  try {
    manifest = await fetchRemoteManifest();
  } catch (err) {
    return {
      ok: false,
      downloaded: [],
      stillMissing: requestedDates,
      error: err?.message || String(err),
    };
  }
  if (!manifest || manifest.format !== 'v2') {
    return { ok: false, downloaded: [], stillMissing: requestedDates, error: 'manifest-has-no-weeks' };
  }

  const installedWeeks = [...(meta.installedWeeks || [])];
  const installedIds = new Set(installedWeeks.map((w) => String(w.id || w.startDate)));
  const downloaded = [];
  const stillMissing = [];
  let lastError = null;
  for (const ymd of requestedDates) {
    if (installedWeeks.some((w) => dateInSpan(ymd, w.startDate, w.endDate) && weekCoversMode(w, 'bus'))) {
      continue;
    }
    // A legacy no-mode manifest week contains both modes, so it covers bus.
    const candidate = (manifest.weeks || []).find(
      (w) => dateInSpan(ymd, w.startDate, w.endDate) && (!w?.mode || w.mode === 'bus'),
    );
    if (!candidate) {
      stillMissing.push(ymd);
      lastError = lastError || `No bus week published covering ${ymd}`;
      continue;
    }
    const candidateId = String(candidate.id || candidate.startDate);
    if (installedIds.has(candidateId)) {
      continue;
    }
    try {
      const entry = await downloadAndValidateWeek(candidate, onProgress);
      installedWeeks.push(entry);
      installedIds.add(candidateId);
      downloaded.push(candidateId);
    } catch (err) {
      lastError = err?.message || String(err);
      stillMissing.push(ymd);
    }
  }

  meta = { ...meta, installedWeeks };
  meta = await applyMonthMigration(meta, today);
  meta.effectiveCoverageEnd = computeEffectiveCoverageEnd(meta);
  await writeJson(BUNDLE_META_FILE, meta);

  return {
    ok: stillMissing.length === 0,
    downloaded,
    stillMissing,
    ...(lastError ? { error: lastError } : {}),
  };
}

export async function loadHostedCoreTables(onProgress) {
  const meta = await getBundleMeta();
  logHostedSqlite('load:core-start', { format: meta?.format, coreFile: CORE_DB_FILE });
  if (meta?.format === 'v2') {
    const coreInfo = await getFileInfo(CORE_DB_URI);
    if (!coreInfo?.exists) {
      throw createHostedSqliteError('load-core-missing', 'Core schedules database was not found on this device.', {
        coreFile: CORE_DB_FILE,
      });
    }
    onProgress?.({ message: 'Reading stops and routes...', percent: 0.62 });
    const db = await SQLite.openDatabaseAsync(CORE_DB_NAME, { useNewConnection: true }, DB_OPEN_DIR);
    try {
      await db.execAsync('PRAGMA journal_mode = WAL;');
      const stops = await db.getAllAsync(
        'SELECT stop_id, stop_name, stop_lat, stop_lon, platform_code, parent_station, location_type FROM stops',
      );
      const routes = await db.getAllAsync(
        'SELECT route_id, route_short_name, route_long_name, route_type FROM routes',
      );
      const pathways = await db
        .getAllAsync('SELECT pathway_id, from_stop_id, to_stop_id, pathway_mode FROM pathways')
        .catch(() => []);
      const calendar = await db
        .getAllAsync(
          'SELECT service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date FROM calendar',
        )
        .catch(() => []);
      const calendarDates = await db.getAllAsync(
        'SELECT service_id, date, exception_type FROM calendar_dates',
      );
      // Stop -> route_type seed (publisher-side fix for the chicken-and-egg:
      // without it, no stop classifies as bus-served before a bus slice
      // loads). Old core files lack the table — the catch keeps them
      // working with the previous trips-only classification.
      const stopRouteTypes = await db
        .getAllAsync('SELECT stop_id, route_type FROM stop_route_types')
        .catch(() => []);
      return { stops, routes, pathways, calendar, calendarDates, stopRouteTypes, meta };
    } finally {
      await db.closeAsync().catch(() => {});
    }
  }

  const legacyInfo = await getFileInfo(LEGACY_DB_URI);
  if (!legacyInfo?.exists) {
    throw new Error('Schedules database was not found on this device.');
  }

  onProgress?.({ message: 'Reading stops and routes...', percent: 0.62 });
  const db = await SQLite.openDatabaseAsync(LEGACY_DB_NAME, { useNewConnection: true }, DB_OPEN_DIR);
  try {
    await db.execAsync('PRAGMA journal_mode = WAL;');
    const stops = await db.getAllAsync(
      'SELECT stop_id, stop_name, stop_lat, stop_lon, platform_code, parent_station, location_type FROM stops',
    );
    const routes = await db.getAllAsync(
      'SELECT route_id, route_short_name, route_long_name, route_type FROM routes',
    );
    const pathways = await db
      .getAllAsync('SELECT pathway_id, from_stop_id, to_stop_id, pathway_mode FROM pathways')
      .catch(() => []);
    const calendar = await db
      .getAllAsync(
        'SELECT service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date FROM calendar',
      )
      .catch(() => []);
    const calendarDates = await db.getAllAsync(
      'SELECT service_id, date, exception_type FROM calendar_dates',
    );
    return { stops, routes, pathways, calendar, calendarDates, meta: { format: 'v1' } };
  } finally {
    await db.closeAsync().catch(() => {});
  }
}

function routeTypesForModes(modes) {
  const types = [];
  if (!modes || modes.train !== false) types.push(2);
  if (!modes || modes.bus !== false) types.push(3);
  return types.length ? types : [2, 3];
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function loadTripsForServices(db, serviceIds, routeTypes) {
  if (!serviceIds.length || !routeTypes.length) return [];
  const trips = [];
  const serviceChunks = chunkArray(serviceIds, 200);
  for (const services of serviceChunks) {
    const placeholders = services.map(() => '?').join(',');
    const typePlaceholders = routeTypes.map(() => '?').join(',');
    const sql = `
      SELECT t.route_id, t.trip_id, t.trip_headsign, t.direction_id, t.shape_id, t.service_id
      FROM trips t
      JOIN routes r ON r.route_id = t.route_id
      WHERE t.service_id IN (${placeholders})
        AND CAST(r.route_type AS INTEGER) IN (${typePlaceholders})
    `;
    const rows = await db.getAllAsync(sql, [...services, ...routeTypes]);
    if (rows?.length) trips.push(...rows);
  }
  return trips;
}

async function loadStopTimesForTripIds(db, tripIds) {
  if (!tripIds.length) return [];
  const stopTimes = [];
  for (const chunk of chunkArray(tripIds, STOP_TIME_BATCH_SIZE)) {
    const placeholders = chunk.map(() => '?').join(',');
    const rows = await db.getAllAsync(
      `SELECT trip_id, arrival_time, departure_time, stop_id, stop_sequence, stop_headsign, pickup_type, drop_off_type
       FROM stop_times WHERE trip_id IN (${placeholders})`,
      chunk,
    );
    if (rows?.length) stopTimes.push(...rows);
  }
  return stopTimes;
}

export async function loadHostedSchedulesForDates(
  dates,
  modes,
  activeServiceIdsForDateFn,
  onProgress,
) {
  const meta = await getBundleMeta();
  logHostedSqlite('load:schedules-start', {
    dates: dates || [],
    modes,
    format: meta?.format,
  });
  const uniqueDates = [...new Set((dates || []).map((d) => String(d)))].filter(Boolean);
  if (!uniqueDates.length) {
    return { trips: [], stopTimes: [], unavailableDates: [] };
  }

  const routeTypes = routeTypesForModes(modes);
  const allTrips = [];
  const allStopTimes = [];
  const unavailableDates = [];
  const unavailableByMode = { train: [], bus: [] };
  let datesDone = 0;

  if (meta?.format === 'v2') {
    // Per-mode resolution: with split week files, one date can need TWO
    // files (train week + bus week). Each mode resolves independently and
    // reports its own unavailability, so a missing bus week never blocks
    // train loads (and vice versa). The month file is the both-modes
    // fallback while installed: when both modes resolve to it for a date,
    // it is opened once with both route types.
    const requestedModes = [];
    if (!modes || modes.train !== false) requestedModes.push('train');
    if (!modes || modes.bus !== false) requestedModes.push('bus');
    for (const ymd of uniqueDates) {
      // Dates with no installed covering file are REPORTED, never silently
      // skipped: callers must never mark unloaded dates as loaded. A stale
      // meta entry pointing at a deleted file, and a per-date query failure,
      // land in unavailableDates too instead of failing the whole load.
      const targetsByDb = new Map();
      for (const mode of requestedModes) {
        const target = resolveScheduleDbForDate(ymd, meta, mode);
        if (!target) {
          unavailableByMode[mode].push(ymd);
          continue;
        }
        if (!targetsByDb.has(target.dbName)) {
          targetsByDb.set(target.dbName, { target, modes: [] });
        }
        targetsByDb.get(target.dbName).modes.push(mode);
      }
      for (const { target, modes: targetModes } of targetsByDb.values()) {
        const targetInfo = await getFileInfo(toFileUri(target.dbFile));
        if (!targetInfo?.exists) {
          logHostedSqlite('load:schedules-date-file-missing', { ymd, dbName: target.dbName });
          for (const mode of targetModes) unavailableByMode[mode].push(ymd);
          continue;
        }
        try {
          const db = await SQLite.openDatabaseAsync(target.dbName, { useNewConnection: true }, DB_OPEN_DIR);
          try {
            await db.execAsync('PRAGMA journal_mode = WAL;');
            const serviceIds = [...activeServiceIdsForDateFn(ymd)];
            const targetRouteTypes = targetModes.map((m) => (m === 'train' ? 2 : 3));
            const trips = await loadTripsForServices(db, serviceIds, targetRouteTypes);
            const tripIds = trips.map((t) => String(t.trip_id));
            const stopTimes = await loadStopTimesForTripIds(db, tripIds);
            allTrips.push(...trips);
            allStopTimes.push(...stopTimes);
          } finally {
            await db.closeAsync().catch(() => {});
          }
        } catch (err) {
          logHostedSqlite('load:schedules-date-failed', {
            ymd,
            dbName: target.dbName,
            error: err?.message || String(err),
          });
          for (const mode of targetModes) unavailableByMode[mode].push(ymd);
        }
      }

      datesDone += 1;
      onProgress?.({
        message: `Loading schedules (${datesDone}/${uniqueDates.length})...`,
        percent: 0.7 + (datesDone / uniqueDates.length) * 0.25,
      });
    }
    for (const mode of requestedModes) {
      for (const ymd of unavailableByMode[mode]) {
        if (!unavailableDates.includes(ymd)) unavailableDates.push(ymd);
      }
    }
    return { trips: allTrips, stopTimes: allStopTimes, unavailableDates, unavailableByMode };
  }

  const legacyInfo = await getFileInfo(LEGACY_DB_URI);
  if (!legacyInfo?.exists) {
    throw new Error('Schedules database was not found on this device.');
  }

  const db = await SQLite.openDatabaseAsync(LEGACY_DB_NAME, { useNewConnection: true }, DB_OPEN_DIR);
  try {
    await db.execAsync('PRAGMA journal_mode = WAL;');
    for (const ymd of uniqueDates) {
      const serviceIds = [...activeServiceIdsForDateFn(ymd)];
      const trips = await loadTripsForServices(db, serviceIds, routeTypes);
      const tripIds = trips.map((t) => String(t.trip_id));
      const stopTimes = await loadStopTimesForTripIds(db, tripIds);
      allTrips.push(...trips);
      allStopTimes.push(...stopTimes);

      datesDone += 1;
      onProgress?.({
        message: `Loading schedules (${datesDone}/${uniqueDates.length})...`,
        percent: 0.7 + (datesDone / uniqueDates.length) * 0.25,
      });
    }
    return { trips: allTrips, stopTimes: allStopTimes, unavailableDates: [], unavailableByMode };
  } finally {
    await db.closeAsync().catch(() => {});
  }
}

/** @deprecated Use loadHostedCoreTables + loadHostedSchedulesForDates */
export async function loadHostedGtfsRows(onProgress) {
  const core = await loadHostedCoreTables(onProgress);
  const today = torontoTodayYmd();
  const dates = [];
  for (let i = 0; i < 7; i += 1) {
    dates.push(addDaysYmd(today, i));
  }
  const schedule = await loadHostedSchedulesForDates(
    dates,
    { train: true, bus: true },
    () => new Set(),
    onProgress,
  );
  return {
    ...core,
    trips: schedule.trips,
    stopTimes: schedule.stopTimes,
  };
}
