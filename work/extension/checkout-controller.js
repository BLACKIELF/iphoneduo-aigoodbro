import { createCheckoutState, advanceCheckout, recoverCheckout } from './checkout-state.js';
import { productPurchaseURL } from './shared.js';

const KEY = 'checkoutRun';
const PAGE_SETTLE_MS = 45000;
const HALTED = new Set(['CANCELLED', 'BLOCKED', 'WAITING_FOR_IDENTITY', 'READY_TO_SUBMIT', 'ORDER_CREATED_UNPAID', 'PAYMENT_STOPPED', 'SUBMISSION_UNKNOWN']);
export function isCheckoutURL(raw) {
  try {
    const url = new URL(raw);
    const isCn = ['www.apple.com.cn', 'secure6.www.apple.com.cn'].includes(url.hostname);
    const isGlobal = ['www.apple.com', 'secure6.www.apple.com'].includes(url.hostname);
    const isShopPath = /^\/(?:(?:hk|hk-zh|jp)\/)?shop(?:\/|$)/.test(url.pathname);
    return url.protocol === 'https:' && (isCn ? /^\/shop(?:\/|$)/.test(url.pathname) : (isGlobal && isShopPath));
  } catch { return false; }
}

function bagURL(areaCode) {
  if (areaCode === 'us') return 'https://www.apple.com/shop/bag';
  if (['hk', 'jp'].includes(areaCode)) return `https://www.apple.com/${areaCode}/shop/bag`;
  return 'https://www.apple.com.cn/shop/bag';
}

export function createCheckoutController(api) {
  let queue = Promise.resolve(), timer, cancellationEpoch = 0, armCancellationEpoch = 0, stopPending = false;
  const serial = (fn) => { const next = queue.then(fn); queue = next.catch(() => {}); return next; };
  const read = async () => (await api.storage.local.get(KEY))[KEY] || null;
  const save = (run) => api.storage.local.set({ [KEY]: run });
  const log = (run, message) => {
    run.log = [...(run.log || []), { time: new Date().toISOString(), message }].slice(-60);
  };
  const wake = (delay = 350) => {
    clearTimeout(timer);
    timer = setTimeout(() => serial(pulse).catch(() => {}), delay);
  };
  async function block(run, message) {
    run.state = advanceCheckout(run.state, { type: 'BLOCK', reason: message }, Date.now()).state;
    log(run, message); await save(run);
  }
  async function send(run, message) {
    return api.tabs.sendMessage(run.tabId, { ...message, nonce: run.nonce, runId: run.state.intent.intentId }, { frameId: 0 });
  }
  async function act(run, snapshot, command, expectedEpoch) {
    if (stopPending || expectedEpoch !== cancellationEpoch) return;
    if (command.kind === 'add-to-bag' && run.bagAttempt) {
      if (Date.now() - run.bagAttempt.at < PAGE_SETTLE_MS) { wake(1000); return; }
      await block(run, '加入购物袋的结果尚未确认；请核对购物袋，不会重复加购。'); return;
    }
    const signature = JSON.stringify([snapshot.stage, command, snapshot.product, snapshot.cartItems, snapshot.checkoutStep, snapshot.pickupProgress]);
    // Persist before dispatch. A timeout cannot replay an add-to-bag or submit click.
    if (run.pendingAction?.signature === signature) {
      if (Date.now() - run.pendingAction.at < PAGE_SETTLE_MS) { wake(1000); return; }
      await block(run, '页面未确认上一项操作结果；已停止，避免重复加购或提交。'); return;
    }
    run.pendingAction = { signature, id: crypto.randomUUID(), at: Date.now(), kind: command.kind };
    if (command.kind === 'add-to-bag') run.bagAttempt = { id: run.pendingAction.id, sku: run.state.intent.product.Code, at: Date.now() };
    log(run, actionLabel(command.kind)); await save(run);
    if (stopPending || expectedEpoch !== cancellationEpoch) return;
    let response;
    try {
      response = await send(run, { type: 'checkout:act', actionId: run.pendingAction.id, expectedStage: snapshot.stage, command });
    } catch {
      // Navigation can close the message port after the click. Observe the resulting page.
      wake(1200); return;
    }
    if (!response?.ok) {
      if (command.kind === 'submit-order') {
        run.state = recoverCheckout(run.state, Date.now()); log(run, '提交操作未确认，禁止重试，请核对官网订单。'); await save(run);
      } else await block(run, response?.error || '页面拒绝执行，已停止。');
      return;
    }
    wake(650);
  }
  async function pulse({ receiptOnly = false } = {}) {
    if (stopPending) return;
    const expectedEpoch = cancellationEpoch;
    const run = await read();
    if (!run || (HALTED.has(run.state.status) && !receiptOnly)) return;
    if (run.trigger?.status === 'armed' && run.tabId == null) return;
    let tab;
    try { tab = await api.tabs.get(run.tabId); } catch {
      run.state = recoverCheckout(run.state, Date.now());
      if (run.state.status !== 'SUBMISSION_UNKNOWN') await block(run, '购买标签页已关闭；任务停止。');
      else { log(run, '提交结果待核对，禁止再次提交。'); await save(run); }
      return;
    }
    if (!isCheckoutURL(tab.url)) {
      if (tab.status === 'loading') { wake(700); return; }
      await block(run, '页面已离开已验证的 Apple 商店地址，请在官网完成身份验证或核对结果。'); return;
    }
    if (tab.status === 'loading') { wake(500); return; }
    let snapshot;
    try {
      const bound = await send(run, { type: 'checkout:bind', intent: { ...run.state.intent, allowReplaceVariant: run.allowReplaceVariant } });
      if (!bound?.ok) throw new Error('bind');
      const result = await send(run, { type: 'checkout:snapshot' });
      if (!result?.ok || !result.snapshot) throw new Error('snapshot');
      snapshot = result.snapshot;
      run.connectionFailures = 0;
      run.connectionFailureSince = null;
    } catch {
      run.connectionFailures = (run.connectionFailures || 0) + 1;
      run.connectionFailureSince ??= Date.now();
      if (Date.now() - run.connectionFailureSince > PAGE_SETTLE_MS) { await block(run, '无法连接购买页面，请更新扩展后重新打开购买标签页。'); return; }
      await save(run); wake(800); return;
    }
    if (expectedEpoch !== cancellationEpoch) return;
    run.stage = snapshot.stage;
    if (receiptOnly) {
      if (['ORDER_CREATED', 'PAYMENT'].includes(snapshot.stage)) {
        run.state = advanceCheckout(run.state, { type: 'OBSERVE', observation: { ...snapshot, phase: snapshot.stage } }, Date.now()).state;
        log(run, '已重新核对页面：' + run.state.reason);
      } else log(run, '尚未读取到本次订单的明确回执；保持停止，不再次提交。');
      await save(run); return;
    }
    // The initial bag check prevents the program from silently purchasing existing items.
    if (!run.state.submitAttempt && snapshot.stage === 'BAG' && snapshot.bagEmpty === true && Array.isArray(snapshot.cartItems) && !snapshot.cartItems.length) {
      if (run.state.intent.entryMode === 'bag') { await block(run, '购物袋模式下购物袋为空，已停止；不会打开商品页或自动加购。'); return; }
      if (run.bagAttempt) { await block(run, '加购后购物袋仍为空，请核对结果；不会自动重复加购。'); return; }
      run.pendingAction = null; log(run, '购物袋为空，打开指定商品。'); await save(run);
      if (expectedEpoch !== cancellationEpoch) return;
      await api.tabs.update(run.tabId, { url: productPurchaseURL(run.state.intent) });
      wake(1000); return;
    }
    if (run.state.intent.entryMode === 'bag' && snapshot.stage === 'PRODUCT' && !run.state.submitAttempt) {
      await block(run, '购物袋模式不允许进入商品页或更改商品配置。'); return;
    }
    if (snapshot.stage === 'PRODUCT' && snapshot.stockAvailable === false && !run.state.submitAttempt) {
      run.state.status = 'WAITING_FOR_STOCK';
      run.nextStockCheck ||= Date.now() + 30000;
      if (Date.now() >= run.nextStockCheck) {
        run.nextStockCheck = Date.now() + 30000; run.pendingAction = null;
        await save(run); if (expectedEpoch !== cancellationEpoch) return;
        await api.tabs.reload(run.tabId); wake(1000);
      } else { await save(run); wake(Math.min(5000, run.nextStockCheck - Date.now())); }
      return;
    }
    run.nextStockCheck = null;
    const item = snapshot.cartItems?.[0];
    if (!run.state.submitAttempt && run.state.intent.entryMode !== 'bag' && snapshot.stage === 'BAG' && run.allowReplaceVariant && snapshot.cartItems?.length === 1 && item?.quantity === 1 &&
        item.product?.Model === run.state.intent.product.Model && item.product?.Capacity === run.state.intent.product.Capacity &&
        item.product?.Color !== run.state.intent.product.Color && snapshot.controls?.some(c => c.kind === 'edit-variant')) {
      await act(run, snapshot, { kind: 'edit-variant', allowReplaceVariant: true }, expectedEpoch); return;
    }
    const previousStatus = run.state.status;
    let transition;
    try { transition = advanceCheckout(run.state, { type: 'OBSERVE', observation: { ...snapshot, phase: snapshot.stage } }, Date.now()); }
    catch { await block(run, '页面数据无法验证，已停止。'); return; }
    run.state = transition.state;
    if (previousStatus !== run.state.status) log(run, '任务状态：' + run.state.status);
    if (run.state.status === 'READY_TO_SUBMIT') {
      try {
        await api.tabs.update(run.tabId, { active: true });
        const currentTab = await api.tabs.get(run.tabId);
        if (currentTab?.windowId) await api.windows?.update(currentTab.windowId, { focused: true });
      } catch {}
      log(run, '已成功直达下单界面（准备下单），请核对订单并点击立即下单完成支付。');
    }
    await save(run);
    if (transition.effect?.type === 'SUBMIT_ORDER') {
      // SUBMITTING has already been stored. There is no retry path for this effect.
      await act(run, snapshot, { kind: 'submit-order', attemptId: transition.effect.attemptId }, expectedEpoch); return;
    }
    if (HALTED.has(run.state.status)) return;
    if (run.state.status === 'SUBMITTING') {
      const submittedAt = run.state.submitAttempt?.startedAt ?? run.pendingAction?.at;
      if (!Number.isFinite(submittedAt) || submittedAt > Date.now() || Date.now() - submittedAt > PAGE_SETTLE_MS) {
        run.state = recoverCheckout(run.state, Date.now()); log(run, '未读取到订单结果，请到官网核对；不会重复提交。'); await save(run);
      } else wake(800);
      return;
    }
    const kinds = new Set((snapshot.controls || []).map(c => c.kind));
    let command;
    if (snapshot.stage === 'PRODUCT') {
      if (kinds.has('select-product')) command = { kind: 'select-product', field: snapshot.controls.find(c => c.kind === 'select-product').field, product: run.state.intent.product };
      else if (kinds.has('open-bag')) command = { kind: 'open-bag' };
      else if (kinds.has('add-to-bag')) command = { kind: 'add-to-bag', product: run.state.intent.product };
    } else if (snapshot.stage === 'BAG' && kinds.has('checkout')) command = { kind: 'checkout' };
    else if (snapshot.stage === 'CHECKOUT') {
      const allowed = run.state.intent.fulfillment === 'pickup' ? ['guest-checkout', 'pickup-step', 'continue-billing', 'checkout'] : ['guest-checkout', 'continue-shipping', 'continue-billing', 'checkout'];
      for (const kind of allowed) if (kinds.has(kind)) { command = { kind }; break; }
    }
    if (command) { run.noActionSince = null; await act(run, snapshot, command, expectedEpoch); return; }
    // Give a dynamic page a short bounded settling window, never a blind click.
    run.noActionSince ||= Date.now();
    if (Date.now() - run.noActionSince > PAGE_SETTLE_MS) { await block(run, (snapshot.issues || []).join('；') || '此页面需要补充信息，程序已停止。'); return; }
    await save(run); wake(700);
  }
  async function handle(message) {
    // Stop takes priority even while a snapshot or persistence call is awaiting a response.
    if (message.type === 'checkout-stop') { stopPending = true; cancellationEpoch++; clearTimeout(timer); }
    return serial(async () => {
      let run = await read();
      if (message.type === 'checkout-status') return { ok: true, run };
      if (message.type === 'checkout-start' || message.type === 'checkout-arm') {
        if (stopPending) return { ok: false, error: '正在停止上一项任务，请稍候。' };
        const startEpoch = cancellationEpoch;
        if (run && !HALTED.has(run.state.status)) return { ok: false, error: '已有购买任务运行中，请先停止。' };
        if (run && (run.state.submitAttempt || ['SUBMISSION_UNKNOWN', 'ORDER_CREATED_UNPAID', 'PAYMENT_STOPPED'].includes(run.state.status)) && !message.newIntentAcknowledged)
          return { ok: false, error: '上次任务已有提交或付款结果，请先核对官网订单，再明确开始新订单。' };
        const state = createCheckoutState({ ...message.intent, intentId: crypto.randomUUID(), revision: 1 }, Date.now());
        run = { state, nonce: crypto.randomUUID(), tabId: null, allowReplaceVariant: message.allowReplaceVariant === true, log: [] };
        if (message.type === 'checkout-arm') {
          if (state.intent.fulfillment !== 'pickup' || state.intent.entryMode !== 'bag') return { ok: false, error: '库存触发仅支持自提＋购物袋模式。' };
          const expectedIdentity = `${state.intent.areaCode}:${state.intent.pickup.storeNumber}:${state.intent.product.Code}`;
          if (typeof message.taskId !== 'string' || !message.taskId.trim() || message.taskId.length > 200 || message.identity !== expectedIdentity)
            return { ok: false, error: '监控任务身份与自提商品不一致。' };
          state.status = 'WAITING_FOR_STOCK'; state.reason = '等待指定监控任务的新库存结果';
          run.trigger = { status: 'armed', taskId: message.taskId, identity: expectedIdentity, armedAt: Date.now(), consumedAt: null };
          log(run, '已等待到货触发；监控结果确认到货后进入现有购物袋。'); await save(run);
          return { ok: true, run };
        }
        log(run, '已创建单次购买任务，先检查购物袋。'); await save(run);
        if (stopPending || startEpoch !== cancellationEpoch) return { ok: false, error: '启动已被停止请求取消。', run };
        stopPending = false;
        const tab = await api.tabs.create({ url: bagURL(state.intent.areaCode), active: true });
        run.tabId = tab.id; await save(run);
        await api.alarms?.create('checkout-pulse', { periodInMinutes: 0.5 }); wake(700);
        return { ok: true, run };
      }
      if (!run) {
        if (message.type === 'checkout-stop') { stopPending = false; return { ok: true, run: null }; }
        return { ok: false, error: '尚未创建购买任务。' };
      }
      if (message.type === 'checkout-stop') {
        run.state = advanceCheckout(run.state, { type: 'CANCEL' }, Date.now()).state;
        log(run, '已请求停止；已提交的订单不会自动撤销。'); await save(run); stopPending = false; return { ok: true, run };
      }
      if (message.type === 'checkout-open') {
        if (run.tabId) await api.tabs.update(run.tabId, { active: true });
        return { ok: true, run };
      }
      if (message.type === 'checkout-resume') {
        if (stopPending) return { ok: false, error: '正在停止当前任务，请稍候。', run };
        const resumeEpoch = cancellationEpoch;
        if (run.trigger?.status === 'armed') return { ok: true, run };
        if (run.state.submitAttempt || ['SUBMISSION_UNKNOWN', 'ORDER_CREATED_UNPAID', 'PAYMENT_STOPPED', 'SUBMITTING'].includes(run.state.status))
          { await pulse({ receiptOnly: true }); return { ok: true, run: await read() }; }
        const uncertainBag = run.pendingAction?.kind === 'add-to-bag';
        run.state.status = 'RUNNING'; run.pendingAction = null; run.noActionSince = null; run.connectionFailures = 0; run.connectionFailureSince = null;
        log(run, '继续当前任务，重新核对页面。'); await save(run);
        if (stopPending || resumeEpoch !== cancellationEpoch) return { ok: false, error: '继续操作已被停止请求取消。', run };
        if (uncertainBag) await api.tabs.update(run.tabId, { url: bagURL(run.state.intent.areaCode) });
        wake(); return { ok: true, run };
      }
      return { ok: false, error: '未知购买操作。' };
    });
  }
  function cancelArmed(reason = '监控已停止或任务已变化，已取消待触发购买。') {
    armCancellationEpoch++;
    return serial(async () => {
      const run = await read();
      if (!run?.trigger || run.tabId != null || !['armed', 'consumed'].includes(run.trigger.status)) return { ok: true, run, cancelled: false };
      run.trigger.status = 'cancelled';
      run.state = advanceCheckout(run.state, { type: 'CANCEL' }, Date.now()).state;
      run.state.reason = reason; log(run, reason); await save(run);
      return { ok: true, run, cancelled: true };
    });
  }
  // Only validated daemon snapshots belong here. Persist trigger consumption before opening a tab.
  function inventory(snapshot) {
    const expectedArmEpoch = armCancellationEpoch, expectedEpoch = cancellationEpoch;
    return serial(async () => {
      const run = await read();
      if (!run || run.trigger?.status !== 'armed' || run.state.status !== 'WAITING_FOR_STOCK' || run.tabId != null) return { ok: true, triggered: false, run };
      const cancelled = () => stopPending || expectedEpoch !== cancellationEpoch || expectedArmEpoch !== armCancellationEpoch;
      if (cancelled()) return { ok: true, triggered: false, run };
      const task = Array.isArray(snapshot?.tasks) ? snapshot.tasks.find(item => item?.id === run.trigger.taskId) : undefined;
      const identity = task ? `${task.areaCode}:${task.store?.StoreNumber}:${task.product?.Code}` : null;
      if (snapshot?.monitoring !== true || !task || identity !== run.trigger.identity) {
        run.trigger.status = 'cancelled';
        run.state = advanceCheckout(run.state, { type: 'CANCEL' }, Date.now()).state;
        run.state.reason = '监控暂停、任务缺失或身份改变，已取消待触发购买。';
        log(run, run.state.reason); await save(run); return { ok: true, triggered: false, run, cancelled: true };
      }
      const item = snapshot.monitorState?.items?.[run.trigger.taskId];
      const checkedAt = typeof item?.checkedAt === 'number' ? item.checkedAt : typeof item?.checkedAt === 'string' ? Date.parse(item.checkedAt) : NaN;
      const now = Date.now();
      if (item?.available !== true || item.identity !== run.trigger.identity || !Number.isFinite(checkedAt) ||
          checkedAt <= run.trigger.armedAt || checkedAt > now || now - checkedAt > 60000) return { ok: true, triggered: false, run };
      run.trigger.status = 'consumed'; run.trigger.consumedAt = now;
      run.state.status = 'READY'; run.state.reason = '新库存已确认，准备核对购物袋'; run.state.updatedAt = now;
      log(run, '库存触发已消费，打开购物袋核对一次。'); await save(run);
      if (cancelled()) return { ok: true, triggered: false, run };
      const expired = () => checkedAt > Date.now() || Date.now() - checkedAt > 60000;
      const stopExpired = async () => {
        await block(run, '等待期间库存证据已过期，已停止；请重新确认监控库存后再等待触发。');
        return { ok: false, triggered: run.tabId != null, run, error: run.state.reason };
      };
      const stopTriggered = async () => {
        run.trigger.status = 'cancelled';
        run.state = advanceCheckout(run.state, { type: 'CANCEL' }, Date.now()).state;
        log(run, '打开购买页时收到取消请求；已停止，不执行结账。'); await save(run);
        return { ok: true, triggered: true, cancelled: true, run };
      };
      if (expired()) return stopExpired();
      try {
        const tab = await api.tabs.create({ url: bagURL(run.state.intent.areaCode), active: true });
        run.tabId = tab.id; await save(run);
        if (cancelled()) return stopTriggered();
        if (expired()) return stopExpired();
        await api.alarms?.create('checkout-pulse', { periodInMinutes: 0.5 });
        if (cancelled()) return stopTriggered();
        if (expired()) return stopExpired();
        wake(700);
        return { ok: true, triggered: true, run };
      } catch {
        await block(run, '库存触发已消费，但购买标签页未能确认打开；不会自动再次打开。');
        return { ok: false, triggered: false, run, error: run.state.reason };
      }
    });
  }
  async function pageChanged(message, sender) {
    const run = await read();
    if (sender.id !== api.runtime.id || sender.frameId !== 0 || !isCheckoutURL(sender.url) ||
        sender.tab?.id !== run?.tabId || message.nonce !== run?.nonce || message.runId !== run?.state.intent.intentId) return false;
    wake(200); return true;
  }
  api.tabs.onUpdated?.addListener((id, change) => { if (change.status === 'complete') read().then(r => { if (r?.tabId === id) wake(); }); });
  api.tabs.onRemoved?.addListener(id => read().then(r => { if (r?.tabId === id) wake(); }));
  api.alarms?.onAlarm?.addListener(alarm => { if (alarm.name === 'checkout-pulse') wake(); });
  return { handle, pageChanged, wake, inventory, cancelArmed };
}
function actionLabel(kind) {
  return ({ 'select-product': '自动选择商品规格', 'add-to-bag': '自动加入购物袋', 'open-bag': '已加购，前往购物袋', checkout: '自动进入结账',
    'guest-checkout': '以访客身份继续结账', 'continue-shipping': '继续官网送货步骤', 'continue-billing': '继续官网付款方式步骤',
    'pickup-step': '继续官网自提门店与时段步骤',
    'edit-variant': '更改购物袋内同款商品颜色', 'submit-order': '提交一次未付款订单，之后只读取结果' })[kind] || kind;
}
