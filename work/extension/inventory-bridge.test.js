import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const pageSource = await readFile(new URL('./inventory-page-bridge.js', import.meta.url), 'utf8');
const contentSource = await readFile(new URL('./inventory-content.js', import.meta.url), 'utf8');
const PATH = '/shop/retail/pickup-message?pl=true&mts.0=regular&parts.0=MEHY4CH%2FB&store=R617&location=410000';
const inventory = { body: { stores: [{ storeNumber: 'R617', secret: 'never-forward', partsAvailability: { 'MEHY4CH/B': { pickupDisplay: 'available', token: 'never-forward' }, OTHER: { pickupDisplay: 'available' } } }] }, token: 'never-forward' };
const flush = () => new Promise(resolve => setImmediate(resolve));

function response({ status = 200, body = JSON.stringify(inventory), headers = {}, chunks } = {}) {
  const bytes = new TextEncoder().encode(body);
  const queue = chunks || [bytes];
  const values = { 'content-type': 'application/json', ...headers };
  let index = 0;
  return { status, headers: { get: name => values[name.toLowerCase()] ?? null }, body: { getReader: () => ({
    read: async () => index < queue.length ? { done: false, value: queue[index++] } : { done: true }, cancel: async () => {}, releaseLock() {}
  }) } };
}
function harness({ url = 'https://www.apple.com.cn/shop/buy-iphone/iphone-17', fetchImpl, top = true } = {}) {
  const listeners = new Map(), timers = new Map(), calls = [], messages = [];
  let timerId = 0, runtimeListener, serial = 0, now = Date.parse('2026-10-16T10:00:00Z');
  const location = new URL(url);
  const window = {
    location,
    addEventListener(type, listener) { const set = listeners.get(type) || new Set(); set.add(listener); listeners.set(type, set); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    postMessage(data, targetOrigin) {
      messages.push(data);
      queueMicrotask(() => { for (const listener of [...(listeners.get('message') || [])]) listener({ source: window, origin: location.origin, data }); });
    },
    fetch: async (requestURL, options) => { calls.push({ requestURL, options }); return fetchImpl ? fetchImpl(requestURL, options) : response(); }
  };
  window.top = top ? window : {};
  const document = {};
  Object.defineProperty(document, 'cookie', { get() { throw new Error('cookie access forbidden'); }, set() { throw new Error('cookie mutation forbidden'); } });
  Object.defineProperty(window, '__shldRun', { get() { throw new Error('challenge execution forbidden'); } });
  class FakeDate extends Date { static now() { return now; } }
  const globals = { window, document, URL, AbortController, TextDecoder, Date: FakeDate, setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; }, clearTimeout(id) { timers.delete(id); } };
  vm.runInNewContext(pageSource, { ...globals });
  vm.runInNewContext(contentSource, { ...globals, chrome: { runtime: { id: 'fixture-extension', onMessage: { addListener(listener) { runtimeListener = listener; } } } } });
  function ask({ requestPath = PATH, requestId = 'request-' + ++serial, sender = { id: 'fixture-extension' } } = {}) {
    return new Promise(resolve => { runtimeListener({ type: 'inventory:query', requestId, requestPath }, sender, result => resolve(JSON.parse(JSON.stringify(result)))); });
  }
  function cancel(requestId, sender = { id: 'fixture-extension' }) {
    return new Promise(resolve => runtimeListener({ type: 'inventory:cancel', requestId }, sender, result => resolve(JSON.parse(JSON.stringify(result)))));
  }
  return { window, calls, messages, timers, listeners, ask, cancel, advance(milliseconds) { now += milliseconds; },
    async fireTimer(delay) { for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.fn(); } await flush(); },
    emit(type) { for (const listener of [...(listeners.get(type) || [])]) listener({}); },
    assertClean() { assert.equal(timers.size, 0); assert.equal(listeners.get('message')?.size, 1); for (const type of ['pagehide', 'hashchange', 'popstate']) assert.equal(listeners.get(type)?.size || 0, 0); }
  };
}

test('inventory bridge returns only scoped stock fields through a same-origin GET', async () => {
  const h = harness(), result = await h.ask();
  assert.deepEqual(result, { ok: true, payload: { body: { stores: [{ storeNumber: 'R617', partsAvailability: { 'MEHY4CH/B': { pickupDisplay: 'available' } } }] } } });
  assert.equal(h.calls.length, 1);
  const call = h.calls[0];
  assert.equal(call.requestURL, 'https://www.apple.com.cn' + PATH);
  assert.equal(call.options.method, 'GET'); assert.equal(call.options.mode, 'same-origin'); assert.equal(call.options.credentials, 'include'); assert.equal(call.options.redirect, 'error');
  assert.ok(!JSON.stringify(result).includes('never-forward'));
  await flush(); h.assertClean();
});

test('inventory bridge rejects other origins, endpoints, unsafe or unbounded query parameters', async () => {
  for (const path of [
    'https://evil.example' + PATH, 'https://user:secret@www.apple.com.cn' + PATH, PATH + '#fragment',
    '/shop/bag', '/shop/checkout', PATH.replace('pickup-message', 'pickup-message/extra'),
    PATH + '&token=private', PATH + '&store=R123', PATH.replace('R617', 'OTHER'), PATH.replace('410000', 'bad'),
    PATH.replace('parts.0', 'parts.1'), PATH.replace('mts.0=regular&', ''), PATH.replace('MEHY4CH%2FB', '..%2Fprivate'),
    PATH.replace('pl=true', 'pl=false'), PATH + '&parts.100=SKU&mts.100=regular', 'x'.repeat(16_385)
  ]) {
    const h = harness(); assert.equal((await h.ask({ requestPath: path })).ok, false, path); assert.equal(h.calls.length, 0, path); await flush(); h.assertClean();
  }
});

test('inventory bridge refuses transaction pages, secure hosts, iframes and bad senders', async () => {
  for (const url of ['https://www.apple.com.cn/shop/bag', 'https://www.apple.com.cn/shop/checkout', 'https://www.apple.com.cn/shop/signin', 'https://www.apple.com.cn/shop/account', 'https://www.apple.com.cn/shop/order/123', 'https://secure6.www.apple.com.cn/shop/buy-iphone/iphone-17', 'https://www.apple.com/shop/buy-iphone/iphone-17']) {
    const h = harness({ url }); assert.equal((await h.ask()).ok, false); assert.equal(h.calls.length, 0);
  }
  const frame = harness({ top: false }); assert.equal((await frame.ask()).ok, false); assert.equal(frame.calls.length, 0);
  const h = harness(); assert.equal((await h.ask({ sender: { id: 'other-extension' } })).ok, false); assert.equal(h.calls.length, 0);
});

test('inventory bridge rejects nested and percent-encoded transaction path segments', async () => {
  for (const segment of ['bag', 'checkout', 'signin', 'account', 'order', 'orders', 'secure', '%63heckout', 'iphone-17%2Fcheckout', '%E0%A4%A']) {
    const h = harness({ url: 'https://www.apple.com.cn/shop/buy-iphone/' + segment + '/test' });
    assert.equal((await h.ask()).ok, false, segment); assert.equal(h.calls.length, 0, segment);
  }
});

test('inventory bridge rejects HTML, invalid inventory JSON and oversized response headers or streams', async () => {
  const fixtures = [
    { body: '<html>Enable JavaScript</html>', headers: { 'content-type': 'text/html' } },
    { body: '<html>not JSON</html>' }, { body: '{"token":"never-forward"}' },
    { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } },
    { chunks: [new Uint8Array(2 * 1024 * 1024), new Uint8Array(1)] }
  ];
  for (const fixture of fixtures) {
    const h = harness({ fetchImpl: () => response(fixture) }), result = await h.ask();
    assert.equal(result.ok, false); assert.ok(!JSON.stringify(result).includes('Enable JavaScript')); assert.ok(!JSON.stringify(result).includes('never-forward')); await flush(); h.assertClean();
  }
});

for (const status of [403, 541]) test(`inventory bridge leaves HTTP ${status} verification to the user without retry`, async () => {
  const h = harness({ fetchImpl: () => response({ status }) }), result = await h.ask();
  assert.equal(result.status, status); assert.match(result.error, /手动完成验证/); assert.equal(h.calls.length, 1); await flush(); h.assertClean();
});

test('inventory bridge 503 and 429 cool down for at least 60 seconds and respect Retry-After', async () => {
  for (const fixture of [{ status: 503, headers: {}, delay: 60_000 }, { status: 429, headers: { 'retry-after': '120' }, delay: 120_000 }, { status: 503, headers: { 'retry-after': 'Fri, 16 Oct 2026 10:05:00 GMT' }, delay: 300_000 }, { status: 503, headers: { 'retry-after': '999999999999999999999999999999' }, delay: 60_000 }]) {
    const h = harness({ fetchImpl: () => response(fixture) }), result = await h.ask();
    assert.equal(result.ok, false); assert.equal(result.status, fixture.status); assert.equal(Date.parse(result.retryAt) - Date.parse('2026-10-16T10:00:00Z'), fixture.delay);
    assert.equal((await h.ask()).status, fixture.status); assert.equal(h.calls.length, 1, 'cooldown does not dispatch another fetch');
    h.advance(fixture.delay); await h.ask(); assert.equal(h.calls.length, 2, 'a new explicit request may run after cooldown'); await flush(); h.assertClean();
  }
});

test('inventory bridge deduplicates concurrent query IDs and rejects a second query', async () => {
  let complete;
  const h = harness({ fetchImpl: () => new Promise(resolve => { complete = resolve; }) });
  const first = h.ask({ requestId: 'same-request' }), second = h.ask({ requestId: 'same-request' });
  await flush(); assert.equal(h.calls.length, 1); assert.equal((await h.ask({ requestId: 'other-request' })).ok, false);
  complete(response()); assert.deepEqual(await first, await second); await flush(); h.assertClean();
});

test('inventory bridge aborts a timed out fetch without retry and releases request listeners', async () => {
  const h = harness({ fetchImpl: () => new Promise(() => {}) }), pending = h.ask();
  await flush(); await h.fireTimer(10_000);
  const result = await pending; assert.equal(result.ok, false); assert.match(result.error, /超时/); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].options.signal.aborted, true); h.assertClean();
});

test('inventory bridge ignores late success after navigation and cancels the pending query', async () => {
  let complete;
  const h = harness({ fetchImpl: () => new Promise(resolve => { complete = resolve; }) }), pending = h.ask();
  await flush(); h.window.location.href = 'https://www.apple.com.cn/shop/bag'; h.emit('pagehide');
  const result = await pending; assert.equal(result.ok, false); assert.match(result.error, /取消/); complete(response()); await flush(); assert.equal(h.calls[0].options.signal.aborted, true); h.assertClean();
});

test('inventory bridge only honors an authorized cancel for the matching pending request', async () => {
  const h = harness({ fetchImpl: () => new Promise(() => {}) }), pending = h.ask({ requestId: 'cancellable-request' });
  await flush();
  assert.equal((await h.cancel('cancellable-request', { id: 'other-extension' })).ok, false);
  assert.equal((await h.cancel('different-request')).cancelled, false);
  assert.equal(h.calls[0].options.signal.aborted, false);
  assert.deepEqual(await h.cancel('cancellable-request'), { ok: true, cancelled: true });
  assert.match((await pending).error, /取消/);
  await flush(); assert.equal(h.calls[0].options.signal.aborted, true); h.assertClean();
});
