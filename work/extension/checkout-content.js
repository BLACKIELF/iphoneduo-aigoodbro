/* Runs in Chrome's isolated world. It never reads cookies, account fields or credentials. */
(() => {
  'use strict';
  if (globalThis.__appleCheckoutContentInstalled) return;
  globalThis.__appleCheckoutContentInstalled = true;
  const D = globalThis.AppleCheckoutDOM;
  if (!D || !D.officialLocation(location.href) || window.top !== window) return;
  let binding = null, busy = false, changeTimer = null;
  const actionResults = new Map();
  const all = (selector, scope = document) => [...scope.querySelectorAll(selector)];
  function visible(el) {
    if (!el || el.closest('[hidden],[aria-hidden="true"]')) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
  }
  const text = el => D.norm(el?.innerText || el?.textContent || '');
  function label(el) {
    const own = el.getAttribute('aria-label');
    const labelled = (el.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)).filter(Boolean).map(text).join(' ');
    return D.norm(own || labelled || [...(el.labels || [])].map(text).join(' ') || text(el));
  }
  function available(el) { return visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true'; }
  function buttons() { return all('button,a[href],input[type="submit"],[role="button"]').filter(available); }
  function exactControl(names, automs = []) {
    const matches = buttons().filter(el => names.includes(label(el)) || automs.includes(el.getAttribute('data-autom')));
    return matches.length === 1 ? matches[0] : null;
  }
  function safeClick(el) {
    if (!available(el) || !D.officialLocation(location.href)) throw new Error('control-unavailable');
    const href = el.getAttribute('href');
    if (href && !href.startsWith('#') && !D.officialLocation(new URL(href, location.href).href)) throw new Error('external-navigation-blocked');
    el.click();
  }
  function completeProductNodes() {
    const preferred = all('[data-autom="bag-item-name"],[data-autom="review-item-name"],[data-autom="product-name"],.rs-iteminfo-title,h1,h2,h3').filter(visible);
    return preferred.map(el => ({el, product: D.parseProduct(text(el))})).filter(item => item.product);
  }
  function quantity(scope) {
    const fields = all('select[data-autom*="quantity"],input[data-autom*="quantity"],select[name*="quantity"],input[name*="quantity"]', scope).filter(visible);
    if (fields.length === 1 && /^\d+$/.test(fields[0].value)) return Number(fields[0].value);
    const matches = [...text(scope).matchAll(/(?:数量|Quantity)\s*[:：]?\s*(\d+)\b/gi)].map(m => Number(m[1]));
    return matches.length && matches.every(n => n === matches[0]) ? matches[0] : null;
  }
  function cartItems(requireRows = false) {
    const rowCandidates = [...new Set([
      ...all('[data-autom="bag-item"],[data-autom="review-item"],.rs-bag-item,.rs-review-item'),
      ...all('[data-autom^="bag-item-"]').filter(el => /^bag-item-\d+$/.test(el.getAttribute('data-autom')))
    ])].filter(visible);
    const rawNames = all('[data-autom="bag-item-name"],[data-autom="review-item-name"],.rs-iteminfo-title').filter(visible);
    const names = rawNames.filter(el => !rawNames.some(other => other !== el && el.contains(other)));
    // Nested rows or item names outside the rows make the complete order ambiguous.
    // Preserve unknown entries instead of reducing the cart to parseable iPhones.
    if (rowCandidates.length) return rowCandidates.map(row => ({
      product: rowCandidates.some(other => other !== row && row.contains(other)) || names.filter(name => row.contains(name)).length > 1 ? null : D.parseProduct(text(row)),
      quantity: quantity(row)
    })).concat(names.filter(name => !rowCandidates.some(row => row.contains(name))).map(name => ({product:D.parseProduct(text(name)), quantity:quantity(name.parentElement)})));
    if (requireRows) return [];
    if (names.length) return names.map(el => ({product: D.parseProduct(text(el)), quantity: names.length === 1 ? quantity(document.body) : quantity(el.parentElement)}));
    return [];
  }
  function selectedProduct() {
    const nodes = completeProductNodes();
    const selected = all('input:checked,[role="radio"][aria-checked="true"]').map(label).join(' ');
    const p = D.parseProduct(selected);
    return p || (nodes.length === 1 ? nodes[0].product : null);
  }
  function total() {
    const candidates = all('[data-autom="bag-total-value"],[data-autom="bagtotalvalue"],[data-autom="order-total"],[data-autom="orderSummaryTotal"],[data-autom="order-summary-total"],.rs-summary-total').filter(visible).map(el => D.parseMoney(text(el))).filter(v => v !== null);
    if (candidates.length) return candidates.every(v => v === candidates[0]) ? candidates[0] : null;
    const body = text(document.body);
    const matches = [...body.matchAll(/(?:订单总额|订单总计|总计|总金额|合计)\s*[:：]?\s*(?:RMB|CNY|人民币|[¥￥])\s*([\d,]+(?:\.\d{1,2})?)/gi)].map(m => Number(m[1].replace(/,/g, '')));
    return matches.length && matches.every(v => v === matches[0]) ? matches[0] : null;
  }
  function stage() {
    const body = text(document.body), path = location.pathname;
    const challenge = all('input[autocomplete="one-time-code"],iframe[src*="captcha"],iframe[title*="验证码"],iframe[title*="验证"]');
    if (challenge.some(visible) || all('h1,h2,[role="dialog"]').filter(visible).some(el => /^(?:验证你的身份|验证您的身份|双重认证|输入验证码|安全验证)/.test(text(el)))) return 'IDENTITY_CHALLENGE';
    if (/(?:订单号|订单编号)\s*[:：]?\s*W\d{8,}/i.test(body)) return 'ORDER_CREATED';
    if (all('h1,h2').filter(visible).some(el => D.reviewHeading(text(el))) && exactControl(['立即下单'], ['place-order','place-order-button'])) return 'REVIEW';
    if (/\/(?:payment|payments)(?:\/|$)/.test(path) || /(?:扫码支付|打开支付宝完成付款|请在\s*\d+\s*分钟内完成支付)/.test(body)) return 'PAYMENT';
    if (/\/shop\/bag(?:\/|$)/.test(path)) return 'BAG';
    if (/\/shop\/(?:checkout|signin)(?:\/|$)/.test(path)) return 'CHECKOUT';
    if (/\/shop\/buy-iphone\//.test(path)) return 'PRODUCT';
    return 'UNKNOWN';
  }
  function radioChoices() {
    return all('input[type="radio"],[role="radio"]').filter(el => !el.disabled && (visible(el) || [...(el.labels || [])].some(visible)));
  }
  function selected(el) { return el.checked === true || el.getAttribute('aria-checked') === 'true'; }
  function paymentMethod() {
    const body = text(document.body);
    const credit = /礼品卡|余额|gift\s*card|(?:account\s*)?balance|store\s*credit/i;
    // A selected Alipay radio may cover only a remainder. Without a verified live
    // summary, any credit mention is ambiguous, even with zero/unknown amounts or
    // unselected alternatives. Fail closed instead of guessing whether it applied.
    if (credit.test(body) || /混合(?:付款|支付)|组合(?:付款|支付)|\b(?:split|mixed)[\s-]*(?:payment|tender)\b/i.test(body)) return null;
    const evidence = all('input:checked,[role="radio"][aria-checked="true"]').filter(el => visible(el) || [...(el.labels || [])].some(visible)).map(el => {
      const value = label(el);
      const context = ['name','id','data-autom'].map(key => el.getAttribute(key) || '').join(' ');
      const paymentControl = /payment|paymethod|billing.?method|gift.?card/i.test(context);
      const paymentLabel = /支付宝|alipay|信用卡|借记卡|银行卡|礼品卡|账户余额|分期|微信|银联|credit\s*card|debit\s*card|gift\s*card|apple\s*pay|paypal|wechat/i.test(value);
      if (!paymentControl && !paymentLabel) return null;
      // Only an explicit selected payment radio proves Alipay. Text, logos,
      // unselected alternatives and ambiguous/mixed labels are not evidence.
      return (el.getAttribute('type') === 'radio' || el.getAttribute('role') === 'radio') && /^(?:支付宝|alipay)$/i.test(value) ? 'alipay' : 'unknown';
    }).filter(Boolean);
    return evidence.length > 0 && evidence.every(value => value === 'alipay') ? 'alipay' : null;
  }
  function selectionControl(intent) {
    if (!intent) return null;
    const radios = radioChoices();
    const goals = [
      ['model', l => D.compact(l).startsWith(D.compact(intent.product.Model)) && !(/promax/.test(D.compact(l)) && !/promax/.test(D.compact(intent.product.Model)))],
      ['color', l => D.compact(l).replace(/冰川蓝色/g,'冰川蓝') === D.compact(intent.product.Color).replace(/冰川蓝色/g,'冰川蓝')],
      ['capacity', l => new RegExp(`^${intent.product.Capacity.replace(/(GB|TB)/, '\\s*$1')}\\b`, 'i').test(l)],
      ['tradein', l => /^(?:不折抵换购|不折抵|不使用折抵换购|不，无需折抵|无需折抵)$/.test(l)],
      ['payment', l => /^(?:全额付款|一次性付款|全额支付)(?:\s|$)/.test(l)],
      ['applecare', l => /^(?:不加购 AppleCare\+ 服务计划|不购买 AppleCare\+ 服务计划|不添加 AppleCare\+|不添加 AppleCare\+ 服务计划|无需 AppleCare\+ 服务计划|不购买保障服务|不加购保障服务|无需保障服务)$/.test(l)]
    ];
    for (const [field, match] of goals) {
      const found = radios.filter(el => match(label(el)));
      if (found.length === 1 && !selected(found[0])) return {el: found[0], field};
    }
    return null;
  }
  function editControl(intent, items) {
    if (!intent?.allowReplaceVariant || items.length !== 1 || items[0].quantity !== 1 || !D.sameVariantFamily(items[0].product, intent.product) || D.sameProduct(items[0].product, intent.product)) return null;
    const names = ['更改', '编辑', '更改配置', '编辑配置'];
    const candidates = all('a[href]').filter(available).filter(el => names.includes(label(el)) && /\/shop\/buy-iphone\//.test(new URL(el.href).pathname));
    return candidates.length === 1 ? candidates[0] : null;
  }
  function controls(currentStage, items) {
    const result = [];
    if (currentStage === 'PRODUCT') {
      const choice = selectionControl(binding?.intent);
      if (choice) result.push({kind:'select-product', field:choice.field});
      if (exactControl(['添加到购物袋','加入购物袋'], ['add-to-cart','add-to-bag','addToBag'])) result.push({kind:'add-to-bag'});
    }
    if (currentStage === 'BAG') {
      if (exactControl(['结账','前往结账'], ['bag-checkout-button','checkout'])) result.push({kind:'checkout'});
      if (editControl(binding?.intent, items)) result.push({kind:'edit-variant'});
    }
    if (currentStage === 'CHECKOUT') {
      if (exactControl(['继续选择送货信息','继续填写送货信息','继续选择付款方式','继续前往付款','继续进行付款'], ['shipping-continue-button','shipping-address-continue-button'])) result.push({kind:'continue-shipping'});
      if (exactControl(['查看订单','检查订单','继续查看订单','继续检查订单','核对订单'], ['review-order-button','billing-continue-button'])) result.push({kind:'continue-billing'});
    }
    if (currentStage === 'REVIEW' && exactControl(['立即下单'], ['place-order','place-order-button'])) result.push({kind:'submit-order'});
    return result;
  }
  function snapshot() {
    const currentStage = stage(), items = ['BAG','CHECKOUT','REVIEW','ORDER_CREATED'].includes(currentStage) ? cartItems(['REVIEW','ORDER_CREATED'].includes(currentStage)) : [];
    const body = text(document.body);
    const product = items.length === 1 ? items[0].product : selectedProduct();
    const orderNumber = body.match(/(?:订单号|订单编号)\s*[:：]?\s*(W\d{8,})\b/i)?.[1];
    const unpaid = /(?:等待付款|待付款|尚未付款|未付款|请完成付款|立即付款)/.test(body);
    const issues = [];
    if (all('[role="alert"],[data-autom="error-message"],.form-message-error,.rs-form-error,.rs-error-message').filter(visible).some(el => text(el))) issues.push('visible-form-error');
    const bagEmpty = currentStage === 'BAG' && items.length === 0 && all('h1,h2,p,[role="status"]').filter(visible).some(el => D.emptyBagText(text(el)));
    const explicitOutOfStock = currentStage === 'PRODUCT' && all('button,[role="status"],[data-autom="availability"],.rf-pdp-fulfillment,p').filter(visible).some(el => D.outOfStockText(text(el)));
    const termsLinks = all('a[href]').filter(visible).map(el => el.href);
    // An intermediate checkout step may not render its order summary yet.
    const unobservedCart = currentStage === 'CHECKOUT' && items.length === 0 && !product;
    const observedQuantity = items.length === 1 ? items[0].quantity : unobservedCart ? quantity(document.body) : null;
    const quantityEvidence = /(?:数量|Quantity)\s*[:：]?\s*\d+\b/i.test(body);
    return {stage:currentStage, product, ...(!unobservedCart ? {cartItems:items} : {}), ...(currentStage === 'BAG' ? {bagEmpty} : {}), ...(explicitOutOfStock ? {stockAvailable:false} : {}), ...(!unobservedCart || observedQuantity !== null || quantityEvidence ? {quantity:observedQuantity} : {}),
      total:total(),currency: /(?:RMB|CNY|[¥￥])/.test(body) ? 'CNY' : null,
      fulfillment: /(?:送货详情|送货地址|配送地址|邮寄到|送货到)/.test(body) && !/(?:取货详情|取货联系人)/.test(body) ? 'delivery' : null,
      paymentMethod: paymentMethod(),
      termsPresent: D.salesTermsPresent(body,termsLinks) && /(?:立即下单|下订单)/.test(body),
      ...(orderNumber ? {orderNumber,unpaid,receiptVerified:unpaid && items.length === 1 && !!product && total() !== null} : {}),
      controls:controls(currentStage,items),issues};
  }
  function assertCart(s) {
    if (s.cartItems.length !== 1 || s.cartItems[0].quantity !== 1 || !D.sameProduct(s.cartItems[0].product,binding.intent.product)) throw new Error('cart-mismatch');
    if (Number.isFinite(s.total) && (s.total <= 0 || s.total > binding.intent.maxTotal)) throw new Error('price-mismatch');
  }
  function execute(command,s) {
    const kind = command?.kind;
    if (!s.controls.some(c => c.kind === kind)) throw new Error('control-not-supported');
    if (kind === 'select-product') {
      const choice=selectionControl(binding.intent); if (!choice) throw new Error('selection-unavailable');
      if (command.field !== choice.field) throw new Error('selection-field-changed');
      const el = choice.el; if (visible(el)) safeClick(el); else { const labels=[...(el.labels||[])].filter(available); if(labels.length!==1)throw new Error('selection-unavailable'); safeClick(labels[0]); }
      return;
    }
    if (kind === 'add-to-bag') {
      if (!D.sameProduct(s.product,binding.intent.product) || selectionControl(binding.intent)) throw new Error('product-not-ready');
      safeClick(exactControl(['添加到购物袋','加入购物袋'],['add-to-cart','add-to-bag','addToBag'])); return;
    }
    if (kind === 'edit-variant') { safeClick(editControl(binding.intent,s.cartItems)); return; }
    if (kind === 'checkout') { assertCart(s); safeClick(exactControl(['结账','前往结账'],['bag-checkout-button','checkout'])); return; }
    if (kind === 'continue-shipping') {
      if (s.issues.length) throw new Error('form-not-ready');
      safeClick(exactControl(['继续选择送货信息','继续填写送货信息','继续选择付款方式','继续前往付款','继续进行付款'],['shipping-continue-button','shipping-address-continue-button'])); return;
    }
    if (kind === 'continue-billing') {
      if(s.issues.length)throw new Error('form-not-ready');
      safeClick(exactControl(['查看订单','检查订单','继续查看订单','继续检查订单','核对订单'],['review-order-button','billing-continue-button'])); return;
    }
    if (kind === 'submit-order') {
      const failures=D.validateFinal(snapshot(),binding.intent); if(failures.length)throw new Error(failures.join(','));
      safeClick(exactControl(['立即下单'],['place-order','place-order-button'])); return;
    }
    throw new Error('unsupported-action');
  }
  chrome.runtime.onMessage.addListener((message,sender,respond) => {
    if(sender.id!==chrome.runtime.id || !D.officialLocation(location.href)) return false;
    if(message?.type==='checkout:bind') {
      if(typeof message.nonce!=='string'||message.nonce.length<16||typeof message.runId!=='string'||!D.validateIntent(message.intent)) { respond({ok:false,error:'invalid-bind'}); return false; }
      if(binding && (binding.nonce!==message.nonce || binding.runId!==message.runId)) actionResults.clear();
      binding={nonce:message.nonce,runId:message.runId,intent:structuredClone(message.intent)}; respond({ok:true}); return false;
    }
    if(!binding||message?.nonce!==binding.nonce||message?.runId!==binding.runId) { respond({ok:false,error:'binding-mismatch'}); return false; }
    if(message.type==='checkout:snapshot') { respond({ok:true,snapshot:snapshot()}); return false; }
    if(message.type!=='checkout:act') return false;
    if(typeof message.actionId!=='string'||message.actionId.length<8) { respond({ok:false,error:'invalid-action-id'});return false; }
    if(actionResults.has(message.actionId)){respond(actionResults.get(message.actionId));return false;}
    if(busy){respond({ok:false,error:'action-in-progress'});return false;}
    busy=true;
    let result;
    try {
      const s=snapshot();
      if(s.stage!==message.expectedStage)throw new Error('stage-changed');
      // Reserve the ID before click; a synchronous navigation may destroy this context.
      actionResults.set(message.actionId,{ok:false,error:'action-already-started'});
      execute(message.command,s); result={ok:true,acted:true,kind:message.command.kind};
    } catch(error) { result={ok:false,error:String(error.message).slice(0,180)}; }
    finally {busy=false;}
    actionResults.set(message.actionId,result); if(actionResults.size>500)actionResults.delete(actionResults.keys().next().value);
    respond(result); return false;
  });
  new MutationObserver(() => {
    if(!binding || changeTimer) return;
    changeTimer=setTimeout(() => {changeTimer=null;chrome.runtime.sendMessage({type:'checkout:changed',nonce:binding.nonce,runId:binding.runId}).catch(()=>{});},100);
  }).observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['disabled','aria-disabled','aria-checked','class']});
})();
