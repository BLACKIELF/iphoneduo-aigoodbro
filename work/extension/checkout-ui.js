const $ = id => document.getElementById('checkout-' + id);
let products = [], run = null, busy = false;
const labels = {
  READY: '准备中', SELECTING_PRODUCT: '自动选配中', CHECKING_OUT: '自动结账中', WAITING_FOR_PAGE: '等待页面', READY_TO_SUBMIT: '等待提交授权', PAYMENT_STOPPED: '已停在付款步骤', CREATED: '准备中', RUNNING: '自动执行中', SELECTING: '选配中', BAG_VERIFIED: '购物袋已核对',
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
  for (const id of ['start', 'resume', 'stop', 'open']) $(id).disabled = busy || (id !== 'start' && !run);
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
async function initialize() {
  const response = await fetch(chrome.runtime.getURL('data/products/product_data_cn.json'));
  const data = await response.json();
  products = Object.values(data.products).flat().filter(p => /^iPhone/.test(p.Model));
  options($('model'), products.map(p => p.Model), 'iPhone 18 Pro'); capacities();
  $('model').addEventListener('change', capacities); $('capacity').addEventListener('change', colors);
  $('start').addEventListener('click', () => {
    const product = products.find(p => p.Model === $('model').value && p.Capacity === $('capacity').value && p.Color === $('color').value);
    const maxTotal = Number($('budget').value);
    if (!product || !Number.isFinite(maxTotal) || maxTotal <= 0) { $('message').textContent = '请选择商品并填写金额上限。'; return; }
    command('checkout-start', {
      intent: { product, areaCode: 'cn', fulfillment: 'delivery', quantity: 1, maxTotal,
        allowSubmit: $('submit').checked, acknowledgedTerms: $('terms').checked },
      allowReplaceVariant: $('replace').checked, newIntentAcknowledged: $('new').checked
    });
  });
  $('stop').addEventListener('click', () => command('checkout-stop'));
  $('resume').addEventListener('click', () => command('checkout-resume'));
  $('open').addEventListener('click', () => command('checkout-open'));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.checkoutRun) { run = changes.checkoutRun.newValue; render(); }
  });
  await command('checkout-status');
}
initialize().catch(error => { $('message').textContent = error.message; });
