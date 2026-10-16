/* Isolated-world companion to the restricted 1016v1 page bridge (GPL-3.0). */
(() => {
  'use strict';
  if (globalThis.__appleInventoryContent) return;
  globalThis.__appleInventoryContent = true;
  const SOURCE = 'apple-helper-inventory';
  let pending = null;
  function validPage() {
    try {
      const url = new URL(window.location.href);
      const path = decodeURIComponent(url.pathname);
      return window.top === window && url.origin === 'https://www.apple.com.cn' && !url.username && !url.password &&
        /^\/shop\/(?:buy-iphone|buy-watch|product)\/[^?#]+$/.test(path) &&
        !/\/(?:bag|checkout|signin|account|orders?|secure)(?:\/|$)/i.test(path);
    } catch { return false; }
  }
  function cleanResult(result) {
    if (result?.ok === true) {
      const stores = result.payload?.body?.stores;
      if (!Array.isArray(stores) || stores.length > 1) return { ok: false, error: '官网库存结果格式无效' };
      const clean = [];
      for (const store of stores) {
        if (!/^R[0-9]{1,8}$/.test(store?.storeNumber || '')) return { ok: false, error: '官网库存结果格式无效' };
        const partsAvailability = {}, parts = Object.entries(store.partsAvailability || {});
        if (parts.length > 100) return { ok: false, error: '官网库存结果格式无效' };
        for (const [sku, part] of parts) {
          if (!/^[A-Za-z0-9][A-Za-z0-9-]{1,49}(?:\/[A-Za-z0-9]{1,8})?$/.test(sku)) return { ok: false, error: '官网库存结果格式无效' };
          partsAvailability[sku] = { pickupDisplay: ['available', 'unavailable', 'ineligible'].includes(part?.pickupDisplay) ? part.pickupDisplay : 'unknown' };
        }
        clean.push({ storeNumber: store.storeNumber, partsAvailability });
      }
      return { ok: true, payload: { body: { stores: clean } } };
    }
    const status = Number.isInteger(result?.status) && result.status >= 100 && result.status <= 599 ? result.status : undefined;
    // Page messages are untrusted: never forward arbitrary error text or extra response fields.
    const safeErrors = new Set(['Apple 库存请求超时，请稍后重试', '页面已变化，库存查询已取消', 'Apple 库存响应过大，未采用结果', 'Apple 页面未返回有效库存 JSON，请检查官网页面', '仅允许查询指定门店和 SKU 的 Apple 库存接口', '已有库存查询正在进行']);
    const error = status === 403 || status === 541 ? '请在 Apple 官网手动完成验证后再查询' : status === 429 || status === 503 ? 'Apple 库存接口暂不可用，库存未知，请稍后重试' : safeErrors.has(result?.error) ? result.error : '官网库存查询未完成，请检查页面或稍后重试';
    const retryAt = typeof result?.retryAt === 'string' && Number.isFinite(Date.parse(result.retryAt)) ? new Date(result.retryAt).toISOString() : '';
    const retryAfter = typeof result?.retryAfter === 'string' && (/^[0-9]{1,16}$/.test(result.retryAfter) || /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(result.retryAfter)) ? result.retryAfter : '';
    return { ok: false, ...(status ? { status } : {}), error, ...(retryAt ? { retryAt } : {}), ...(retryAfter ? { retryAfter } : {}) };
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!['inventory:query', 'inventory:cancel'].includes(message?.type)) return false;
    if (sender?.id !== chrome.runtime.id || window.top !== window) { respond({ ok: false, error: '库存查询仅允许扩展在顶层官网页执行' }); return false; }
    if (message.type === 'inventory:cancel') {
      const cancelled = Boolean(pending && pending.id === message.requestId);
      if (cancelled) pending.cancel();
      respond({ ok: true, cancelled }); return false;
    }
    if (!validPage()) { respond({ ok: false, error: '库存查询仅允许在已打开的 Apple 商品页执行' }); return false; }
    if (typeof message.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(message.requestId) || typeof message.requestPath !== 'string' || message.requestPath.length > 16_384) {
      respond({ ok: false, error: '库存查询参数无效' }); return false;
    }
    if (pending) {
      if (pending.id === message.requestId && pending.path === message.requestPath) { pending.promise.then(respond); return true; }
      respond({ ok: false, error: '已有库存查询正在进行' }); return false;
    }
    const id = message.requestId, path = message.requestPath, href = window.location.href;
    let finish, timer;
    const promise = new Promise(resolve => {
      finish = result => {
        if (pending?.id !== id) return;
        clearTimeout(timer); window.removeEventListener('message', onResponse);
        window.removeEventListener('pagehide', onNavigation); window.removeEventListener('hashchange', onNavigation); window.removeEventListener('popstate', onNavigation);
        pending = null; resolve(result);
      };
    });
    function cancel() { window.postMessage({ source: SOURCE, direction: 'cancel', requestId: id }, window.location.origin); }
    function onNavigation() { cancel(); finish({ ok: false, error: '页面已变化，库存查询已取消' }); }
    function onResponse(event) {
      const value = event.data;
      if (event.source !== window || event.origin !== window.location.origin || value?.source !== SOURCE || value.direction !== 'response' || value.requestId !== id || value.href !== href) return;
      if (!validPage() || window.location.href !== href) { onNavigation(); return; }
      finish(cleanResult(value.result));
    }
    pending = { id, path, promise, cancel() { cancel(); finish({ ok: false, error: '库存查询已取消' }); } };
    window.addEventListener('message', onResponse);
    window.addEventListener('pagehide', onNavigation); window.addEventListener('hashchange', onNavigation); window.addEventListener('popstate', onNavigation);
    timer = setTimeout(() => { cancel(); finish({ ok: false, error: 'Apple 页面库存查询超时，请稍后重试' }); }, 12_000);
    promise.then(respond);
    window.postMessage({ source: SOURCE, direction: 'request', requestId: id, requestPath: path }, window.location.origin);
    return true;
  });
})();
