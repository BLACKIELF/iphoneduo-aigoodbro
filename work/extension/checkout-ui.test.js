import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function form(overrides = {}) {
  const product = { Model:'iPhone 17', Capacity:'512GB', Color:'Blue', Code:'MG744CH/A', Type:'iphone17' };
  const store = { StoreNumber:'R617', CityStoreName:'Changsha-Apple Changsha', Province:'Hunan', City:'Changsha' };
  const fields = Object.fromEntries(Object.entries({ model:product.Model, capacity:product.Capacity, color:product.Color,
    budget:'11999', fulfillment:'delivery', entry:'product', store:'R617', address:'District test' })
    .map(([key,value]) => [key,{ value }]));
  for (const key of ['submit','terms','replace','new']) fields[key] = { checked:true };
  for (const [key, value] of Object.entries(overrides)) Object.assign(fields[key], value);
  const context = vm.createContext({ document: { getElementById:id => fields[id.replace('checkout-','')] } });
  const source = readFileSync(new URL('./checkout-ui.js', import.meta.url),'utf8').replace(/^initialize\(\)\.catch.*$/m, '');
  vm.runInContext(source,context);
  vm.runInContext(`products=${JSON.stringify([product])}; stores=${JSON.stringify([store])};`,context);
  return trial => JSON.parse(JSON.stringify(vm.runInContext(`purchaseRequest(${trial})`,context)));
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
