// Notification transport adapted from Apple-Monitor's FeiShuBotPush / FeiShuUtils.
// No remote response body or configured credential is included in an error.
export const DEFAULT_NOTIFICATION_SETTINGS = Object.freeze({
  barkUrl: "",
  feishuWebhook: "",
  feishuSecret: "",
  intervalSeconds: 30
});
const INTERVALS = new Set([30, 60, 120, 300]);

function settingText(value, label, limit = 4096) {
  if (value == null) return "";
  if (typeof value !== "string" || value.length > limit) throw new Error(label + "格式无效");
  return value.trim();
}

function safeURL(raw, label) {
  let url;
  try { url = new URL(raw); } catch { throw new Error(label + "格式无效"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) {
    throw new Error(label + "必须使用 HTTPS，且不能含账号、端口或片段");
  }
  return url;
}

export function normalizeNotificationSettings(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("通知设置格式无效");
  const settings = {
    barkUrl: settingText(input.barkUrl, "Bark 地址"),
    feishuWebhook: settingText(input.feishuWebhook, "飞书 Webhook"),
    feishuSecret: settingText(input.feishuSecret, "飞书签名密钥"),
    intervalSeconds: input.intervalSeconds == null ? 30 : Number(input.intervalSeconds)
  };
  if (!INTERVALS.has(settings.intervalSeconds)) throw new Error("检查间隔只支持 30、60、120 或 300 秒");
  if (settings.barkUrl) {
    const url = safeURL(settings.barkUrl, "Bark 地址");
    if (url.hostname !== "api.day.app" || !/^\/[^/]+(?:\/.*)?$/.test(url.pathname)) {
      throw new Error("Bark 地址必须是 https://api.day.app/ 下的有效推送地址");
    }
    settings.barkUrl = url.href;
  }
  if (settings.feishuWebhook) {
    const url = safeURL(settings.feishuWebhook, "飞书 Webhook");
    if (!["open.feishu.cn", "open.larksuite.com"].includes(url.hostname) ||
        !/^\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]+$/.test(url.pathname) || url.search) {
      throw new Error("飞书 Webhook 必须是飞书或 Lark 官方自定义机器人的 HTTPS 地址");
    }
    settings.feishuWebhook = url.href;
  } else if (settings.feishuSecret) {
    throw new Error("填写飞书签名密钥前，请先填写 Webhook");
  }
  return settings;
}

export async function feishuSignature(secret, timestamp, cryptoImpl = globalThis.crypto) {
  const key = await cryptoImpl.subtle.importKey(
    "raw", new TextEncoder().encode(timestamp + "\n" + secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const signed = await cryptoImpl.subtle.sign("HMAC", key, new Uint8Array());
  return btoa(String.fromCharCode(...new Uint8Array(signed)));
}

async function requestJSON(url, options, dependencies = {}) {
  const { fetchImpl = globalThis.fetch, signal, timeoutMs = 10000 } = dependencies;
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await fetchImpl(url, {
      ...options, credentials: "omit", cache: "no-store", redirect: "error", signal: controller.signal
    });
    if (!response.ok) throw new Error("HTTP " + response.status);
    try { return await response.json(); } catch {
      if (controller.signal.aborted) throw new Error("aborted");
      throw new Error("服务未返回有效 JSON");
    }
  } catch (error) {
    if (timedOut) throw new Error("请求超时（10 秒）");
    if (signal?.aborted) throw new Error("请求已取消");
    if (/^(HTTP \d{3}|服务未返回有效 JSON)$/.test(error?.message || "")) throw error;
    throw new Error("网络连接失败");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export async function sendBark(settings, notification, dependencies = {}) {
  const validated = normalizeNotificationSettings(settings);
  const url = new URL(validated.barkUrl);
  url.searchParams.set("title", notification.title);
  url.searchParams.set("body", notification.message);
  url.searchParams.set("url", notification.link);
  const result = await requestJSON(url.href, { method: "GET" }, dependencies);
  if (result?.code !== 200) throw new Error("Bark 服务未确认推送成功");
}

export async function sendFeishu(settings, notification, dependencies = {}) {
  const validated = normalizeNotificationSettings(settings);
  const payload = { msg_type: "text", content: { text: notification.title + "\n" + notification.message + "\n" + notification.link } };
  if (validated.feishuSecret) {
    payload.timestamp = String(Math.floor((dependencies.now?.() ?? Date.now()) / 1000));
    try {
      payload.sign = await feishuSignature(validated.feishuSecret, payload.timestamp, dependencies.cryptoImpl);
    } catch { throw new Error("飞书签名计算失败"); }
  }
  // Signing is asynchronous: recheck permission immediately before dispatch.
  if (dependencies.canSend && !await dependencies.canSend()) return { skipped: true };
  if (dependencies.signal?.aborted) return { skipped: true };
  const result = await requestJSON(validated.feishuWebhook, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
  }, dependencies);
  const code = result?.code ?? result?.StatusCode;
  if (code !== 0) throw new Error("飞书 / Lark 服务未确认推送成功");
}

export async function dispatchStockNotifications({ settings, notification, createDesktop, canSend, signal, onResult, dependencies = {} }) {
  const channels = [{ name: "桌面", send: () => createDesktop(notification) }];
  if (settings.barkUrl) channels.push({ name: "Bark", send: () => sendBark(settings, notification, { ...dependencies, signal }) });
  if (settings.feishuWebhook) channels.push({ name: "飞书 / Lark", send: () => sendFeishu(settings, notification, { ...dependencies, signal, canSend }) });
  return Promise.all(channels.map(async ({ name, send }) => {
    if (signal?.aborted || !await canSend() || signal?.aborted) return { channel: name, skipped: true };
    let outcome;
    try {
      const result = await send();
      outcome = result?.skipped ? { channel: name, skipped: true } : { channel: name, ok: true };
    } catch (error) {
      // Desktop errors can contain platform details; only transports produce fixed safe errors.
      outcome = { channel: name, ok: false, error: name === "桌面" ? "系统未确认通知成功" : error.message };
    }
    await onResult?.(outcome);
    return outcome;
  }));
}
