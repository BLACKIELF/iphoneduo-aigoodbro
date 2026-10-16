import { createCheckoutState, advanceCheckout, recoverCheckout } from './checkout-state.js';
import { productPurchaseURL } from './shared.js';

const KEY = 'checkoutRun';
const HALTED = new Set(['CANCELLED', 'BLOCKED', 'WAITING_FOR_IDENTITY', 'READY_TO_SUBMIT', 'ORDER_CREATED_UNPAID', 'PAYMENT_STOPPED', 'SUBMISSION_UNKNOWN']);
export function isCheckoutURL(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && ['www.apple.com.cn', 'secure6.www.apple.com.cn'].includes(url.hostname) && url.pathname.startsWith('/shop/');
  } catch { return false; }
}

export function createCheckoutController(api) {
  let queue = Promise.resolve(), timer, cancellationEpoch = 0, stopPending = false;
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
      await block(run, '加入购物袋的结果尚未确认；请核对购物袋，不会重复加购。'); return;
    }
    const signature = JSON.stringify([snapshot.stage, command, snapshot.product, snapshot.cartItems, snapshot.total]);
    // Persist before dispatch. A timeout cannot replay an add-to-bag or submit click.
    if (run.pendingAction?.signature === signature) {
      if (Date.now() - run.pendingAction.at < 12000) { wake(1000); return; }
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
    } catch {
      run.connectionFailures = (run.connectionFailures || 0) + 1;
      if (run.connectionFailures > 12) { await block(run, '无法连接购买页面，请更新扩展后重新打开购买标签页。'); return; }
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
      if (run.bagAttempt) { await block(run, '加购后购物袋仍为空，请核对结果；不会自动重复加购。'); return; }
      run.pendingAction = null; log(run, '购物袋为空，打开指定商品。'); await save(run);
      if (expectedEpoch !== cancellationEpoch) return;
      await api.tabs.update(run.tabId, { url: productPurchaseURL(run.state.intent) });
      wake(1000); return;
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
    if (!run.state.submitAttempt && snapshot.stage === 'BAG' && run.allowReplaceVariant && snapshot.cartItems?.length === 1 && item?.quantity === 1 &&
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
    await save(run);
    if (transition.effect?.type === 'SUBMIT_ORDER') {
      // SUBMITTING has already been stored. There is no retry path for this effect.
      await act(run, snapshot, { kind: 'submit-order', attemptId: transition.effect.attemptId }, expectedEpoch); return;
    }
    if (HALTED.has(run.state.status)) return;
    if (run.state.status === 'SUBMITTING') {
      if (run.pendingAction && Date.now() - run.pendingAction.at > 15000) {
        run.state = recoverCheckout(run.state, Date.now()); log(run, '未读取到订单结果，请到官网核对；不会重复提交。'); await save(run);
      } else wake(800);
      return;
    }
    const kinds = new Set((snapshot.controls || []).map(c => c.kind));
    let command;
    if (snapshot.stage === 'PRODUCT') {
      if (kinds.has('select-product')) command = { kind: 'select-product', field: snapshot.controls.find(c => c.kind === 'select-product').field, product: run.state.intent.product };
      else if (kinds.has('add-to-bag')) command = { kind: 'add-to-bag', product: run.state.intent.product };
    } else if (snapshot.stage === 'BAG' && kinds.has('checkout')) command = { kind: 'checkout' };
    else if (snapshot.stage === 'CHECKOUT') {
      for (const kind of ['continue-shipping', 'continue-billing', 'checkout']) if (kinds.has(kind)) { command = { kind }; break; }
    }
    if (command) { run.noActionSince = null; await act(run, snapshot, command, expectedEpoch); return; }
    // Give a dynamic page a short bounded settling window, never a blind click.
    run.noActionSince ||= Date.now();
    if (Date.now() - run.noActionSince > 12000) { await block(run, (snapshot.issues || []).join('；') || '此页面需要补充信息，程序已停止。'); return; }
    await save(run); wake(700);
  }
  async function handle(message) {
    // Stop takes priority even while a snapshot or persistence call is awaiting a response.
    if (message.type === 'checkout-stop') { stopPending = true; cancellationEpoch++; clearTimeout(timer); }
    return serial(async () => {
      let run = await read();
      if (message.type === 'checkout-status') return { ok: true, run };
      if (message.type === 'checkout-start') {
        if (stopPending) return { ok: false, error: '正在停止上一项任务，请稍候。' };
        const startEpoch = cancellationEpoch;
        if (run && !HALTED.has(run.state.status)) return { ok: false, error: '已有购买任务运行中，请先停止。' };
        if (run && (run.state.submitAttempt || ['SUBMISSION_UNKNOWN', 'ORDER_CREATED_UNPAID', 'PAYMENT_STOPPED'].includes(run.state.status)) && !message.newIntentAcknowledged)
          return { ok: false, error: '上次任务已有提交或付款结果，请先核对官网订单，再明确开始新订单。' };
        const state = createCheckoutState({ ...message.intent, intentId: crypto.randomUUID(), revision: 1 }, Date.now());
        run = { state, nonce: crypto.randomUUID(), tabId: null, allowReplaceVariant: message.allowReplaceVariant === true, log: [] };
        log(run, '已创建单次购买任务，先检查购物袋。'); await save(run);
        if (stopPending || startEpoch !== cancellationEpoch) return { ok: false, error: '启动已被停止请求取消。', run };
        stopPending = false;
        const tab = await api.tabs.create({ url: 'https://www.apple.com.cn/shop/bag', active: true });
        run.tabId = tab.id; await save(run);
        await api.alarms?.create('checkout-pulse', { periodInMinutes: 0.5 }); wake(700);
        return { ok: true, run };
      }
      if (!run) return { ok: false, error: '尚未创建购买任务。' };
      if (message.type === 'checkout-stop') {
        run.state = advanceCheckout(run.state, { type: 'CANCEL' }, Date.now()).state;
        log(run, '已请求停止；已提交的订单不会自动撤销。'); await save(run); stopPending = false; return { ok: true, run };
      }
      if (message.type === 'checkout-open') {
        if (run.tabId) await api.tabs.update(run.tabId, { active: true });
        return { ok: true, run };
      }
      if (message.type === 'checkout-resume') {
        if (run.state.submitAttempt || ['SUBMISSION_UNKNOWN', 'ORDER_CREATED_UNPAID', 'PAYMENT_STOPPED', 'SUBMITTING'].includes(run.state.status))
          { await pulse({ receiptOnly: true }); return { ok: true, run: await read() }; }
        const uncertainBag = run.pendingAction?.kind === 'add-to-bag';
        run.state.status = 'RUNNING'; run.pendingAction = null; run.noActionSince = null; run.connectionFailures = 0;
        log(run, '继续当前任务，重新核对页面。'); await save(run);
        if (uncertainBag) await api.tabs.update(run.tabId, { url: 'https://www.apple.com.cn/shop/bag' });
        wake(); return { ok: true, run };
      }
      return { ok: false, error: '未知购买操作。' };
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
  return { handle, pageChanged, wake };
}
function actionLabel(kind) {
  return ({ 'select-product': '自动选择商品规格', 'add-to-bag': '自动加入购物袋', checkout: '自动进入结账',
    'continue-shipping': '继续官网送货步骤', 'continue-billing': '继续官网付款方式步骤',
    'edit-variant': '更改购物袋内同款商品颜色', 'submit-order': '提交一次未付款订单，之后只读取结果' })[kind] || kind;
}
