import assert from 'node:assert/strict';
import test from 'node:test';
import {createUpdateChecker, UPDATE_CACHE_KEY, UPDATE_SOURCE} from './update-checker.js';

const release = (version = '1.5.0', overrides = {}) => ({version, versionName: '1018v1', changes: ['升级检测与版本说明'], ...overrides});
const jsonResponse = value => new Response(JSON.stringify(value));
const clone = value => structuredClone(value);
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};

function harness({currentVersion = '1.4.1', remote = release(), fetchImpl, timeoutMs} = {}) {
  let time = Date.parse('2026-10-18T00:00:00Z');
  const data = {}, calls = [], reads = [], writes = [];
  const storage = {
    async get(key) {reads.push(key); return clone({[key]: data[key]});},
    async set(value) {writes.push(clone(value)); Object.assign(data, clone(value));}
  };
  const fetcher = async (...args) => {calls.push(args); return fetchImpl ? fetchImpl(...args) : jsonResponse(remote);};
  const create = (version = currentVersion) => createUpdateChecker({currentVersion: version,
    fetchImpl: fetcher, storage, now: () => time, ...(timeoutMs ? {timeoutMs} : {})});
  return {checker: create(), create, calls, reads, writes, data, storage, advance: ms => {time += ms;},
    setRemote: value => {remote = value;}};
}

for (const [currentVersion, latestVersion, expected] of [
  ['1.4.1', '1.5.0', 'available'], ['1.5.0', '1.5.0', 'current'], ['1.6.0', '1.5.0', 'ahead'],
  ['1.9.0', '1.10.0', 'available'], ['1.10.0', '1.9.0', 'ahead'],
  ['1.5.0', '1.5.0.0', 'current'], ['1.5.0', '1.5.0.1', 'available'],
  ['1.5.0.2', '1.5.0.1', 'ahead'], ['1.5.0', '65535.0.0', 'available']
]) {
  test(`version comparison ${currentVersion} / ${latestVersion}: ${expected}`, async () => {
    const h = harness({currentVersion, remote: release(latestVersion)});
    const result = await h.checker.check();
    assert.equal(result.status, expected);
    assert.equal(result.currentVersion, currentVersion);
    assert.equal(result.latestVersion, latestVersion);
    assert.equal(result.versionName, '1018v1');
    assert.deepEqual(result.changes, ['升级检测与版本说明']);
    assert.equal(result.cached, false);
  });
}

test('only fixed public metadata is requested without local data or credentials', async () => {
  const h = harness({remote: release('1.5.0', {url: 'https://untrusted.invalid', command: 'do-not-run'})});
  const result = await h.checker.check();
  const [url, options] = h.calls[0];
  assert.equal(url, UPDATE_SOURCE);
  assert.deepEqual(Object.keys(options).sort(), ['cache', 'credentials', 'redirect', 'referrerPolicy', 'signal']);
  assert.equal(options.credentials, 'omit');
  assert.equal(options.redirect, 'error');
  assert.equal(options.referrerPolicy, 'no-referrer');
  assert.equal(options.cache, 'no-store');
  assert.deepEqual(h.reads, [UPDATE_CACHE_KEY]);
  assert.deepEqual(Object.keys(h.writes[0]), [UPDATE_CACHE_KEY]);
  assert.equal('url' in result, false);
  assert.equal('command' in result, false);
  assert.equal(JSON.stringify(h.data).includes('untrusted'), false);
});

test('fresh cache survives recreation; 24 hours expires and force bypasses it', async () => {
  const h = harness();
  await h.checker.check();
  h.advance(24 * 60 * 60 * 1000 - 1);
  assert.equal((await h.create().check()).cached, true);
  assert.equal(h.calls.length, 1);
  h.advance(1);
  assert.equal((await h.checker.check()).cached, false);
  assert.equal(h.calls.length, 2);
  assert.equal((await h.checker.check({force: true})).cached, false);
  assert.equal(h.calls.length, 3);
});

test('concurrent checks, including manual force, share a single request', async () => {
  const gate = deferred();
  const h = harness({fetchImpl: () => gate.promise});
  const first = h.checker.check(), second = h.checker.check({force: true});
  assert.equal(first, second);
  gate.resolve(jsonResponse(release()));
  const results = await Promise.all([first, second]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(h.calls.length, 1);
});

test('local version change must not reuse an old available status', async () => {
  const h = harness();
  assert.equal((await h.checker.check()).status, 'available');
  const result = await h.create('1.6.0').check();
  assert.equal(result.status, 'ahead');
  assert.equal(result.cached, false);
  assert.equal(h.calls.length, 2);
});

test('network failure is an error, preserves last success, and supports a manual retry', async () => {
  let fails = false;
  const h = harness({fetchImpl: () => {
    if (fails) throw new Error('private transport detail');
    return jsonResponse(release());
  }});
  const good = await h.checker.check();
  fails = true; h.advance(1000);
  const failed = await h.checker.check({force: true});
  assert.equal(failed.status, 'error');
  assert.equal(failed.latestVersion, null);
  assert.equal(failed.lastKnown.status, 'available');
  assert.equal(failed.lastKnown.checkedAt, good.checkedAt);
  assert.equal(failed.lastKnown.latestVersion, '1.5.0');
  assert.equal(JSON.stringify(failed).includes('private transport'), false);
  assert.equal((await h.create().check()).status, 'error');
  assert.equal((await h.checker.check()).cached, true);
  assert.equal(h.calls.length, 2);
  const upgraded = await h.create('1.6.0').check();
  assert.equal(upgraded.status, 'error');
  assert.equal(upgraded.lastKnown.status, 'ahead');
  fails = false;
  assert.equal((await h.checker.check({force: true})).status, 'available');
});

test('timeout bounds a fetch that never resolves and aborts the request', async () => {
  const h = harness({fetchImpl: () => new Promise(() => {}), timeoutMs: 10});
  const result = await h.checker.check();
  assert.equal(result.status, 'error');
  assert.match(result.error, /超时/);
  assert.equal(h.calls[0][1].signal.aborted, true);
});

test('timeout also bounds a response body that never finishes', async () => {
  let cancelled = false;
  const h = harness({timeoutMs: 10, fetchImpl: () => new Response(new ReadableStream({
    start(controller) {controller.enqueue(new TextEncoder().encode('{'));},
    cancel() {cancelled = true;}
  }))});
  const result = await h.checker.check();
  assert.equal(result.status, 'error');
  assert.match(result.error, /超时/);
  assert.equal(cancelled, true);
});

for (const [name, response] of [
  ['HTTP error', () => new Response('unavailable', {status: 503})],
  ['HTML response', () => new Response('<html>not JSON</html>')],
  ['invalid UTF-8', () => new Response(new Uint8Array([0xff]))],
  ['redirect flag', () => ({ok: true, redirected: true})],
  ['unexpected final URL', () => ({ok: true, url: 'https://untrusted.invalid/update.json'})],
  ['declared oversize', () => new Response('{}', {headers: {'Content-Length': String(64 * 1024 + 1)}})],
  ['streamed oversize', () => new Response(' '.repeat(64 * 1024 + 1))]
]) {
  test(`${name} cannot claim the local version is current`, async () => {
    const h = harness({fetchImpl: response});
    const result = await h.checker.check();
    assert.equal(result.status, 'error');
    assert.equal(result.latestVersion, null);
    assert.deepEqual(result.changes, []);
    assert.equal(result.lastKnown, undefined);
  });
}

for (const version of ['1.5', '1', 'v1.5.0', '1.5.0-beta', '01.5.0', '1.5.00', '1.5.0.1.2',
  '65536.0.0', '0.0.0', '1.5.-1', '1.5.0 ', '1.5.0\n', '1.5.0\r', '1.5.0\r\n', 150, null]) {
  test(`reject malformed remote version ${JSON.stringify(version)}`, async () => {
    assert.equal((await harness({remote: release(version)}).checker.check()).status, 'error');
  });
}

for (const [name, remote] of [
  ['missing version', {versionName: '1018v1', changes: ['change']}],
  ['missing version name', {version: '1.5.0', changes: ['change']}],
  ['missing changelog', {version: '1.5.0', versionName: '1018v1'}],
  ['empty changelog', release('1.5.0', {changes: []})],
  ['non-string changelog', release('1.5.0', {changes: [1]})],
  ['too many changes', release('1.5.0', {changes: Array(21).fill('change')})],
  ['long change', release('1.5.0', {changes: ['a'.repeat(501)]})],
  ['long total changes', release('1.5.0', {changes: Array(9).fill('a'.repeat(500))})],
  ['control characters', release('1.5.0', {changes: ['change\u0000']})],
  ['long name', release('1.5.0', {versionName: 'a'.repeat(81)})],
  ['empty name', release('1.5.0', {versionName: ''})],
  ['null body', null], ['array body', []]
]) {
  test(`${name} is invalid release metadata`, async () => {
    assert.equal((await harness({remote}).checker.check()).status, 'error');
  });
}

test('corrupt or future cache is ignored and malformed cache cannot inject fields', async () => {
  const h = harness();
  h.data[UPDATE_CACHE_KEY] = {schema: 1, currentVersion: '1.4.1', checkedAt: '2099-01-01T00:00:00Z',
    release: release('9.0.0')};
  assert.equal((await h.checker.check()).latestVersion, '1.5.0');
  h.data[UPDATE_CACHE_KEY].release.version = 'not-a-version';
  assert.equal((await h.create().check()).cached, false);
  assert.equal(h.calls.length, 2);
});

test('callers cannot mutate cached changes through a returned object', async () => {
  const h = harness();
  const first = await h.checker.check();
  first.changes[0] = 'changed locally';
  assert.deepEqual((await h.checker.check()).changes, ['升级检测与版本说明']);
});

test('cache storage failures do not turn valid network metadata into a false version claim', async () => {
  const h = harness();
  h.storage.get = async () => {throw new Error('cache unavailable');};
  h.storage.set = async () => {throw new Error('disk unavailable');};
  assert.equal((await h.checker.check()).status, 'available');
  assert.equal((await h.checker.check()).cached, true);
  assert.equal(h.calls.length, 1);
});

test('invalid local versions and unbounded timeouts are rejected before networking', () => {
  assert.throws(() => harness({currentVersion: 'garbage'}));
  assert.throws(() => harness({timeoutMs: 10001}));
});
