import { buildFulfillmentPath, parseStockResponse } from "./shared.js";
import { redactText } from "./native-client.js";

const STOPPED = Symbol("inventory query stopped");
const RETRY_KEY = "inventoryPageRetryAt";
const RESULT_KEY = "inventoryPageResults";

function normalizeTask(task) {
  if (!task || Array.isArray(task) || task.areaCode !== "cn" ||
      typeof task.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(task.id) ||
      ["__proto__", "constructor", "prototype"].includes(task.id) ||
      typeof task.store?.StoreNumber !== "string" || !/^R\d{3}$/.test(task.store.StoreNumber) ||
      typeof task.product?.Code !== "string" || !/^[A-Z0-9]{5,12}\/[A-Z]$/.test(task.product.Code)) {
    throw new Error("官网查询仅支持一个有效的中国大陆监控任务");
  }
  return { id: task.id, areaCode: "cn", store: {
    StoreNumber: task.store.StoreNumber, District: String(task.store.District || "")
  }, product: { Code: task.product.Code } };
}

function identity(task) {
  return `${task.areaCode}:${task.store.StoreNumber}:${task.product.Code}`;
}

function sameStoredTask(tasks, task) {
  const matches = Array.isArray(tasks) ? tasks.filter((item) => item?.id === task.id) : [];
  if (matches.length !== 1) return false;
  try { return identity(normalizeTask(matches[0])) === identity(task); }
  catch { return false; }
}

function productTab(tab) {
  try {
    const url = new URL(tab.url);
    const path = decodeURIComponent(url.pathname);
    return Number.isInteger(tab.id) && tab.id >= 0 &&
      url.origin === "https://www.apple.com.cn" && !url.username && !url.password &&
      /^\/shop\/(?:buy-iphone|buy-watch|product)\/[^/]+/.test(path) &&
      !/(?:^|\/)(?:secure|bag|checkout|signin|account|orders?)(?:\/|$)/i.test(path) &&
      (!tab.pendingUrl || tab.pendingUrl === tab.url);
  } catch { return false; }
}

function retryDeadline(response, time) {
  const candidates = [time + 60000];
  if (typeof response.retryAfter === "number" || /^\d+(?:\.\d+)?$/.test(String(response.retryAfter || ""))) {
    const seconds = Number(response.retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) candidates.push(time + seconds * 1000);
  } else if (typeof response.retryAfter === "string") candidates.push(Date.parse(response.retryAfter));
  if (typeof response.retryAt === "number") candidates.push(response.retryAt);
  else if (typeof response.retryAt === "string") candidates.push(Date.parse(response.retryAt));
  return Math.max(...candidates.filter((value) => Number.isFinite(value) && value < 8640000000000000));
}

export function createInventoryPageClient(chrome, { now = Date.now } = {}) {
  let active = null;
  let writes = Promise.resolve();
  const ensureActive = (run) => { if (run.stopped) throw STOPPED; };
  const safeError = (run, error) => redactText(error, run.settings) || "官网库存查询失败";
  const unknown = (run, detail, pending = false) => ({
    identity: identity(run.task), known: false, available: null, status: "库存未知",
    detail: safeError(run, detail), checkedAt: pending ? "" : new Date(now()).toISOString()
  });

  function save(run, result, extra = {}, stopped = false) {
    const pending = writes.then(async () => {
      if (!stopped) ensureActive(run);
      const saved = await chrome.storage.local.get(["tasks", RESULT_KEY]);
      if (!stopped) ensureActive(run);
      if (!sameStoredTask(saved.tasks, run.task)) return false;
      const previous = saved[RESULT_KEY];
      const results = previous && typeof previous === "object" && !Array.isArray(previous) ? previous : {};
      await chrome.storage.local.set({ [RESULT_KEY]: { ...results, [run.task.id]: result }, ...extra });
      return true;
    });
    writes = pending.catch(() => {});
    return pending;
  }

  async function stop(run, reason) {
    if (!run) return;
    if (run.stopping) return run.stopping;
    run.stopped = true;
    clearTimeout(run.timer);
    if (run.tabId != null && run.requestId) {
      try {
        Promise.resolve(chrome.tabs.sendMessage(run.tabId, {
          type: "inventory:cancel", requestId: run.requestId
        }, { frameId: 0 })).catch(() => {});
      } catch { /* A closed or navigated tab must not delay cancellation. */ }
    }
    run.stopping = (async () => {
      const result = unknown(run, reason);
      try {
        if (run.validated) await save(run, result, {}, true);
      } finally {
        run.resolveStop({ ok: false, error: reason, ...(run.validated ? { result } : {}) });
        if (active === run) active = null;
      }
    })();
    return run.stopping;
  }

  async function execute(run) {
    try {
      const saved = await chrome.storage.local.get(["tasks", RETRY_KEY, "notificationSettings"]);
      ensureActive(run);
      run.settings = saved.notificationSettings || {};
      if (!sameStoredTask(saved.tasks, run.task)) throw new Error("监控任务已更改或移除，请重新选择任务");
      run.validated = true;
      if (!await save(run, unknown(run, "正在查询当前官网商品页", true))) throw new Error("监控任务已更改或移除");
      ensureActive(run);
      const retryAt = typeof saved[RETRY_KEY] === "number" ? saved[RETRY_KEY] : Date.parse(saved[RETRY_KEY]);
      if (retryAt > now()) throw new Error("Apple 库存接口正在等待重试，请在冷却结束后再查询");
      const tabs = await chrome.tabs.query({ url: "https://www.apple.com.cn/shop/*" });
      ensureActive(run);
      const tab = tabs.find(productTab);
      if (!tab) throw new Error("请先打开一个 Apple 中国大陆官网商品页，再点官网查询");
      run.tabId = tab.id;
      run.requestId = crypto.randomUUID();
      let response;
      try {
        response = await chrome.tabs.sendMessage(tab.id, {
          type: "inventory:query", requestId: run.requestId, requestPath: buildFulfillmentPath([run.task]),
          targetStore: run.task.store.StoreNumber
        }, { frameId: 0 });
      } catch {
        ensureActive(run);
        throw new Error("无法连接官网商品页，请刷新该商品页后重试");
      }
      ensureActive(run);
      const [currentTab, current] = await Promise.all([
        chrome.tabs.get(tab.id), chrome.storage.local.get(["tasks"])
      ]);
      ensureActive(run);
      if (!productTab(currentTab) || currentTab.url !== tab.url || currentTab.id !== tab.id) {
        throw new Error("官网页面已切换，本次库存结果已丢弃");
      }
      if (!sameStoredTask(current.tasks, run.task)) throw new Error("监控任务已更改或移除，本次结果已丢弃");
      if (!response || typeof response !== "object" || Array.isArray(response) || typeof response.ok !== "boolean") {
        throw new Error("官网商品页未返回有效库存结果，请刷新商品页后重试");
      }
      const status = Number(response.status);
      if ([429, 503].includes(status)) {
        const detail = safeError(run, response.error) + `（HTTP ${status}，等待重试）`;
        const result = unknown(run, detail);
        const retry = new Date(retryDeadline(response, now())).toISOString();
        if (!await save(run, result, { [RETRY_KEY]: retry })) throw new Error("监控任务已更改或移除");
        ensureActive(run);
        return { ok: false, result, error: detail };
      }
      if (!response.ok || (response.status != null && (!Number.isInteger(status) || status < 200 || status > 299))) {
        throw new Error(safeError(run, response.error));
      }
      const parsed = parseStockResponse(response.payload, run.task.store.StoreNumber, run.task.product.Code);
      const result = {
        identity: identity(run.task), known: parsed.known, available: parsed.known ? parsed.available : null,
        status: parsed.known ? (parsed.available ? "有货" : "无货") : "库存未知",
        detail: parsed.known ? "官网商品页查询：已匹配所选门店和 SKU" : "官网未返回所选门店和 SKU 的明确库存状态",
        checkedAt: new Date(now()).toISOString()
      };
      if (!await save(run, result)) throw new Error("监控任务已更改或移除，本次结果已丢弃");
      ensureActive(run);
      return { ok: true, result };
    } catch (error) {
      if (error === STOPPED || run.stopped) return run.stopResult;
      const detail = safeError(run, error?.message);
      const result = unknown(run, detail);
      if (run.validated) {
        try { await save(run, result); }
        catch { if (run.stopped) return run.stopResult; }
      }
      return { ok: false, error: detail, ...(run.validated ? { result } : {}) };
    }
  }

  async function query(task) {
    let normalized;
    try { normalized = normalizeTask(task); }
    catch (error) { return { ok: false, error: redactText(error.message) }; }
    if (active) return { ok: false, error: "已有官网库存查询正在进行，请等待完成" };
    const run = { task: normalized, settings: {}, stopped: false, validated: false };
    run.stopResult = new Promise((resolve) => { run.resolveStop = resolve; });
    active = run;
    run.timer = setTimeout(() => { stop(run, "官网库存查询超时，请稍后重试").catch(() => {}); }, 15000);
    try { return await Promise.race([execute(run), run.stopResult]); }
    finally {
      clearTimeout(run.timer);
      if (active === run && !run.stopped) active = null;
    }
  }

  return { query, cancel: () => stop(active, "官网库存查询已取消") };
}
