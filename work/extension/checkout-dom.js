/* Pure, privacy-preserving checkout predicates shared with the isolated content script. */
(function (root) {
  'use strict';
  const norm = value => String(value ?? '').replace(/[\u00a0\u202f\u200b]/g, ' ').replace(/\s+/g, ' ').trim();
  const compact = value => norm(value).replace(/\s/g, '').toLowerCase();
  const colors = ['勃艮第酒红色', '青雾蓝色', '冰川蓝色', '冰川蓝', '星光白色', '星光白', '黑色', '银色', '蓝色', '红色', 'Silver', 'Black', 'Blue', 'White', 'Natural Titanium', 'Desert Titanium', 'Black Titanium', 'White Titanium', 'Pink', 'Teal', 'Ultramarine', '原色鈦金屬', '沙漠色鈦金屬', '黑色鈦金屬', '白色鈦金屬', '湖水綠色', '群青色', '粉紅色', '午夜暗色', '星光色', 'ナチュラルチタニウム', 'デザートチタニウム', 'ブラックチタニウム', 'ホワイトチタニウム', 'ブラック', 'ホワイト', 'ピンク', 'ティール', 'ウルトラマリン'];
  function parseProduct(value) {
    const text = norm(value), model = text.match(/iPhone\s*(?:\d+\s*(?:Pro\s*Max|Pro|Plus|Air)?|Duo)/i);
    const capacity = text.match(/\b(\d+)\s*(GB|TB)\b/i);
    const color = colors.find(c => text.includes(c));
    if (!model || !capacity || !color) return null;
    const parsed = {Model: norm(model[0]).replace(/iPhone\s*/i, 'iPhone ').replace(/Pro\s*Max/i, 'Pro Max'), Capacity: `${capacity[1]}${capacity[2].toUpperCase()}`, Color: color};
    const code = text.match(/\b([A-Z0-9]{5}(?:CH|J|ZA|ZP|LL|B)\/A)\b/); if (code) parsed.Code = code[1];
    return parsed;
  }
  function canonicalColor(value) { return compact(value).replace(/冰川蓝色/g, '冰川蓝'); }
  function sameProduct(a, b) {
    return !!a && !!b && compact(a.Model) === compact(b.Model) && compact(a.Capacity) === compact(b.Capacity) && canonicalColor(a.Color) === canonicalColor(b.Color) && (!a.Code || !b.Code || a.Code === b.Code);
  }
  function sameVariantFamily(a, b) { return !!a && !!b && compact(a.Model) === compact(b.Model) && compact(a.Capacity) === compact(b.Capacity); }
  function parseMoney(value) {
    const match = norm(value).match(/(?:RMB|CNY|JPY|HKD|USD|HK\$|人民币|[¥￥$]|円)\s*([\d,]+(?:\.\d{1,2})?)|([\d,]+(?:\.\d{1,2})?)\s*(?:円|元)/i);
    if (!match) return null;
    const rawNumber = match[1] || match[2];
    const number = Number(rawNumber.replace(/,/g, '')); return Number.isFinite(number) && number >= 0 ? number : null;
  }
  function officialLocation(value) {
    try {
      const url = new URL(value);
      const isCn = /^(?:www|secure\d+\.www)\.apple\.com\.cn$/.test(url.hostname);
      const isGlobal = /^(?:www|secure\d+\.www)\.apple\.com$/.test(url.hostname);
      const validGlobalPath = /^\/(?:(?:hk|hk-zh|jp)\/)?shop(?:\/|$)/.test(url.pathname);
      return url.protocol === 'https:' && !url.username && !url.password && !url.port && (isCn || (isGlobal && validGlobalPath));
    } catch { return false; }
  }
  function reviewHeading(value) { return /^(?:准备下单了吗|準備好下單了嗎|核對你的訂單|確定訂單|Review your (?:order|bag)|Ready to place your order|ご注文の確定|ご注文の確認|ご注文の準備はよろしいですか)[？?]?(?:\s|$)/i.test(norm(value)); }
  function emptyBagText(value) { return /^(?:(?:你|您)的)?購物袋(?:(?:是|還)?空的|為空|中沒有商品)|(?:(?:你|您)的)?购物袋(?:(?:是|还)?空的|为空|中没有商品)|(?:お客様の)?(?:バッグ|ショッピングバッグ)(?:は空です|に商品はありません)|(?:Your )?(?:bag|Shopping Bag) is empty[。.!！]?$/i.test(norm(value)); }
  function outOfStockText(value) { return /^(?:(?:此|这款|該|该)(?:产品|商品|機型|机型)(?:目前|现在|現在)?(?:已)?(?:不可购买|無法購買|无法购买|无货|缺货|缺貨)|(?:目前|现在|現在|暂时|暫時|暂)?(?:无货|缺货|缺貨|不可购买|無法購買|无法购买|无法供货|無法供貨)|售罄|已售罄|在庫がありません|現在ご注文いただけません|在庫切れ|受取不可|Currently unavailable|Out of stock|Sold out)[。.!！]?$/i.test(norm(value)); }
  function salesTermsPresent(body, links) {
    if (!/(?:Apple\s*Store|Apple)/.test(norm(body)) || !/(?:销售条款|条款(?:和|与)条件|販売条件|利用規約|利用条件)/.test(norm(body))) return false;
    return links.some(href => {
      try {
        const url = new URL(href);
        const hostValid = /^(?:www\.)?apple\.com\.cn$/.test(url.hostname) || /^(?:www\.)?apple\.com$/.test(url.hostname);
        return url.protocol === 'https:' && hostValid && !url.port &&
          /(?:\/salespolicies(?:\/|$)|\/legal\/sales-support\/sales-policies(?:\/|$))/.test(url.pathname);
      } catch { return false; }
    });
  }
  function pickupStoreMatches(snapshot, intent) {
    if (intent?.fulfillment !== 'pickup') return false;
    const expected = intent.pickup;
    if (!expected || !/^R\d{1,8}$/.test(expected.storeNumber || '') || !norm(expected.storeName)) return false;
    if (snapshot.pickupStoreNumber) return snapshot.pickupStoreNumber === expected.storeNumber;
    return !!norm(snapshot.pickupStoreName) && norm(snapshot.pickupStoreName).normalize('NFKC').toLowerCase() === norm(expected.storeName).normalize('NFKC').toLowerCase();
  }
  function validateIntent(intent) {
    const areaCode = intent?.areaCode || 'cn';
    return !!intent && ['cn', 'jp', 'hk', 'us'].includes(areaCode) && !!parseProduct(`${intent.product?.Model} ${intent.product?.Capacity} ${intent.product?.Color}`) && intent.quantity === 1 && Number.isFinite(intent.maxTotal) && intent.maxTotal > 0 && typeof intent.allowSubmit === 'boolean' && typeof intent.acknowledgedTerms === 'boolean' && [undefined, 'delivery', 'pickup'].includes(intent.fulfillment) && (intent.fulfillment !== 'pickup' || (!!intent.pickup && /^R\d{1,8}$/.test(intent.pickup.storeNumber || '') && !!norm(intent.pickup.storeName) && intent.pickup.slotPolicy === 'earliest'));
  }
  function validateFinal(snapshot, intent) {
    const issues = [];
    if (!validateIntent(intent)) issues.push('invalid-intent');
    if (snapshot.stage !== 'REVIEW') issues.push('not-review');
    if (!intent?.allowSubmit || !intent?.acknowledgedTerms || intent.runMode === 'review') issues.push('submission-not-authorized');
    if (!sameProduct(snapshot.product, intent?.product)) issues.push('product-mismatch');
    if (!Array.isArray(snapshot.cartItems) || snapshot.cartItems.length !== 1 || !sameProduct(snapshot.cartItems[0]?.product, intent?.product) || snapshot.cartItems[0]?.quantity !== 1 || snapshot.quantity !== 1) issues.push('cart-mismatch');
    const currencyMap = { cn: 'CNY', jp: 'JPY', hk: 'HKD', us: 'USD' };
    const expectedCurrency = currencyMap[intent?.areaCode || 'cn'] || 'CNY';
    if (snapshot.currency !== expectedCurrency || !Number.isFinite(snapshot.total) || snapshot.total <= 0 || snapshot.total > intent?.maxTotal) issues.push('price-mismatch');
    if (snapshot.fulfillment !== (intent?.fulfillment || 'delivery')) issues.push('fulfillment-mismatch');
    if (intent?.fulfillment === 'pickup' && !pickupStoreMatches(snapshot, intent)) issues.push('pickup-store-mismatch');
    const expectedPayment = ['jp', 'hk', 'us'].includes(intent?.areaCode)
      ? ['credit-card', 'apple-pay', 'convenience-store', 'alipay', 'wechat']
      : ['alipay'];
    if (!expectedPayment.includes(snapshot.paymentMethod)) issues.push('payment-mismatch');
    if (!snapshot.termsPresent) issues.push('terms-not-visible');
    if (snapshot.issues?.length) issues.push(...snapshot.issues);
    return [...new Set(issues)];
  }
  root.AppleCheckoutDOM = Object.freeze({norm, compact, parseProduct, sameProduct, sameVariantFamily, parseMoney, officialLocation, reviewHeading, emptyBagText, outOfStockText, salesTermsPresent, pickupStoreMatches, validateIntent, validateFinal});
})(globalThis);
