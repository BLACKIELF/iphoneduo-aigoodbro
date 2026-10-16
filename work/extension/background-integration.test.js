import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';
import {createCheckoutState, advanceCheckout, recoverCheckout} from './checkout-state.js';
import {productPurchaseURL} from './shared.js';
import {normalizeNotificationSettings} from './notifications.js';
import {createNativeClient, redactText} from './native-client.js';

const backgroundSource = readFileSync(new URL('./background.js', import.meta.url), 'utf8');
const controllerSource = readFileSync(new URL('./checkout-controller.js', import.meta.url), 'utf8');
const product = {Code:'MJTF4CH/A', Model:'iPhone 18 Pro', Capacity:'512GB', Color:'冰川蓝色', Type:'iphone18pro'};
const pickup = {storeNumber:'R617', storeName:'Apple 长沙', region:{state:'湖南', city:'长沙', address:'芙蓉区'}, slotPolicy:'earliest'};
const intent = {intentId:'previous', revision:1, product, areaCode:'cn', fulfillment:'pickup', pickup, quantity:1,
  maxTotal:11999, entryMode:'bag', runMode:'submit', allowSubmit:true, acknowledgedTerms:true};
const task = {id:'task-1', areaCode:'cn', store:{StoreNumber:'R617'}, product};
const identity = `cn:R617:${product.Code}`;
const settings = {intervalSeconds:30, barkUrl:'', feishuWebhook:'', feishuSecret:''};
const STOCK_ALARM = 'checkout-stock-status';
const clone = value => structuredClone(value);
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
const flush = async () => {for (let index = 0; index < 40; index++) await Promise.resolve();};
const stripImports = source => source.replace(/^import .*;\r?\n/gm, '');
const stoppedRun = () => ({state:{...createCheckoutState(intent, Date.now()), status:'CANCELLED'}, log:[], tabId:null, nonce:'previous'});
const armedRun = () => ({...stoppedRun(), state:{...createCheckoutState(intent, Date.now()), status:'WAITING_FOR_STOCK'},
  trigger:{status:'armed', taskId:task.id, identity, armedAt:Date.now()-1000, consumedAt:null}});

// Use the real background router, controller, state machine and Native client.
// Chrome APIs, the clock-driven wakeups and Apple inventory-page cancellation are
// local doubles: this suite cannot open a real tab, request stock or place an order.
function harness({initialRun = stoppedRun(), accessGate, cancelGate, initialReadGate, alarmGetGate} = {}) {
  const store = {checkoutRun:clone(initialRun), tasks:[clone(task)], notificationSettings:clone(settings)};
  const events = [], alarms = new Map(), listeners = {alarm:[]};
  const nativeState = {ok:true, tasks:[clone(task)], notificationSettings:clone(settings), monitoring:true,
    monitorState:{running:true, checking:false, items:{}, log:[], lastCheck:''}};
  let runReads = 0, alarmReads = 0, nextTab = 10;
  const api = {
    runtime:{id:'integration-fixture', getURL:path => 'chrome-extension://integration-fixture/'+path,
      onInstalled:{addListener() {}}, onStartup:{addListener(fn) {listeners.startup = fn;}},
      onMessage:{addListener(fn) {listeners.message = fn;}},
      sendNativeMessage(host, request, reply) {
        events.push({kind:'native', host, request:clone(request)});
        if (request.action === 'start' || request.action === 'stop') {
          nativeState.monitoring = request.action === 'start';
          nativeState.monitorState.running = nativeState.monitoring;
        }
        if (request.tasks) nativeState.tasks = clone(request.tasks);
        reply(clone(nativeState));
      }},
    action:{onClicked:{addListener() {}}},
    storage:{local:{
      async setAccessLevel() {await accessGate?.promise;},
      async get(keys) {
        const result = clone(Object.fromEntries((typeof keys === 'string' ? [keys] : keys).map(key => [key, store[key]])));
        if (keys === 'checkoutRun' && runReads++ === 0 && initialReadGate) await initialReadGate.promise;
        return result;
      },
      async set(value) {Object.assign(store, clone(value)); events.push({kind:'save', run:clone(store.checkoutRun)});}
    }},
    tabs:{
      async create(options) {events.push({kind:'create', options:clone(options)}); return {id:nextTab++, ...options};},
      async update(id, options) {events.push({kind:'update', id, options:clone(options)}); return {id, ...options};},
      async get(id) {return {id, url:'https://www.apple.com.cn/shop/bag', status:'complete'};},
      onUpdated:{addListener() {}}, onRemoved:{addListener() {}}
    },
    alarms:{
      async get(name) {const result = alarms.get(name); if (alarmReads++ === 0 && alarmGetGate) await alarmGetGate.promise; return result;},
      async create(name, options) {events.push({kind:'alarm-create', name}); alarms.set(name, clone(options));},
      async clear(name) {events.push({kind:'alarm-clear', name}); alarms.delete(name);},
      onAlarm:{addListener(fn) {listeners.alarm.push(fn);}}
    }
  };
  // A separate VM isolates the controller's timers without replacing production logic.
  const controllerContext = {createCheckoutState, advanceCheckout, recoverCheckout, productPurchaseURL,
    crypto:{randomUUID}, Date, URL, setTimeout:() => 1, clearTimeout() {}};
  vm.runInNewContext(stripImports(controllerSource).replace(/^export /gm, '') + '\nglobalThis.factory=createCheckoutController;', controllerContext);
  const context = {
    chrome:api, productPurchaseURL, normalizeNotificationSettings, redactText,
    createNativeClient:runtime => createNativeClient(runtime, {setTimer:() => 1, clearTimer() {}}),
    createCheckoutController:controllerContext.factory,
    createInventoryPageClient:() => ({
      async cancel() {events.push({kind:'inventory-cancel'}); await cancelGate?.promise;},
      async query() {throw new Error('unexpected Apple inventory query');}
    })
  };
  vm.runInNewContext(stripImports(backgroundSource) + '\nglobalThis.handle=handleMessage;', context);
  const handle = message => new Promise(resolve => listeners.message(message,
    {id:api.runtime.id, url:api.runtime.getURL('app.html'), frameId:0}, resolve));
  return {handle, store, events, alarms, nativeState, fireAlarm:() => listeners.alarm.forEach(fn => fn({name:STOCK_ALARM}))};
}

const startMessage = type => ({type, intent:clone(intent), taskId:task.id, identity});
const createdTabs = h => h.events.filter(event => event.kind === 'create');

for (const waitAt of ['inventory cancellation', 'storage initialization']) {
  for (const type of ['checkout-start', 'checkout-arm']) {
    test(`${type} waiting on ${waitAt} cannot run after checkout-stop`, async () => {
      const gate = deferred();
      const h = harness(waitAt === 'inventory cancellation' ? {cancelGate:gate} : {accessGate:gate});
      await flush();
      const pendingStart = h.handle(startMessage(type));
      await flush();
      const pendingStop = h.handle({type:'checkout-stop'});
      await flush();
      assert.equal(h.store.checkoutRun.state.status, 'CANCELLED');
      gate.resolve();
      const [start, stop] = await Promise.all([pendingStart, pendingStop]);
      assert.equal(stop.ok, true);
      assert.equal(start.ok, false, 'an older start must not become a new authorization after stopping');
      assert.equal(h.store.checkoutRun.state.status, 'CANCELLED');
      assert.notEqual(h.store.checkoutRun.trigger?.status, 'armed');
      assert.equal(createdTabs(h).length, 0);
    });
  }
}

for (const type of ['stop-monitor', 'save-tasks', 'start-monitor']) {
  test(`pending checkout-arm is invalidated by ${type}`, async () => {
    const gate = deferred();
    const h = harness({cancelGate:gate});
    await flush();
    const pendingArm = h.handle(startMessage('checkout-arm'));
    await flush();
    const pendingChange = h.handle({type, tasks:[clone(task)], notificationSettings:clone(settings)});
    await flush();
    gate.resolve();
    const [arm, change] = await Promise.all([pendingArm, pendingChange]);
    assert.equal(change.ok, true);
    assert.equal(arm.ok, false, 'an old arm request must not survive a monitor/task mutation');
    assert.notEqual(h.store.checkoutRun.trigger?.status, 'armed');
    assert.equal(createdTabs(h).length, 0);
    assert.equal(h.alarms.has(STOCK_ALARM), false);
  });
}

test('checkout-resume waiting for storage cannot revive a task after checkout-stop', async () => {
  const gate = deferred();
  const h = harness({initialRun:{...stoppedRun(), tabId:10}, accessGate:gate});
  const pendingResume = h.handle({type:'checkout-resume'});
  await flush();
  const pendingStop = h.handle({type:'checkout-stop'});
  await flush();
  gate.resolve();
  const [resume, stop] = await Promise.all([pendingResume, pendingStop]);
  assert.equal(stop.ok, true);
  assert.equal(resume.ok, false);
  assert.equal(h.store.checkoutRun.state.status, 'CANCELLED');
  assert.equal(createdTabs(h).length, 0);
});

test('delayed initialization cannot clear the alarm for a newly armed task', async () => {
  const gate = deferred();
  const h = harness({initialRun:null, initialReadGate:gate});
  await flush();
  const pendingArm = h.handle(startMessage('checkout-arm'));
  await flush();
  assert.equal(h.store.checkoutRun.trigger.status, 'armed');
  // Release initialization before awaiting arm: alarm reconciliation may be serialized.
  gate.resolve();
  assert.equal((await pendingArm).ok, true);
  await flush();
  assert.equal(h.alarms.has(STOCK_ALARM), true);
});

test('delayed armed reconciliation cannot recreate a stock alarm after stopping', async () => {
  const gate = deferred();
  const h = harness({initialRun:armedRun(), alarmGetGate:gate});
  await flush();
  const pendingStop = h.handle({type:'checkout-stop'});
  await flush();
  assert.equal(h.store.checkoutRun.state.status, 'CANCELLED');
  gate.resolve();
  assert.equal((await pendingStop).ok, true);
  await flush();
  assert.equal(h.alarms.has(STOCK_ALARM), false);
  assert.equal(createdTabs(h).length, 0);
});

test('Native status routed from an alarm consumes matching fresh stock only once', async () => {
  const h = harness();
  await flush();
  assert.equal((await h.handle(startMessage('checkout-arm'))).ok, true);
  h.store.checkoutRun.trigger.armedAt = Date.now()-1000;
  h.nativeState.monitorState.items[task.id] = {available:true, identity, checkedAt:new Date(Date.now()-10).toISOString()};
  h.fireAlarm();
  await h.handle({type:'get-backend-state'}); // Queue barrier after the alarm.
  await h.handle({type:'get-backend-state'});
  assert.equal(createdTabs(h).length, 1);
  assert.equal(createdTabs(h)[0].options.url, 'https://www.apple.com.cn/shop/bag');
  assert.equal(h.store.checkoutRun.trigger.status, 'consumed');
  assert.equal(h.alarms.has(STOCK_ALARM), false);
  assert.ok(h.events.filter(event => event.kind === 'native').every(event => event.request.action === 'status'));
});

test('a mismatched Native stock identity cannot open a checkout tab', async () => {
  const h = harness();
  await flush();
  assert.equal((await h.handle(startMessage('checkout-arm'))).ok, true);
  h.store.checkoutRun.trigger.armedAt = Date.now()-1000;
  h.nativeState.monitorState.items[task.id] = {available:true, identity:'cn:R999:'+product.Code, checkedAt:new Date(Date.now()-10).toISOString()};
  await h.handle({type:'get-backend-state'});
  assert.equal(createdTabs(h).length, 0);
  assert.equal(h.store.checkoutRun.trigger.status, 'armed');
  assert.equal(h.alarms.has(STOCK_ALARM), true);
});
