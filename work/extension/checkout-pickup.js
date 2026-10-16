/* Restricted adaptation of suversal checkout.rs / checkout_pickup_region.js.
 * Adapted 2026-10-16 by AiGoodBro; upstream commit 7f9e86d.
 * Copyright (C) 2020-2025 Hteen and contributors; 2026 apple-pickup-watcher
 * and apple-store-inventory-monitor contributors. See licenses/Suversal-NOTICE.
 * GPL-3.0-or-later. Isolated-world DOM only; no CDP, network or contact storage. */
(function (root) {
  'use strict';
  const norm = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const canonical = value => norm(value).replace(/\s/g, '');
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
        state.pickupStoreName = titles.length === 1 ? text(titles[0]) : (state.pickupStoreNumber === p.storeNumber ? p.storeName : '');
      }
      // Summary evidence must be explicit and current. Never substitute a previous
      // page's selection when the Review page omits its pickup store.
      if (step === 'review') {
        const lines = String(document.body?.innerText || document.body?.textContent || '').split(/[\r\n]+/).map(norm);
        const labels = lines.map(line => /^(?:取货门店|取货地点)\s*[:：]\s*(.+)$/.exec(line)?.[1]).filter(Boolean);
        if (labels.length > 1 || (labels.length === 1 && canonical(labels[0]) !== canonical(p.storeName))) return fail('确认页取货门店与目标不一致或不唯一');
        if (selected.length === 1 && (state.pickupStoreNumber !== p.storeNumber || (state.pickupStoreName && canonical(state.pickupStoreName) !== canonical(p.storeName)))) return fail('确认页选中门店、门店名称与目标冲突');
        if (labels.length === 1) {
          if (state.pickupStoreName && canonical(state.pickupStoreName) !== canonical(labels[0])) return fail('确认页门店摘要与选中门店冲突');
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
          return fields.length !== 1 || !norm(fields[0].value) || fields[0].getAttribute('aria-invalid') === 'true';
        });
        const extra = all('input[required],select[required],input[aria-required="true"],select[aria-required="true"],input[data-autom="form-field-nationalIdSelf"]').filter(visible);
        if (missing || extra.some(el => !norm(el.value) || el.getAttribute('aria-invalid') === 'true')) return fail('取货联系人或证件信息未完整，请在 Apple 官网补齐后继续');
        // Only booleans leave this scope; no personal value is retained or returned.
        state.pickupProgress.state = 'contact-ready';
        return oneButton('continue-button-label', 'continue-contact');
      }
      if (step === 'billing') {
        if (credit.test(text(document.body))) return fail('付款摘要包含余额、礼品卡或混合付款，请在官网核对');
        const radios = all('input[data-autom^="checkout-billingOptions-"]').filter(usableRadio);
        const alipay = radios.filter(el => el.value === 'ALIPAY');
        if (alipay.length !== 1) return fail('无法唯一确定支付宝付款选项');
        if (!chosen(alipay[0])) return offer('select-alipay', target(alipay[0]), 'ALIPAY');
        if (radios.some(el => chosen(el) && el !== alipay[0])) return fail('付款方式选中状态不唯一');
        return oneButton('continue-button-review', 'continue-review');
      }
      if (step !== 'fulfillment') return state;
      const pickupTabs = all('button').filter(el => available(el) && text(el) === '我要取货');
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
      if (store.disabled || /不可取货|无法取货|不可提取|无法提取|无货|售罄/.test(storeLabel)) return fail('指定门店目前不可取货');
      if (!target(store)) { const more = button('show-more-stores-button'); return more.length === 1 ? offer('show-more-stores', more[0]) : fail('指定门店尚未展开，请在官网展开'); }
      if (!chosen(store)) return offer('select-store', target(store), p.storeNumber);
      if (selected.length !== 1 || selected[0] !== store) return fail('选中的取货门店与目标不一致');
      const dates = all('input[name="bartPickupDateSelectorButtonGroup"]').filter(usableRadio);
      const date = dates.find(chosen);
      const selects = all('select[data-autom="pickup-availablewindow-dropdown"]').filter(visible);
      if (selects.length > 1) return fail('取货时段选项不唯一');
      const select = selects[0], slots = select ? [...select.options].filter(option => norm(option.value) && !option.disabled) : [];
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
