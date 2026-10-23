/* Based on the restricted 1016v1 bridge (Sunbelife integration, GPL-3.0).
 * Uses only the page's existing session; never reads cookies or invokes challenge scripts. */
(() => {
  'use strict';
  if (window.__appleInventoryPageBridge) return;
  window.__appleInventoryPageBridge = true;
  const SOURCE = 'apple-helper-inventory';
  const MAX_BODY_BYTES = 2 * 1024 * 1024;
  let active = null, retryAt = 0, retryStatus = 503;
  const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(value);
  function validPage() {
    try {
      const url = new URL(window.location.href);
      const path = decodeURIComponent(url.pathname);
      const isCn = url.origin === 'https://www.apple.com.cn' && /^\/shop\/(?:buy-iphone|buy-watch|product)\/[^?#]+$/.test(path);
      const isJp = url.origin === 'https://www.apple.com' && /^\/jp\/shop\/(?:buy-iphone|buy-watch|product)\/[^?#]+$/.test(path);
      return window.top === window && (isCn || isJp) && !url.username && !url.password &&
        !/\/(?:bag|checkout|signin|account|orders?|secure)(?:\/|$)/i.test(path);
    } catch { return false; }
  }
  function query(path, targetStore) {
    if (typeof path !== 'string' || path.length > 16_384 || typeof targetStore !== 'string' || !/^R[0-9]{1,8}$/.test(targetStore)) throw new Error('invalid-query');
    const url = new URL(path, window.location.origin);
    const validCn = url.origin === 'https://www.apple.com.cn' && url.pathname === '/shop/retail/pickup-message';
    const validJp = url.origin === 'https://www.apple.com' && url.pathname === '/jp/shop/retail/pickup-message';
    if ((!validCn && !validJp) || url.username || url.password || url.hash) throw new Error('invalid-query');
    const values = new Map(), parts = new Map(), modes = new Map();
    for (const [key, value] of url.searchParams) {
      if (values.has(key)) throw new Error('invalid-query');
      values.set(key, value);
      if (key === 'pl' && value === 'true' || key === 'store' && /^R[0-9]{1,8}$/.test(value) ||
          key === 'location' && (/^[0-9]{6}$/.test(value) || /^[0-9]{3}-?[0-9]{4}$/.test(value)) ||
          key === 'cppart' && /^[A-Za-z0-9_]+$/.test(value)) continue;
      const part = /^(parts|mts)\.(0|[1-9][0-9]?)$/.exec(key);
      if (!part || (part[1] === 'mts' ? value !== 'regular' : !/^[A-Za-z0-9][A-Za-z0-9-]{1,49}(?:\/[A-Za-z0-9]{1,8})?$/.test(value))) throw new Error('invalid-query');
      (part[1] === 'parts' ? parts : modes).set(Number(part[2]), value);
    }
    if (values.get('pl') !== 'true' || (!values.has('store') && !values.has('location')) ||
        (values.has('store') && values.get('store') !== targetStore) || !parts.size || parts.size !== modes.size) throw new Error('invalid-query');
    for (let index = 0; index < parts.size; index++) if (!parts.has(index) || !modes.has(index)) throw new Error('invalid-query');
    return { url, store: targetStore, skus: [...parts.values()] };
  }
  function safePayload(raw, request) {
    const stores = raw?.body?.stores ?? raw?.body?.content?.pickupMessage?.stores;
    if (!Array.isArray(stores) || stores.length > 1000) throw new Error('invalid-json');
    const matches = stores.filter(store => store?.storeNumber === request.store);
    if (matches.length > 1) throw new Error('invalid-json');
    return { body: { stores: matches.map(store => {
      const partsAvailability = {};
      for (const sku of request.skus) {
        const part = store.partsAvailability?.[sku];
        if (!part || typeof part !== 'object') continue;
        const value = part.pickupDisplay ?? part.messageTypes?.regular?.pickupDisplay;
        partsAvailability[sku] = { pickupDisplay: ['available', 'unavailable', 'ineligible'].includes(value) ? value : 'unknown' };
      }
      return { storeNumber: request.store, partsAvailability };
    }) } };
  }
  function serverRetry(raw, now) {
    if (typeof raw !== 'string' || raw.length > 100) return { at: 0, value: '' };
    const value = raw.trim();
    let at;
    if (/^[0-9]+$/.test(value)) {
      const seconds = Number(value);
      at = Number.isSafeInteger(seconds) && seconds <= (8_640_000_000_000_000 - now) / 1000 ? now + seconds * 1000 : NaN;
    } else if (/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) at = Date.parse(value);
    return Number.isFinite(at) ? { at: Math.max(now, at), value } : { at: 0, value: '' };
  }
  async function readJSON(response) {
    if (!/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) throw new Error('invalid-json');
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw new Error('response-too-large');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('invalid-json');
    const decoder = new TextDecoder();
    let bytes = 0, text = '';
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_BODY_BYTES) throw new Error('response-too-large');
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
      try { return JSON.parse(text); } catch { throw new Error('invalid-json'); }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  function emit(id, href, result) {
    if (validPage() && window.location.href === href) window.postMessage({ source: SOURCE, direction: 'response', requestId: id, href, result }, window.location.origin);
  }
  async function run(message) {
    const href = window.location.href;
    if (!validPage()) return;
    let request;
    try { request = query(message.requestPath, message.targetStore); } catch { emit(message.requestId, href, { ok: false, error: '仅允许查询指定门店和 SKU 的 Apple 库存接口' }); return; }
    if (retryAt > Date.now()) { emit(message.requestId, href, { ok: false, status: retryStatus, error: '官网库存查询正在冷却，请稍后重试', retryAt: new Date(retryAt).toISOString() }); return; }
    if (active) {
      if (active.id !== message.requestId) emit(message.requestId, href, { ok: false, error: '已有库存查询正在进行' });
      return;
    }
    const controller = new AbortController(), current = { id: message.requestId, controller };
    active = current;
    let timer, rejectCancelled;
    const cancelled = new Promise((_, reject) => { rejectCancelled = reject; });
    const cancel = () => { controller.abort(); rejectCancelled(new Error('cancelled')); };
    current.cancel = cancel;
    window.addEventListener('pagehide', cancel);
    window.addEventListener('hashchange', cancel);
    window.addEventListener('popstate', cancel);
    try {
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, 10_000); });
      const result = await Promise.race([deadline, cancelled, (async () => {
        const response = await window.fetch(request.url.href, { method: 'GET', credentials: 'include', mode: 'same-origin', redirect: 'error', signal: controller.signal,
          headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' } });
        if (response.status === 429 || response.status === 503) {
          const now = Date.now(), after = serverRetry(response.headers.get('retry-after'), now);
          retryAt = Math.max(now + 60_000, after.at);
          retryStatus = response.status;
          return { ok: false, status: response.status, error: 'Apple 库存接口暂不可用，库存未知', retryAt: new Date(retryAt).toISOString(), ...(after.value ? { retryAfter: after.value } : {}) };
        }
        if (response.status === 403 || response.status === 541) return { ok: false, status: response.status, error: '请在 Apple 官网手动完成验证后再查询' };
        if (response.status !== 200) return { ok: false, status: response.status, error: 'Apple 库存接口返回 HTTP ' + response.status };
        return { ok: true, payload: safePayload(await readJSON(response), request) };
      })()]);
      emit(message.requestId, href, result);
    } catch (error) {
      const messages = { timeout: 'Apple 库存请求超时，请稍后重试', cancelled: '页面已变化，库存查询已取消', 'response-too-large': 'Apple 库存响应过大，未采用结果', 'invalid-json': 'Apple 页面未返回有效库存 JSON，请检查官网页面' };
      emit(message.requestId, href, { ok: false, error: messages[error.message] || 'Apple 库存请求失败，请检查官网页面后重试' });
    } finally {
      clearTimeout(timer); controller.abort();
      window.removeEventListener('pagehide', cancel); window.removeEventListener('hashchange', cancel); window.removeEventListener('popstate', cancel);
      if (active === current) active = null;
    }
  }
  window.addEventListener('message', event => {
    const message = event.data;
    if (event.source !== window || event.origin !== window.location.origin || message?.source !== SOURCE || !validId(message.requestId)) return;
    if (message.direction === 'cancel') { if (active?.id === message.requestId) active.cancel(); return; }
    if (message.direction === 'request') void run(message);
  });
})();
