import test from 'node:test';
import assert from 'node:assert/strict';
import './checkout-dom.js';
const D=globalThis.AppleCheckoutDOM;
const product={Model:'iPhone 18 Pro',Capacity:'512GB',Color:'冰川蓝',Code:'MJTF4CH/A'};
const intent={product,quantity:1,maxTotal:11999,allowSubmit:true,acknowledgedTerms:true};
const review=()=>({stage:'REVIEW',product:{...product},cartItems:[{product:{...product},quantity:1}],quantity:1,total:11999,currency:'CNY',fulfillment:'delivery',paymentMethod:'alipay',termsPresent:true,issues:[]});
test('parses exact product and rejects incomplete configuration',()=>{assert.deepEqual(D.parseProduct('iPhone 18 Pro 512GB 冰川蓝色'),{Model:'iPhone 18 Pro',Capacity:'512GB',Color:'冰川蓝色'});assert.equal(D.parseProduct('iPhone 18 Pro'),null);assert(D.sameProduct(D.parseProduct('iPhone 18 Pro 512GB 冰川蓝色'),product));});
test('different SKU/model/capacity/color cannot be submitted',()=>{for(const changed of [{Code:'MJTE4CH/A'},{Color:'勃艮第酒红色'},{Model:'iPhone 18 Pro Max'},{Capacity:'1TB'}])assert(!D.sameProduct({...product,...changed},product));});
test('official origin allowlist is exact and HTTPS only',()=>{for(const u of ['https://www.apple.com.cn/shop/bag','https://secure8.www.apple.com.cn/shop/checkout'])assert(D.officialLocation(u));for(const u of ['http://www.apple.com.cn/','https://www.apple.com.cn.evil.test/','https://secure.www.apple.com.cn/','https://www.apple.com.cn:4430/','https://user@www.apple.com.cn/'])assert(!D.officialLocation(u));});
test('review predicate enforces every material order parameter',()=>{assert.deepEqual(D.validateFinal(review(),intent),[]);for(const changed of [{stage:'PAYMENT'},{total:12000},{total:null},{currency:'USD'},{quantity:2},{cartItems:[]},{fulfillment:'pickup'},{paymentMethod:'credit-card'},{termsPresent:false},{issues:['visible-form-error']}])assert(D.validateFinal({...review(),...changed},intent).length);for(const changed of [{allowSubmit:false},{acknowledgedTerms:false}])assert(D.validateFinal(review(),{...intent,...changed}).length);});
test('extra products and changed quantities block order',()=>{let s=review();s.cartItems.push({product,quantity:1});assert(D.validateFinal(s,intent).includes('cart-mismatch'));s=review();s.cartItems[0].quantity=2;assert(D.validateFinal(s,intent).includes('cart-mismatch'));});
test('money parsing does not silently accept unrelated digits',()=>{assert.equal(D.parseMoney('RMB 11,999.00'),11999);assert.equal(D.parseMoney('订单 11999'),null);});

test('budget is user configured, including Duo above the current test budget',()=>{assert(D.validateIntent({...intent,maxTotal:15999}));assert(!D.validateIntent({...intent,maxTotal:Infinity}));assert(!D.validateIntent({...intent,maxTotal:0}));});
test('review heading accepts the observed explanatory suffix',()=>{assert(D.reviewHeading('准备下单了吗？ 请确保以下信息均准确无误。'));assert(D.reviewHeading('准备下单了吗？'));assert(!D.reviewHeading('尚未准备下单了吗？'));});
test('empty bag and unavailable stock require explicit text',()=>{assert(D.emptyBagText('你的购物袋是空的。'));assert(!D.emptyBagText('购物袋'));assert(!D.emptyBagText('无法加载购物袋'));assert(D.outOfStockText('暂时无货'));assert(D.outOfStockText('此产品目前不可购买。'));assert(!D.outOfStockText('请稍候'));assert(!D.outOfStockText('产品存货状况可能有所变化'));});
test('terms require official sales policy href and visible Apple Store terms',()=>{assert(D.salesTermsPresent('点击立即下单表示同意 Apple Store 的条款和条件。',['https://www.apple.com.cn/shop/open/salespolicies']));assert(!D.salesTermsPresent('Apple Store 条款和条件',['https://evil.test/salespolicies']));assert(!D.salesTermsPresent('Apple Store 条款和条件',['https://www.apple.com.cn/legal/sales-support/applecare/applecareplus']));});

test('iPhone 17 mist blue is exact and never collapses into generic or ice blue',()=>{
  const target={Model:'iPhone 17',Capacity:'512GB',Color:'青雾蓝色',Code:'MG744CH/A'};
  const parsed=D.parseProduct('iPhone 17 512GB 青雾蓝色 MG744CH/A');
  assert.deepEqual(parsed,target);
  assert(D.sameProduct(parsed,target));
  for(const Color of ['蓝色','冰川蓝色'])assert(!D.sameProduct({...parsed,Color},target));
});
