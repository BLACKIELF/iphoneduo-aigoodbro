import { AREAS, groupProductsByModel, unique } from "./shared.js";

const elements = {
  area: document.querySelector("#area"),
  fulfillment: document.querySelector("#fulfillment"),
  provinceField: document.querySelector("#province-field"),
  storeField: document.querySelector("#store-field"),
  province: document.querySelector("#province"),
  store: document.querySelector("#store"),
  model: document.querySelector("#model"),
  capacity: document.querySelector("#capacity"),
  color: document.querySelector("#color"),
  bark: document.querySelector("#bark"),
  feishuWebhook: document.querySelector("#feishu-webhook"),
  feishuSecret: document.querySelector("#feishu-secret"),
  interval: document.querySelector("#interval"),
  saveSettings: document.querySelector("#save-settings"),
  settingsMessage: document.querySelector("#settings-message"),
  add: document.querySelector("#add"),
  start: document.querySelector("#start"),
  stop: document.querySelector("#stop"),
  check: document.querySelector("#check"),
  tasks: document.querySelector("#tasks"),
  emptyTasks: document.querySelector("#empty-tasks"),
  monitorBadge: document.querySelector("#monitor-badge"),
  lastCheck: document.querySelector("#last-check"),
  logs: document.querySelector("#logs"),
  formMessage: document.querySelector("#form-message"),
  backendMessage: document.querySelector("#backend-message"),
  reconnect: document.querySelector("#reconnect"),
  alarmBanner: document.querySelector("#alarm-banner"),
  alarmBannerTitle: document.querySelector("#alarm-banner-title"),
  alarmBannerDesc: document.querySelector("#alarm-banner-desc"),
  stopAlarmBtn: document.querySelector("#stop-alarm-btn"),
  soundAlert: document.querySelector("#sound-alert"),
  testSound: document.querySelector("#test-sound"),
  soundStatus: document.querySelector("#sound-status")
};

let productsByModel = {};
let stores = [];
let tasks = [];
let monitorState = null;
let monitoring = false;
let backendConnected = false;
let backendError = "正在读取后台状态…";
let operationPending = false;
let settingsDirty = false;
let refreshInFlight = null;
let refreshTimer;
let inventoryPageResults = {};
let inventoryQueryPending = false;
let audioCtx = null;
let alarmInterval = null;
let isRinging = false;
const notifiedInStockTasks = new Set();

function getAudioContext() {
  if (!audioCtx && (window.AudioContext || window.webkitAudioContext)) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AudioContextClass();
  }
  if (audioCtx && audioCtx.state === "suspended") {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

function playAlarmTone(freq, durationMs, startTimeOffset = 0) {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    const start = ctx.currentTime + startTimeOffset;
    const end = start + durationMs / 1000;
    osc.frequency.setValueAtTime(freq, start);
    gain.gain.setValueAtTime(0.001, start);
    gain.gain.exponentialRampToValueAtTime(0.35, start + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.001, end);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(end);
  } catch {}
}

function playChimeSequence() {
  playAlarmTone(1046.5, 180, 0);
  playAlarmTone(1318.5, 180, 0.12);
  playAlarmTone(1567.98, 400, 0.24);
}

function startContinuousAlarm(message = "发现库存！", detail = "") {
  if (elements.alarmBanner) {
    elements.alarmBanner.hidden = false;
    if (elements.alarmBannerTitle) elements.alarmBannerTitle.textContent = message;
    if (elements.alarmBannerDesc && detail) elements.alarmBannerDesc.textContent = detail;
  }
  if (isRinging) return;
  isRinging = true;
  getAudioContext();
  playChimeSequence();
  if (alarmInterval) clearInterval(alarmInterval);
  alarmInterval = setInterval(() => {
    playChimeSequence();
  }, 1000);
}

function stopContinuousAlarm() {
  isRinging = false;
  if (alarmInterval) {
    clearInterval(alarmInterval);
    alarmInterval = null;
  }
  if (elements.alarmBanner) {
    elements.alarmBanner.hidden = true;
  }
}

function unlockAudio() {
  getAudioContext();
}

try {
  await initialize();
} catch (error) {
  setFormMessage("载入失败：" + error.message, true);
}

function updateFulfillmentUI() {
  const isDelivery = elements.fulfillment && elements.fulfillment.value === "delivery";
  if (elements.provinceField) elements.provinceField.hidden = isDelivery;
  if (elements.storeField) elements.storeField.hidden = isDelivery;
  const checkoutFulfillment = document.querySelector("#checkout-fulfillment");
  if (checkoutFulfillment && checkoutFulfillment.value !== elements.fulfillment.value) {
    checkoutFulfillment.value = elements.fulfillment.value;
    checkoutFulfillment.dispatchEvent(new Event("change"));
  }
}

async function initialize() {
  fillSelect(elements.area, AREAS.map((area) => ({ value: area.code, label: area.title })));
  const saved = await chrome.storage.local.get([
    "tasks",
    "barkUrl",
    "notificationSettings",
    "monitorState",
    "monitoring",
    "uiSelection",
    "inventoryPageResults"
  ]);
  tasks = Array.isArray(saved.tasks) ? saved.tasks : [];
  monitorState = saved.monitorState || null;
  monitoring = Boolean(saved.monitoring);
  inventoryPageResults = saved.inventoryPageResults || {};
  populateSettings(saved.notificationSettings || { barkUrl: saved.barkUrl || "" });
  elements.area.value = saved.uiSelection?.areaCode || "cn";
  if (elements.fulfillment && saved.uiSelection?.fulfillment) {
    elements.fulfillment.value = saved.uiSelection.fulfillment;
  }
  updateFulfillmentUI();
  bindEvents();
  render();
  await Promise.all([loadAreaData(saved.uiSelection || {}), refreshBackend()]);
  render();
}

function bindEvents() {
  if (elements.fulfillment) {
    elements.fulfillment.addEventListener("change", () => {
      updateFulfillmentUI();
      saveSelection();
    });
  }
  elements.area.addEventListener("change", async () => {
    await loadAreaData({});
    await saveSelection();
  });
  elements.province.addEventListener("change", () => {
    populateStores();
    saveSelection();
  });
  elements.store.addEventListener("change", saveSelection);
  elements.model.addEventListener("change", () => {
    populateCapacities();
    saveSelection();
  });
  elements.capacity.addEventListener("change", () => {
    populateColors();
    saveSelection();
  });
  elements.color.addEventListener("change", saveSelection);
  elements.saveSettings.addEventListener("click", saveSettings);
  for (const field of [elements.bark, elements.feishuWebhook, elements.feishuSecret, elements.interval]) {
    field.addEventListener("input", () => { settingsDirty = true; elements.settingsMessage.textContent = "设置有改动，保存后生效"; });
  }
  if (elements.soundAlert) {
    elements.soundAlert.addEventListener("change", () => {
      settingsDirty = true;
      elements.settingsMessage.textContent = "设置有改动，保存后生效";
    });
  }
  if (elements.testSound) {
    elements.testSound.addEventListener("click", () => {
      unlockAudio();
      playChimeSequence();
      if (elements.soundStatus) {
        elements.soundStatus.textContent = "已播放测试铃声";
        setTimeout(() => {
          if (elements.soundStatus && elements.soundStatus.textContent === "已播放测试铃声") {
            elements.soundStatus.textContent = "";
          }
        }, 3000);
      }
    });
  }
  if (elements.stopAlarmBtn) {
    elements.stopAlarmBtn.addEventListener("click", () => {
      stopContinuousAlarm();
    });
  }
  window.addEventListener("click", unlockAudio, { passive: true });
  window.addEventListener("keydown", unlockAudio, { passive: true });
  elements.add.addEventListener("click", addTask);
  elements.start.addEventListener("click", startMonitoring);
  elements.stop.addEventListener("click", stopMonitoring);
  elements.check.addEventListener("click", checkNow);
  elements.reconnect.addEventListener("click", () => refreshBackend());
  document.addEventListener("visibilitychange", () => {
    clearTimeout(refreshTimer);
    if (!document.hidden) refreshBackend();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") {
      return;
    }
    if (changes.tasks) {
      tasks = Array.isArray(changes.tasks.newValue) ? changes.tasks.newValue : [];
    }
    if (changes.monitorState) {
      monitorState = changes.monitorState.newValue || null;
    }
    if (changes.monitoring) {
      monitoring = Boolean(changes.monitoring.newValue);
    }
    if (changes.inventoryPageResults) inventoryPageResults = changes.inventoryPageResults.newValue || {};
    if (changes.notificationSettings && !settingsDirty) populateSettings(changes.notificationSettings.newValue);
    if (changes.backendConnection) {
      backendConnected = changes.backendConnection.newValue?.connected === true;
      backendError = changes.backendConnection.newValue?.error || "";
    }
    if (changes.monitorState || changes.tasks) {
      const currentTasks = changes.tasks ? (Array.isArray(changes.tasks.newValue) ? changes.tasks.newValue : []) : tasks;
      const currentState = changes.monitorState ? changes.monitorState.newValue : monitorState;
      checkForStockAlert(currentTasks, currentState, readSettings());
    }
    render();
  });
}

async function loadAreaData(selection) {
  const areaCode = elements.area.value;
  setFormMessage("正在载入产品和门店…", false);
  const productURL = chrome.runtime.getURL("data/products/product_data_" + areaCode + ".json");
  const storeURL = chrome.runtime.getURL("data/stores/store_" + areaCode + ".json");
  const [productResponse, storeResponse] = await Promise.all([fetch(productURL), fetch(storeURL)]);
  if (!productResponse.ok || !storeResponse.ok) {
    throw new Error("当前地区的内置数据载入失败");
  }
  const productData = await productResponse.json();
  const storeData = await storeResponse.json();
  productsByModel = groupProductsByModel(productData.products);
  stores = Array.isArray(storeData.stores) ? storeData.stores : [];

  populateProvinces(selection.province);
  populateModels(selection.model || "iPhone Duo");
  if (selection.storeNumber) {
    elements.store.value = selection.storeNumber;
  }
  if (selection.capacity) {
    elements.capacity.value = selection.capacity;
    populateColors(selection.color);
  }
  setFormMessage("", false);
}

function populateProvinces(preferredValue) {
  const provinces = unique(stores.map((store) => store.Province || store.City || "全部"))
    .sort((a, b) => a.localeCompare(b, "zh-CN"));
  fillSelect(elements.province, provinces.map((value) => ({ value, label: value })));
  if (preferredValue && provinces.includes(preferredValue)) {
    elements.province.value = preferredValue;
  }
  populateStores();
}

function populateStores() {
  const province = elements.province.value;
  const filtered = stores
    .filter((store) => (store.Province || store.City || "全部") === province)
    .sort((a, b) => a.CityStoreName.localeCompare(b.CityStoreName, "zh-CN"));
  fillSelect(elements.store, filtered.map((store) => ({
    value: store.StoreNumber,
    label: store.CityStoreName
  })));
}

function populateModels(preferredValue) {
  const models = Object.keys(productsByModel);
  fillSelect(elements.model, models.map((value) => ({ value, label: value })));
  if (preferredValue && models.includes(preferredValue)) {
    elements.model.value = preferredValue;
  }
  populateCapacities();
}

function populateCapacities() {
  const products = productsByModel[elements.model.value] || [];
  const capacities = unique(products.map((product) => product.Capacity));
  fillSelect(elements.capacity, capacities.map((value) => ({ value, label: value })));
  populateColors();
}

function populateColors(preferredValue) {
  const products = productsByModel[elements.model.value] || [];
  const colors = unique(products
    .filter((product) => product.Capacity === elements.capacity.value)
    .map((product) => product.Color));
  fillSelect(elements.color, colors.map((value) => ({ value, label: value })));
  if (preferredValue && colors.includes(preferredValue)) {
    elements.color.value = preferredValue;
  }
}

function fillSelect(select, options) {
  select.replaceChildren();
  for (const optionData of options) {
    const option = document.createElement("option");
    option.value = optionData.value;
    option.textContent = optionData.label;
    select.append(option);
  }
  select.disabled = options.length === 0;
}

async function saveSelection() {
  await chrome.storage.local.set({
    uiSelection: {
      areaCode: elements.area.value,
      fulfillment: elements.fulfillment?.value || "pickup",
      province: elements.province.value,
      storeNumber: elements.store.value,
      model: elements.model.value,
      capacity: elements.capacity.value,
      color: elements.color.value
    }
  });
}

async function addTask() {
  const fulfillment = elements.fulfillment?.value || "pickup";
  const area = AREAS.find((candidate) => candidate.code === elements.area.value);
  const store = fulfillment === "delivery"
    ? (stores.find((candidate) => candidate.StoreNumber === elements.store.value) || stores[0])
    : stores.find((candidate) => candidate.StoreNumber === elements.store.value);
  const product = (productsByModel[elements.model.value] || []).find((candidate) =>
    candidate.Capacity === elements.capacity.value && candidate.Color === elements.color.value
  );
  if (!area || !store || !product) {
    setFormMessage(fulfillment === "delivery" ? "请完整选择地区和商品。" : "请完整选择地区、门店和商品。", true);
    return;
  }

  const duplicate = tasks.some((task) =>
    task.areaCode === area.code &&
    (task.fulfillment || "pickup") === fulfillment &&
    task.store.StoreNumber === store.StoreNumber &&
    task.product.Code === product.Code
  );
  if (duplicate) {
    setFormMessage("这个商品配置已经在监控列表中。", true);
    return;
  }

  const task = {
    id: crypto.randomUUID(),
    areaCode: area.code,
    areaTitle: area.title,
    fulfillment,
    store: structuredClone(store),
    product: structuredClone(product)
  };
  const result = await sendBackendCommand({ type: "save-tasks", tasks: [...tasks, task] });
  if (!result?.ok) { setFormMessage(result?.error || "添加失败", true); return; }
  await saveSelection();
  setFormMessage("已保存到 Java 后台监控列表。", false);
}

async function startMonitoring() {
  unlockAudio();
  if (tasks.length === 0) {
    setFormMessage("请先添加至少一个监控任务。", true);
    return;
  }
  setFormMessage("正在启动 Java 后台监控…", false);
  const result = await sendBackendCommand({ type: "start-monitor", tasks, notificationSettings: readSettings() });
  if (!result?.ok) { setFormMessage(result?.error || "启动监控失败", true); return; }
  settingsDirty = false;
  populateSettings(result.notificationSettings);
  elements.settingsMessage.textContent = "已保存到 Java 后台";
  setFormMessage("Java 后台监控已启动；关闭 Chrome 后仍会继续。", false);
}

async function stopMonitoring() {
  stopContinuousAlarm();
  const result = await sendBackendCommand({ type: "stop-monitor" });
  setFormMessage(result?.ok ? "Java 后台监控已暂停。" : result?.error || "暂停失败", !result?.ok);
}

async function checkNow() {
  setFormMessage("正在请求后台检查库存…", false);
  const result = await sendBackendCommand({ type: "check-now" });
  const retryAt = result?.monitorState?.retryAt;
  setFormMessage(result?.ok ? (Date.parse(retryAt) > Date.now()
    ? "Apple 库存接口暂不可用，最早可在 " + formatTime(retryAt) + " 重试。"
    : "已请求检查，请查看后台状态与日志。") : result?.error || "检查失败", !result?.ok);
}

async function removeTask(taskId) {
  const result = await sendBackendCommand({ type: "save-tasks", tasks: tasks.filter((task) => task.id !== taskId) });
  setFormMessage(result?.ok ? "已从 Java 后台移除。" : result?.error || "移除失败", !result?.ok);
}

async function openProduct(task) {
  const result = await chrome.runtime.sendMessage({ type: "open-product", task });
  if (!result?.ok) {
    setFormMessage(result?.error || "无法打开商品页", true);
  }
}

async function directToOrder(task) {
  if (operationPending) return;
  setFormMessage(`正在为「${task.product.Model} · ${task.product.Color}」启动直达下单…`, false);
  try {
    const budgets = { cn: 30000, hk: 35000, jp: 500000, us: 4000 };
    const maxTotal = budgets[task.areaCode] || 30000;
    const fulfillment = task.fulfillment || 'pickup';
    let pickup = undefined;
    if (fulfillment === 'pickup' && task.store) {
      const store = task.store;
      const address = store?.District || store?.City || store?.Province || "Store Area";
      const state = store?.Province || store?.City || "Region";
      const city = store?.City || store?.Province || "City";
      pickup = {
        storeNumber: store.StoreNumber,
        storeName: store.CityStoreName ? store.CityStoreName.split('-').slice(1).join('-').trim() || store.CityStoreName : (store.StoreName || ''),
        region: { state, city, address },
        slotPolicy: 'earliest'
      };
    }
    const intent = {
      product: task.product,
      areaCode: task.areaCode || 'cn',
      fulfillment,
      quantity: 1,
      maxTotal,
      entryMode: 'product',
      runMode: 'review',
      allowSubmit: false,
      acknowledgedTerms: true,
      ...(pickup ? { pickup } : {})
    };
    const result = await chrome.runtime.sendMessage({
      type: 'checkout-start',
      intent,
      allowReplaceVariant: true,
      newIntentAcknowledged: true
    });
    if (!result?.ok) throw new Error(result?.error || '无法启动直达下单');
    setFormMessage(`已启动「${task.product.Model}」直达下单，自动化正在运行，完成后将直达最终下单界面…`, false);
  } catch (error) {
    setFormMessage(`直达下单启动失败：${error.message}`, true);
  }
}

async function queryOfficialPage(task) {
  if (inventoryQueryPending) return;
  inventoryQueryPending = true;
  renderTasks();
  setFormMessage("正在使用已打开的官网商品页查询库存…", false);
  try {
    const result = await chrome.runtime.sendMessage({ type: "check-inventory-page", taskId: task.id });
    setFormMessage(result?.ok ? "官网页查询已完成，结果显示在对应任务下方。" : result?.error || "官网页查询失败", !result?.ok);
  } catch {
    setFormMessage("官网页连接已断开，请刷新官网商品页后重试。", true);
  } finally {
    inventoryQueryPending = false;
    renderTasks();
  }
}

function render() {
  renderTasks();
  renderMonitorState();
  renderLogs();
}

function renderTasks() {
  elements.tasks.replaceChildren();
  elements.emptyTasks.hidden = tasks.length > 0;
  for (const task of tasks) {
    const item = document.createElement("article");
    item.className = "task";

    const content = document.createElement("div");
    const title = document.createElement("h3");
    title.textContent = task.product.Model + " · " + task.product.Capacity;
    const meta = document.createElement("p");
    const fulfillmentLabel = task.fulfillment === "delivery"
      ? "【送货上门】"
      : `【自提 · ${task.store.CityStoreName}】`;
    meta.textContent = task.areaTitle + " · " + fulfillmentLabel + " · " + task.product.Color;
    const itemState = monitorState?.items?.[task.id];
    const status = document.createElement("span");
    status.className = "task-status " + statusClass(itemState?.status);
    status.textContent = "后台：" + (itemState?.status || "等待");
    if (itemState?.detail) {
      status.title = itemState.detail;
    }
    content.append(title, meta, status);
    if (["查询异常", "需官网验证", "暂不可自提"].includes(itemState?.status) && itemState.detail) {
      const detail = document.createElement("p");
      detail.className = "task-detail";
      detail.textContent = itemState.detail;
      content.append(detail);
    }
    const pageResult = inventoryPageResults[task.id];
    if (pageResult?.identity === [task.areaCode, task.store.StoreNumber, task.product.Code].join(":")) {
      const resultLine = document.createElement("p");
      resultLine.className = "task-detail";
      resultLine.textContent = "官网页：" + pageResult.status + (pageResult.detail ? " · " + pageResult.detail : "") +
        (pageResult.checkedAt ? " · " + formatTime(pageResult.checkedAt) : "");
      content.append(resultLine);
    }

    const actions = document.createElement("div");
    actions.className = "task-actions";
    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.textContent = "官网";
    openButton.addEventListener("click", () => openProduct(task));
    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.textContent = "移除";
    removeButton.disabled = !backendConnected || operationPending;
    removeButton.addEventListener("click", () => removeTask(task.id));
    actions.append(openButton, removeButton);
    if (["cn", "jp", "hk", "us"].includes(task.areaCode)) {
      const directOrderBtn = document.createElement("button");
      directOrderBtn.type = "button";
      directOrderBtn.textContent = "直达下单";
      directOrderBtn.title = "直接自动选配、加袋并前往该商品的门店自提下单界面";
      directOrderBtn.disabled = operationPending;
      directOrderBtn.addEventListener("click", () => directToOrder(task));
      actions.append(directOrderBtn);

      const pageCheck = document.createElement("button");
      pageCheck.type = "button";
      pageCheck.textContent = "官网页查库存";
      pageCheck.title = "仅使用已经打开的官网商品页查询一次；需要先在官网完成验证";
      pageCheck.disabled = inventoryQueryPending || operationPending;
      pageCheck.addEventListener("click", () => queryOfficialPage(task));
      actions.append(pageCheck);
    }

    item.append(content, actions);
    elements.tasks.append(item);
  }
}

function renderMonitorState() {
  const waitingRetry = Date.parse(monitorState?.retryAt) > Date.now();
  const queryFailed = Object.values(monitorState?.items || {}).some((item) => ["查询异常", "需官网验证"].includes(item?.status));
  elements.monitorBadge.className = "status-badge";
  if (!backendConnected) {
    elements.monitorBadge.classList.add("idle");
    elements.monitorBadge.textContent = "后台未连接";
  } else if (monitorState?.checking) {
    elements.monitorBadge.classList.add("checking");
    elements.monitorBadge.textContent = "检查中";
  } else if (!monitoring) {
    elements.monitorBadge.classList.add("idle");
    elements.monitorBadge.textContent = "已暂停";
  } else if (waitingRetry || queryFailed) {
    elements.monitorBadge.classList.add("error");
    elements.monitorBadge.textContent = waitingRetry ? "等待重试" : "库存查询异常";
  } else {
    elements.monitorBadge.classList.add("running");
    elements.monitorBadge.textContent = "监控中";
  }
  const disabled = !backendConnected || operationPending;
  elements.start.disabled = disabled || tasks.length === 0 || monitoring;
  elements.stop.disabled = disabled || !monitoring;
  elements.check.disabled = disabled || tasks.length === 0 || Boolean(monitorState?.checking) || waitingRetry;
  elements.check.title = waitingRetry ? "Apple 库存接口暂不可用，最早可在 " + formatTime(monitorState.retryAt) + " 重试" : "";
  elements.add.disabled = disabled;
  elements.saveSettings.disabled = disabled;
  for (const field of [elements.bark, elements.feishuWebhook, elements.feishuSecret, elements.interval]) field.disabled = operationPending;
  elements.reconnect.disabled = operationPending || Boolean(refreshInFlight);
  elements.backendMessage.textContent = backendConnected ? "已连接本机 Java 后台" :
    (backendError || "后台未连接，请重新连接") + "。下方为缓存，当前监控状态未知。";
  elements.backendMessage.style.color = backendConnected ? "var(--green)" : "var(--red)";
  elements.lastCheck.textContent = monitorState?.lastCheck
    ? "上次检查 " + formatTime(monitorState.lastCheck)
    : "尚未检查";
  if (waitingRetry) elements.lastCheck.textContent += (monitoring ? " · 下次重试 " : " · 最早可重试 ") + formatTime(monitorState.retryAt);
}

function renderLogs() {
  elements.logs.replaceChildren();
  const log = Array.isArray(monitorState?.log) ? [...monitorState.log].reverse() : [];
  if (log.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "启动监控后，这里会显示查询状态。";
    elements.logs.append(empty);
    return;
  }
  for (const entry of log) {
    const row = document.createElement("p");
    row.textContent = "[" + entry.time + "] " + entry.message;
    elements.logs.append(row);
  }
}

function statusClass(status) {
  if (status === "有货") {
    return "in-stock";
  }
  if (status === "需官网验证") {
    return "verify";
  }
  if (status === "查询异常") {
    return "error";
  }
  return "";
}

function setFormMessage(message, isError) {
  elements.formMessage.textContent = message;
  elements.formMessage.style.color = isError ? "var(--red)" : "var(--green)";
}

function formatTime(value) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function readSettings() {
  return {
    barkUrl: elements.bark.value.trim(),
    feishuWebhook: elements.feishuWebhook.value.trim(),
    feishuSecret: elements.feishuSecret.value.trim(),
    intervalSeconds: Number(elements.interval.value),
    soundAlert: elements.soundAlert ? elements.soundAlert.checked : true
  };
}

async function saveSettings() {
  const result = await sendBackendCommand({ type: "save-settings", notificationSettings: readSettings() });
  if (result?.ok) {
    settingsDirty = false;
    populateSettings(result.notificationSettings);
    elements.settingsMessage.textContent = "已保存到 Java 后台";
    elements.settingsMessage.style.color = "var(--green)";
  } else {
    elements.settingsMessage.textContent = result?.error || "设置保存失败";
    elements.settingsMessage.style.color = "var(--red)";
  }
}

function populateSettings(settings = {}) {
  elements.bark.value = settings.barkUrl || "";
  elements.feishuWebhook.value = settings.feishuWebhook || "";
  elements.feishuSecret.value = settings.feishuSecret || "";
  elements.interval.value = String(settings.intervalSeconds || 30);
  if (elements.soundAlert) {
    elements.soundAlert.checked = settings.soundAlert !== false;
  }
}

function checkForStockAlert(tasksList, state, settings) {
  if (!Array.isArray(tasksList) || !state?.items) return;
  const soundEnabled = settings?.soundAlert !== false;
  let newlyInStockTask = null;

  for (const task of tasksList) {
    const item = state.items[task.id];
    if (item?.available === true) {
      if (!notifiedInStockTasks.has(task.id)) {
        notifiedInStockTasks.add(task.id);
        if (!newlyInStockTask) newlyInStockTask = task;
      }
    } else {
      notifiedInStockTasks.delete(task.id);
    }
  }

  if (newlyInStockTask) {
    const model = newlyInStockTask.product?.Model || "iPhone";
    const color = newlyInStockTask.product?.Color || "";
    const store = newlyInStockTask.store?.StoreName || newlyInStockTask.store?.CityStoreName || "Apple Store";
    const title = `🎉 发现「${model} · ${color}」有货（${store}）！正在持续响铃`;
    const desc = `已自动跳转至官网结算/下单界面，请尽快确认完成下单！`;

    if (soundEnabled) {
      startContinuousAlarm(title, desc);
    } else if (elements.alarmBanner) {
      elements.alarmBanner.hidden = false;
      if (elements.alarmBannerTitle) elements.alarmBannerTitle.textContent = title;
      if (elements.alarmBannerDesc) elements.alarmBannerDesc.textContent = desc;
    }

    directToOrder(newlyInStockTask);
  }
}

function applySnapshot(result) {
  if (result?.connected === false) {
    backendConnected = false;
    backendError = result.error || "后台未连接，请重新连接";
  } else if (result?.ok && result.connected) {
    backendConnected = true;
    backendError = "";
    tasks = result.tasks;
    monitoring = result.monitoring;
    monitorState = result.monitorState;
    if (!settingsDirty) populateSettings(result.notificationSettings);
    checkForStockAlert(result.tasks, result.monitorState, result.notificationSettings || readSettings());
  }
  render();
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  if (!document.hidden) refreshTimer = setTimeout(() => refreshBackend(), 5000);
}

async function refreshBackend() {
  if (refreshInFlight) return refreshInFlight;
  if (operationPending) { scheduleRefresh(); return; }
  clearTimeout(refreshTimer);
  refreshInFlight = (async () => {
    try {
      const result = await chrome.runtime.sendMessage({ type: "get-backend-state" });
      if (!result?.ok) applySnapshot({ ...result, connected: false });
      else applySnapshot(result);
    } catch {
      applySnapshot({ connected: false, error: "扩展连接已中断，请重新打开控制台" });
    }
  })();
  renderMonitorState();
  try { await refreshInFlight; } finally {
    refreshInFlight = null;
    renderMonitorState();
    scheduleRefresh();
  }
}

async function sendBackendCommand(message) {
  if (operationPending) return { ok: false, error: "正在处理上一项操作，请稍候" };
  if (!backendConnected) return { ok: false, error: "后台未连接，请先重新连接；修改尚未保存" };
  operationPending = true;
  clearTimeout(refreshTimer);
  render();
  try {
    if (refreshInFlight) await refreshInFlight;
    if (!backendConnected) return { ok: false, error: "后台未连接，修改尚未保存" };
    const result = await chrome.runtime.sendMessage(message);
    applySnapshot(result);
    return result;
  } catch {
    const result = { ok: false, connected: false, error: "扩展连接已中断；操作结果尚未确认，请重新连接" };
    applySnapshot(result);
    return result;
  } finally {
    operationPending = false;
    render();
    scheduleRefresh();
  }
}
