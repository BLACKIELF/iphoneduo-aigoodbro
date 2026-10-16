const $ = id => document.getElementById('checkout-' + id);
let products = [], stores = [], run = null, busy = false;
const labels = {
  WAITING_FOR_STOCK: '等待指定门店有货（单次）', READY: '准备中', SELECTING_PRODUCT: '自动选配中', CHECKING_OUT: '自动结账中', WAITING_FOR_PAGE: '等待页面', READY_TO_SUBMIT: '等待提交授权', PAYMENT_STOPPED: '已停在付款步骤', CREATED: '准备中', RUNNING: '自动执行中', SELECTING: '选配中', BAG_VERIFIED: '购物袋已核对',
  CHECKOUT: '结账中', REVIEW_VERIFIED: '订单已核对', WAITING_FOR_IDENTITY: '等待身份验证',
  AWAITING_SUBMIT_AUTHORIZATION: '等待提交授权', SUBMITTING: '正在生成订单', SUBMISSION_UNKNOWN: '提交结果待核对',
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
  for (const id of ['start', 'trial', 'arm', 'resume', 'stop', 'open']) $(id).disabled = busy || (['resume', 'stop', 'open'].includes(id) && !run) || (id === 'open' && run?.tabId == null);
  $('arm').disabled ||= $('fulfillment').value !== 'pickup' || $('entry').value !== 'bag';
}
async function command(type, extra = {}) {
  if (busy) return;
  busy = true; render();
  try {
    const result = await chrome.runtime.sendMessage({ type, ...extra });
    if (!result?.ok) throw new Error(result?.error || '扩展未返回结果');
    run = result.run; $('message').textContent = run?.state.reason || ''; render();
  } catch (error) { $('message').textContent = error.message; }
  finally { busy = false; render(); }
}
function fulfillmentFields() {
  const pickup = $('fulfillment').value === 'pickup';
  $('store-field').hidden = !pickup; $('address-field').hidden = !pickup;
  $('replace').disabled = $('entry').value === 'bag';
  if ($('replace').disabled) $('replace').checked = false;
  render();
}
function purchaseRequest(trial = false) {
  const product = products.find(p => p.Model === $('model').value && p.Capacity === $('capacity').value && p.Color === $('color').value);
  const maxTotal = Number($('budget').value);
  if (!product || !Number.isFinite(maxTotal) || maxTotal <= 0) throw new Error('请选择商品并填写金额上限。');
  const fulfillment = $('fulfillment').value;
  let pickup;
  if (fulfillment === 'pickup') {
    const store = stores.find(s => s.StoreNumber === $('store').value);
    const address = $('address').value.trim();
    if (!store || !address) throw new Error('请选择唯一自提门店并填写其公开区县或地址。');
    pickup = { storeNumber: store.StoreNumber, storeName: store.CityStoreName.split('-').slice(1).join('-').trim(),
      region: { state: store.Province, city: store.City, address }, slotPolicy: 'earliest' };
  }
  const allowSubmit = !trial && $('submit').checked;
  return { intent: { product, areaCode: 'cn', fulfillment, quantity: 1, maxTotal,
    entryMode: $('entry').value, runMode: allowSubmit ? 'submit' : 'review', allowSubmit,
    acknowledgedTerms: $('terms').checked, ...(pickup ? { pickup } : {}) },
    allowReplaceVariant: $('replace').checked, newIntentAcknowledged: $('new').checked };
}
async function startPurchase(trial = false, armed = false) {
  if (busy) return;
  try {
    const request = purchaseRequest(trial);
    if (armed) {
      if (request.intent.fulfillment !== 'pickup' || request.intent.entryMode !== 'bag') throw new Error('有货触发需要指定门店自提，并仅使用已准备的购物袋。');
      busy = true; render();
      const state = await chrome.runtime.sendMessage({ type: 'get-backend-state' });
      if (!state?.ok || !state.monitoring) throw new Error('请先启动相同商品和门店的 Java 库存监控。');
      const matches = state.tasks.filter(t => t.areaCode === 'cn' && t.store?.StoreNumber === request.intent.pickup.storeNumber && t.product?.Code === request.intent.product.Code);
      if (matches.length !== 1) throw new Error('需要且只能有一个相同商品与门店的监控任务。');
      request.taskId = matches[0].id;
      request.identity = `cn:${request.intent.pickup.storeNumber}:${request.intent.product.Code}`;
    }
    busy = false;
    await command(armed ? 'checkout-arm' : 'checkout-start', request);
  } catch (error) { $('message').textContent = error.message; }
  finally { busy = false; render(); }
}
async function initialize() {
  const [data, storeData] = await Promise.all(['data/products/product_data_cn.json', 'data/stores/store_cn.json'].map(async path => {
    const response = await fetch(chrome.runtime.getURL(path));
    if (!response.ok) throw new Error('商品或门店目录未加载，请重新加载扩展。');
    return response.json();
  }));
  products = Object.values(data.products).flat().filter(p => /^iPhone/.test(p.Model));
  stores = storeData.stores;
  $('store').replaceChildren(...stores.map(store => Object.assign(document.createElement('option'), { value: store.StoreNumber, textContent: store.CityStoreName })));
  options($('model'), products.map(p => p.Model), 'iPhone 18 Pro'); capacities();
  $('model').addEventListener('change', capacities); $('capacity').addEventListener('change', colors);
  $('store').addEventListener('change', () => { $('address').value = ''; });
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
