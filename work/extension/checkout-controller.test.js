import assert from 'node:assert/strict';
import test from 'node:test';
import { createCheckoutController, isCheckoutURL } from './checkout-controller.js';

const product = { Code: 'MJTF4CH/A', Model: 'iPhone 18 Pro', Capacity: '512GB', Color: '冰川蓝色', Type: 'iphone18pro' };
const intent = { product, areaCode: 'cn', fulfillment: 'delivery', quantity: 1, maxTotal: 11999, allowSubmit: true, acknowledgedTerms: true };
const bag = { stage: 'BAG', product, cartItems: [{ product, quantity: 1 }], quantity: 1, controls: [{ kind: 'checkout' }] };
const review = { ...bag, stage: 'REVIEW', total: 11999, currency: 'CNY', fulfillment: 'delivery', paymentMethod: 'alipay', controls: [{ kind: 'submit-order' }] };
const clone = value => structuredClone(value);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function harness(t) {
  let now = 100000, nextTimer = 0, nextTab = 10;
  const timers = new Map(), tabs = new Map(), store = {}, events = [], listeners = {};
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', fn => { const id = ++nextTimer; timers.set(id, fn); return id; });
  t.mock.method(globalThis, 'clearTimeout', id => timers.delete(id));
  const h = { snapshot: clone(bag), actionError: null, unreachable: false, rejectSave: null, events, store, tabs };
  const api = {
    runtime: { id: 'test-extension' },
    storage: { local: {
      get: async () => clone(store),
      set: async value => {
        if (h.rejectSave?.(value)) throw new Error('storage unavailable');
        Object.assign(store, clone(value));
        events.push({ kind: 'save', run: clone(store.checkoutRun) });
        await h.afterSave?.(value);
      }
    } },
    tabs: {
      create: async options => { const tab = { id: nextTab++, status: 'complete', ...options }; tabs.set(tab.id, tab); events.push({ kind: 'create', options }); return clone(tab); },
      get: async id => { if (!tabs.has(id)) throw new Error('tab removed'); return clone(tabs.get(id)); },
      update: async (id, options) => { if (!tabs.has(id)) throw new Error('tab removed'); Object.assign(tabs.get(id), options); events.push({ kind: 'update', options }); return clone(tabs.get(id)); },
      reload: async id => { if (!tabs.has(id)) throw new Error('tab removed'); events.push({ kind: 'reload', id }); },
      sendMessage: async (id, message, options) => {
        events.push({ kind: 'message', id, message: clone(message), options, persistedRun: clone(store.checkoutRun) });
        if (h.unreachable) throw new Error('message port closed');
        if (message.type === 'checkout:bind') return { ok: true };
        if (message.type === 'checkout:snapshot') { await h.beforeSnapshot?.(); return { ok: true, snapshot: clone(h.snapshot) }; }
        if (message.type === 'checkout:act') {
          if (h.actionError instanceof Error) throw h.actionError;
          return h.actionError || { ok: true };
        }
        throw new Error('unexpected message');
      },
      onUpdated: { addListener: fn => { listeners.updated = fn; } },
      onRemoved: { addListener: fn => { listeners.removed = fn; } }
    },
    alarms: { create: async (name, options) => events.push({ kind: 'alarm', name, options }), onAlarm: { addListener: fn => { listeners.alarm = fn; } } }
  };
  const controller = createCheckoutController(api);
  return Object.assign(h, {
    controller, api, listeners,
    start: overrides => controller.handle({ type: 'checkout-start', intent: clone(intent), ...overrides }),
    status: async () => (await controller.handle({ type: 'checkout-status' })).run,
    actions: () => events.filter(event => event.kind === 'message' && event.message.type === 'checkout:act'),
    async pulse(advanceMs = 1000) {
      now += advanceMs;
      controller.wake(0);
      const [id, fn] = timers.entries().next().value;
      timers.delete(id);
      await fn();
      return (await controller.handle({ type: 'checkout-status' })).run;
    }
  });
}

test('checkout URL allowlist rejects alternate schemes and lookalike hosts', () => {
  assert.equal(isCheckoutURL('https://www.apple.com.cn/shop/bag'), true);
  assert.equal(isCheckoutURL('https://secure6.www.apple.com.cn/shop/checkout'), true);
  for (const url of ['http://www.apple.com.cn/shop/bag', 'https://www.apple.com.cn.evil.test/shop/bag', 'https://evil.test/shop/bag', 'https://www.apple.com.cn/support/', 'javascript:alert(1)']) assert.equal(isCheckoutURL(url), false);
});

test('start opens the bag first; an observed empty bag opens the chosen SKU', async t => {
  const h = harness(t);
  const started = await h.start();
  assert.equal(started.ok, true);
  assert.equal(h.events.find(event => event.kind === 'create').options.url, 'https://www.apple.com.cn/shop/bag');
  assert.equal(h.actions().length, 0);
  h.snapshot = { stage: 'BAG', bagEmpty: true, cartItems: [], controls: [] };
  await h.pulse();
  assert.equal(h.tabs.get(started.run.tabId).url, 'https://www.apple.com.cn/shop/product/MJTF4CH/A');
  assert.equal(h.actions().length, 0);
});

test('an empty parsed list without explicit empty-bag evidence cannot navigate', async t => {
  const h = harness(t);
  const started = await h.start();
  h.snapshot = { stage: 'BAG', cartItems: [], controls: [] };
  assert.equal((await h.pulse()).state.status, 'BLOCKED');
  assert.equal(h.tabs.get(started.run.tabId).url, 'https://www.apple.com.cn/shop/bag');
  assert.equal(h.actions().length, 0);
});

test('known out-of-stock product reloads at a bounded interval without checkout actions', async t => {
  const h = harness(t);
  await h.start();
  h.snapshot = { stage: 'PRODUCT', stockAvailable: false, controls: [] };
  assert.equal((await h.pulse()).state.status, 'WAITING_FOR_STOCK');
  assert.equal(h.actions().length, 0);
  assert.equal(h.events.filter(event => event.kind === 'reload').length, 0);
  await h.pulse(30000);
  assert.equal(h.events.filter(event => event.kind === 'reload').length, 1);
  assert.equal(h.actions().length, 0);
});

test('a pending submission never redirects an empty bag or edits a variant', async t => {
  const h = harness(t);
  const started = await h.start({ allowReplaceVariant: true });
  h.snapshot = clone(review);
  await h.pulse();
  const actionCount = h.actions().length;
  const updateCount = h.events.filter(event => event.kind === 'update').length;
  h.snapshot = { stage: 'BAG', bagEmpty: true, cartItems: [], controls: [] };
  await h.pulse();
  assert.equal(h.events.filter(event => event.kind === 'update').length, updateCount, 'submitted runs must only observe receipt');
  h.snapshot = { ...clone(bag), cartItems: [{ product: { ...product, Color: '银色' }, quantity: 1 }], controls: [{ kind: 'edit-variant' }] };
  await h.pulse();
  assert.equal(h.actions().length, actionCount, 'variant edit must respect durable submission fence');
});

test('a bag with exactly the requested item may enter checkout', async t => {
  const h = harness(t);
  await h.start();
  const run = await h.pulse();
  assert.equal(run.state.status, 'CHECKING_OUT');
  assert.deepEqual(h.actions().map(event => event.message.command.kind), ['checkout']);
});

test('an extra item, wrong colour, missing list or extra quantity cannot checkout', async t => {
  const h = harness(t);
  for (const cartItems of [undefined, [], [...bag.cartItems, ...bag.cartItems], [{ product, quantity: 2 }], [{ product: { ...product, Color: '银色' }, quantity: 1 }]]) {
    await h.start();
    h.snapshot = { ...clone(bag), cartItems };
    const before = h.actions().length;
    const run = await h.pulse();
    assert.equal(h.actions().length, before);
    if (cartItems?.length !== 0) assert.equal(run.state.status, 'BLOCKED');
    await h.controller.handle({ type: 'checkout-stop' });
  }
});

test('pending action is durably stored before dispatch and identical snapshots do not replay it', async t => {
  const h = harness(t);
  await h.start();
  await h.pulse();
  const action = h.actions()[0];
  assert.equal(action.persistedRun.pendingAction.id, action.message.actionId);
  assert.equal(action.persistedRun.pendingAction.kind, 'checkout');
  await h.pulse();
  assert.equal(h.actions().length, 1);
  const stopped = await h.pulse(13000);
  assert.equal(stopped.state.status, 'BLOCKED');
  assert.equal(h.actions().length, 1);
});

test('storage failure before dispatch prevents any click', async t => {
  const h = harness(t);
  await h.start();
  h.rejectSave = value => Boolean(value.checkoutRun.pendingAction);
  await h.pulse();
  assert.equal(h.actions().length, 0);
});

test('stop during an awaited snapshot prevents the pending pulse from submitting', async t => {
  const h = harness(t), entered = deferred(), release = deferred();
  await h.start();
  h.snapshot = clone(review);
  h.beforeSnapshot = async () => { entered.resolve(); await release.promise; };
  const pulse = h.pulse();
  await entered.promise;
  const stopped = h.controller.handle({ type: 'checkout-stop' });
  release.resolve();
  await Promise.all([pulse, stopped]);
  assert.equal(h.actions().length, 0);
  assert.equal((await h.status()).state.status, 'CANCELLED');
});

test('stop also fences a second pulse already queued behind an awaiting first pulse', async t => {
  const h = harness(t), entered = deferred(), release = deferred();
  await h.start();
  h.snapshot = clone(review);
  h.beforeSnapshot = async () => { h.beforeSnapshot = null; entered.resolve(); await release.promise; };
  const firstPulse = h.pulse();
  await entered.promise;
  const queuedPulse = h.pulse();
  const stopped = h.controller.handle({ type: 'checkout-stop' });
  release.resolve();
  await Promise.all([firstPulse, queuedPulse, stopped]);
  assert.equal(h.actions().length, 0);
  assert.equal((await h.status()).state.status, 'CANCELLED');
});

test('stop while the action fence is being saved prevents the click after save returns', async t => {
  const h = harness(t), entered = deferred(), release = deferred();
  await h.start();
  h.snapshot = clone(review);
  h.afterSave = async value => {
    if (value.checkoutRun.pendingAction?.kind === 'submit-order') {
      h.afterSave = null; entered.resolve(); await release.promise;
    }
  };
  const pulse = h.pulse();
  await entered.promise;
  const stopped = h.controller.handle({ type: 'checkout-stop' });
  release.resolve();
  await Promise.all([pulse, stopped]);
  assert.equal(h.actions().length, 0);
  assert.equal((await h.status()).state.status, 'SUBMISSION_UNKNOWN');
});

test('an unresolved add-to-bag cannot replay when its displayed price changes', async t => {
  const h = harness(t);
  await h.start();
  h.snapshot = { stage: 'PRODUCT', product, total: null, controls: [{ kind: 'add-to-bag' }] };
  await h.pulse();
  assert.equal(h.actions().length, 1);
  h.snapshot.total = 11999;
  await h.pulse();
  assert.equal(h.actions().length, 1);
  await h.pulse(13000);
  assert.equal(h.actions().length, 1);
});

test('model and colour selection carry different fields even before the summary updates', async t => {
  const h = harness(t);
  await h.start();
  h.snapshot = { stage: 'PRODUCT', product: null, total: null, controls: [{ kind: 'select-product', field: 'model' }] };
  await h.pulse();
  h.snapshot.controls[0].field = 'color';
  await h.pulse();
  assert.deepEqual(h.actions().map(action => action.message.command.field), ['model', 'color']);
  assert.notEqual(h.actions()[0].message.actionId, h.actions()[1].message.actionId);
});

test('submission fence is persisted before act and repeated review never resubmits', async t => {
  const h = harness(t);
  await h.start();
  await h.pulse();
  h.snapshot = clone(review);
  const submitted = await h.pulse();
  const submits = () => h.actions().filter(event => event.message.command.kind === 'submit-order');
  assert.equal(submits().length, 1);
  assert.equal(submitted.state.status, 'SUBMITTING');
  assert.equal(submits()[0].persistedRun.state.status, 'SUBMITTING');
  assert.equal(submits()[0].persistedRun.state.submitAttempt.attemptId, submits()[0].message.command.attemptId);
  await h.pulse();
  const uncertain = await h.pulse(16000);
  assert.equal(uncertain.state.status, 'SUBMISSION_UNKNOWN');
  assert.equal(submits().length, 1);
  const checked = await h.controller.handle({ type: 'checkout-resume' });
  assert.equal(checked.ok, true);
  assert.equal(checked.run.state.status, 'SUBMISSION_UNKNOWN');
  assert.equal(submits().length, 1);
});

test('manual receipt recheck resolves a late verified receipt without checkout actions', async t => {
  const h = harness(t);
  await h.start();
  h.snapshot = clone(review);
  await h.pulse();
  await h.pulse(16000);
  assert.equal((await h.status()).state.status, 'SUBMISSION_UNKNOWN');
  const actionCount = h.actions().length;
  h.snapshot = { stage: 'ORDER_CREATED', product, orderNumber: 'W1234567890', unpaid: true, receiptVerified: true, controls: [{ kind: 'checkout' }] };
  const checked = await h.controller.handle({ type: 'checkout-resume' });
  assert.equal(checked.ok, true);
  assert.equal(checked.run.state.status, 'ORDER_CREATED_UNPAID');
  assert.equal(checked.run.state.orderNumber, 'W1234567890');
  assert.equal(h.actions().length, actionCount);
  h.snapshot = { stage: 'PAYMENT', controls: [{ kind: 'checkout' }] };
  const checkedAgain = await h.controller.handle({ type: 'checkout-resume' });
  assert.equal(checkedAgain.run.state.status, 'ORDER_CREATED_UNPAID');
  assert.equal(h.actions().length, actionCount);
});

test('receipt recheck on an actionable product or bag never restarts purchases', async t => {
  const h = harness(t);
  await h.start({ allowReplaceVariant: true });
  h.snapshot = clone(review);
  await h.pulse();
  await h.pulse(16000);
  const actionCount = h.actions().length;
  const updateCount = h.events.filter(event => event.kind === 'update').length;
  for (const snapshot of [
    { stage: 'PRODUCT', stockAvailable: true, controls: [{ kind: 'add-to-bag' }] },
    { stage: 'BAG', bagEmpty: true, cartItems: [], controls: [] },
    { ...clone(bag), cartItems: [{ product: { ...product, Color: '银色' }, quantity: 1 }], controls: [{ kind: 'edit-variant' }] }
  ]) {
    h.snapshot = snapshot;
    const checked = await h.controller.handle({ type: 'checkout-resume' });
    assert.equal(checked.ok, true);
    assert.equal(checked.run.state.status, 'SUBMISSION_UNKNOWN');
    assert.equal(h.actions().length, actionCount);
    assert.equal(h.events.filter(event => event.kind === 'update').length, updateCount);
  }
});

test('a submit message port closure is not retried and a bound unpaid receipt completes', async t => {
  const h = harness(t);
  await h.start();
  await h.pulse();
  h.snapshot = clone(review);
  h.actionError = new Error('navigation closed port');
  await h.pulse();
  h.actionError = null;
  h.snapshot = { stage: 'ORDER_CREATED', product, orderNumber: 'W1234567890', unpaid: true, receiptVerified: true, controls: [] };
  const completed = await h.pulse();
  assert.equal(completed.state.status, 'ORDER_CREATED_UNPAID');
  assert.equal(h.actions().filter(event => event.message.command.kind === 'submit-order').length, 1);
});

test('price mismatch and missing authorization never submit', async t => {
  const h = harness(t);
  await h.start();
  h.snapshot = { ...clone(review), total: 12000 };
  assert.equal((await h.pulse()).state.status, 'BLOCKED');
  assert.equal(h.actions().length, 0);
  await h.start({ intent: { ...clone(intent), allowSubmit: false } });
  h.snapshot = clone(review);
  assert.equal((await h.pulse()).state.status, 'READY_TO_SUBMIT');
  assert.equal(h.actions().length, 0);
});

test('stop before submission prevents queued actions and permits a distinct task', async t => {
  const h = harness(t);
  const first = await h.start();
  assert.equal((await h.start()).ok, false);
  await h.controller.handle({ type: 'checkout-stop' });
  await h.pulse();
  assert.equal(h.actions().length, 0);
  const second = await h.start({ intent: { ...clone(intent), product: { ...product, Color: '银色' } } });
  assert.equal(second.ok, true);
  assert.notEqual(second.run.state.intent.intentId, first.run.state.intent.intentId);
  assert.notEqual(second.run.nonce, first.run.nonce);
  assert.notEqual(second.run.tabId, first.run.tabId);
  const oldSender = { id: h.api.runtime.id, frameId: 0, url: 'https://www.apple.com.cn/shop/bag', tab: { id: first.run.tabId } };
  assert.equal(await h.controller.pageChanged({ nonce: first.run.nonce, runId: first.run.state.intent.intentId }, oldSender), false);
});

test('stop after submission cannot hide the attempt or silently start a new order', async t => {
  const h = harness(t);
  await h.start();
  h.snapshot = clone(review);
  await h.pulse();
  const stopped = await h.controller.handle({ type: 'checkout-stop' });
  assert.equal(stopped.run.state.status, 'SUBMISSION_UNKNOWN');
  assert.equal((await h.start()).ok, false);
  await h.pulse();
  assert.equal(h.actions().filter(event => event.message.command.kind === 'submit-order').length, 1);
});

test('closed tab stops an unsubmitted task and preserves an uncertain submitted task', async t => {
  const h = harness(t);
  const first = await h.start();
  h.tabs.delete(first.run.tabId);
  assert.equal((await h.pulse()).state.status, 'BLOCKED');
  const second = await h.start();
  h.snapshot = clone(review);
  await h.pulse();
  h.tabs.delete(second.run.tabId);
  assert.equal((await h.pulse()).state.status, 'SUBMISSION_UNKNOWN');
  assert.equal(h.actions().filter(event => event.message.command.kind === 'submit-order').length, 1);
});

test('unreachable content script stops after bounded retries without clicking', async t => {
  const h = harness(t);
  await h.start();
  h.unreachable = true;
  for (let i = 0; i < 13; i++) await h.pulse();
  assert.equal((await h.status()).state.status, 'BLOCKED');
  assert.equal(h.actions().length, 0);
});

test('payment and identity pages halt rather than executing checkout controls', async t => {
  const h = harness(t);
  await h.start();
  h.snapshot = { stage: 'IDENTITY_CHALLENGE', controls: [{ kind: 'checkout' }] };
  assert.equal((await h.pulse()).state.status, 'WAITING_FOR_IDENTITY');
  assert.equal(h.actions().length, 0);
  await h.controller.handle({ type: 'checkout-resume' });
  h.snapshot = { stage: 'PAYMENT', controls: [{ kind: 'checkout' }] };
  assert.equal((await h.pulse()).state.status, 'PAYMENT_STOPPED');
  assert.equal(h.actions().length, 0);
});

test('page notifications require extension, top frame, tab, nonce and current run', async t => {
  const h = harness(t);
  const { run } = await h.start();
  const message = { nonce: run.nonce, runId: run.state.intent.intentId };
  const sender = { id: h.api.runtime.id, frameId: 0, url: 'https://www.apple.com.cn/shop/bag', tab: { id: run.tabId } };
  assert.equal(await h.controller.pageChanged(message, sender), true);
  for (const changed of [{ id: 'other' }, { frameId: 1 }, { url: 'https://evil.test/shop/bag' }, { tab: { id: run.tabId + 1 } }]) assert.equal(await h.controller.pageChanged(message, { ...sender, ...changed }), false);
  assert.equal(await h.controller.pageChanged({ ...message, nonce: 'wrong' }, sender), false);
  assert.equal(await h.controller.pageChanged({ ...message, runId: 'old-task' }, sender), false);
});
