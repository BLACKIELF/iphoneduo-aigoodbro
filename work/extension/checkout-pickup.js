/* Restricted adaptation of suversal checkout.rs / checkout_pickup_region.js.
 * Adapted 2026-10-16 by AiGoodBro; upstream commit 7f9e86d.
 * Copyright (C) 2020-2025 Hteen and contributors; 2026 apple-pickup-watcher
 * and apple-store-inventory-monitor contributors. See licenses/Suversal-NOTICE.
 * GPL-3.0-or-later. Isolated-world DOM only; no CDP, network or contact storage. */
(function (root) {
  'use strict';
  const norm = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const canonical = value => norm(value).replace(/\s/g, '');
  const storeName = value => norm(value).normalize('NFKC').toLowerCase();
  const SLOT_LOAD_TIMEOUT_MS = 12000;
  const regionName = value => canonical(value).replace(/(省|市)$/, '');
  const credit = /礼品卡|余额|gift\s*card|(?:account\s*)?balance|store\s*credit|混合(?:付款|支付)|组合(?:付款|支付)|\b(?:split|mixed)[\s-]*(?:payment|tender)\b/i;
  function create({ document, location, getComputedStyle, click, setSelect, now = Date.now }) {
    let identity = '', observed = '', since = 0;
    const used = new Set(), exhaustedDates = new Set();
    const all = (selector, scope = document) => [...scope.querySelectorAll(selector)];
    const visible = el => !!el && !el.closest('[hidden],[aria-hidden="true"]') && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden' && el.getClientRects().length > 0;
    const available = el => visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
    const text = el => norm(el?.innerText || el?.textContent || '');
    const usableRadio = el => !el.disabled && el.getAttribute('aria-disabled') !== 'true' && (visible(el) || [...(el.labels || [])].some(available));
    const target = el => available(el) ? el : [...(el.labels || [])].filter(available).length === 1 ? [...el.labels].find(available) : null;
    const chosen = el => el?.checked === true || el?.getAttribute('aria-checked') === 'true' || el?.getAttribute('aria-pressed') === 'true';
    const button = autom => all(`button[data-autom="${autom}"]`).filter(available);
    const optionAvailable = option => !option.disabled && option.getAttribute?.('aria-disabled') !== 'true' && !option.closest?.('optgroup[disabled]');
    function fieldComplete(el) {
      if (el.getAttribute('aria-invalid') === 'true' || el.validity?.valid === false) return false;
      const type = String(el.type || el.getAttribute('type') || '').toLowerCase();
      if (type === 'checkbox') return el.checked === true;
      if (type === 'radio') {
        const name = el.getAttribute('name');
        return name ? all('input[type="radio"]').some(other => other.getAttribute('name') === name && usableRadio(other) && other.checked === true) : el.checked === true;
      }
      if (el.selectedOptions && [...el.selectedOptions].some(option => !optionAvailable(option))) return false;
      return !!norm(el.value);
    }
    const phase = () => /^(Fulfillment|PickupContact|Billing|Review)(?:$|[-_])/i.exec(new URL(location.href).searchParams.get('_s') || '')?.[1].toLowerCase() || '';
    function inspect(intent) {
      const key = JSON.stringify([intent?.intentId, intent?.revision, intent?.pickup]);
      if (key !== identity) { identity = key; observed = ''; since = now(); used.clear(); exhaustedDates.clear(); }
      const p = intent?.pickup, step = phase();
      const state = { checkoutStep: step, pickupProgress: { step, state: 'waiting', storeNumber: '', storeName: '', date: '', slot: '' }, pickupStoreNumber: '', pickupStoreName: '', issues: [], action: null };
      const fail = reason => { state.issues.push(reason); state.pickupProgress.state = 'blocked'; return state; };
      const offer = (kind, element, value = '') => {
        const actionKey = JSON.stringify([step, kind, value, kind === 'select-slot' ? state.pickupProgress.date : '']);
        if (used.has(actionKey)) return state;
        state.action = { key: actionKey, kind, element, value };
        state.pickupProgress.nextAction = actionKey;
        state.pickupProgress.state = 'ready'; return state;
      };
      const oneButton = (autom, action) => { const nodes = button(autom); return nodes.length === 1 ? offer(action, nodes[0]) : nodes.length > 1 ? fail('取货步骤按钮不唯一，请在官网确认') : state; };
      if (intent?.fulfillment !== 'pickup') return state;
      if (!p || !/^R\d{1,8}$/.test(p.storeNumber || '') || !norm(p.storeName) || p.slotPolicy !== 'earliest') return fail('取货门店或时段策略无效');
      if (!step) return state;
      const stores = all('input[name="store-locator-result"]');
      const selected = stores.filter(el => chosen(el) && usableRadio(el));
      if (selected.length > 1) return fail('取货门店选中状态不唯一');
      if (selected.length === 1) {
        state.pickupStoreNumber = selected[0].value;
        const titles = [...(selected[0].labels || [])].flatMap(label => all('.form-selector-title', label)).filter(visible);
        const titleNames = [...new Set(titles.map(title => storeName(text(title))).filter(Boolean))];
        if (titleNames.length > 1) return fail('选中门店包含冲突名称，请在官网确认');
        state.pickupStoreName = titleNames.length === 1 ? text(titles[0]) : (state.pickupStoreNumber === p.storeNumber ? p.storeName : '');
      }
      // Summary evidence must be explicit and current. Never substitute a previous
      // page's selection when the Review page omits its pickup store.
      if (step === 'review') {
        const lines = String(document.body?.innerText || document.body?.textContent || '').split(/[\r\n]+/).map(norm).filter(Boolean);
        const labels = [];
        for (let index = 0; index < lines.length; index++) {
          const match = /^(?:取货门店|取货地点|受取店舗|受取場所)(?:\s*[:：]\s*|\s+)(.*)$/.exec(lines[index]);
          const standalone = /^(?:取货门店|取货地点|受取店舗|受取場所)[:：]?$/.test(lines[index]);
          if (match || standalone) {
            const value = match?.[1] || lines[index + 1];
            if (!value || /^(?:取货门店|取货地点|受取店舗|受取場所)[:：]?$/.test(value)) return fail('确认页取货门店摘要不完整');
            labels.push(storeName(value));
          }
        }
        const distinctNames = [...new Set(labels)];
        if (distinctNames.length > 1 || (distinctNames.length === 1 && distinctNames[0] !== storeName(p.storeName))) return fail('确认页取货门店与目标不一致或不唯一');
        if (selected.length === 1 && (state.pickupStoreNumber !== p.storeNumber || (state.pickupStoreName && storeName(state.pickupStoreName) !== storeName(p.storeName)))) return fail('确认页选中门店、门店名称与目标冲突');
        if (distinctNames.length === 1) {
          if (state.pickupStoreName && storeName(state.pickupStoreName) !== distinctNames[0]) return fail('确认页门店摘要与选中门店冲突');
          state.pickupStoreName = p.storeName;
        }
      }
      state.pickupProgress.storeNumber = state.pickupStoreNumber;
      state.pickupProgress.storeName = state.pickupStoreName;
      if (step === 'review') { state.pickupProgress.state = 'review'; return state; }
      if (all('[role="alert"],.rs-form-error,.rs-error-message').filter(visible).some(el => text(el))) return fail('官网取货表单存在错误，请在官网补齐');
      if (step === 'pickupcontact') {
        const required = ['lastName', 'firstName', 'emailAddress', 'fullDaytimePhone'];
        const missing = required.some(name => {
          const fields = all(`input[data-autom="form-field-${name}"]`).filter(visible);
          return fields.length !== 1 || !fieldComplete(fields[0]);
        });
        const extra = all('input[required],select[required],textarea[required],input[aria-required="true"],select[aria-required="true"],textarea[aria-required="true"],input[data-autom="form-field-nationalIdSelf"]').filter(el => visible(el) || [...(el.labels || [])].some(visible));
        if (missing || extra.some(el => !el.disabled && !fieldComplete(el))) return fail('取货联系人或证件信息未完整，请在 Apple 官网补齐后继续');
        // Only booleans leave this scope; no personal value is retained or returned.
        state.pickupProgress.state = 'contact-ready';
        return oneButton('continue-button-label', 'continue-contact');
      }
      if (step === 'billing') {
        if (credit.test(text(document.body))) return fail('付款摘要包含余额、礼品卡或混合付款，请在官网核对');
        const radios = all('input[data-autom^="checkout-billingOptions-"]').filter(usableRadio);
        const alipay = radios.filter(el => el.value === 'ALIPAY');
        if (alipay.length !== 1) return fail('无法唯一确定支付宝付款选项');
        const alipayLabel = norm(alipay[0].getAttribute('aria-label') || [...(alipay[0].labels || [])].map(text).join(' '));
        if (alipayLabel && !/^(?:支付宝|alipay)$/i.test(alipayLabel)) return fail('支付宝选项与可见付款说明冲突，请在官网确认');
        if (!chosen(alipay[0])) return offer('select-alipay', target(alipay[0]), 'ALIPAY');
        if (radios.some(el => chosen(el) && el !== alipay[0])) return fail('付款方式选中状态不唯一');
        return oneButton('continue-button-review', 'continue-review');
      }
      if (step !== 'fulfillment') return state;
      const pickupTabs = all('button').filter(el => available(el) && ['我要取货', '店舗受取', '受け取り', '受取'].includes(text(el)));
      if (pickupTabs.length > 1) return fail('取货方式选项不唯一');
      if (pickupTabs.length === 1 && !chosen(pickupTabs[0])) return offer('select-pickup', pickupTabs[0]);
      if (pickupTabs.length === 0 && stores.length === 0) return state;
      const exact = stores.filter(el => el.value === p.storeNumber);
      if (exact.length > 1) return fail('目标门店重复，无法唯一选择');
      if (exact.length === 0) {
        const panels = ['state', 'city', 'district'].map(part => ({ part, nodes: all(`[data-autom="address-field-provinceselector-${part}-panel"]`).filter(visible) })).filter(value => value.nodes.length);
        if (panels.length > 1 || panels.some(value => value.nodes.length !== 1)) return fail('取货地区选择面板不唯一');
        if (panels.length) {
          const { part, nodes } = panels[0];
          if (!p.region?.state || !p.region?.city || (part === 'district' && !p.region?.address)) return fail('门店地区信息不完整，请在官网选择取货地区');
          const options = all('button', nodes[0]).filter(el => available(el) && text(el));
          if (!options.length) return state;
          const matches = options.filter(el => part === 'district' ? canonical(p.region.address).includes(canonical(text(el))) : regionName(text(el)) === regionName(p.region[part]));
          return matches.length === 1 ? offer('region-' + part, matches[0], text(matches[0])) : fail('无法唯一确定目标门店所在省市区，请在官网选择');
        }
        const more = button('show-more-stores-button');
        if (stores.length && more.length === 1) return offer('show-more-stores', more[0]);
        const picker = button('fulfillment-pickup-store-search-button');
        if (picker.length === 1 && p.region?.state && p.region?.city && !(text(picker[0]).includes(regionName(p.region.state)) && text(picker[0]).includes(regionName(p.region.city)))) return offer('open-region', picker[0]);
        return fail('列表中没有指定取货门店，请在官网确认地区和库存');
      }
      const store = exact[0], storeLabel = [...(store.labels || [])].map(text).join(' ');
      if (store.disabled || /不可取货|无法取货|不可提取|无法提取|无货|售罄|受取不可|在庫切れ|在庫がありません/.test(storeLabel)) return fail('指定门店目前不可取货');
      if (!target(store)) { const more = button('show-more-stores-button'); return more.length === 1 ? offer('show-more-stores', more[0]) : fail('指定门店尚未展开，请在官网展开'); }
      if (!chosen(store)) return offer('select-store', target(store), p.storeNumber);
      if (selected.length !== 1 || selected[0] !== store) return fail('选中的取货门店与目标不一致');
      const dateNodes = all('input[name="bartPickupDateSelectorButtonGroup"]');
      const selectedDates = dateNodes.filter(chosen);
      if (selectedDates.length > 1 || selectedDates.some(el => !usableRadio(el))) return fail('已选取货日期不可用或不唯一');
      const dates = dateNodes.filter(usableRadio);
      if (new Set(dates.map(el => el.value)).size !== dates.length) return fail('取货日期编号不唯一');
      const date = selectedDates[0];
      const selects = all('select[data-autom="pickup-availablewindow-dropdown"]').filter(visible);
      if (selects.length > 1) return fail('取货时段选项不唯一');
      const select = selects[0], slots = select ? [...select.options].filter(option => norm(option.value) && optionAvailable(option)) : [];
      if (new Set(slots.map(option => option.value)).size !== slots.length) return fail('取货时段编号不唯一');
      const continues = button('fulfillment-continue-button');
      const signature = JSON.stringify([step, p.storeNumber, dates.map(el => [el.value, chosen(el)]), slots.map(el => el.value), select?.value || '', continues.length]);
      if (signature !== observed) { observed = signature; since = now(); }
      state.pickupProgress.date = date?.value || '';
      state.pickupProgress.slot = slots.some(el => el.value === select?.value) ? select.value : '';
      if (now() - since < 1200) return state;
      if (select?.disabled || all('[aria-busy="true"]').some(visible)) return state;
      const earliest = dates.find(el => !exhaustedDates.has(el.value));
      if (earliest && !chosen(earliest)) return offer('select-date', target(earliest), earliest.value);
      if (!select || !slots.length) {
        // An empty first render is not proof that this date has no windows.
        if (now() - since < SLOT_LOAD_TIMEOUT_MS) return state;
        if (date) exhaustedDates.add(date.value);
        const next = dates.find(el => !exhaustedDates.has(el.value));
        return next ? offer('select-date', target(next), next.value) : fail('没有可验证的取货时段，请在官网选择');
      }
      const earliestSlot = slots[0].value;
      if (select.value !== earliestSlot) return offer('select-slot', select, earliestSlot);
      state.pickupProgress.state = 'confirmed';
      return continues.length === 1 ? offer('continue-fulfillment', continues[0], JSON.stringify([p.storeNumber, date?.value || '', earliestSlot])) : state;
    }
    function observe(intent) { const { action, ...state } = inspect(intent); return { ...state, canAct: !!action }; }
    function step(intent) {
      const state = inspect(intent);
      if (state.issues.length) throw new Error(state.issues[0]);
      if (!state.action || !state.action.element) throw new Error('pickup-step-not-ready');
      const action = state.action;
      used.add(action.key); // reserve before dispatch; no repeat even if DOM stays unchanged
      if (action.kind === 'select-slot') setSelect(action.element, action.value);
      else click(action.element);
      return action.kind;
    }
    return Object.freeze({ observe, step });
  }
  root.AppleCheckoutPickup = Object.freeze({ create });
})(globalThis);
