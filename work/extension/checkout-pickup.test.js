import assert from 'node:assert/strict';
import test from 'node:test';
import './checkout-pickup.js';
const P = globalThis.AppleCheckoutPickup;
const intent = {intentId:'pickup-fixture', revision:1, fulfillment:'pickup', pickup:{storeNumber:'R617', storeName:'Apple 长沙', region:{state:'湖南',city:'长沙',address:'湖南省长沙市芙蓉区'},slotPolicy:'earliest'}};
function fixture(step='Fulfillment') {
  let clock=1000; const nodes=new Map(), actions=[];
  const query=(selector,map=nodes)=>[...new Set(selector.split(',').flatMap(s=>map.get(s)||[]))];
  const node=(text='', attrs={}, extras={})=>({innerText:text,textContent:text,value:'',labels:[],checked:false,disabled:false,
    style:{display:'block',visibility:'visible'},getAttribute(key){return attrs[key]??null;},
    closest(){return this.hidden?this:null;},getClientRects(){return this.hidden?[]:[{}];},querySelectorAll:()=>[],...extras});
  const add=(selector,...values)=>{nodes.set(selector,values);return values[0];};
  const button=(autom,text='继续')=>{const el=node(text,{'data-autom':autom});add(`button[data-autom="${autom}"]`,el);const buttons=nodes.get('button')||[];nodes.set('button',[...buttons,el]);return el;};
  const body=node(''); const location={href:`https://secure6.www.apple.com.cn/shop/checkout?_s=${step}`};
  const adapter=P.create({document:{body,querySelectorAll:query},location,getComputedStyle:el=>el.style,now:()=>clock,
    click:el=>{actions.push({kind:'click',el});},setSelect:(el,value)=>{actions.push({kind:'select',value});el.value=value;}});
  const store=(number='R617',checked=true)=>add('input[name="store-locator-result"]',node('',{}, {value:number,checked}));
  const slot=(values=['09:00-09:30'],value='')=>add('select[data-autom="pickup-availablewindow-dropdown"]',node('',{}, {options:values.map(v=>typeof v==='string'?{value:v,disabled:false}:v),value}));
  const stable=()=>{adapter.observe(intent);clock+=1300;return adapter.observe(intent);};
  return {adapter,add,node,button,store,slot,stable,body,location,actions,query,tick:(ms=1300)=>{clock+=ms;}};
}
test('pickup mode is selected once even if the DOM does not acknowledge the click',()=>{
 const f=fixture(); f.add('button',f.node('我要取货',{'aria-checked':'false'}));
 assert(f.adapter.observe(intent).canAct);assert.equal(f.adapter.step(intent),'select-pickup');
 assert.equal(f.adapter.observe(intent).canAct,false);assert.throws(()=>f.adapter.step(intent),/not-ready/);assert.equal(f.actions.length,1);
});
test('target store is exact; a selected nearby store never passes as requested store',()=>{
 const f=fixture();f.store('R999');const s=f.adapter.observe(intent);
 assert.equal(s.pickupStoreNumber,'R999');assert.match(s.issues[0],/没有指定取货门店/);assert.equal(f.actions.length,0);
});
test('only the exact target store may be selected and selection is never repeated',()=>{
 const f=fixture();const wrong=f.node('',{}, {value:'R999',checked:true});const wanted=f.node('',{}, {value:'R617',checked:false});f.add('input[name="store-locator-result"]',wrong,wanted);
 assert.equal(f.adapter.step(intent),'select-store');assert.equal(f.actions[0].el,wanted);assert.equal(f.adapter.observe(intent).canAct,false);assert.equal(f.actions.length,1);
});
test('disabled or unavailable target store cannot be clicked',()=>{
 for(const change of [{disabled:true},{labels:[{innerText:'此门店无法取货',querySelectorAll:()=>[]}]}]){const f=fixture();Object.assign(f.store(),change);assert.match(f.adapter.observe(intent).issues[0],/不可取货/);assert.equal(f.actions.length,0);}
});
test('region selections use unique exact province/city and unique district address match',()=>{
 const f=fixture(); f.add('button',f.node('我要取货',{'aria-checked':'true'})); const match=f.node('湖南省');const panel=f.node('',{}, {querySelectorAll:()=>[match,f.node('湖北省')]});f.add('[data-autom="address-field-provinceselector-state-panel"]',panel);
 assert.equal(f.adapter.step(intent),'region-state');assert.equal(f.actions[0].el,match);assert.equal(f.adapter.observe(intent).canAct,false);
 const g=fixture();g.add('button',g.node('我要取货',{'aria-checked':'true'}));g.add('[data-autom="address-field-provinceselector-district-panel"]',g.node('',{}, {querySelectorAll:()=>[g.node('芙蓉区'),g.node('芙蓉区')]}));assert.match(g.adapter.observe(intent).issues[0],/无法唯一/);assert.equal(g.actions.length,0);
});
test('earliest enabled date and first enabled nonempty slot are chosen after stable observation',()=>{
 const f=fixture();f.store();const later=f.node('',{}, {value:'2026-10-18',checked:true});const first=f.node('',{}, {value:'2026-10-17',checked:false});f.add('input[name="bartPickupDateSelectorButtonGroup"]',first,later);
 const select=f.slot([{value:'',disabled:false},{value:'08:00',disabled:true},{value:'09:00',disabled:false},{value:'10:00',disabled:false}]);f.button('fulfillment-continue-button');
 assert.equal(f.adapter.observe(intent).canAct,false);f.stable();assert.equal(f.adapter.step(intent),'select-date');assert.equal(f.actions[0].el,first);
 later.checked=false;first.checked=true;f.stable();assert.equal(f.adapter.step(intent),'select-slot');assert.equal(select.value,'09:00');
 f.stable();assert.equal(f.adapter.step(intent),'continue-fulfillment');assert.equal(f.adapter.observe(intent).canAct,false);assert.equal(f.actions.length,3);
});
test('missing or empty pickup windows stop rather than continuing',()=>{
 for(const missing of [true,false]){const f=fixture();f.store();if(!missing)f.slot([]);f.button('fulfillment-continue-button');f.stable();f.tick(12000);const s=f.adapter.observe(intent);assert.match(s.issues[0],/没有可验证的取货时段/);assert.equal(s.canAct,false);assert.equal(f.actions.length,0);}
});
test('unavailable first date advances once to next available date',()=>{
 const f=fixture();f.store();f.slot([]);const first=f.node('',{}, {value:'2026-10-17',checked:true});const next=f.node('',{}, {value:'2026-10-18'});f.add('input[name="bartPickupDateSelectorButtonGroup"]',first,next);f.stable();f.tick(12000);assert.equal(f.adapter.step(intent),'select-date');assert.equal(f.actions[0].el,next);assert.equal(f.actions.length,1);
});
test('contact values never leave adapter and incomplete contact or identity fields stop',()=>{
 const f=fixture('PickupContact');const secret='sensitive-fixture-value';
 for(const field of ['lastName','firstName','emailAddress','fullDaytimePhone'])f.add(`input[data-autom="form-field-${field}"]`,f.node('',{}, {value:secret}));
 f.button('continue-button-label');assert.equal(f.adapter.observe(intent).canAct,true);assert(!JSON.stringify(f.adapter.observe(intent)).includes(secret));
 f.add('input[data-autom="form-field-nationalIdSelf"]',f.node('',{}, {value:''}));assert.match(f.adapter.observe(intent).issues[0],/证件信息未完整/);assert.equal(f.actions.length,0);
 const g=fixture('PickupContact');g.button('continue-button-label');assert.match(g.adapter.observe(intent).issues[0],/未完整/);assert.equal(g.actions.length,0);
});
test('pre-filled contact is reused without writes and continuation is at most once',()=>{
 const f=fixture('PickupContact');for(const field of ['lastName','firstName','emailAddress','fullDaytimePhone'])f.add(`input[data-autom="form-field-${field}"]`,f.node('',{}, {value:'already-filled'}));f.button('continue-button-label');assert.equal(f.adapter.step(intent),'continue-contact');assert.equal(f.adapter.observe(intent).canAct,false);assert.equal(f.actions.length,1);
});
test('only unique Alipay radio is selected, never Wechat or installment',()=>{
 const f=fixture('Billing');const alipay=f.node('',{type:'radio'},{value:'ALIPAY'});const wechat=f.node('',{type:'radio'},{value:'WECHAT'});f.add('input[data-autom^="checkout-billingOptions-"]',wechat,alipay);f.button('continue-button-review');assert.equal(f.adapter.step(intent),'select-alipay');assert.equal(f.actions[0].el,alipay);assert.equal(f.adapter.observe(intent).canAct,false);alipay.checked=true;assert.equal(f.adapter.step(intent),'continue-review');assert.equal(f.actions.length,2);
});
test('mixed credit evidence and multiple payment selections cannot continue billing',()=>{
 for(const text of ['余额 ¥0','支付宝 + 礼品卡','mixed payment']){const f=fixture('Billing');f.body.innerText=text;f.add('input[data-autom^="checkout-billingOptions-"]',f.node('',{}, {value:'ALIPAY',checked:true}));f.button('continue-button-review');assert.match(f.adapter.observe(intent).issues[0],/付款/);assert.equal(f.actions.length,0);}
 const f=fixture('Billing');f.add('input[data-autom^="checkout-billingOptions-"]',f.node('',{}, {value:'ALIPAY',checked:true}),f.node('',{}, {value:'WECHAT',checked:true}));f.button('continue-button-review');assert.match(f.adapter.observe(intent).issues[0],/不唯一/);
});
test('Review only exports current explicit store evidence; it never replays fulfillment selection',()=>{
 const f=fixture();f.store();assert.equal(f.adapter.observe(intent).pickupStoreNumber,'R617');f.add('input[name="store-locator-result"]');f.location.href='https://secure6.www.apple.com.cn/shop/checkout?_s=Review';
 assert.equal(f.adapter.observe(intent).pickupStoreNumber,'');assert.equal(f.adapter.observe(intent).pickupStoreName,'');
 f.body.innerText='取货门店：Apple 长沙';const s=f.adapter.observe(intent);assert.equal(s.pickupStoreName,'Apple 长沙');assert.equal(s.canAct,false);assert.equal(f.actions.length,0);
 f.body.innerText='取货门店：Apple 武汉';assert.match(f.adapter.observe(intent).issues[0],/不一致/);
});
test('hidden contacts, multiple target stores, invalid plan and busy page fail closed',()=>{
 const f=fixture();f.add('input[name="store-locator-result"]',f.node('',{}, {value:'R617'}),f.node('',{}, {value:'R617'}));assert.match(f.adapter.observe(intent).issues[0],/重复/);
 const g=fixture();g.store();g.slot(['09:00'],'09:00');g.button('fulfillment-continue-button');g.add('[aria-busy="true"]',g.node(''));assert.equal(g.stable().canAct,false);assert.equal(g.actions.length,0);
 assert.match(g.adapter.observe({...intent,pickup:{...intent.pickup,slotPolicy:'random'}}).issues[0],/无效/);
});

test('Review always reconciles explicit summary with checked store and target',()=>{
 const f=fixture('Review');f.store('R617');f.body.innerText='取货门店：Apple 武汉';assert.match(f.adapter.observe(intent).issues[0],/不一致/);assert.equal(f.actions.length,0);
 f.body.innerText='取货门店：Apple 长沙';assert.deepEqual(f.adapter.observe(intent).issues,[]);
 f.store('R999');assert.match(f.adapter.observe(intent).issues[0],/冲突/);assert.equal(f.actions.length,0);
});

test('delayed windows stay pending rather than exhausting a date after 1.2 seconds',()=>{
 const f=fixture();f.store();f.slot([]);f.button('fulfillment-continue-button');
 const pending=f.stable();assert.deepEqual(pending.issues,[]);assert.equal(pending.canAct,false);
 f.slot(['09:00'],'');f.stable();assert.equal(f.adapter.step(intent),'select-slot');assert.equal(f.actions.length,1);
});
test('date list with disabled selected date must not continue on a stale enabled window',()=>{
 const f=fixture();f.store();f.slot(['09:00'],'09:00');f.button('fulfillment-continue-button');
 f.add('input[name="bartPickupDateSelectorButtonGroup"]',f.node('',{}, {value:'2026-10-17',checked:true,disabled:true}));
 const result=f.stable();assert.equal(result.canAct,false);assert(result.issues.length);assert.equal(f.actions.length,0);
});
test('multiple selected dates or duplicate slot values never authorize continuation',()=>{
 const f=fixture();f.store();f.slot(['09:00'],'09:00');f.button('fulfillment-continue-button');
 f.add('input[name="bartPickupDateSelectorButtonGroup"]',f.node('',{}, {value:'2026-10-17',checked:true}),f.node('',{}, {value:'2026-10-18',checked:true}));
 assert(f.stable().issues.length);assert.equal(f.actions.length,0);
 const g=fixture();g.store();g.slot(['09:00','09:00'],'09:00');g.button('fulfillment-continue-button');assert(g.stable().issues.length);assert.equal(g.actions.length,0);
});
test('a required unchecked consent checkbox is not complete just because its value is on',()=>{
 const f=fixture('PickupContact');for(const field of ['lastName','firstName','emailAddress','fullDaytimePhone'])f.add(`input[data-autom="form-field-${field}"]`,f.node('',{}, {value:'already-filled'}));
 f.add('input[required]',f.node('',{type:'checkbox'}, {value:'on',checked:false}));f.button('continue-button-label');
 assert.equal(f.adapter.observe(intent).canAct,false);assert(f.adapter.observe(intent).issues.length);assert.equal(f.actions.length,0);
});
test('native invalid contact validity blocks without exposing its value',()=>{
 const f=fixture('PickupContact');for(const field of ['lastName','firstName','emailAddress','fullDaytimePhone'])f.add(`input[data-autom="form-field-${field}"]`,f.node('',{}, {value:'invalid-contact-value',validity:{valid:field!=='emailAddress'}}));
 f.button('continue-button-label');assert.equal(f.adapter.observe(intent).canAct,false);assert(!JSON.stringify(f.adapter.observe(intent)).includes('invalid-contact-value'));
});
test('required radio, textarea and disabled selected option are checked semantically',()=>{
 const contact=()=>{const f=fixture('PickupContact');for(const field of ['lastName','firstName','emailAddress','fullDaytimePhone'])f.add(`input[data-autom="form-field-${field}"]`,f.node('',{}, {value:'already-filled'}));f.button('continue-button-label');return f;};
 for(const [selector,node] of [['input[required]',{attrs:{type:'radio'},value:'self',checked:false}],['textarea[required]',{value:''}],['select[required]',{value:'placeholder',selectedOptions:[{disabled:true}]}]]){const f=contact();f.add(selector,f.node('',node.attrs||{},node));assert.equal(f.adapter.observe(intent).canAct,false);assert.equal(f.actions.length,0);}
});
test('Review reconciles multiline headings and allows repeated identical public store evidence',()=>{
 const f=fixture('Review');f.store();f.body.innerText='取货门店：\nApple 武汉';assert(f.adapter.observe(intent).issues.length);
 f.body.innerText='取货门店：Apple 长沙\n取货地点：Apple 长沙';assert.deepEqual(f.adapter.observe(intent).issues,[]);
 f.body.innerText='取货门店\nApple 武汉';assert(f.adapter.observe(intent).issues.length);
 f.body.innerText='取货门店：Apple 长沙\n取货地点：Apple 武汉';assert(f.adapter.observe(intent).issues.length);
});
test('Review rejects conflicting visible titles on its selected store radio',()=>{
 const f=fixture('Review');const selected=f.store();const titles=[f.node('Apple 长沙'),f.node('Apple 武汉')];selected.labels=[f.node('',{}, {querySelectorAll:()=>titles})];
 assert(f.adapter.observe(intent).issues.length);assert.equal(f.actions.length,0);
});

test('a delayed first date retains priority when its windows arrive within the loading deadline',()=>{
 const f=fixture();f.store();f.slot([]);const first=f.node('',{}, {value:'2026-10-17',checked:true}),next=f.node('',{}, {value:'2026-10-18'});f.add('input[name="bartPickupDateSelectorButtonGroup"]',first,next);f.button('fulfillment-continue-button');
 assert.equal(f.stable().canAct,false);f.tick(7000);assert.equal(f.adapter.observe(intent).canAct,false);f.slot(['09:00']);f.stable();assert.equal(f.adapter.step(intent),'select-slot');assert.equal(f.actions.length,1);assert.equal(f.actions[0].kind,'select');
});
test('unavailable selected window must be replaced before any continuation, including disabled optgroups',()=>{
 for(const unavailable of [{value:'09:00',disabled:true},{value:'09:00',disabled:false,closest:()=>({disabled:true})}]){const f=fixture();f.store();f.slot([unavailable,{value:'10:00',disabled:false}],'09:00');f.button('fulfillment-continue-button');f.stable();assert.equal(f.adapter.step(intent),'select-slot');assert.deepEqual(f.actions,[{kind:'select',value:'10:00'}]);f.stable();assert.equal(f.adapter.step(intent),'continue-fulfillment');assert.equal(f.actions.length,2);}
});
test('required checked controls and a fulfilled radio group can continue without exposing values',()=>{
 const f=fixture('PickupContact');for(const field of ['lastName','firstName','emailAddress','fullDaytimePhone'])f.add(`input[data-autom="form-field-${field}"]`,f.node('',{}, {value:'private-form-value',validity:{valid:true}}));
 const checkbox=f.node('',{type:'checkbox'},{checked:true,value:''}),self=f.node('',{type:'radio',name:'recipient'},{checked:true,value:'self'}),other=f.node('',{type:'radio',name:'recipient'},{checked:false,value:'other'});
 f.add('input[required]',checkbox,other);f.add('input[type="radio"]',self,other);f.button('continue-button-label');const result=f.adapter.observe(intent);assert.equal(result.canAct,true);assert(!JSON.stringify(result).includes('private-form-value'));assert.equal(f.adapter.step(intent),'continue-contact');assert.equal(f.actions.length,1);
});
test('a required visually hidden checkbox with visible label still requires explicit checked state',()=>{
 const f=fixture('PickupContact');for(const field of ['lastName','firstName','emailAddress','fullDaytimePhone'])f.add(`input[data-autom="form-field-${field}"]`,f.node('',{}, {value:'already-filled'}));
 const hidden=f.node('',{type:'checkbox'},{hidden:true,value:'on',checked:false,labels:[f.node('必须确认')]});f.add('input[required]',hidden);f.button('continue-button-label');assert.equal(f.adapter.observe(intent).canAct,false);assert.equal(f.actions.length,0);
});
test('Billing does not continue when ALIPAY value contradicts its visible label',()=>{
 const f=fixture('Billing');const radio=f.node('',{type:'radio','aria-label':'银行卡'},{value:'ALIPAY',checked:true});f.add('input[data-autom^="checkout-billingOptions-"]',radio);f.button('continue-button-review');assert.equal(f.adapter.observe(intent).canAct,false);assert(f.adapter.observe(intent).issues.length);assert.equal(f.actions.length,0);
});
