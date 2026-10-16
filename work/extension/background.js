import { productPurchaseURL } from "./shared.js";
import { normalizeNotificationSettings } from "./notifications.js";
import { createNativeClient, redactText } from "./native-client.js";
import { createCheckoutController } from "./checkout-controller.js";
import { createInventoryPageClient } from "./inventory-page-client.js";

const DASHBOARD_URL = chrome.runtime.getURL("app.html");
const nativeRequest = createNativeClient(chrome.runtime);
const checkoutController = createCheckoutController(chrome);
const inventoryPageClient = createInventoryPageClient(chrome);
const storageReady = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
let requestQueue = Promise.resolve();
let inventoryGeneration = 0;

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") openDashboard().catch(() => {});
});
chrome.action.onClicked.addListener(() => openDashboard().catch(() => {}));

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'checkout:changed') {
    checkoutController.pageChanged(message, sender).then(ok => sendResponse({ ok })).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (sender.id !== chrome.runtime.id || sender.url !== DASHBOARD_URL || (sender.frameId != null && sender.frameId !== 0)) {
    sendResponse({ ok: false, error: "此操作仅允许扩展控制台执行" });
    return false;
  }
  handleMessage(message)
    .then(sendResponse)
    .catch(() => sendResponse({ ok: false, error: "操作失败，请重新连接后台后重试" }));
  return true;
});

async function handleMessage(message) {
  if (["stop-monitor", "save-tasks", "checkout-start"].includes(message?.type)) {
    inventoryGeneration++;
    await storageReady;
    await inventoryPageClient.cancel();
  }
  if (message?.type === "check-inventory-page") {
    const generation = inventoryGeneration;
    await storageReady;
    const saved = await chrome.storage.local.get("tasks");
    if (generation !== inventoryGeneration) return { ok: false, error: "官网库存查询已取消" };
    const task = (saved.tasks || []).find((candidate) => candidate.id === message.taskId);
    if (!task) return { ok: false, error: "监控任务已移除，请刷新控制面板" };
    validateTasks([task]);
    return inventoryPageClient.query(task);
  }
  if (message?.type?.startsWith('checkout-')) {
    await storageReady;
    try { return await checkoutController.handle(message); }
    catch (error) { return { ok: false, error: redactText(error.message) || '购买操作失败' }; }
  }
  if (message?.type === "open-dashboard") {
    await openDashboard();
    return { ok: true };
  }
  if (message?.type === "open-product") {
    validateTasks([message.task]);
    await chrome.tabs.create({ url: productPurchaseURL(message.task), active: true });
    return { ok: true };
  }
  // Serialize status and mutations so an older status cannot overwrite a later command.
  const pending = requestQueue.then(() => bridgeMessage(message));
  requestQueue = pending.catch(() => {});
  return pending;
}

async function bridgeMessage(message) {
  await storageReady;
  let request;
  try {
    switch (message?.type) {
      case "get-backend-state": request = { action: "status" }; break;
      case "start-monitor":
        validateTasks(message.tasks);
        if (!message.tasks.length) throw new Error("请先添加至少一个监控任务");
        request = { action: "start", tasks: message.tasks, notificationSettings: normalizeNotificationSettings(message.notificationSettings) };
        break;
      case "stop-monitor": request = { action: "stop" }; break;
      case "check-now": request = { action: "check" }; break;
      case "save-settings":
        request = { action: "sync", notificationSettings: normalizeNotificationSettings(message.notificationSettings) };
        break;
      case "save-tasks":
        validateTasks(message.tasks);
        request = { action: "sync", tasks: message.tasks };
        break;
      default: return { ok: false, error: "未知操作" };
    }
  } catch (error) {
    return { ok: false, error: redactText(error.message, message?.notificationSettings) };
  }

  const saved = await chrome.storage.local.get(["notificationSettings"]);
  const safeError = (value) => redactText(redactText(value, saved.notificationSettings), request.notificationSettings);
  try {
    const response = await nativeRequest(request);
    if (response.ok !== true) {
      // Native bridge and Java service report failures without fabricating a paused state.
      const error = safeError(response.error) || "后台未接受操作，请重新连接后重试";
      const connection = { connected: false, error, checkedAt: new Date().toISOString() };
      await chrome.storage.local.set({ backendConnection: connection });
      return { ok: false, connected: false, error };
    }
    const snapshot = validateSnapshot(response, saved.notificationSettings);
    const connection = { connected: true, error: "", checkedAt: new Date().toISOString() };
    await chrome.storage.local.set({ ...snapshot, backendConnection: connection });
    return { ok: true, connected: true, ...snapshot };
  } catch (error) {
    const detail = safeError(error.message) || "后台未连接，请重新连接";
    await chrome.storage.local.set({ backendConnection: { connected: false, error: detail, checkedAt: new Date().toISOString() } });
    return { ok: false, connected: false, error: detail };
  }
}

function validateTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length > 100) throw new Error("监控任务信息无效");
  const ids = new Set();
  for (const task of tasks) {
    if (!task || typeof task.id !== "string" || !task.id || ["__proto__", "constructor", "prototype"].includes(task.id) ||
        !task.store?.StoreNumber || !task.product?.Code || ids.has(task.id)) throw new Error("监控任务信息无效或重复");
    ids.add(task.id);
    try { productPurchaseURL(task); } catch { throw new Error("监控任务的地区或商品信息无效"); }
  }
}

function validateSnapshot(response, previousSettings) {
  if (typeof response.monitoring !== "boolean" || !response.monitorState ||
      typeof response.monitorState !== "object" || Array.isArray(response.monitorState) ||
      typeof response.monitorState.running !== "boolean" || typeof response.monitorState.checking !== "boolean" ||
      response.monitorState.running !== response.monitoring || !Array.isArray(response.monitorState.log) ||
      !response.monitorState.items || typeof response.monitorState.items !== "object" || Array.isArray(response.monitorState.items)) {
    throw new Error("后台状态格式无效，请重新连接");
  }
  validateTasks(response.tasks);
  if (!response.notificationSettings || typeof response.notificationSettings !== "object" || Array.isArray(response.notificationSettings)) {
    throw new Error("后台设置格式无效，请重新连接");
  }
  const settings = normalizeNotificationSettings(response.notificationSettings);
  const clean = (value) => redactText(redactText(value, previousSettings), settings);
  const items = {};
  for (const task of response.tasks) {
    const item = response.monitorState.items[task.id];
    if (item && typeof item === "object") {
      items[task.id] = { status: clean(item.status), detail: clean(item.detail), checkedAt: clean(item.checkedAt) };
    }
  }
  return {
    tasks: response.tasks,
    notificationSettings: settings,
    monitoring: response.monitoring,
    monitorState: {
      running: response.monitoring,
      checking: response.monitorState.checking,
      lastCheck: clean(response.monitorState.lastCheck),
      retryAt: Number.isFinite(Date.parse(response.monitorState.retryAt)) ? clean(response.monitorState.retryAt) : "",
      items,
      log: response.monitorState.log.slice(-80).map((entry) => ({ time: clean(entry?.time), message: clean(entry?.message) }))
    }
  };
}

async function openDashboard() {
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((tab) => tab.url === DASHBOARD_URL);
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId) await chrome.windows.update(existing.windowId, { focused: true });
  } else await chrome.tabs.create({ url: DASHBOARD_URL });
}
