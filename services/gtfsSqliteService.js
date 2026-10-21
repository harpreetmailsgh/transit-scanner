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
  return {
    fileName: fileName || url.split('/').pop(),
    url,
    sizeBytes: Number(asset.sizeBytes || asset.size || 0) || 0,
    checksumSha256: String(asset.checksumSha256 || asset.sha256 || '').trim() || null,
    startDate: String(asset.startDate || '').trim() || null,
    endDate: String(asset.endDate || '').trim() || null,
    id: String(asset.id || asset.startDate || '').trim() || null,
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

async function downloadFile(dbUrl, destPath, onProgress, label = 'schedules') {
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
  // Use a non-resumable download on iOS to avoid known corruption with resumable API
  if (Platform.OS === 'ios') {
    onProgress?.({ message: `Downloading ${label}...`, percent: 0.05 });
    result = await FileSystem.downloadAsync(dbUrl, tempPath).catch((err) => {
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
  } else {
    const download = FileSystem.createDownloadResumable(
      dbUrl,
      tempPath,
      {},
      (event) => {
        if (!onProgress) return;
        const written = Number(event?.totalBytesWritten || 0);
        const expected = Number(event?.totalBytesExpectedToWrite || 0);
        if (expected <= 0) return;
        const pct = Math.max(0, Math.min(1, written / expected));
        const bucket = Math.floor(pct * 100);
        if (bucket === lastBucket) return;
        lastBucket = bucket;
        onProgress({ message: `Downloading ${label}... ${bucket}%`, percent: 0.05 + pct * 0.5 });
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

async function validateDbTables(dbName, requiredTables, stopsRequired = false) {
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

function weekDbName(startDate) {
  return `go-gtfs-week-${startDate}.sqlite`;
}

function weekDbFile(startDate) {
  return joinPath(DB_OPEN_DIR, weekDbName(startDate));
}

function weekDbUri(startDate) {
  return joinUri(DB_FS_DIR, weekDbName(startDate));
}

function computeEffectiveCoverageEnd(meta) {
  const monthEnd = String(meta?.month?.endDate || '');
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

function resolveScheduleDbForDate(ymd, meta) {
  if (dateInSpan(ymd, meta?.month?.startDate, meta?.month?.endDate)) {
    return { dbName: MONTH_DB_NAME, dbFile: MONTH_DB_FILE };
  }
  for (const week of meta?.installedWeeks || []) {
    if (dateInSpan(ymd, week.startDate, week.endDate)) {
      const name = weekDbName(week.startDate);
      return { dbName: name, dbFile: weekDbFile(week.startDate) };
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
  await downloadFile(asset.url, destPath, onProgress, label);
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
}

async function ensureHostedBundleV2(manifest, options = {}) {
  const { force = false, onProgress } = options;
  let meta = (await readJson(BUNDLE_META_FILE)) || {};
  const localVersion = String(meta?.version || '');
  const versionChanged = force || !localVersion || localVersion !== manifest.version;

  const coreInfo = await getFileInfo(CORE_DB_URI);
  const monthInfo = await getFileInfo(MONTH_DB_URI);
  let needsCore = versionChanged || !coreInfo?.exists;
  let needsMonth = versionChanged || !monthInfo?.exists;

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

  if (!needsMonth) {
    const existingMonthValidation = await validateDbTables(MONTH_DB_NAME, ['trips', 'stop_times']).catch(
      (error) => ({ ok: false, reason: error?.message }),
    );
    if (!existingMonthValidation.ok) {
      logHostedSqlite('bundle:v2:existing-month-invalid', {
        monthFile: MONTH_DB_FILE,
        validation: existingMonthValidation,
      });
      needsMonth = true;
    }
  }

  logHostedSqlite('bundle:v2:start', {
    manifestVersion: manifest.version,
    coreUrl: manifest.core.url,
    monthUrl: manifest.month.url,
    needsCore,
    needsMonth,
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

  if (needsMonth) {
    onProgress?.({ message: 'Downloading monthly schedules...', percent: 0.35 });
    logHostedSqlite('bundle:v2:download-month', { monthUrl: manifest.month.url, monthFile: MONTH_DB_FILE });
    await downloadBundleAsset(manifest.month, MONTH_DB_URI, onProgress, 'monthly schedules');
    const monthValidation = await validateDbTables(MONTH_DB_NAME, ['trips', 'stop_times']).catch((error) => ({
      ok: false,
      reason: error?.message,
    }));
    if (!monthValidation.ok) {
      await FileSystem.deleteAsync(MONTH_DB_URI, { idempotent: true }).catch(() => {});
      logHostedSqlite('bundle:v2:month-validation-failed', { monthValidation, monthFile: MONTH_DB_FILE });
      throw createHostedSqliteError('month-validation', `Month database invalid: ${monthValidation.reason}`, {
        monthFile: MONTH_DB_FILE,
        validation: monthValidation,
      });
    }
    meta.installedWeeks = [];
  }

  const validInstalledWeeks = [];
  for (const week of meta.installedWeeks || []) {
    const startDate = String(week?.startDate || '');
    if (!startDate) continue;
    const weekFile = weekDbUri(startDate);
    const weekInfo = await getFileInfo(weekFile);
    if (!weekInfo?.exists) continue;
    const weekValidation = await validateDbTables(weekDbName(startDate), ['trips', 'stop_times']).catch(
      (error) => ({ ok: false, reason: error?.message }),
    );
    if (weekValidation.ok) {
      validInstalledWeeks.push(week);
    } else {
      logHostedSqlite('bundle:v2:existing-week-invalid', {
        weekFile,
        validation: weekValidation,
      });
      await FileSystem.deleteAsync(weekFile, { idempotent: true }).catch(() => {});
    }
  }
  meta.installedWeeks = validInstalledWeeks;

  const installedWeekIds = new Set((meta.installedWeeks || []).map((w) => String(w.id || w.startDate)));
  const checkDue = force || isCheckDue(meta);
  let weeksChanged = false;

  if (checkDue && !versionChanged) {
    for (const week of manifest.weeks || []) {
      const weekId = String(week.id || week.startDate || '');
      if (!weekId || installedWeekIds.has(weekId)) continue;
      const dest = weekDbUri(week.startDate);
      onProgress?.({ message: `Downloading week ${week.startDate}...`, percent: 0.55 });
      await downloadBundleAsset(week, dest, onProgress, `week ${week.startDate}`);
      const weekValidation = await validateDbTables(weekDbName(week.startDate), ['trips', 'stop_times']).catch(
        (error) => ({ ok: false, reason: error?.message }),
      );
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
      meta.installedWeeks = [
        ...(meta.installedWeeks || []),
        {
          id: weekId,
          startDate: week.startDate,
          endDate: week.endDate,
          fileName: week.fileName,
        },
      ];
      installedWeekIds.add(weekId);
      weeksChanged = true;
    }
  }

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

  return {
    ok: true,
    changed: needsCore || needsMonth || weeksChanged,
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
    const monthInfo = await getFileInfo(MONTH_DB_URI);
    if (!monthInfo?.exists) {
      return { ok: false, reason: 'local-month-missing' };
    }
    const monthValidation = await validate(MONTH_DB_NAME, ['trips', 'stop_times']);
    if (!monthValidation.ok) {
      return { ok: false, reason: `local-month-invalid: ${monthValidation.reason || 'unknown'}` };
    }
    // Prune invalid week DBs (mirrors ensureHostedBundleV2): a corrupt week
    // file would otherwise crash schedule resolution at startup.
    const validInstalledWeeks = [];
    for (const week of bundleMeta.installedWeeks || []) {
      const startDate = String(week?.startDate || '');
      if (!startDate) continue;
      const weekFile = weekDbUri(startDate);
      const weekInfo = await getFileInfo(weekFile);
      if (!weekInfo?.exists) continue;
      const weekValidation = await validate(weekDbName(startDate), ['trips', 'stop_times']);
      if (weekValidation.ok) {
        validInstalledWeeks.push(week);
      } else {
        logHostedSqlite('bundle:v2:existing-week-invalid', {
          weekFile,
          validation: weekValidation,
        });
        await FileSystem.deleteAsync(weekFile, { idempotent: true }).catch(() => {});
      }
    }
    if (validInstalledWeeks.length !== (bundleMeta.installedWeeks || []).length) {
      await writeJson(BUNDLE_META_FILE, { ...bundleMeta, installedWeeks: validInstalledWeeks });
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

  const { force = false, onProgress } = options;
  onProgress?.({ message: 'Checking schedules database version...', percent: 0.02 });
  const manifest = await fetchRemoteManifest();
  if (!manifest) {
    return { ok: false, reason: 'manifest-unavailable' };
  }

  if (manifest.format === 'v2') {
    return ensureHostedBundleV2(manifest, { force, onProgress });
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

  if (manifest.format === 'v2' && isCheckDue(localMeta)) {
    const installedWeekIds = new Set((localMeta.installedWeeks || []).map((w) => String(w.id || w.startDate)));
    const missingWeek = (manifest.weeks || []).find((w) => !installedWeekIds.has(String(w.id || w.startDate)));
    if (missingWeek) {
      const pending = {
        status: 'available',
        detectedAt: Date.now(),
        version: manifest.version,
        format: 'v2-week-extension',
        weekId: missingWeek.id || missingWeek.startDate,
        remoteFingerprint: {
          contentLength: missingWeek.sizeBytes || null,
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
  }

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
      return { stops, routes, pathways, calendar, calendarDates, meta };
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
    return { trips: [], stopTimes: [] };
  }

  const routeTypes = routeTypesForModes(modes);
  const allTrips = [];
  const allStopTimes = [];
  let datesDone = 0;

  if (meta?.format === 'v2') {
    for (const ymd of uniqueDates) {
      const target = resolveScheduleDbForDate(ymd, meta);
      if (!target) continue;

      const db = await SQLite.openDatabaseAsync(target.dbName, { useNewConnection: true }, DB_OPEN_DIR);
      try {
        await db.execAsync('PRAGMA journal_mode = WAL;');
        const serviceIds = [...activeServiceIdsForDateFn(ymd)];
        const trips = await loadTripsForServices(db, serviceIds, routeTypes);
        const tripIds = trips.map((t) => String(t.trip_id));
        const stopTimes = await loadStopTimesForTripIds(db, tripIds);
        allTrips.push(...trips);
        allStopTimes.push(...stopTimes);
      } finally {
        await db.closeAsync().catch(() => {});
      }

      datesDone += 1;
      onProgress?.({
        message: `Loading schedules (${datesDone}/${uniqueDates.length})...`,
        percent: 0.7 + (datesDone / uniqueDates.length) * 0.25,
      });
    }
    return { trips: allTrips, stopTimes: allStopTimes };
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
    return { trips: allTrips, stopTimes: allStopTimes };
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
