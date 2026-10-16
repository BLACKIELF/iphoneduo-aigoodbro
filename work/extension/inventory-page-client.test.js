import assert from "node:assert/strict";
import test from "node:test";
import { createInventoryPageClient } from "./inventory-page-client.js";

const TIME = Date.parse("2026-10-16T10:00:00Z");
const TASK = { id: "watch-1", areaCode: "cn", store: { StoreNumber: "R617", District: "410000" }, product: { Code: "MEHY4CH/B" } };
const IDENTITY = "cn:R617:MEHY4CH/B";
const URL = "https://www.apple.com.cn/shop/buy-watch/apple-watch-se";
const stock = (display = "available", store = "R617", sku = "MEHY4CH/B") => ({
  body: { stores: [{ storeNumber: store, partsAvailability: { [sku]: { pickupDisplay: display } } }] }
});
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

function fake({ tabs = [{ id: 8, url: URL }], reply = { ok: true, status: 200, payload: stock() }, send, saved = {} } = {}) {
  const state = { tasks: structuredClone([TASK]), monitorState: { items: { untouched: true } },
    checkoutState: { untouched: true }, ...structuredClone(saved) };
  const calls = { sent: [], writes: [], query: 0, get: 0 };
  const started = deferred();
  const chrome = {
    storage: { local: {
      async get(keys) { return Object.fromEntries(keys.map((key) => [key, structuredClone(state[key])])); },
      async set(value) { calls.writes.push(structuredClone(value)); Object.assign(state, structuredClone(value)); }
    } },
    tabs: {
      async query() { calls.query++; return structuredClone(tabs); },
      async get(id) { calls.get++; return structuredClone(tabs.find((tab) => tab.id === id)); },
      async sendMessage(...args) { calls.sent.push(args); started.resolve(); return send ? send(...args) : reply; },
      async create() { assert.fail("must not create browser tabs"); },
      async update() { assert.fail("must not navigate or focus browser tabs"); }
    }
  };
  return { chrome, state, calls, tabs, started, client: createInventoryPageClient(chrome, { now: () => TIME }) };
}

test("one explicit query uses an existing product tab and returns only exact stock fields", async () => {
  const f = fake();
  const response = await f.client.query(TASK);
  assert.deepEqual(response, { ok: true, result: {
    identity: IDENTITY, known: true, available: true, status: "有货",
    detail: "官网商品页查询：已匹配所选门店和 SKU", checkedAt: new Date(TIME).toISOString()
  } });
  assert.equal(f.calls.sent.length, 1);
  const [tab, message, options] = f.calls.sent[0];
  assert.equal(tab, 8);
  assert.equal(message.type, "inventory:query");
  assert.match(message.requestId, /^[0-9a-f-]{36}$/);
  const path = new globalThis.URL(message.requestPath, "https://www.apple.com.cn");
  assert.equal(path.pathname, "/shop/retail/pickup-message");
  assert.deepEqual([...path.searchParams.keys()], ["pl", "mts.0", "parts.0", "location", "store"]);
  assert.equal(path.searchParams.get("parts.0"), "MEHY4CH/B");
  assert.equal(path.searchParams.get("store"), "R617");
  assert.deepEqual(options, { frameId: 0 });
  assert.equal(f.calls.get, 1);
  assert.deepEqual(f.state.inventoryPageResults[TASK.id], response.result);
  assert.deepEqual(f.state.monitorState, { items: { untouched: true } });
  assert.deepEqual(f.state.checkoutState, { untouched: true });
  assert.deepEqual(f.state.tasks, [TASK]);
  assert.ok(f.calls.writes.every((write) => Object.keys(write).every((key) => ["inventoryPageResults", "inventoryPageRetryAt"].includes(key))));
});

test("rejects malformed tasks before accessing tabs or writing state", async () => {
  for (const task of [null, [TASK], { ...TASK, id: "__proto__" }, { ...TASK, id: "" }, { ...TASK, areaCode: "us" },
    { ...TASK, store: { StoreNumber: "R617?store=R001" } }, { ...TASK, product: { Code: "../checkout" } },
    { ...TASK, product: { Code: "MEHY4CH/B&parts.1=OTHER" } }]) {
    const f = fake();
    assert.equal((await f.client.query(task)).ok, false);
    assert.equal(f.calls.query, 0);
    assert.equal(f.calls.writes.length, 0);
  }
});

test("requires the task to remain a unique saved task", async () => {
  for (const tasks of [[], [TASK, TASK], [{ ...TASK, product: { Code: "MG744CH/A" } }]]) {
    const f = fake({ saved: { tasks } });
    assert.equal((await f.client.query(TASK)).ok, false);
    assert.equal(f.calls.sent.length, 0);
  }
});

test("rejects secure, transaction, foreign, pending-navigation and disguised pages", async () => {
  const urls = ["https://secure6.www.apple.com.cn/shop/buy-watch/apple-watch-se",
    "https://www.apple.com.cn/shop/bag", "https://www.apple.com.cn/shop/checkout",
    "https://www.apple.com.cn/shop/signin", "https://www.apple.com.cn/shop/account",
    "https://www.apple.com.cn/shop/order", "https://www.apple.com/shop/buy-watch/apple-watch-se",
    "https://www.apple.com.cn.evil.test/shop/buy-watch/apple-watch-se",
    "https://www.apple.com.cn/shop/product/%63heckout", "https://www.apple.com.cn/shop/product/x/account",
    "http://www.apple.com.cn/shop/buy-watch/apple-watch-se"];
  for (const url of urls) {
    const f = fake({ tabs: [{ id: 8, url }] });
    assert.equal((await f.client.query(TASK)).ok, false, url);
    assert.equal(f.calls.sent.length, 0);
  }
  const f = fake({ tabs: [{ id: 8, url: URL, pendingUrl: "https://secure6.www.apple.com.cn/shop/checkout" }] });
  assert.equal((await f.client.query(TASK)).ok, false);
  assert.equal(f.calls.sent.length, 0);
});

test("accepts the three allowed product routes without navigating", async () => {
  for (const path of ["buy-watch/apple-watch-se", "buy-iphone/iphone-17/mg744ch/a", "product/MEHY4CH/B"]) {
    const f = fake({ tabs: [{ id: 8, url: "https://www.apple.com.cn/shop/" + path }] });
    assert.equal((await f.client.query(TASK)).ok, true);
  }
});

test("unavailable is distinct from missing, mismatched and unknown stock", async () => {
  for (const [payload, expected] of [[stock("unavailable"), false], [stock("ineligible"), null],
    [stock("available", "R999"), null], [stock("available", "R617", "MG744CH/A"), null], [{}, null]]) {
    const f = fake({ reply: { ok: true, payload }, saved: { inventoryPageResults: { [TASK.id]: { known: true, available: true } } } });
    const response = await f.client.query(TASK);
    assert.equal(response.ok, true);
    assert.equal(response.result.available, expected);
    assert.equal(response.result.known, expected !== null);
    assert.equal(f.state.inventoryPageResults[TASK.id].available, expected);
    assert.equal(f.calls.writes[0].inventoryPageResults[TASK.id].available, null);
  }
});

test("429 and 503 persist at least 60 seconds of cooldown across client recreation", async () => {
  for (const status of [429, 503]) {
    const f = fake({ reply: { ok: false, status, retryAfter: 1, error: "暂时不可用" } });
    const response = await f.client.query(TASK);
    assert.equal(response.ok, false);
    assert.equal(response.result.available, null);
    assert.equal(Date.parse(f.state.inventoryPageRetryAt), TIME + 60000);
    const restarted = createInventoryPageClient(f.chrome, { now: () => TIME + 1000 });
    assert.equal((await restarted.query(TASK)).ok, false);
    assert.equal(f.calls.sent.length, 1);
  }
});

test("respects longer Retry-After seconds, HTTP dates and retryAt timestamps", async () => {
  for (const extra of [{ retryAfter: "240" }, { retryAfter: new Date(TIME + 240000).toUTCString() },
    { retryAt: new Date(TIME + 240000).toISOString() }, { retryAt: TIME + 240000 }]) {
    const f = fake({ reply: { ok: false, status: 503, ...extra } });
    await f.client.query(TASK);
    assert.equal(Date.parse(f.state.inventoryPageRetryAt), TIME + 240000);
  }
});

test("expired cooldown permits a fresh query and never reuses old known stock", async () => {
  const f = fake({ saved: { inventoryPageRetryAt: new Date(TIME - 1).toISOString() } });
  assert.equal((await f.client.query(TASK)).ok, true);
  assert.equal(f.calls.sent.length, 1);
});

test("transport and malformed-response failures clear old known availability", async () => {
  for (const send of [async () => { throw Error("Receiving end does not exist"); }, async () => undefined,
    async () => ({ ok: true, status: 500, payload: stock() })]) {
    const f = fake({ send, saved: { inventoryPageResults: { [TASK.id]: { known: true, available: true } } } });
    const response = await f.client.query(TASK);
    assert.equal(response.ok, false);
    assert.equal(f.state.inventoryPageResults[TASK.id].available, null);
    assert.equal(f.state.inventoryPageResults[TASK.id].known, false);
  }
  const f = fake({ send: async () => { throw Error("missing script"); } });
  assert.match((await f.client.query(TASK)).error, /刷新.*商品页/);
});

test("only one query runs at a time; cancel suppresses late success and cooldown writes", async () => {
  for (const reply of [{ ok: true, payload: stock() }, { ok: false, status: 503 }]) {
    const pending = deferred();
    const f = fake({ send: () => pending.promise });
    const first = f.client.query(TASK);
    await f.started.promise;
    assert.equal((await f.client.query(TASK)).ok, false);
    assert.equal(f.calls.sent.length, 1);
    await f.client.cancel();
    assert.deepEqual(f.calls.sent[1], [8, {
      type: "inventory:cancel", requestId: f.calls.sent[0][1].requestId
    }, { frameId: 0 }]);
    assert.equal((await first).ok, false);
    assert.match(f.state.inventoryPageResults[TASK.id].detail, /取消/);
    const writes = f.calls.writes.length;
    pending.resolve(reply);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.calls.writes.length, writes);
    assert.equal(f.state.inventoryPageRetryAt, undefined);
    assert.deepEqual(f.state.monitorState, { items: { untouched: true } });
    assert.deepEqual(f.state.checkoutState, { untouched: true });
  }
});

test("cancel waits out a pending storage write and leaves the next query usable", async () => {
  const f = fake();
  const entered = deferred();
  const release = deferred();
  const originalSet = f.chrome.storage.local.set;
  let firstWrite = true;
  f.chrome.storage.local.set = async (value) => {
    if (firstWrite) { firstWrite = false; entered.resolve(); await release.promise; }
    return originalSet(value);
  };
  const query = f.client.query(TASK);
  await entered.promise;
  const stopped = f.client.cancel();
  release.resolve();
  await stopped;
  assert.equal((await query).ok, false);
  assert.match(f.state.inventoryPageResults[TASK.id].detail, /取消/);
  assert.equal(f.calls.sent.length, 0);
  assert.equal((await f.client.query(TASK)).ok, true);
});

test("a failed cancellation message cannot block cancellation", async () => {
  const pending = deferred();
  const f = fake({ send: async (_tab, message) => {
    if (message.type === "inventory:cancel") throw Error("tab closed");
    return pending.promise;
  } });
  const query = f.client.query(TASK);
  await f.started.promise;
  await f.client.cancel();
  assert.equal((await query).ok, false);
  assert.match(f.state.inventoryPageResults[TASK.id].detail, /取消/);
  pending.resolve({ ok: true, payload: stock() });
});

test("navigation or task replacement during response discards the late result", async () => {
  for (const change of [(f) => { f.tabs[0].url = "https://secure6.www.apple.com.cn/shop/checkout"; },
    (f) => { f.state.tasks[0].product.Code = "MG744CH/A"; }]) {
    const pending = deferred();
    const f = fake({ send: () => pending.promise });
    const query = f.client.query(TASK);
    await f.started.promise;
    change(f);
    pending.resolve({ ok: true, payload: stock() });
    assert.equal((await query).ok, false);
    assert.notEqual(f.state.inventoryPageResults[TASK.id].available, true);
  }
});

test("errors are redacted and raw payloads are never stored or returned", async () => {
  const f = fake({ saved: { notificationSettings: { feishuSecret: "private-signature" } },
    reply: { ok: false, status: 403, error: "private-signature https://secret.test/token", payload: { private: "not-for-ui" } } });
  const response = await f.client.query(TASK);
  const output = JSON.stringify([response, f.state.inventoryPageResults]);
  assert.doesNotMatch(output, /private-signature|secret\.test|not-for-ui/);
  assert.match(output, /已隐藏/);
});

test("15 second timeout writes unknown and suppresses later responses", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = deferred();
  const f = fake({ send: () => pending.promise });
  const query = f.client.query(TASK);
  await f.started.promise;
  t.mock.timers.tick(15000);
  const response = await query;
  assert.equal(response.ok, false);
  assert.match(response.error, /超时/);
  assert.equal(f.state.inventoryPageResults[TASK.id].available, null);
  const writes = f.calls.writes.length;
  pending.resolve({ ok: true, payload: stock() });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls.writes.length, writes);
});
