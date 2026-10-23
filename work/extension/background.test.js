import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { compareVersions } from "./update-checker.js";

const backgroundSource = readFileSync(new URL("./background.js", import.meta.url), "utf8");
const TASK = { id: "task-1", areaCode: "cn", store: { StoreNumber: "R617" }, product: { Code: "MG744CH/A" } };
const SETTINGS = { barkUrl: "", feishuWebhook: "", feishuSecret: "", intervalSeconds: 30 };

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function harness({ responseOverride = {}, run = null, accessReady = Promise.resolve() } = {}) {
  const readingTasks = deferred();
  const tasksReply = deferred();
  const calls = { queries: [], cancellations: 0, native: [], checkout: [], stock: [], armCancellations: 0,
    saved: [], badges: [], opened: [] };
  const chrome = {
    runtime: {
      getURL: (path) => "chrome-extension://fixture/" + path,
      getManifest: () => ({version: "1.5.0"}),
      onInstalled: { addListener(fn) { calls.installed = fn; } },
      onStartup: { addListener() {} },
      onMessage: { addListener() {} }
    },
    alarms: { async get() {}, async create() {}, async clear() {}, onAlarm: { addListener(fn) { calls.alarm = fn; } } },
    action: { onClicked: { addListener() {} }, async setBadgeBackgroundColor() {},
      async setBadgeText({text}) { calls.badges.push(text); } },
    tabs: { async query() { return []; }, async create(value) { calls.opened.push(value); } },
    storage: { local: {
      async setAccessLevel() { await accessReady; },
      async get(keys) {
        if (keys === "tasks") {
          readingTasks.resolve();
          return tasksReply.promise;
        }
        if (keys === "checkoutRun") return { checkoutRun: run };
        return { notificationSettings: SETTINGS };
      },
      async set(value) { calls.saved.push(value); }
    } }
  };
  const context = {
    chrome,
    compareVersions,
    productPurchaseURL: () => "https://www.apple.com.cn/shop/product/MG744CH/A",
    normalizeNotificationSettings: (settings) => settings,
    redactText: (value) => typeof value === "string" ? value : "",
    createInventoryPageClient: () => ({
      async query(task) { calls.queries.push(task); return { ok: true }; },
      async cancel() { calls.cancellations++; }
    }),
    createCheckoutController: () => ({
      async cancelArmed() { calls.armCancellations++; },
      async inventory(snapshot) { calls.stock.push(snapshot); },
      async handle(message) { calls.checkout.push(message.type); return { ok: true }; }
    }),
    createNativeClient: () => async (request) => {
      calls.native.push(request.action);
      return {
        ok: true, tasks: [TASK], notificationSettings: SETTINGS, monitoring: false,
        monitorState: { running: false, checking: false, items: {}, log: [], lastCheck: "" }, ...responseOverride
      };
    }
  };
  // Exercise the actual background routing; only its external collaborators are stubs.
  const source = backgroundSource.replace(/^import .*;\r?\n/gm, "") + "\nglobalThis.handle = handleMessage;";
  vm.runInNewContext(source, context, { filename: "background.js" });
  return { handle: context.handle, readingTasks, tasksReply, calls };
}

for (const type of ["stop-monitor", "checkout-start", "checkout-arm", "save-tasks"]) {
  test(`${type} blocks an older inventory query awaiting saved tasks`, async () => {
    const f = harness();
    const pending = f.handle({ type: "check-inventory-page", taskId: TASK.id });
    await f.readingTasks.promise;
    const command = await f.handle({ type, ...(type === "save-tasks" ? { tasks: [TASK] } : {}) });
    assert.equal(command.ok, true);
    assert.equal(f.calls.cancellations, 1);
    assert.deepEqual(type.startsWith("checkout-") ? f.calls.checkout : f.calls.native,
      [type.startsWith("checkout-") ? type : type === "stop-monitor" ? "stop" : "sync"]);

    f.tasksReply.resolve({ tasks: [TASK] });
    const result = await pending;
    assert.equal(f.calls.queries.length, 0, "cancelled preflight must not start a page query later");
    assert.equal(result.ok, false);
    assert.match(result.error, /取消/);
  });
}

test("an uncancelled inventory query starts after saved tasks resolve", async () => {
  const f = harness();
  const pending = f.handle({ type: "check-inventory-page", taskId: TASK.id });
  await f.readingTasks.promise;
  assert.equal(f.calls.queries.length, 0);
  f.tasksReply.resolve({ tasks: [TASK] });
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(f.calls.queries.length, 1);
  assert.equal(f.calls.queries[0].id, TASK.id);
  assert.equal(f.calls.cancellations, 0);
});

const nativeSnapshot = (item) => ({ monitoring: true,
  monitorState: { running: true, checking: false, items: { [TASK.id]: item }, log: [], lastCheck: "" } });
test("only validated native facts reach the checkout stock trigger", async () => {
  const checkedAt = new Date().toISOString();
  const f = harness({ responseOverride: nativeSnapshot({ available: true, identity: "cn:R617:MG744CH/A", checkedAt }) });
  const result = await f.handle({ type: "get-backend-state" });
  assert.equal(result.ok, true);
  assert.equal(f.calls.stock.length, 1);
  const item = f.calls.stock[0].monitorState.items[TASK.id];
  assert.equal(item.available, true); assert.equal(item.identity, "cn:R617:MG744CH/A"); assert.equal(item.checkedAt, checkedAt);
});
test("text availability cannot trigger checkout and malformed native state is rejected", async () => {
  const f = harness({ responseOverride: nativeSnapshot({ available: "true", identity: "cn:R617:MG744CH/A", checkedAt: new Date().toISOString() }) });
  assert.equal((await f.handle({ type: "get-backend-state" })).ok, false);
  assert.equal(f.calls.stock.length, 0);
});
test("mismatched identity and invalid timestamp cannot be promoted to stock evidence", async () => {
  const f = harness({ responseOverride: nativeSnapshot({ available: true, identity: "cn:R000:MG744CH/A", checkedAt: "invalid" }) });
  assert.equal((await f.handle({ type: "get-backend-state" })).ok, true);
  const item = f.calls.stock[0].monitorState.items[TASK.id];
  assert.equal(item.identity, ""); assert.equal(item.checkedAt, "");
});
test("manual page inventory results never feed automatic purchase", async () => {
  const f = harness();
  const pending = f.handle({ type: "check-inventory-page", taskId: TASK.id });
  f.tasksReply.resolve({ tasks: [TASK] });
  await pending;
  assert.equal(f.calls.stock.length, 0);
});
test("stop and task changes cancel waiting purchase before native mutation", async () => {
  for (const type of ["stop-monitor", "start-monitor", "save-tasks"]) {
    const f = harness();
    const pending = f.handle({ type, tasks: [TASK] });
    assert.equal(f.calls.armCancellations, 1);
    assert.equal(f.calls.native.length, 0);
    await pending;
  }
});
test("stock alarm uses only local status while armed", async () => {
  const f = harness({ run: { trigger: { status: "armed" }, state: { status: "WAITING_FOR_STOCK" } } });
  f.calls.alarm({ name: "checkout-stock-status" });
  await f.handle({ type: "get-backend-state" }); // queue barrier
  assert.deepEqual(f.calls.native, ["status", "status"]);
  assert.equal(f.calls.queries.length, 0);
});
test("stock alarm does not request status when no purchase is armed", async () => {
  const f = harness();
  f.calls.alarm({ name: "checkout-stock-status" });
  await f.handle({ type: "get-backend-state" });
  assert.deepEqual(f.calls.native, ["status"]);
});

test("checkout stop raises its controller fence even while storage access setup is pending", async () => {
  const gate = deferred();
  const f = harness({ accessReady: gate.promise });
  const pending = f.handle({ type: "checkout-stop" });
  assert.deepEqual(f.calls.checkout, ["checkout-stop"]);
  gate.resolve();
  assert.equal((await pending).ok, true);
});

test('upgrading records the actual previous version and marks the icon without starting a purchase', async () => {
  const f = harness();
  f.calls.installed({ reason: 'update', previousVersion: '1.4.1' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.saved[0].updateInstallEvent.previousVersion, '1.4.1');
  assert.equal(f.calls.saved[0].updateInstallEvent.version, '1.5.0');
  assert.deepEqual(f.calls.badges, ['新']);
  assert.deepEqual(f.calls.checkout, []);
  assert.deepEqual(f.calls.native, []);
  assert.deepEqual(f.calls.opened, []);
});

test('same-version reload preserves the earlier upgrade notice and does not reflag it', async () => {
  const f = harness();
  f.calls.installed({ reason: 'update', previousVersion: '1.5.0' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls.saved, []);
  assert.deepEqual(f.calls.badges, []);
});

test('downgrading clears a stale new-version badge', async () => {
  const f = harness();
  f.calls.installed({ reason: 'update', previousVersion: '1.6.0' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls.badges, ['']);
  assert.deepEqual(f.calls.checkout, []);
  assert.deepEqual(f.calls.native, []);
});

test('first install opens the dashboard but does not invent an upgrade or invoke native actions', async () => {
  const f = harness();
  f.calls.installed({ reason: 'install' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.saved[0].updateInstallEvent.reason, 'install');
  assert.equal(f.calls.saved[0].updateInstallEvent.previousVersion, '');
  assert.deepEqual(f.calls.badges, []);
  assert.equal(f.calls.opened[0].url, 'chrome-extension://fixture/app.html');
  assert.deepEqual(f.calls.native, []);
});
