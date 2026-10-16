import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import {advanceCheckout, createCheckoutState} from './checkout-state.js';

const product = {Code:'MJTF4CH/A', Model:'iPhone 18 Pro', Capacity:'512GB', Color:'冰川蓝色', Type:'iphone18pro'};
const intent = {intentId:'content-snapshot-test', revision:1, product, areaCode:'cn', fulfillment:'delivery', quantity:1, maxTotal:11999, allowSubmit:true, acknowledgedTerms:true};
const domSource = readFileSync(new URL('./checkout-dom.js', import.meta.url), 'utf8');
const pickupSource = readFileSync(new URL('./checkout-pickup.js', import.meta.url), 'utf8');
const contentSource = readFileSync(new URL('./checkout-content.js', import.meta.url), 'utf8');
const productName = color => `iPhone 18 Pro 512GB ${color || product.Color}`;

// A local DOM fixture for the selectors used by the content script. Clicks only
// increment a counter; there is no browser, network, or navigation.
function contentFixture({phase='CHECKOUT', rows=[], bodyText='', heading, selectedLabel, totals=[], errors=[], looseNames=[], paymentChoices=[], images=[], links=[], bindIntent=intent, step='', controlAutom, pickupChoices=[], pathname} = {}) {
  let clicks = 0;
  const element = (value, attributes={}, appearance={}) => ({
    innerText:value, textContent:value, labels:[], disabled:false,
    getAttribute:key => attributes[key] ?? null,
    closest() {return appearance.hidden ? this : null;},
    style:{display:appearance.display || 'block', visibility:appearance.visibility || 'visible'},
    getClientRects:() => [{}],
    contains:() => false,
    querySelectorAll:() => [],
    click:() => {clicks++;}
  });
  const names = rows.map(row => element(row.name, {'data-autom':'bag-item-name'}));
  const items = rows.map((row, index) => {
    const item = element(`${row.name}${row.quantity === undefined ? '' : ` 数量 ${row.quantity}`}`, {'data-autom':row.autom || 'bag-item'});
    item.contains = node => node === item || node === names[index];
    names[index].parentElement = row.nestedName ? element(row.name) : item;
    return item;
  });
  names.push(...looseNames.map(name => element(name, {'data-autom':'bag-item-name'})));
  const headings = (Array.isArray(heading) ? heading : heading ? [heading] : []).map(value => element(value));
  const controls = phase === 'REVIEW' ? [element('立即下单',controlAutom ? {'data-autom':controlAutom} : {})] : phase === 'CHECKOUT' ? [element('继续选择付款方式')] : [];
  const selected = selectedLabel ? [element('', {'aria-label':selectedLabel})] : [];
  const paymentNodes = paymentChoices.map(choice => {
    const node = element('', {'aria-label':choice.label, type:choice.type || 'radio', name:'paymentMethod', ...(choice.autom ? {'data-autom':choice.autom} : {})}, choice);
    node.checked = choice.checked === true; node.value = choice.value || '';
    return node;
  });
  const pickupNodes = pickupChoices.map(choice => {
    const node=element('',{type:'radio',name:'store-locator-result'},choice);node.value=choice.value;node.checked=choice.checked===true;
    if(choice.title){const title=element(choice.title);const label=element(choice.title);label.querySelectorAll=selector=>selector==='.form-selector-title'?[title]:[];node.labels=[label];}
    return node;
  });
  const imageNodes = images.map(alt => ({...element('', {alt}), alt}));
  const linkNodes = links.map(href => ({...element('销售条款', {href}), href}));
  const totalNodes = totals.map(total => element(total.text, {'data-autom':total.autom}, total));
  const errorNodes = errors.map(error => element(error.text, {class:error.className}, error));
  const visibleText = (nodes, specs) => nodes.filter((_, i) => !specs[i].hidden && specs[i].display !== 'none' && specs[i].visibility !== 'hidden').map(node => node.innerText);
  const body = element([...headings.map(node => node.innerText), ...items.map(item => item.innerText), ...looseNames, ...paymentChoices.map(choice => choice.label), ...visibleText(totalNodes, totals), ...visibleText(errorNodes, errors), bodyText].filter(Boolean).join(' '));
  const selectors = new Map([
    ['[data-autom="bag-item-name"]', names],
    ['[data-autom="bag-item"]', items.filter(item => item.getAttribute('data-autom') === 'bag-item')],
    ['[data-autom^="bag-item-"]', [...items, ...names].filter(item => item.getAttribute('data-autom').startsWith('bag-item-'))],
    ['input:checked', [...selected, ...paymentNodes.filter(node => node.checked), ...pickupNodes.filter(node => node.checked)]],
    ['input[name="store-locator-result"]',pickupNodes], ['h1', headings], ['button', controls],
    ['img[alt]', imageNodes], ['a[href]', linkNodes],
    ...totals.map(total => [`[data-autom="${total.autom}"]`, totalNodes.filter(node => node.getAttribute('data-autom') === total.autom)]),
    ...errors.map(error => [`.${error.className}`, errorNodes.filter(node => node.getAttribute('class') === error.className)])
  ]);
  const document = {body, documentElement:{}, querySelectorAll:selector => [...new Set(selector.split(',').flatMap(part => selectors.get(part) || []))], getElementById:() => null};
  const location = new URL(`https://secure6.www.apple.com.cn/shop/${phase === 'BAG' ? 'bag' : 'checkout'}`);
  if (pathname) location.pathname=pathname;
  if (step) location.search = '?_s=' + step;
  const window = {}; window.top = window;
  let listener;
  const runtime = {id:'fixture-extension', onMessage:{addListener:fn => {listener=fn;}}, sendMessage:async () => ({})};
  const context = vm.createContext({URL, document, location, window, chrome:{runtime}, structuredClone,
    getComputedStyle:node => node.style,
    MutationObserver:class {observe() {}}, setTimeout, clearTimeout});
  vm.runInContext(domSource, context);
  vm.runInContext(pickupSource, context);
  vm.runInContext(contentSource, context);
  const nonce = 'fixture-nonce-123456789', runId = 'fixture-run';
  const message = payload => {
    let reply;
    listener({...payload, nonce, runId}, {id:runtime.id}, value => {reply=value;});
    assert(reply, 'content script must answer the fixture message');
    return JSON.parse(JSON.stringify(reply));
  };
  assert.equal(message({type:'checkout:bind', intent:bindIntent}).ok, true);
  return {
    snapshot:() => message({type:'checkout:snapshot'}).snapshot,
    act:kind => message({type:'checkout:act', actionId:`fixture-action-${kind}`, expectedStage:phase, command:{kind}}),
    clicks:() => clicks
  };
}

function snapshotOf(options) {return contentFixture(options).snapshot();}

function advance(snapshot) {
  return advanceCheckout(createCheckoutState(intent, 1000), {type:'OBSERVE', observation:{...snapshot, phase:snapshot.stage}}, 2000);
}

test('content snapshot omits unobserved intermediate cart and lets checkout continue', () => {
  const snapshot = snapshotOf({bodyText:'送货地址'});
  assert.equal(snapshot.stage, 'CHECKOUT');
  assert.equal(snapshot.product, null);
  const result = advance(snapshot);
  assert.equal(result.state.status, 'CHECKING_OUT');
  assert.equal(Object.hasOwn(snapshot, 'cartItems'), false);
  assert.equal(Object.hasOwn(snapshot, 'quantity'), false);
  assert.deepEqual(result.effect.allowedActions, ['CONTINUE_CHECKOUT']);
});

test('content snapshot preserves visible quantity without a rendered cart', () => {
  const snapshot = snapshotOf({bodyText:'送货地址 数量 2'});
  assert.equal(snapshot.quantity, 2);
  assert.equal(advance(snapshot).state.status, 'BLOCKED');
  const conflicting = snapshotOf({bodyText:'数量 1 Quantity 2'});
  assert.equal(conflicting.quantity, null);
  assert.equal(advance(conflicting).state.status, 'BLOCKED');
});

test('content snapshot preserves exact visible checkout cart', () => {
  const snapshot = snapshotOf({rows:[{name:productName(), quantity:1}]});
  assert.equal(snapshot.cartItems.length, 1);
  assert.equal(snapshot.quantity, 1);
  assert.equal(advance(snapshot).state.status, 'CHECKING_OUT');
});

test('content snapshot never omits known checkout product or quantity mismatches', () => {
  for (const row of [{name:productName('银色'), quantity:1}, {name:productName(), quantity:2}]) {
    const snapshot = snapshotOf({rows:[row]});
    assert.equal(snapshot.cartItems.length, 1);
    assert.equal(advance(snapshot).state.status, 'BLOCKED');
  }
});

test('visible product with unknown quantity remains blocked', () => {
  const snapshot = snapshotOf({rows:[{name:productName()}]});
  assert.equal(snapshot.quantity, null);
  assert.equal(snapshot.cartItems[0].quantity, null);
  assert.equal(advance(snapshot).state.status, 'BLOCKED');
});

test('visible selected product without a verifiable cart remains blocked', () => {
  const snapshot = snapshotOf({selectedLabel:productName()});
  assert.equal(snapshot.product.Model, product.Model);
  assert.deepEqual(snapshot.cartItems, []);
  assert.equal(advance(snapshot).state.status, 'BLOCKED');
});

test('unparsed visible checkout row and additional products remain blocked', () => {
  for (const rows of [[{name:'Unrecognized accessory', quantity:1}], [{name:productName(), quantity:1}, {name:productName('银色'), quantity:1}]]) {
    const snapshot = snapshotOf({rows});
    assert.equal(snapshot.cartItems.length, rows.length);
    assert.equal(advance(snapshot).state.status, 'BLOCKED');
  }
});

test('empty BAG keeps explicit empty evidence and does not pass cart validation', () => {
  const snapshot = snapshotOf({phase:'BAG', heading:'你的购物袋是空的。'});
  assert.equal(snapshot.stage, 'BAG');
  assert.equal(snapshot.bagEmpty, true);
  assert.deepEqual(snapshot.cartItems, []);
  assert.equal(snapshot.quantity, null);
  assert.equal(advance(snapshot).state.status, 'BLOCKED');
});

test('REVIEW without rendered cart still requires complete order evidence', () => {
  const snapshot = snapshotOf({phase:'REVIEW', heading:'准备下单了吗？', bodyText:'总计 RMB 11,999 送货地址 支付宝'});
  assert.equal(snapshot.stage, 'REVIEW');
  assert.deepEqual(snapshot.cartItems, []);
  assert.equal(snapshot.quantity, null);
  assert.equal(advance(snapshot).state.status, 'BLOCKED');
});

const completeReview = changes => ({phase:'REVIEW', heading:'准备下单了吗？', rows:[{name:productName(), quantity:1}], bodyText:'送货地址 Apple Store 条款和条件 立即下单', paymentChoices:[{label:'支付宝', checked:true}], links:['https://www.apple.com.cn/shop/browse/open/salespolicies'], ...changes});

test('review accepts explicitly selected Alipay and may submit exactly the verified cart', () => {
  const fixture = contentFixture(completeReview({totals:[{autom:'order-total', text:'RMB 11,999'}], paymentChoices:[{label:'支付宝', checked:true}, {label:'信用卡', checked:false}]}));
  assert.equal(fixture.snapshot().paymentMethod, 'alipay');
  assert.equal(advance(fixture.snapshot()).state.status, 'SUBMITTING');
  assert.deepEqual(fixture.act('submit-order'), {ok:true, acted:true, kind:'submit-order'});
  assert.equal(fixture.clicks(), 1);
});

test('Alipay copy, logo and an unselected alternative cannot override selected credit card', () => {
  const fixture = contentFixture(completeReview({totals:[{autom:'order-total', text:'RMB 11,999'}], bodyText:'送货地址 Apple Store 条款和条件 立即下单 支付宝', images:['支付宝'], paymentChoices:[{label:'信用卡', checked:true}, {label:'支付宝', checked:false}]}));
  assert.equal(fixture.snapshot().paymentMethod, null);
  assert.equal(advance(fixture.snapshot()).state.status, 'BLOCKED');
  assert.match(fixture.act('submit-order').error, /payment-mismatch/);
  assert.equal(fixture.clicks(), 0);
});

test('unknown, gift-card, installment and mixed selected payment methods block submission', () => {
  const selections = [
    [{label:'礼品卡', checked:true}],
    [{label:'其他方式', checked:true}],
    [{label:'支付宝分期', checked:true}],
    [{label:'支付宝', checked:true}, {label:'礼品卡', type:'checkbox', checked:true}],
    [{label:'支付宝', checked:true}, {label:'其他方式', checked:true}],
    [{label:'支付宝 + 礼品卡', checked:true}]
  ];
  for (const paymentChoices of selections) {
    const fixture = contentFixture(completeReview({totals:[{autom:'order-total', text:'RMB 11,999'}], paymentChoices}));
    assert.equal(fixture.snapshot().paymentMethod, null);
    assert.equal(advance(fixture.snapshot()).state.status, 'BLOCKED');
    assert.match(fixture.act('submit-order').error, /payment-mismatch/);
    assert.equal(fixture.clicks(), 0);
  }
});

test('no selected payment evidence stays blocked even if Alipay text and logo are visible', () => {
  const fixture = contentFixture(completeReview({totals:[{autom:'order-total', text:'RMB 11,999'}], bodyText:'送货地址 支付宝 Apple Store 条款和条件 立即下单', images:['支付宝'], paymentChoices:[{label:'支付宝', checked:false}]}));
  assert.equal(fixture.snapshot().paymentMethod, null);
  assert.match(fixture.act('submit-order').error, /payment-mismatch/);
  assert.equal(fixture.clicks(), 0);
});

test('selected Alipay cannot override any gift-card, account-credit or mixed-payment mention', () => {
  const summaries = [
    '已使用 Apple 礼品卡抵扣 RMB 1,000。剩余款项由支付宝支付。',
    'Apple 礼品卡已使用 RMB 1,000。',
    '已抵扣 RMB 1,000，来源：Apple 礼品卡。',
    '已使用账户余额 RMB 1,000。',
    '账户余额已扣除 RMB 1,000。',
    '抵扣 RMB 1,000（Apple 账户余额）。',
    'Apple Gift Card applied: RMB 1,000.',
    'Applied RMB 1,000 from an Apple Gift Card.',
    'RMB 1,000 redeemed using a gift card.',
    'Account balance used: RMB 1,000.',
    'Used RMB 1,000 of account balance.',
    'Store credit applied: RMB 1,000.',
    'Applied store credit: RMB 1,000.',
    '混合支付：支付宝与礼品卡。',
    '组合付款：账户余额、支付宝。',
    'Split payment: Alipay and Apple Gift Card.',
    'Mixed tender: Alipay and store credit.',
    'Apple 礼品卡：-RMB 1,000。剩余款项由支付宝支付。',
    '账户余额：-¥1,000。支付宝：¥10,000。',
    'Apple 礼品卡：RMB 0。',
    '账户余额：未知。',
    'Store credit: unknown.',
    'Gift card: RMB 0.'
  ];
  for (const summary of summaries) {
    const fixture = contentFixture(completeReview({totals:[{autom:'order-total', text:'RMB 11,999'}], bodyText:`送货地址 Apple Store 销售条款 立即下单。${summary}`}));
    assert.equal(fixture.snapshot().paymentMethod, null, summary);
    assert.equal(advance(fixture.snapshot()).state.status, 'BLOCKED', summary);
    assert.match(fixture.act('submit-order').error, /payment-mismatch/, summary);
    assert.equal(fixture.clicks(), 0, summary);
  }
});

test('an unselected gift-card option mentioned in the body remains uncertain and blocks submission', () => {
  const fixture = contentFixture(completeReview({totals:[{autom:'order-total', text:'RMB 11,999'}], bodyText:'送货地址 Apple Store 销售条款 立即下单。付款方式：支付宝、Apple 礼品卡。', paymentChoices:[{label:'支付宝', checked:true}, {label:'Apple 礼品卡', checked:false}]}));
  assert.equal(fixture.snapshot().paymentMethod, null);
  assert.equal(advance(fixture.snapshot()).state.status, 'BLOCKED');
  assert.match(fixture.act('submit-order').error, /payment-mismatch/);
  assert.equal(fixture.clicks(), 0);
});

test('review never infers a complete cart from a parseable iPhone heading and body quantity', () => {
  const fixture = contentFixture(completeReview({rows:[], heading:['准备下单了吗？', productName(), 'USB-C 充电线'], bodyText:'送货地址 数量 1 总计 RMB 11,999 Apple Store 条款和条件 立即下单'}));
  assert.deepEqual(fixture.snapshot().cartItems, []);
  assert.equal(advance(fixture.snapshot()).state.status, 'BLOCKED');
  assert.match(fixture.act('submit-order').error, /cart-mismatch/);
  assert.equal(fixture.clicks(), 0);
});

test('review item names without complete row evidence cannot authorize submission', () => {
  const fixture = contentFixture(completeReview({rows:[], looseNames:[productName()], bodyText:'送货地址 数量 1 总计 RMB 11,999 Apple Store 条款和条件 立即下单'}));
  assert.deepEqual(fixture.snapshot().cartItems, []);
  assert.match(fixture.act('submit-order').error, /cart-mismatch/);
  assert.equal(fixture.clicks(), 0);
});

test('review retains an unknown accessory row and blocks the whole cart', () => {
  const fixture = contentFixture(completeReview({rows:[{name:productName(), quantity:1}, {name:'USB-C 充电线', quantity:1}], totals:[{autom:'order-total', text:'RMB 11,999'}]}));
  assert.equal(fixture.snapshot().cartItems.length, 2);
  assert.equal(fixture.snapshot().cartItems[1].product, null);
  assert.equal(advance(fixture.snapshot()).state.status, 'BLOCKED');
  assert.match(fixture.act('submit-order').error, /cart-mismatch/);
  assert.equal(fixture.clicks(), 0);
});

test('review does not ignore an unknown item name outside recognized rows', () => {
  const fixture = contentFixture(completeReview({looseNames:['USB-C 充电线'], totals:[{autom:'order-total', text:'RMB 11,999'}]}));
  assert.equal(fixture.snapshot().cartItems.length, 2);
  assert.equal(fixture.snapshot().cartItems[1].product, null);
  assert.match(fixture.act('submit-order').error, /cart-mismatch/);
  assert.equal(fixture.clicks(), 0);
});

test('bagtotalvalue provides total through the actual content snapshot', () => {
  const snapshot = snapshotOf(completeReview({totals:[{autom:'bagtotalvalue', text:'RMB 11,999'}]}));
  assert.equal(snapshot.total, 11999);
  assert.equal(advance(snapshot).state.status, 'SUBMITTING');
});

test('numbered bag rows preserve two nested item names and their own quantities', () => {
  const snapshot = snapshotOf({phase:'BAG', rows:[
    {autom:'bag-item-0', name:productName(), quantity:1, nestedName:true},
    {autom:'bag-item-1', name:productName(), quantity:1, nestedName:true}
  ]});
  assert.equal(snapshot.cartItems.length, 2);
  assert.deepEqual(snapshot.cartItems.map(item => item.quantity), [1,1]);
  assert.equal(advance(snapshot).state.status, 'BLOCKED');
});

test('bag-item-name is not a numbered bag row', () => {
  const snapshot = snapshotOf({phase:'BAG', looseNames:[productName()], bodyText:'数量 1'});
  assert.equal(snapshot.cartItems.length, 1);
  assert.equal(snapshot.quantity, 1);
  assert.equal(advance(snapshot).state.status, 'CHECKING_OUT');
});

test('conflicting total nodes cannot fall back to a convenient lower body total', () => {
  const snapshot = snapshotOf(completeReview({bodyText:'总计 RMB 11,999 送货地址 支付宝', totals:[
    {autom:'bagtotalvalue', text:'RMB 12,999'}, {autom:'order-total', text:'RMB 11,999'}
  ]}));
  assert.equal(snapshot.total, null);
  assert.equal(advance(snapshot).state.status, 'BLOCKED');
});

test('bagtotalvalue over the budget blocks review while matching totals remain valid', () => {
  const over = snapshotOf(completeReview({totals:[{autom:'bagtotalvalue', text:'RMB 12,999'}]}));
  assert.equal(over.total, 12999);
  assert.equal(advance(over).state.status, 'BLOCKED');
  const matching = snapshotOf(completeReview({totals:[{autom:'bagtotalvalue', text:'RMB 11,999'}, {autom:'order-total', text:'RMB 11,999'}]}));
  assert.equal(matching.total, 11999);
  assert.equal(advance(matching).state.status, 'SUBMITTING');
});

test('hidden total candidates do not create a false conflict', () => {
  const snapshot = snapshotOf(completeReview({totals:[
    {autom:'bagtotalvalue', text:'RMB 11,999'}, {autom:'order-total', text:'RMB 12,999', display:'none'}
  ]}));
  assert.equal(snapshot.total, 11999);
});

test('visible upstream form error classes block the content action', () => {
  for (const className of ['rs-form-error', 'rs-error-message']) {
    const fixture = contentFixture({errors:[{className, text:'请检查送货信息'}]});
    assert.deepEqual(fixture.snapshot().issues, ['visible-form-error']);
    assert.deepEqual(fixture.act('continue-shipping'), {ok:false, error:'form-not-ready'});
    assert.equal(fixture.clicks(), 0);
  }
});

test('hidden and empty upstream error nodes do not block a local continuation', () => {
  const fixture = contentFixture({errors:[
    {className:'rs-form-error', text:'旧错误', hidden:true},
    {className:'rs-form-error', text:'旧错误', display:'none'},
    {className:'rs-error-message', text:'旧错误', visibility:'hidden'},
    {className:'rs-error-message', text:'   '}
  ]});
  assert.deepEqual(fixture.snapshot().issues, []);
  assert.deepEqual(fixture.act('continue-shipping'), {ok:true, acted:true, kind:'continue-shipping'});
  assert.equal(fixture.clicks(), 1);
});

const pickupIntent = {...intent,fulfillment:'pickup',entryMode:'bag',runMode:'review',allowSubmit:false,pickup:{storeNumber:'R617',storeName:'Apple 长沙',region:{state:'湖南',city:'长沙',address:''},slotPolicy:'earliest'}};
test('upstream Review URL and placeOrder button are recognized while review-only mode never submits',()=>{
 const fixture=contentFixture(completeReview({heading:'请检查订单',step:'Review',controlAutom:'continue-button-placeOrder',bindIntent:pickupIntent,bodyText:'取货详情 Apple Store 条款和条件 立即下单\n取货门店：Apple 长沙',totals:[{autom:'bagtotalvalue',text:'RMB 11,999'}]}));
 const s=fixture.snapshot();assert.equal(s.stage,'REVIEW');assert.equal(s.checkoutStep,'review');assert.equal(s.fulfillment,'pickup');assert.equal(s.pickupStoreName,'Apple 长沙');assert.equal(s.pickupStoreNumber,'');assert.match(fixture.act('submit-order').error,/submission-not-authorized/);assert.equal(fixture.clicks(),0);
});
test('pickup submit requires exact current review store and never falls back from a mismatch',()=>{
 for(const store of ['Apple 武汉','']){const fixture=contentFixture(completeReview({step:'Review',controlAutom:'continue-button-placeOrder',bindIntent:{...pickupIntent,runMode:'submit',allowSubmit:true},bodyText:'取货详情 Apple Store 条款和条件 立即下单'+(store?'\n取货门店：'+store:''),totals:[{autom:'bagtotalvalue',text:'RMB 11,999'}]}));assert.match(fixture.act('submit-order').error,/pickup-store-mismatch/);assert.equal(fixture.clicks(),0);}
});
test('pickup verified review submits at most once per action ID and keeps all final guards',()=>{
 const fixture=contentFixture(completeReview({step:'Review',controlAutom:'continue-button-placeOrder',bindIntent:{...pickupIntent,runMode:'submit',allowSubmit:true},bodyText:'取货详情 Apple Store 条款和条件 立即下单\n取货门店：Apple 长沙',totals:[{autom:'bagtotalvalue',text:'RMB 11,999'}]}));assert.equal(fixture.act('submit-order').ok,true);assert.equal(fixture.act('submit-order').ok,true);assert.equal(fixture.clicks(),1);
 const mixed=contentFixture(completeReview({step:'Review',bindIntent:{...pickupIntent,runMode:'submit',allowSubmit:true},bodyText:'取货详情 Apple Store 条款和条件 立即下单 礼品卡余额 0\n取货门店：Apple 长沙',totals:[{autom:'bagtotalvalue',text:'RMB 11,999'}]}));assert.match(mixed.act('submit-order').error,/payment-mismatch/);assert.equal(mixed.clicks(),0);
});

test('upstream selected ALIPAY field is explicit evidence but other billing values remain unknown',()=>{
 for(const [value,expected] of [['ALIPAY','alipay'],['WECHAT',null],['INSTALLMENT',null]]){const fixture=contentFixture(completeReview({paymentChoices:[{label:'',autom:'checkout-billingOptions-'+value,value,checked:true}],totals:[{autom:'bagtotalvalue',text:'RMB 11,999'}]}));assert.equal(fixture.snapshot().paymentMethod,expected);}
});

test('Review selected target radio cannot override a contradictory explicit pickup summary',()=>{
 const target={...pickupIntent,runMode:'submit',allowSubmit:true};
 const fixture=contentFixture(completeReview({step:'Review',controlAutom:'continue-button-placeOrder',bindIntent:target,pickupChoices:[{value:'R617',title:'Apple 长沙',checked:true}],bodyText:'取货详情 Apple Store 条款和条件 立即下单\n取货门店：Apple 武汉',totals:[{autom:'bagtotalvalue',text:'RMB 11,999'}]}));
 const s=fixture.snapshot();assert.equal(s.pickupStoreNumber,'R617');assert(s.issues.some(issue=>/门店/.test(issue)));assert.equal(fixture.act('submit-order').ok,false);assert.equal(fixture.clicks(),0);
 const transition=advanceCheckout(createCheckoutState(target,1000),{type:'OBSERVE',observation:{...s,phase:s.stage}},2000);
 assert.equal(transition.state.status,'BLOCKED');assert.equal(transition.state.submitAttempt,null);assert.equal(fixture.act('submit-order').ok,false);assert.equal(fixture.clicks(),0);
});

test('structured payment identity cannot be overridden by an Alipay label',()=>{
 for(const choice of [
  {label:'支付宝',autom:'checkout-billingOptions-WECHAT',value:'WECHAT',checked:true},
  {label:'银行卡',autom:'checkout-billingOptions-ALIPAY',value:'ALIPAY',checked:true},
  {label:'PayPal',autom:'checkout-billingOptions-ALIPAY',value:'ALIPAY',checked:true},
  {label:'支付宝',value:'CREDIT_CARD',checked:true}
 ]){const f=contentFixture(completeReview({paymentChoices:[choice],totals:[{autom:'bagtotalvalue',text:'RMB 11,999'}]}));assert.equal(f.snapshot().paymentMethod,null);assert.equal(f.act('submit-order').ok,false);assert.equal(f.clicks(),0);}
});
test('multiple visible selected Alipay controls are ambiguous and cannot submit',()=>{
 const f=contentFixture(completeReview({paymentChoices:[{label:'支付宝',checked:true},{label:'支付宝',checked:true}],totals:[{autom:'bagtotalvalue',text:'RMB 11,999'}]}));assert.equal(f.snapshot().paymentMethod,null);assert.equal(f.act('submit-order').ok,false);assert.equal(f.clicks(),0);
});
test('payment page takes precedence over a retained Review heading and submit button',()=>{
 const f=contentFixture(completeReview({pathname:'/shop/payment',step:'Review',bodyText:'送货地址 Apple Store 条款和条件 立即下单 扫码支付',totals:[{autom:'bagtotalvalue',text:'RMB 11,999'}]}));assert.equal(f.snapshot().stage,'PAYMENT');assert.equal(f.act('submit-order').ok,false);assert.equal(f.clicks(),0);
});
