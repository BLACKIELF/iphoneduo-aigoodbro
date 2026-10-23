import { compareVersions, createUpdateChecker } from "./update-checker.js";
import { RELEASE } from "./release-info.js";

const REPOSITORY = "https://github.com/BLACKIELF/iphoneduo-aigoodbro";

export function updatePrompt(version, versionName) {
  compareVersions(version, version); // Only a validated numeric version may enter this instruction.
  const label = typeof versionName === "string" && versionName.trim() === versionName && /^\d{4}v[1-9]\d{0,3}$/.test(versionName) ? `（${versionName}）` : "";
  return `请用 Codex 协助我将 ${REPOSITORY} 的 iPhoneduo助手aigoodbro 更新至 ${version}${label}：先读 README，复用原安装和扩展目录，保留本地改动、任务、设置及监控状态；先停止旧购买任务，比较文件后更新，Java 后台有变化才重建安装；重新加载扩展并核验版本、固定 ID 与后台连接，不自动恢复购买或付款。`;
}

export async function initializeUpdateUI({ document, chrome, checker, release = RELEASE, clipboard } = {}) {
  const field = name => document.getElementById(`update-${name}`);
  const currentVersion = chrome.runtime.getManifest().version;
  field("current").textContent = currentVersion;
  const topbarVersion = typeof document?.querySelector === "function" ? document.querySelector(".topbar .version") : null;
  if (topbarVersion) {
    topbarVersion.textContent = `${currentVersion} · ${release.versionName || "1023v1"} · Chrome + Java`;
  }
  let saved = {};
  try { saved = await chrome.storage.local.get(["updateSeenVersion", "updateInstallEvent"]); }
  catch { /* Still show the loaded version if local storage is temporarily unavailable. */ }
  const previous = saved.updateInstallEvent?.version === currentVersion && saved.updateInstallEvent?.reason === "update"
    ? saved.updateInstallEvent.previousVersion : saved.updateSeenVersion;
  let upgraded = false;
  try { upgraded = compareVersions(currentVersion, previous) > 0; } catch { /* No trustworthy previous version. */ }
  field("notice").hidden = saved.updateSeenVersion === currentVersion;
  field("notice-title").textContent = upgraded ? `已升级至 ${currentVersion}（此前 ${previous}）` : `已载入 ${currentVersion} · 本次更新`;
  function list(target, changes) {
    target.replaceChildren();
    for (const text of changes) {
      const item = document.createElement("li"); item.textContent = text; target.append(item);
    }
  }
  list(field("local-notes"), release.version === currentVersion ? release.changes : []);
  field("ack").addEventListener("click", async () => {
    try {
      await chrome.storage.local.set({ updateSeenVersion: currentVersion });
      field("notice").hidden = true;
      try { await chrome.action?.setBadgeText({ text: "" }); } catch { /* A badge failure does not undo acknowledgement. */ }
    } catch { field("status").textContent = "版本已载入，但提示状态未保存，请稍后重试。"; }
  });
  let pending = false;
  async function check(force = false) {
    if (pending) return;
    pending = true; field("check").disabled = true;
    field("status").textContent = "正在检查新版本…";
    try {
      const result = await checker.check({ force });
      field("copy-status").textContent = "";
      field("prompt").value = "";
      field("latest").textContent = result.latestVersion || (result.lastKnown?.latestVersion ? `${result.lastKnown.latestVersion}（上次结果）` : "尚未取得");
      field("checked").textContent = result.checkedAt ? `检查时间：${new Date(result.checkedAt).toLocaleString("zh-CN")}${result.cached ? " · 缓存结果" : ""}` : "";
      field("actions").hidden = result.status !== "available";
      field("remote-notes").hidden = result.status !== "available";
      list(field("remote-notes"), result.status === "available" ? result.changes || [] : []);
      if (result.status === "available") {
        field("status").textContent = `发现新版本 ${result.latestVersion} · ${result.versionName}`;
        field("prompt").value = updatePrompt(result.latestVersion, result.versionName);
      } else if (result.status === "current") {
        field("status").textContent = `当前已是最新公开版本 ${currentVersion}`;
        if (force) {
          const originalText = field("check").textContent;
          field("check").textContent = "✅ 已是最新";
          setTimeout(() => {
            if (field("check").textContent === "✅ 已是最新") field("check").textContent = originalText;
          }, 1800);
        }
      } else if (result.status === "ahead") field("status").textContent = "本地版本高于当前公开版本，无需降级。";
      else field("status").textContent = "检查失败，暂时无法确认是否有新版；请稍后重试。";
    } catch {
      field("status").textContent = "检查失败，暂时无法确认是否有新版；请稍后重试。";
      field("latest").textContent = "尚未取得";
      field("checked").textContent = "";
      field("prompt").value = "";
      field("copy-status").textContent = "";
      field("actions").hidden = true;
      field("remote-notes").hidden = true;
    } finally { pending = false; field("check").disabled = false; }
  }
  field("check").addEventListener("click", () => check(true));
  field("copy").addEventListener("click", async () => {
    try {
      if (!clipboard?.writeText) throw new Error("clipboard unavailable");
      await clipboard.writeText(field("prompt").value);
      field("copy-status").textContent = "已复制，粘贴给 Codex 即可。";
    } catch {
      field("prompt").focus(); field("prompt").select();
      field("copy-status").textContent = "请复制下方已选中的更新口令。";
    }
  });
  await check();
  return { check };
}

if (typeof document !== "undefined" && typeof chrome !== "undefined") {
  const currentVersion = chrome.runtime.getManifest().version;
  const checker = createUpdateChecker({ currentVersion, storage: chrome.storage.local });
  initializeUpdateUI({ document, chrome, checker, clipboard: navigator.clipboard }).catch(() => {
    document.getElementById("update-status").textContent = "版本检查暂不可用，请稍后重新打开助手。";
  });
}
