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

function harness() {
  const readingTasks = deferred();
  const tasksReply = deferred();
  const calls = { queries: [], cancellations: 0, native: [], checkout: [] };
  const chrome = {
    runtime: {
      getURL: (path) => "chrome-extension://fixture/" + path,
      onInstalled: { addListener() {} },
      onMessage: { addListener() {} }
    },
    action: { onClicked: { addListener() {} } },
    storage: { local: {
      async setAccessLevel() {},
      async get(keys) {
        if (keys === "tasks") {
          readingTasks.resolve();
          return tasksReply.promise;
        }
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
      async handle(message) { calls.checkout.push(message.type); return { ok: true }; }
    }),
    createNativeClient: () => async (request) => {
      calls.native.push(request.action);
      return {
        ok: true, tasks: [TASK], notificationSettings: SETTINGS, monitoring: false,
        monitorState: { running: false, checking: false, items: {}, log: [], lastCheck: "" }
      };
    }
  };
  // Exercise the actual background routing; only its external collaborators are stubs.
  const source = backgroundSource.replace(/^import .*;\r?\n/gm, "") + "\nglobalThis.handle = handleMessage;";
  vm.runInNewContext(source, context, { filename: "background.js" });
  return { handle: context.handle, readingTasks, tasksReply, calls };
}

for (const type of ["stop-monitor", "checkout-start", "save-tasks"]) {
  test(`${type} blocks an older inventory query awaiting saved tasks`, async () => {
    const f = harness();
    const pending = f.handle({ type: "check-inventory-page", taskId: TASK.id });
    await f.readingTasks.promise;
    const command = await f.handle({ type, ...(type === "save-tasks" ? { tasks: [TASK] } : {}) });
    assert.equal(command.ok, true);
    assert.equal(f.calls.cancellations, 1);
    assert.deepEqual(type === "checkout-start" ? f.calls.checkout : f.calls.native,
      [type === "checkout-start" ? type : type === "stop-monitor" ? "stop" : "sync"]);

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
