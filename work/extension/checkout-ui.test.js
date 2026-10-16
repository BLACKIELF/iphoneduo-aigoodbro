import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function form(overrides = {}, sendMessage = async () => ({ ok:true, run:null })) {
  const product = { Model:'iPhone 17', Capacity:'512GB', Color:'Blue', Code:'MG744CH/A', Type:'iphone17' };
  const store = { StoreNumber:'R617', CityStoreName:'Changsha-Apple Changsha', Province:'Hunan', City:'Changsha' };
  const fields = Object.fromEntries(Object.entries({ model:product.Model, capacity:product.Capacity, color:product.Color,
    budget:'11999', fulfillment:'delivery', entry:'product', store:'R617', address:'District test' })
    .map(([key,value]) => [key,{ value }]));
  for (const key of ['submit','terms','replace','new']) fields[key] = { checked:true };
  for (const [key, value] of Object.entries(overrides)) Object.assign(fields[key], value);
  for (const key of ['status','resume','log','start','trial','arm','stop','open','message']) fields[key] = { replaceChildren() {} };
  const context = vm.createContext({ document: { getElementById:id => fields[id.replace('checkout-','')], createElement:() => ({}) },
    chrome:{ runtime:{ sendMessage } } });
  const source = readFileSync(new URL('./checkout-ui.js', import.meta.url),'utf8').replace(/^initialize\(\)\.catch.*$/m, '');
  vm.runInContext(source,context);
  vm.runInContext(`products=${JSON.stringify([product])}; stores=${JSON.stringify([store])};`,context);
  return Object.assign(trial => JSON.parse(JSON.stringify(vm.runInContext(`purchaseRequest(${trial})`,context))), {
    fields, start:(trial = false, armed = false) => vm.runInContext(`startPurchase(${trial},${armed})`,context),
    stop:() => vm.runInContext("command('checkout-stop')",context),
    current:() => JSON.parse(JSON.stringify(vm.runInContext('({run,busy,stopping})',context)))
  });
}
test('review trial strips submit permission even when the submit checkbox is checked', () => {
  const request = form()(true);
  assert.equal(request.intent.allowSubmit,false);
  assert.equal(request.intent.runMode,'review');
});
test('ordinary start preserves explicit submit choice and budget', () => {
  const request = form()(false);
  assert.equal(request.intent.allowSubmit,true);
  assert.equal(request.intent.maxTotal,11999);
  assert.equal(request.intent.runMode,'submit');
});
test('pickup carries exact store and public region only', () => {
  const request = form({ fulfillment:{value:'pickup'}, entry:{value:'bag'} })(false);
  assert.equal(request.intent.entryMode,'bag');
  assert.deepEqual(request.intent.pickup,{ storeNumber:'R617', storeName:'Apple Changsha',
    region:{state:'Hunan', city:'Changsha', address:'District test'}, slotPolicy:'earliest' });
});
test('missing budget or pickup region is rejected before starting', () => {
  assert.throws(() => form({budget:{value:''}})(false));
  assert.throws(() => form({fulfillment:{value:'pickup'},address:{value:''}})(false));
});

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('stop stays usable during inventory preflight and a late reply cannot arm checkout', async () => {
  const gate = deferred(), sent = [];
  const ui = form({ fulfillment:{value:'pickup'}, entry:{value:'bag'} }, async message => {
    sent.push(message.type);
    return message.type === 'get-backend-state' ? gate.promise : {ok:true, run:null};
  });
  const pending = ui.start(false,true);
  assert.equal(ui.fields.stop.disabled,false);
  await ui.stop();
  gate.resolve({ ok:true, monitoring:true, tasks:[{id:'fixture',areaCode:'cn',store:{StoreNumber:'R617'},product:{Code:'MG744CH/A'}}] });
  await pending;
  assert.deepEqual(sent,['get-backend-state','checkout-stop']);
  assert.equal(ui.current().busy,false);
  assert.equal(ui.current().run,null);
});

test('late start response cannot replace the stopped state in the dashboard', async () => {
  const gate = deferred(), sent = [];
  const stopped = { state:{status:'CANCELLED',reason:'Stopped'}, log:[] };
  const ui = form({}, async message => {
    sent.push(message.type);
    return message.type === 'checkout-start' ? gate.promise : {ok:true,run:stopped};
  });
  const pending = ui.start();
  assert.equal(ui.fields.stop.disabled,false);
  await ui.stop();
  gate.resolve({ok:true,run:{state:{status:'RUNNING',reason:'Late'},log:[]}});
  await pending;
  assert.deepEqual(sent,['checkout-start','checkout-stop']);
  assert.equal(ui.current().run.state.status,'CANCELLED');
  assert.equal(ui.fields.message.textContent,'Stopped');
});
