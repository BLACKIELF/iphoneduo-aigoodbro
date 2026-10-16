import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { createCheckoutController } from './checkout-controller.js';

const source = name => readFileSync(new URL(name, import.meta.url), 'utf8');
const domSource = source('./checkout-dom.js'), contentSource = source('./checkout-content.js');
const catalog = JSON.parse(source('./data/products/product_data_cn.json'));
const product = Object.values(catalog.products).flat().find(p => p.Code === 'MG744CH/A');
assert(product, 'The test target must come from the existing catalog');
const intent = { product, areaCode:'cn', fulfillment:'delivery', quantity:1, maxTotal:11999, allowSubmit:true, acknowledgedTerms:true };
// These values exist only in the local test fixture. They are NOT an Apple price or order.
const SYNTHETIC_TOTAL = 8799, TEST_ONLY_ORDER_NUMBER = 'W000000000000';
const clone = value => JSON.parse(JSON.stringify(value));

// No browser or network is used. Only the tiny DOM surface read by the real
// content script is modeled; all clicks change this local fixture alone.
function flow(t, options = {}) {
  let now = 100000, timerId = 0, page = 'EMPTY', listener;
  const timers = new Map(), saved = {}, messages = [], clicks = [];
  const choices = new Set();
  const tab = { id:1, status:'complete', url:'https://www.apple.com.cn/shop/bag' };
  let selectors = new Map();
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', fn => { const id = ++timerId; timers.set(id, fn); return id; });
  t.mock.method(globalThis, 'clearTimeout', id => timers.delete(id));
  const element = (value, attributes = {}, click = () => {}) => ({
    innerText:value, textContent:value, labels:[], disabled:false,
    getAttribute:key => attributes[key] ?? null,
    closest:() => null, getClientRects:() => [{}], contains:() => false,
    querySelectorAll:() => [], click,
    ...(attributes.href ? {href:attributes.href} : {})
  });
  const document = { body:null, documentElement:{}, querySelectorAll:selector => selectors.get(selector) || [], getElementById:() => null };
  const location = { href:tab.url, pathname:'/shop/bag' };
  const window = {}; window.top = window;
  const runtime = { id:'offline-flow-fixture', onMessage:{addListener:fn => {listener=fn;}}, sendMessage:async () => ({}) };
  const context = vm.createContext({URL, document, location, window, chrome:{runtime}, structuredClone,
    getComputedStyle:() => ({display:'block', visibility:'visible'}),
    MutationObserver:class {observe() {}}, setTimeout, clearTimeout});
  vm.runInContext(domSource, context);
  vm.runInContext(contentSource, context);

  function render(next) {
    page = next;
    const path = page === 'EMPTY' || page === 'BAG' ? '/shop/bag'
      : page === 'PRODUCT' ? '/shop/buy-iphone/iphone-17'
      : page === 'PAYMENT' ? '/shop/payment' : '/shop/checkout';
    tab.url = `${page === 'PRODUCT' || page === 'EMPTY' || page === 'BAG' ? 'https://www.apple.com.cn' : 'https://secure6.www.apple.com.cn'}${path}`;
    location.href = tab.url; location.pathname = path;
    const headings = [], names = [], rows = [], buttons = [], radios = [], links = [];
    const body = [];
    const button = (label, action) => {
      buttons.push(element(label, {}, () => { clicks.push({page, label}); action(); }));
    };
    if (page === 'EMPTY') headings.push(element('你的购物袋是空的。'));
    if (page === 'PRODUCT') {
      headings.push(element(product.Model));
      for (const [field, label] of [['model', product.Model], ['color', product.Color], ['capacity', product.Capacity]]) {
        const radio = element('', {'aria-label':label}, () => { clicks.push({page, field, label}); choices.add(field); render('PRODUCT'); });
        radio.checked = choices.has(field); radios.push(radio);
      }
      button('添加到购物袋', () => render('BAG'));
    }
    if (['BAG','REVIEW','RECEIPT'].includes(page)) {
      const p = page === 'REVIEW' && options.wrongReviewColor ? {...product, Color:'黑色'} : product;
      const name = element(`${p.Model} ${p.Capacity} ${p.Color} ${p.Code}`);
      const row = element(`${name.innerText} 数量 1`);
      row.contains = node => node === row || node === name; name.parentElement = row;
      names.push(name); rows.push(row); body.push(row.innerText);
      body.push(`总计 RMB ${page === 'REVIEW' && options.overBudget ? 12000 : SYNTHETIC_TOTAL}`);
    }
    if (page === 'BAG') button('结账', () => render('SHIPPING'));
    if (page === 'SHIPPING') {
      body.push('送货地址'); button('继续选择付款方式', () => render('BILLING'));
    }
    if (page === 'BILLING') {
      body.push('支付宝'); button('查看订单', () => render('REVIEW'));
    }
    if (page === 'REVIEW') {
      headings.push(element('准备下单了吗？'));
      body.push('送货地址 支付宝 Apple Store 条款和条件 立即下单');
      const payment = element('', {'aria-label':'支付宝', type:'radio', name:'paymentMethod'});
      payment.checked = true; radios.push(payment);
      links.push(element('条款和条件', {href:'https://www.apple.com.cn/shop/browse/open/salespolicies'}));
      button('立即下单', () => render(options.endAtPayment ? 'PAYMENT' : 'RECEIPT'));
    }
    if (page === 'RECEIPT') body.push(`仅用于离线合成测试 订单号 ${TEST_ONLY_ORDER_NUMBER} 未付款`);
    if (page === 'PAYMENT') {
      body.push('扫码支付'); button('立即付款', () => { throw new Error('A payment click is forbidden'); });
    }
    document.body = element([...headings.map(el => el.innerText), ...body].join(' '));
    selectors = new Map([
      ['[data-autom="bag-item-name"],[data-autom="review-item-name"],[data-autom="product-name"],.rs-iteminfo-title,h1,h2,h3', [...names,...headings]],
      ['[data-autom="bag-item"],[data-autom="review-item"],.rs-bag-item,.rs-review-item', rows],
      ['[data-autom="bag-item-name"],[data-autom="review-item-name"],.rs-iteminfo-title', names],
      ['input:checked,[role="radio"][aria-checked="true"]', radios.filter(r => r.checked)],
      ['input[type="radio"],[role="radio"]', radios],
      ['h1,h2,[role="dialog"]', headings], ['h1,h2', headings], ['h1,h2,p,[role="status"]', headings],
      ['button,a[href],input[type="submit"],[role="button"]', [...buttons,...links]], ['a[href]', links]
    ]);
  }
  render('EMPTY');
  const api = {
    runtime,
    storage:{local:{get:async () => clone(saved), set:async value => Object.assign(saved, clone(value))}},
    tabs:{
      create:async ({url}) => { assert.equal(url, 'https://www.apple.com.cn/shop/bag'); render('EMPTY'); return clone(tab); },
      get:async () => clone(tab),
      update:async (id, {url}) => {
        assert.equal(id, tab.id);
        assert.equal(url, 'https://www.apple.com.cn/shop/buy-iphone/iphone-17/mg744ch/a');
        // A locally rendered selector, not a navigation to Apple's live URL.
        render('PRODUCT'); return clone(tab);
      },
      sendMessage:async (id, message, target) => {
        assert.equal(id, tab.id); assert.equal(target.frameId, 0);
        const event = {message:clone(message), persisted:clone(saved.checkoutRun)};
        messages.push(event);
        let reply;
        listener(clone(message), {id:runtime.id}, value => {reply=clone(value);});
        assert(reply, `No content-script reply to ${message.type}`);
        event.reply = reply;
        return reply;
      },
      onUpdated:{addListener() {}}, onRemoved:{addListener() {}}
    },
    alarms:{create:async () => {}, onAlarm:{addListener() {}}}
  };
  const controller = createCheckoutController(api);
  return {
    clicks, messages,
    start:() => controller.handle({type:'checkout-start', intent:clone(intent)}),
    async pulse() {
      now += 1000; controller.wake(0);
      const [id, run] = timers.entries().next().value; timers.delete(id); await run();
      return clone(saved.checkoutRun);
    },
    async finish() {
      for (let i = 0; i < 16; i++) {
        const run = await this.pulse();
        if (['ORDER_CREATED_UNPAID','PAYMENT_STOPPED','BLOCKED','SUBMISSION_UNKNOWN'].includes(run.state.status)) return run;
      }
      assert.fail(`Flow did not finish: ${JSON.stringify(saved.checkoutRun.state)}`);
    }
  };
}

test('offline full message flow selects exact catalog product and creates one synthetic unpaid receipt', async t => {
  const h = flow(t);
  assert.equal((await h.start()).ok, true);
  const run = await h.finish();
  assert.equal(run.state.status, 'ORDER_CREATED_UNPAID');
  assert.equal(run.state.orderNumber, TEST_ONLY_ORDER_NUMBER);
  assert.equal(run.state.intent.product.Code, product.Code);
  const review = h.messages.find(m => m.reply?.snapshot?.stage === 'REVIEW').reply.snapshot;
  assert.deepEqual(review.product, Object.fromEntries(['Code','Model','Capacity','Color'].map(key => [key, product[key]])));
  assert.equal(review.cartItems.length, 1);
  assert.equal(review.quantity, 1);
  assert.equal(review.total, SYNTHETIC_TOTAL);
  assert.equal(review.fulfillment, 'delivery');
  assert.deepEqual(h.clicks.filter(c => c.field).map(c => c.label), [product.Model, product.Color, product.Capacity]);
  assert.deepEqual(h.clicks.filter(c => !c.field).map(c => c.label), ['添加到购物袋','结账','继续选择付款方式','查看订单','立即下单']);
  const submitted = h.messages.find(m => m.message.command?.kind === 'submit-order');
  assert.equal(submitted.persisted.state.status, 'SUBMITTING');
  assert.equal(submitted.persisted.state.submitAttempt.attemptId, submitted.message.command.attemptId);
  await h.pulse(); await h.pulse();
  assert.equal(h.clicks.filter(c => c.label === '添加到购物袋').length, 1);
  assert.equal(h.clicks.filter(c => c.label === '立即下单').length, 1);
});

for (const [name, options] of [['wrong review color', {wrongReviewColor:true}], ['over-budget total', {overBudget:true}]]) {
  test(`offline full message flow stops ${name} before submission`, async t => {
    const h = flow(t, options); await h.start();
    const run = await h.finish();
    assert.equal(run.state.status, 'BLOCKED');
    assert.equal(run.state.submitAttempt, null);
    assert.equal(h.clicks.filter(c => c.label === '立即下单').length, 0);
  });
}

test('offline full message flow stops on payment page without clicking payment', async t => {
  const h = flow(t, {endAtPayment:true}); await h.start();
  const run = await h.finish();
  assert.equal(run.state.status, 'PAYMENT_STOPPED');
  await h.pulse();
  assert.equal(h.clicks.filter(c => c.label === '立即下单').length, 1);
  assert.equal(h.clicks.filter(c => c.label === '立即付款').length, 0);
});
