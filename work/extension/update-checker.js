// Read public release metadata only. Never send tasks, settings or credentials.
export const UPDATE_SOURCE = 'https://raw.githubusercontent.com/BLACKIELF/iphoneduo-aigoodbro/codex/1016v6/update.json';
export const UPDATE_CACHE_KEY = 'releaseUpdateCache';
const CACHE_MS = 24 * 60 * 60 * 1000;
const MAX_BYTES = 64 * 1024;
const ERRORS = Object.freeze({
  timeout: '升级检测超时，请稍后重试。',
  network: '无法连接升级信息源，请稍后重试。',
  http: '升级信息源暂不可用，请稍后重试。',
  redirect: '升级信息源发生重定向，已停止检测。',
  format: '升级信息格式无效，无法确认最新版本。',
  size: '升级信息过大，已停止检测。'
});

class UpdateError extends Error {
  constructor(code) { super(ERRORS[code]); this.code = code; }
}

function versionParts(version) {
  if (typeof version !== 'string' || version.trim() !== version || !/^(0|[1-9]\d{0,4})(\.(0|[1-9]\d{0,4})){2,3}$/.test(version)) {
    throw new UpdateError('format');
  }
  const parts = version.split('.').map(Number);
  if (parts.some(part => part > 65535) || parts.every(part => part === 0)) throw new UpdateError('format');
  while (parts.length < 4) parts.push(0);
  return parts;
}

export function compareVersions(left, right) {
  const a = versionParts(left), b = versionParts(right);
  for (let index = 0; index < 4; index++) {
    if (a[index] !== b[index]) return Math.sign(a[index] - b[index]);
  }
  return 0;
}

function validText(value, maxLength) {
  return typeof value === 'string' && value.length <= maxLength && value.trim() === value &&
    value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value);
}

function releaseInfo(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new UpdateError('format');
  versionParts(value.version);
  if (!validText(value.versionName, 80) || !Array.isArray(value.changes) ||
      value.changes.length < 1 || value.changes.length > 20 ||
      !value.changes.every(change => validText(change, 500)) ||
      value.changes.reduce((length, change) => length + change.length, 0) > 4000) {
    throw new UpdateError('format');
  }
  // Do not retain remote URLs, commands or arbitrary additional metadata.
  return {version: value.version, versionName: value.versionName, changes: [...value.changes]};
}

function validTimestamp(value, now) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) &&
    Date.parse(value) >= 0 && Date.parse(value) <= now;
}

function cacheRecord(value, now) {
  try {
    if (!value || value.schema !== 1 || !validTimestamp(value.checkedAt, now)) return null;
    versionParts(value.currentVersion);
    const release = value.release == null ? null : releaseInfo(value.release);
    if ((release && value.errorCode != null) || (!release && !Object.hasOwn(ERRORS, value.errorCode))) return null;
    let lastKnown = null;
    if (value.lastKnown && validTimestamp(value.lastKnown.checkedAt, now)) {
      lastKnown = {release: releaseInfo(value.lastKnown.release), checkedAt: value.lastKnown.checkedAt};
    }
    return {schema: 1, currentVersion: value.currentVersion, checkedAt: value.checkedAt,
      release, errorCode: release ? null : value.errorCode, lastKnown};
  } catch { return null; }
}

function successResult(currentVersion, release, checkedAt, cached) {
  const comparison = compareVersions(release.version, currentVersion);
  return {status: comparison > 0 ? 'available' : comparison < 0 ? 'ahead' : 'current',
    currentVersion, latestVersion: release.version, versionName: release.versionName,
    changes: [...release.changes], checkedAt, cached};
}

function resultFromRecord(currentVersion, record, cached) {
  if (record.release) return successResult(currentVersion, record.release, record.checkedAt, cached);
  const result = {status: 'error', currentVersion, latestVersion: null, versionName: '', changes: [],
    checkedAt: record.checkedAt, error: ERRORS[record.errorCode], cached};
  if (record.lastKnown) result.lastKnown = successResult(currentVersion,
    record.lastKnown.release, record.lastKnown.checkedAt, true);
  return result;
}

async function readRelease(response, signal) {
  const rejectResponse = code => {
    try { Promise.resolve(response?.body?.cancel()).catch(() => {}); } catch { /* Ignore transport cleanup errors. */ }
    throw new UpdateError(code);
  };
  if (!response || response.ok !== true) rejectResponse('http');
  if (response.redirected || (response.url && response.url !== UPDATE_SOURCE)) rejectResponse('redirect');
  const declaredSize = response.headers?.get('content-length');
  if (declaredSize && /^\d+$/.test(declaredSize) && Number(declaredSize) > MAX_BYTES) rejectResponse('size');
  if (!response.body?.getReader) throw new UpdateError('format');
  const reader = response.body.getReader();
  const cancel = () => { Promise.resolve(reader.cancel()).catch(() => {}); };
  signal.addEventListener('abort', cancel, {once: true});
  if (signal.aborted) cancel();
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      if (signal.aborted) throw new UpdateError('timeout');
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { cancel(); throw new UpdateError('size'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return releaseInfo(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes))); }
    catch { throw new UpdateError('format'); }
  } finally {
    signal.removeEventListener('abort', cancel);
    try { reader.releaseLock(); } catch { /* A cancelled reader can still be settling. */ }
  }
}

/** storage is a chrome.storage.local-compatible {get(key), set(object)} adapter. */
export function createUpdateChecker({currentVersion, fetchImpl = globalThis.fetch, storage,
  now = Date.now, timeoutMs = 10000} = {}) {
  versionParts(currentVersion);
  if (typeof fetchImpl !== 'function' || typeof storage?.get !== 'function' || typeof storage?.set !== 'function') {
    throw new TypeError('升级检测缺少网络或本机缓存接口');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10000) throw new TypeError('升级检测超时配置无效');
  let loaded = false, record = null, pending = null;

  async function run(force) {
    if (!loaded) {
      try { record = cacheRecord((await storage.get(UPDATE_CACHE_KEY))?.[UPDATE_CACHE_KEY], now()); }
      catch { record = null; }
      loaded = true;
    }
    const age = record ? now() - Date.parse(record.checkedAt) : Infinity;
    if (!force && record?.currentVersion === currentVersion && age >= 0 && age < CACHE_MS) {
      return resultFromRecord(currentVersion, record, true);
    }
    const lastKnown = record?.release ? {release: record.release, checkedAt: record.checkedAt} : record?.lastKnown || null;
    const controller = new AbortController();
    let timer, release = null, errorCode = null;
    try {
      release = await Promise.race([
        Promise.resolve().then(() => fetchImpl(UPDATE_SOURCE, {credentials: 'omit', cache: 'no-store',
          redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal}))
          .then(response => readRelease(response, controller.signal)),
        new Promise((_, reject) => {
          timer = setTimeout(() => { reject(new UpdateError('timeout')); controller.abort(); }, timeoutMs);
        })
      ]);
    } catch (error) { errorCode = error instanceof UpdateError ? error.code : 'network'; }
    finally { clearTimeout(timer); }
    record = {schema: 1, currentVersion, checkedAt: new Date(now()).toISOString(), release, errorCode,
      lastKnown: release ? null : lastKnown};
    // Failure is cached too: automatic checks stay daily; the manual button bypasses it.
    // A cache-write failure must not misrepresent a valid network result.
    try { await storage.set({[UPDATE_CACHE_KEY]: record}); } catch { /* Retain this session's cache. */ }
    return resultFromRecord(currentVersion, record, false);
  }

  return {check({force = false} = {}) {
    if (pending) return pending;
    pending = run(force === true).finally(() => { pending = null; });
    return pending;
  }};
}
