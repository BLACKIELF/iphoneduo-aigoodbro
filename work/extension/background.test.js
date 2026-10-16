import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

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
  const calls = { queries: [], cancellations: 0, native: [], checkout: [], stock: [], armCancellations: 0 };
  const chrome = {
    runtime: {
      getURL: (path) => "chrome-extension://fixture/" + path,
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: { addListener() {} }
    },
    alarms: { async get() {}, async create() {}, async clear() {}, onAlarm: { addListener(fn) { calls.alarm = fn; } } },
    action: { onClicked: { addListener() {} } },
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
      async set() {}
    } }
  };
  const context = {
    chrome,
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
