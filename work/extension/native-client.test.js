import test from "node:test";
import assert from "node:assert/strict";
import { createNativeClient, NATIVE_HOST, redactText } from "./native-client.js";

const task = { id: "fixture-task", areaCode: "cn", areaTitle: "中国大陆", store: { StoreNumber: "R001", CityStoreName: "测试门店" }, product: { Code: "TESTCH/A", Type: "iphoneduo", Model: "iPhone Duo", Capacity: "256GB", Color: "测试色" } };
const settings = { barkUrl: "", feishuWebhook: "", feishuSecret: "", intervalSeconds: 30 };
const snapshot = (overrides = {}) => ({ ok: true, monitoring: false, tasks: [structuredClone(task)], notificationSettings: { ...settings }, monitorState: { running: false, checking: false, lastCheck: "", items: {}, log: [] }, ...overrides });
function event() { const listeners = []; return { listeners, addListener: fn => listeners.push(fn) }; }
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

async function setup(initial = {}) {
  const store = structuredClone(initial);
  const requests = [];
  const tabs = [];
  const access = [];
  const chrome = {
    runtime: { id: "fixture-extension", getURL: path => "chrome-extension://fixture-extension/" + path, onInstalled: event(), onMessage: event(),
      sendNativeMessage: (host, request, callback) => {
        requests.push({ host, request: structuredClone(request) });
        Promise.resolve(mock.reply(request)).then(callback);
      }
    },
    action: { onClicked: event() },
    storage: { local: {
      setAccessLevel: async value => { access.push(value); },
      get: async keys => Object.fromEntries(keys.filter(key => key in store).map(key => [key, structuredClone(store[key])])),
      set: async values => Object.assign(store, structuredClone(values))
    } },
    tabs: { query: async () => tabs, create: async value => { tabs.push(value); return value; }, update: async () => {} },
    windows: { update: async () => {} }
  };
  const mock = { chrome, store, requests, tabs, access, reply: async () => snapshot() };
  globalThis.chrome = chrome;
  globalThis.fetch = async () => assert.fail("The extension must not perform stock or notification requests");
  await import("./background.js?native-test=" + Math.random());
  mock.message = (message, sender = { id: chrome.runtime.id, url: chrome.runtime.getURL("app.html"), frameId: 0 }) => new Promise(resolve => {
    chrome.runtime.onMessage.listeners[0](message, sender, resolve);
  });
  return mock;
}

test("native client uses fixed host and passes only a supported action", async () => {
  const sent = [];
  const client = createNativeClient({ sendNativeMessage: (host, message, cb) => { sent.push({ host, message }); cb({ ok: true }); } });
  assert.deepEqual(await client({ action: "status" }), { ok: true });
  assert.equal(sent[0].host, NATIVE_HOST);
  await assert.rejects(client({ action: "shell" }), /不支持/);
  assert.equal(sent.length, 1);
});

test("native timeout ignores a late response and clears its timer", async () => {
  let fireTimeout, callback;
  const cleared = [];
  const client = createNativeClient({ sendNativeMessage: (_host, _request, cb) => { callback = cb; } }, {
    setTimer: fn => { fireTimeout = fn; return 17; }, clearTimer: id => cleared.push(id)
  });
  const pending = client({ action: "status" });
  fireTimeout();
  await assert.rejects(pending, /连接超时/);
  callback({ ok: true });
  assert.deepEqual(cleared, [17]);
});

test("missing or disconnected native host returns a safe actionable error", async () => {
  const runtime = { sendNativeMessage: (_host, _request, cb) => { runtime.lastError = { message: "Native host not found https://secret.example/key" }; cb(); runtime.lastError = undefined; } };
  await assert.rejects(createNativeClient(runtime)({ action: "status" }), error => /未找到本机连接器/.test(error.message) && !error.message.includes("secret.example"));
  await assert.rejects(createNativeClient({ sendNativeMessage: (_h, _r, cb) => cb(null) })({ action: "status" }), /有效状态/);
});

test("dashboard is the only allowed caller and credentials stay in trusted contexts", async () => {
  const m = await setup();
  assert.deepEqual(m.access, [{ accessLevel: "TRUSTED_CONTEXTS" }]);
  for (const sender of [
    { id: m.chrome.runtime.id, url: "https://www.apple.com.cn/" },
    { id: "other-extension", url: m.chrome.runtime.getURL("app.html") },
    { id: m.chrome.runtime.id, url: m.chrome.runtime.getURL("app.html"), frameId: 2 }
  ]) assert.equal((await m.message({ type: "get-backend-state" }, sender)).ok, false);
  assert.equal(m.requests.length, 0);
});

test("status recovers actual Java state instead of browser cache", async () => {
  const m = await setup({ monitoring: false, tasks: [] });
  m.reply = () => snapshot({ monitoring: true, monitorState: { running: true, checking: true, lastCheck: "2026-10-16T00:00:00Z", items: {}, log: [] } });
  const result = await m.message({ type: "get-backend-state" });
  assert.equal(result.ok, true);
  assert.equal(result.monitoring, true);
  assert.equal(m.store.monitoring, true);
  assert.equal(m.store.backendConnection.connected, true);
  assert.deepEqual(m.requests.map(item => item.request), [{ action: "status" }]);
});

test("start sends tasks and settings; no browser stock fetch, alarm, or notification is used", async () => {
  const m = await setup();
  m.reply = () => snapshot({ monitoring: true, monitorState: { running: true, checking: false, lastCheck: "", items: {}, log: [] } });
  const result = await m.message({ type: "start-monitor", tasks: [task], notificationSettings: settings });
  assert.equal(result.ok, true);
  assert.deepEqual(m.requests[0], { host: NATIVE_HOST, request: { action: "start", tasks: [task], notificationSettings: settings } });
  assert.equal(m.store.monitoring, true);
  assert.equal(m.tabs.length, 0);
});

test("task and settings saves map to sync and do not start monitoring", async () => {
  const m = await setup();
  assert.equal((await m.message({ type: "save-tasks", tasks: [task] })).ok, true);
  assert.equal((await m.message({ type: "save-settings", notificationSettings: settings })).ok, true);
  assert.deepEqual(m.requests.map(item => item.request), [{ action: "sync", tasks: [task] }, { action: "sync", notificationSettings: settings }]);
  assert.equal(m.store.monitoring, false);
});

test("stop and one-off check use Java authority without locally changing running state", async () => {
  const m = await setup({ monitoring: true });
  await m.message({ type: "stop-monitor" });
  await m.message({ type: "check-now" });
  assert.deepEqual(m.requests.map(item => item.request.action), ["stop", "check"]);
  assert.equal(m.store.monitoring, false);
});

test("failed save preserves last confirmed data and marks backend disconnected", async () => {
  const m = await setup({ tasks: [task], monitoring: true, notificationSettings: settings });
  m.reply = () => ({ ok: false, error: "Java 服务未连接" });
  const result = await m.message({ type: "save-tasks", tasks: [] });
  assert.equal(result.ok, false);
  assert.equal(m.store.tasks.length, 1);
  assert.equal(m.store.monitoring, true);
  assert.equal(m.store.backendConnection.connected, false);
});

test("native failure does not expose configured credentials in page errors or logs", async () => {
  const secretSettings = { ...settings, barkUrl: "https://api.day.app/bark-secret", feishuWebhook: "https://open.feishu.cn/open-apis/bot/v2/hook/hook-secret", feishuSecret: "fixture-signing-secret" };
  const m = await setup({ notificationSettings: secretSettings });
  m.reply = () => ({ ok: false, error: "failed " + Object.values(secretSettings).join(" ") });
  const result = await m.message({ type: "get-backend-state" });
  assert.doesNotMatch(result.error, /bark-secret|hook-secret|fixture-signing-secret/);
  m.reply = () => snapshot({ notificationSettings: secretSettings, monitorState: { running: false, checking: false, lastCheck: "", items: { [task.id]: { status: "查询异常", detail: secretSettings.feishuSecret } }, log: [{ time: "now", message: Object.values(secretSettings).join(" ") }] } });
  const success = await m.message({ type: "get-backend-state" });
  assert.doesNotMatch(JSON.stringify(success.monitorState), /bark-secret|hook-secret|fixture-signing-secret/);
});

test("invalid backend snapshot never fabricates a paused or empty state", async () => {
  const m = await setup({ tasks: [task], monitoring: true });
  m.reply = () => ({ ok: true });
  const result = await m.message({ type: "get-backend-state" });
  assert.equal(result.ok, false);
  assert.equal(m.store.monitoring, true);
  assert.equal(m.store.tasks.length, 1);
});

test("status and commands are serialized so stale snapshots cannot undo a stop", async () => {
  const m = await setup();
  const statusReply = deferred();
  const entered = deferred();
  m.reply = request => { if (request.action === "status") { entered.resolve(); return statusReply.promise; } return snapshot(); };
  const status = m.message({ type: "get-backend-state" });
  await entered.promise;
  const stop = m.message({ type: "stop-monitor" });
  assert.equal(m.requests.length, 1);
  statusReply.resolve(snapshot({ monitoring: true, monitorState: { running: true, checking: false, lastCheck: "", items: {}, log: [] } }));
  await Promise.all([status, stop]);
  assert.deepEqual(m.requests.map(item => item.request.action), ["status", "stop"]);
  assert.equal(m.store.monitoring, false);
});

test("invalid tasks and notification settings fail before native calls", async () => {
  const m = await setup();
  assert.equal((await m.message({ type: "save-tasks", tasks: [task, task] })).ok, false);
  assert.equal((await m.message({ type: "start-monitor", tasks: [] })).ok, false);
  assert.equal((await m.message({ type: "save-settings", notificationSettings: { barkUrl: "http://example.com" } })).ok, false);
  assert.equal(m.requests.length, 0);
});

test("log redaction removes URLs even when they are not the configured webhook", () => {
  assert.equal(redactText("request https://api.day.app/unknown?key=secret failed"), "request [链接已隐藏] failed");
});


test("previous signing key is redacted from saved logs after settings change", async () => {
  const oldSettings = { ...settings, feishuWebhook: "https://open.feishu.cn/open-apis/bot/v2/hook/hook-secret", feishuSecret: "previous-secret" };
  const m = await setup({ notificationSettings: oldSettings });
  m.reply = () => snapshot({ monitorState: { running: false, checking: false, lastCheck: "", items: {}, log: [{ time: "now", message: "failed previous-secret" }] } });
  const result = await m.message({ type: "save-settings", notificationSettings: settings });
  assert.equal(result.ok, true);
  assert.doesNotMatch(JSON.stringify(result.monitorState), /previous-secret/);
});
