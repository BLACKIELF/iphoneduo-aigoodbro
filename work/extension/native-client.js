// Native Messaging is the only route to the local Java monitor.
export const NATIVE_HOST = "com.aigoodbro.apple_helper";
const ACTIONS = new Set(["status", "sync", "start", "stop", "check"]);

export function createNativeClient(runtime, { timeoutMs = 15000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  return (request) => new Promise((resolve, reject) => {
    if (!ACTIONS.has(request?.action)) {
      reject(new Error("不支持的后台操作"));
      return;
    }
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimer(() => finish(new Error("后台连接超时；请重新连接并确认本机 Java 服务运行中")), timeoutMs);
    try {
      runtime.sendNativeMessage(NATIVE_HOST, request, (response) => {
        // Reading lastError in the callback prevents an unchecked runtime error.
        const error = runtime.lastError;
        if (error) {
          const reason = String(error.message || "");
          const detail = /not found|does not exist/i.test(reason) ? "未找到本机连接器" :
            /forbidden|not allowed|access/i.test(reason) ? "本机连接器未授权当前扩展" : "本机连接器已断开";
          finish(new Error("后台未连接：" + detail + "；请重新连接"));
        } else if (!response || typeof response !== "object" || Array.isArray(response)) {
          finish(new Error("后台未连接：本机连接器未返回有效状态；请重新连接"));
        } else finish(null, response);
      });
    } catch {
      finish(new Error("后台未连接：无法启动本机连接器；请重新连接"));
    }
  });
}

export function redactText(value, settings = {}) {
  let text = typeof value === "string" ? value : "";
  for (const secret of [settings.barkUrl, settings.feishuWebhook, settings.feishuSecret]
    .filter((value) => typeof value === "string" && value).sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join("[已隐藏]");
  }
  // Logs need no webhook URL. Never expose an unexpected transport URL or key.
  return text.replace(/https?:\/\/[^\s<>"']+/g, "[链接已隐藏]").slice(0, 1200);
}
