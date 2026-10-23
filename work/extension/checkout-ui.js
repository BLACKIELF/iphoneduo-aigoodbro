const $ = id => document.getElementById('checkout-' + id);
let products = [], stores = [], run = null, busy = false, stopping = false, operationEpoch = 0;
const labels = {
  WAITING_FOR_STOCK: '等待指定门店有货（单次）', READY: '准备中', SELECTING_PRODUCT: '自动选配中', CHECKING_OUT: '自动结账中', WAITING_FOR_PAGE: '等待页面', READY_TO_SUBMIT: '已直达下单界面（等待确认下单）', PAYMENT_STOPPED: '已停在付款步骤', CREATED: '准备中', RUNNING: '自动执行中', SELECTING: '选配中', BAG_VERIFIED: '购物袋已核对',
  CHECKOUT: '结账中', REVIEW_VERIFIED: '订单已核对', WAITING_FOR_IDENTITY: '等待身份验证',
  AWAITING_SUBMIT_AUTHORIZATION: '已直达下单界面（等待确认下单）', SUBMITTING: '正在生成订单', SUBMISSION_UNKNOWN: '提交结果待核对',
  ORDER_CREATED_UNPAID: '已生成未付款订单', PAYMENT_REQUIRED: '已停在付款步骤', CANCELLED: '已停止', BLOCKED: '需要处理'
};
function options(element, values, preferred) {
  element.replaceChildren(...[...new Set(values)].map(value => Object.assign(document.createElement('option'), { value, textContent: value })));
  if (values.includes(preferred)) element.value = preferred;
}
function capacities() {
  options($('capacity'), products.filter(p => p.Model === $('model').value).map(p => p.Capacity), '512GB'); colors();
}
function colors() {
  options($('color'), products.filter(p => p.Model === $('model').value && p.Capacity === $('capacity').value).map(p => p.Color));
}
function render() {
  $('status').textContent = run ? (labels[run.state.status] || run.state.status) : '尚未启动';
  $('resume').textContent = run?.state.submitAttempt ? '核对订单结果' : '补全信息后继续';
  $('log').replaceChildren(...(run?.log || []).slice().reverse().map(entry => {
    const p = document.createElement('p'); p.textContent = new Date(entry.time).toLocaleTimeString('zh-CN') + ' ' + entry.message; return p;
  }));
  for (const id of ['start', 'trial', 'arm', 'resume', 'open']) $(id).disabled = busy || (['resume', 'open'].includes(id) && !run) || (id === 'open' && run?.tabId == null);
  $('stop').disabled = stopping || (!run && !busy);
  $('arm').disabled ||= $('fulfillment').value !== 'pickup' || $('entry').value !== 'bag';
}
async function command(type, extra = {}, expectedEpoch = null) {
  const stop = type === 'checkout-stop';
  if (stop ? stopping : expectedEpoch === null ? busy : expectedEpoch !== operationEpoch) return;
  const epoch = expectedEpoch ?? ++operationEpoch;
  if (stop) stopping = true;
  busy = true; render();
  try {
    const result = await chrome.runtime.sendMessage({ type, ...extra });
    if (epoch !== operationEpoch) return;
    if (!result?.ok) throw new Error(result?.error || '扩展未返回结果');
    run = result.run; $('message').textContent = run?.state.reason || ''; render();
  } catch (error) { if (epoch === operationEpoch) $('message').textContent = error.message; }
  finally { if (epoch === operationEpoch) { busy = false; stopping = false; render(); } }
}
function fulfillmentFields() {
  const pickup = $('fulfillment').value === 'pickup';
  $('store-field').hidden = !pickup; $('address-field').hidden = !pickup;
  $('replace').disabled = $('entry').value === 'bag';
  if ($('replace').disabled) $('replace').checked = false;
  render();
}
function purchaseRequest(trial = false) {
  const areaCode = $('area')?.value || 'cn';
  const product = products.find(p => p.Model === $('model').value && p.Capacity === $('capacity').value && p.Color === $('color').value);
  const maxTotal = Number($('budget').value);
  if (!product || !Number.isFinite(maxTotal) || maxTotal <= 0) throw new Error('请选择商品并填写金额上限。');
  const fulfillment = $('fulfillment').value;
  let pickup;
  if (fulfillment === 'pickup') {
    const store = stores.find(s => s.StoreNumber === $('store').value);
    const address = $('address').value.trim();
    if (!store || !address) throw new Error('请选择唯一自提门店并填写其公开区县或地址。');
    const storeName = store.CityStoreName ? store.CityStoreName.split('-').slice(1).join('-').trim() || store.CityStoreName : (store.StoreName || '');
    pickup = { storeNumber: store.StoreNumber, storeName,
      region: { state: store.Province || store.City || '', city: store.City || store.Province || '', address }, slotPolicy: 'earliest' };
  }
  const allowSubmit = !trial && $('submit').checked;
  return { intent: { product, areaCode, fulfillment, quantity: 1, maxTotal,
    entryMode: $('entry').value, runMode: allowSubmit ? 'submit' : 'review', allowSubmit,
    acknowledgedTerms: $('terms').checked, ...(pickup ? { pickup } : {}) },
    allowReplaceVariant: $('replace').checked, newIntentAcknowledged: $('new').checked };
}
async function startPurchase(trial = false, armed = false) {
  if (busy) return;
  const epoch = ++operationEpoch;
  busy = true; render();
  try {
    const request = purchaseRequest(trial);
    if (armed) {
      if (request.intent.fulfillment !== 'pickup' || request.intent.entryMode !== 'bag') throw new Error('有货触发需要指定门店自提，并仅使用已准备的购物袋。');
      const state = await chrome.runtime.sendMessage({ type: 'get-backend-state' });
      if (epoch !== operationEpoch) return;
      if (!state?.ok || !state.monitoring) throw new Error('请先启动相同商品和门店的 Java 库存监控。');
      const matches = state.tasks.filter(t => t.areaCode === request.intent.areaCode && t.store?.StoreNumber === request.intent.pickup.storeNumber && t.product?.Code === request.intent.product.Code);
      if (matches.length !== 1) throw new Error('需要且只能有一个相同商品与门店的监控任务。');
      request.taskId = matches[0].id;
      request.identity = `${request.intent.areaCode}:${request.intent.pickup.storeNumber}:${request.intent.product.Code}`;
    }
    if (epoch !== operationEpoch) return;
    await command(armed ? 'checkout-arm' : 'checkout-start', request, epoch);
  } catch (error) { if (epoch === operationEpoch) $('message').textContent = error.message; }
  finally { if (epoch === operationEpoch) { busy = false; render(); } }
}
async function loadCatalog(areaCode = 'cn') {
  const [data, storeData] = await Promise.all([`data/products/product_data_${areaCode}.json`, `data/stores/store_${areaCode}.json`].map(async path => {
    const response = await fetch(chrome.runtime.getURL(path));
    if (!response.ok) throw new Error('商品或门店目录未加载，请重新加载扩展。');
    return response.json();
  }));
  products = Object.values(data.products).flat().filter(p => /^iPhone/.test(p.Model));
  stores = storeData.stores || [];
  $('store').replaceChildren(...stores.map(store => Object.assign(document.createElement('option'), { value: store.StoreNumber, textContent: store.CityStoreName || store.StoreName })));
  const defaultModel = products[0]?.Model || 'iPhone 18 Pro';
  options($('model'), products.map(p => p.Model), defaultModel);
  capacities();
  if ($('budget')) {
    const placeholders = {
      cn: '请填写本次订单最高金额（CNY，如 10000）',
      hk: '请填写本次订单最高金额（HKD，如 11000）',
      jp: '请填写本次订单最高金额（JPY，如 200000）',
      us: '请填写本次订单最高金额（USD，如 1300）'
    };
    $('budget').placeholder = placeholders[areaCode] || '请填写本次订单最高金额';
  }
}
async function initialize() {
  await loadCatalog($('area')?.value || 'cn');
  if ($('area')) {
    $('area').addEventListener('change', () => loadCatalog($('area').value).catch(error => { $('message').textContent = error.message; }));
  }
  $('model').addEventListener('change', capacities); $('capacity').addEventListener('change', colors);
  const districtMap = {
    R320: '朝阳区', R388: '西城区', R448: '东城区', R479: '朝阳区', R645: '朝阳区', R792: '大兴区',
    R359: '黄浦区', R389: '浦东新区', R390: '黄浦区', R401: '徐汇区', R581: '杨浦区', R678: '静安区', R683: '普陀区', R705: '闵行区',
    R577: '天河区', R639: '天河区', R484: '南山区', R761: '罗湖区', R793: '宝安区',
    R502: '成华区', R580: '锦江区', R579: '和平区', R637: '南开区', R638: '河西区',
    R476: '江北区', R480: '渝中区', R573: '九龙坡区', R471: '上城区', R532: '上城区',
    R493: '秦淮区', R643: '雨花台区', R703: '玄武区', R534: '沈河区', R576: '和平区', R609: '西岗区',
    R575: '江汉区', R617: '芙蓉区', R572: '二七区', R670: '五华区', R571: '青秀区',
    R574: '梁溪区', R688: '工业园区', R531: '海曙区', R766: '瓯海区', R765: '蜀山区',
    R648: '历下区', R557: '市南区', R644: '思明区', R646: '晋安区'
  };
  function autoFillAddress() {
    const s = stores.find(item => item.StoreNumber === $('store').value);
    if (s && !$('address').value.trim()) {
      const known = districtMap[s.StoreNumber] || '';
      $('address').value = [known, s.CityStoreName, s.District].filter(Boolean).join(' ');
    }
  }
  $('store').addEventListener('change', () => {
    $('address').value = '';
    autoFillAddress();
  });
  autoFillAddress();
  $('fulfillment').addEventListener('change', fulfillmentFields); $('entry').addEventListener('change', fulfillmentFields);
  $('start').addEventListener('click', () => startPurchase());
  $('trial').addEventListener('click', () => startPurchase(true));
  $('arm').addEventListener('click', () => startPurchase(false, true));
  fulfillmentFields();
  $('stop').addEventListener('click', () => command('checkout-stop'));
  $('resume').addEventListener('click', () => command('checkout-resume'));
  $('open').addEventListener('click', () => command('checkout-open'));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.checkoutRun) { run = changes.checkoutRun.newValue; render(); }
  });
  await command('checkout-status');
}
initialize().catch(error => { $('message').textContent = error.message; });
