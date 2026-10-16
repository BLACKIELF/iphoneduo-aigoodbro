// Pure checkout decisions. Persist the returned state BEFORE executing its effect.
// validateCheckoutIntent returns a normalized intent, or throws TypeError.
// recoverCheckout returns state; advanceCheckout returns { state, effect }.
const PHASES = new Set(["PRODUCT", "BAG", "CHECKOUT", "REVIEW", "IDENTITY_CHALLENGE", "ORDER_CREATED", "PAYMENT", "UNKNOWN"]);
const TERMINAL = new Set(["CANCELLED", "BLOCKED", "ORDER_CREATED_UNPAID", "PAYMENT_STOPPED"]);
const SUPPORTED_IPHONE_MODELS = new Map([
  ["iphone16", "iphone 16"], ["iphone17", "iphone 17"],
  ["iphone18pro", "iphone 18 pro"], ["iphone18promax", "iphone 18 pro max"],
  ["iphoneduo", "iphone duo"]
]);
const text = value => typeof value === "string" ? value.trim().replace(/\s+/gu, " ") : "";
const normalized = value => text(value).toLocaleLowerCase("en-US");
const capacity = value => normalized(value).replace(/\s+/gu, "");
const color = value => normalized(value).replace(/^冰川蓝色$/u, "冰川蓝");
const storeName = value => normalized(value).normalize("NFKC");
const copy = value => JSON.parse(JSON.stringify(value));
const clock = now => {
  if (!Number.isFinite(now) || now < 0) throw new TypeError("now 必须为有效的毫秒时间戳");
  return now;
};

export function validateCheckoutIntent(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("缺少下单配置");
  const intentId = text(raw.intentId);
  if (!/^[a-zA-Z0-9._:-]{1,128}$/u.test(intentId)) throw new TypeError("intentId 无效");
  if (!Number.isSafeInteger(raw.revision) || raw.revision < 1) throw new TypeError("revision 必须为正整数");
  const p = raw.product;
  if (!p || typeof p !== "object" || Array.isArray(p)) throw new TypeError("缺少商品");
  const product = Object.fromEntries(["Code", "Model", "Capacity", "Color", "Type"].map(key => [key, text(p[key])]));
  if (!/^[A-Z0-9]{4,24}\/[A-Z0-9]{1,4}$/u.test(product.Code)) throw new TypeError("商品编号无效");
  if (!["Model", "Capacity", "Color", "Type"].every(key => product[key] && product[key].length <= 160)) throw new TypeError("型号、容量、颜色和商品类型必须完整");
  if (SUPPORTED_IPHONE_MODELS.get(product.Type) !== normalized(product.Model)) throw new TypeError("自动购买仅支持已适配的 iPhone 型号，Apple Watch 暂不支持");
  if (raw.areaCode !== "cn" || !["delivery", "pickup"].includes(raw.fulfillment)) throw new TypeError("当前仅支持中国官网邮寄或门店自提");
  if (raw.quantity !== 1) throw new TypeError("每次只允许一件商品");
  if (typeof raw.maxTotal !== "number" || !Number.isFinite(raw.maxTotal) || raw.maxTotal <= 0) throw new TypeError("最高总价无效");
  for (const key of ["allowSubmit", "acknowledgedTerms"]) {
    if (raw[key] !== undefined && typeof raw[key] !== "boolean") throw new TypeError(`${key} 必须为布尔值`);
  }
  const entryMode = raw.entryMode === undefined ? "product" : raw.entryMode;
  const runMode = raw.runMode === undefined ? (raw.allowSubmit === true && raw.acknowledgedTerms === true ? "submit" : "review") : raw.runMode;
  if (!["product", "bag"].includes(entryMode)) throw new TypeError("购买入口必须为 product 或 bag");
  if (!["review", "submit"].includes(runMode)) throw new TypeError("运行模式必须为 review 或 submit");
  let pickup;
  if (raw.fulfillment === "pickup") {
    const source = raw.pickup;
    if (!source || typeof source !== "object" || Array.isArray(source)) throw new TypeError("缺少自提门店信息");
    const storeNumber = text(source.storeNumber), storeName = text(source.storeName);
    if (!/^R\d{1,10}$/u.test(storeNumber)) throw new TypeError("自提门店编号必须为 R 加数字");
    if (!storeName || storeName.length > 160) throw new TypeError("自提门店名称无效");
    const region = Object.fromEntries(["state", "city", "address"].map(key => [key, text(source.region?.[key])]));
    if (!region.state || !region.city || Object.values(region).some(value => value.length > 300)) throw new TypeError("自提门店公开省市信息必须完整");
    if (source.slotPolicy !== undefined && source.slotPolicy !== "earliest") throw new TypeError("仅支持选择最早可用自提时段");
    pickup = { storeNumber, storeName, region, slotPolicy: "earliest" };
  }
  return {
    intentId, revision: raw.revision, product, areaCode: "cn", fulfillment: raw.fulfillment, quantity: 1,
    entryMode, runMode, ...(pickup ? { pickup } : {}),
    maxTotal: raw.maxTotal, allowSubmit: runMode === "submit" && raw.allowSubmit === true, acknowledgedTerms: raw.acknowledgedTerms === true
  };
}

export function createCheckoutState(intent, now) {
  const timestamp = clock(now);
  return {
    schemaVersion: 1, intent: validateCheckoutIntent(intent), status: "READY", phase: "UNKNOWN",
    createdAt: timestamp, updatedAt: timestamp, reason: "", submitAttempt: null, orderNumber: null
  };
}

function productProblem(actual, expected) {
  if (!actual || typeof actual !== "object") return "缺少页面商品信息";
  for (const key of ["Model", "Capacity", "Color"]) {
    const normalize = key === "Capacity" ? capacity : key === "Color" ? color : normalized;
    if (!text(actual[key])) return `缺少页面商品${key}`;
    if (normalize(actual[key]) !== normalize(expected[key])) return `商品${key}与目标不一致`;
  }
  if (actual.Code !== undefined && text(actual.Code) !== expected.Code) return "商品编号与目标不一致";
  return "";
}

function cartProblem(observation, intent) {
  if (!Array.isArray(observation.cartItems)) return "缺少完整购物袋清单";
  if (observation.cartItems.length !== 1) return "购物袋必须仅含目标商品，不能有其他商品";
  const item = observation.cartItems[0];
  if (!item || item.quantity !== 1) return "购物袋商品数量必须为 1";
  return productProblem(item.product, intent.product);
}

function reviewProblem(observation, intent) {
  const problem = productProblem(observation.product, intent.product) || cartProblem(observation, intent);
  if (problem) return problem;
  if (observation.quantity !== 1) return "缺少或不正确的订单数量";
  if (typeof observation.total !== "number" || !Number.isFinite(observation.total) || observation.total <= 0) return "缺少有效订单总价";
  if (observation.total > intent.maxTotal) return "订单总价超过授权上限";
  if (observation.currency !== "CNY") return "订单币种必须为人民币 CNY";
  if (observation.fulfillment !== intent.fulfillment) return "订单履约方式与目标不一致";
  if (intent.fulfillment === "pickup") {
    const storeNumber = text(observation.pickupStoreNumber);
    if (storeNumber) {
      if (storeNumber !== intent.pickup.storeNumber) return "订单自提门店编号与目标不一致";
    } else {
      if (!text(observation.pickupStoreName) || storeName(observation.pickupStoreName) !== storeName(intent.pickup.storeName)) return "缺少匹配的订单自提门店证据";
    }
  }
  if (observation.paymentMethod !== "alipay") return "订单付款方式必须为支付宝";
  return "";
}

function outcome(state, now, status, reason, effect, phase = state.phase) {
  return { state: { ...state, status, phase, reason, updatedAt: clock(now) }, effect };
}

function stop(state, now, status, reason, phase = state.phase) {
  return outcome(state, now, status, reason, { type: "STOP", reason }, phase);
}

export function recoverCheckout(state, now) {
  const saved = copy(state);
  saved.intent = validateCheckoutIntent(saved.intent);
  saved.updatedAt = clock(now);
  if (saved.status === "SUBMITTING" || (saved.submitAttempt && !TERMINAL.has(saved.status))) {
    saved.status = "SUBMISSION_UNKNOWN";
    saved.reason = "提交可能已经发出；只读取订单回执，不再次提交";
  }
  return saved;
}

export function advanceCheckout(state, event, now) {
  clock(now);
  const current = copy(state);
  current.intent = validateCheckoutIntent(current.intent);
  if (current.status === "ORDER_CREATED_UNPAID") return stop(current, now, current.status, current.reason);
  if (!event || typeof event !== "object") return stop(current, now, "BLOCKED", "缺少有效的下单事件");
  if (event.type === "CANCEL") return stop(current, now, current.submitAttempt ? "SUBMISSION_UNKNOWN" : "CANCELLED", current.submitAttempt ? "自动化已停止；提交可能已经发出，请核对订单结果" : "已取消自动下单");
  if (event.type === "BLOCK") return stop(current, now, current.submitAttempt ? "SUBMISSION_UNKNOWN" : "BLOCKED", text(event.reason) || "自动下单已停止");
  if (event.type !== "OBSERVE") return stop(current, now, "BLOCKED", "不支持的下单事件");
  // Support either {type:'OBSERVE', observation:{...}} or a flat OBSERVE event.
  const observation = event.observation && typeof event.observation === "object" ? event.observation : event;
  const phase = PHASES.has(observation.phase) ? observation.phase : "UNKNOWN";
  if (phase === "PAYMENT") return stop(current, now, "PAYMENT_STOPPED", "已到付款页面；自动化不执行付款", phase);
  if (phase === "ORDER_CREATED") {
    if (current.status === "ORDER_CREATED_UNPAID") return stop(current, now, current.status, current.reason, phase);
    const orderNumber = text(observation.orderNumber);
    const productMismatch = observation.product && productProblem(observation.product, current.intent.product);
    const binding = observation.receiptBinding;
    const bindingMatches = binding &&
      binding.intentId === current.intent.intentId && binding.revision === current.intent.revision &&
      binding.attemptId === current.submitAttempt?.attemptId;
    const receiptMatches = (observation.product && !productMismatch) || bindingMatches;
    let fulfillmentProblem = text(observation.fulfillment) && observation.fulfillment !== current.intent.fulfillment ? "订单回执履约方式与目标不一致" : "";
    if (current.intent.fulfillment === "pickup") {
      const actualNumber = text(observation.pickupStoreNumber), actualName = text(observation.pickupStoreName);
      const storeMatches = actualNumber ? actualNumber === current.intent.pickup.storeNumber : actualName && storeName(actualName) === storeName(current.intent.pickup.storeName);
      if ((actualNumber || actualName) && !storeMatches) fulfillmentProblem = "订单回执自提门店与目标不一致";
      else if (!fulfillmentProblem && !(observation.fulfillment === "pickup" && storeMatches) && !bindingMatches)
        fulfillmentProblem = "自提订单回执缺少门店履约证据或本次提交绑定";
    }
    if (current.submitAttempt && receiptMatches && observation.receiptVerified === true && observation.unpaid === true && /^[a-zA-Z0-9-]{3,80}$/u.test(orderNumber) && !productMismatch && !fulfillmentProblem) {
      return stop({ ...current, orderNumber }, now, "ORDER_CREATED_UNPAID", "未付款订单已生成，自动化已停止", phase);
    }
    return stop(current, now, current.submitAttempt ? "SUBMISSION_UNKNOWN" : "BLOCKED", productMismatch || fulfillmentProblem || "订单回执尚未证明本次未付款订单已生成", phase);
  }
  if (TERMINAL.has(current.status)) return stop(current, now, current.status, current.reason);
  // submitAttempt is an independent durable fence: even a corrupt status must not retry.
  if (current.submitAttempt || current.status === "SUBMITTING" || current.status === "SUBMISSION_UNKNOWN") {
    return stop(current, now, current.status === "SUBMITTING" ? "SUBMITTING" : "SUBMISSION_UNKNOWN", "提交可能已经发出；只读取订单回执，不再次提交", phase);
  }
  if (phase === "IDENTITY_CHALLENGE") return outcome(current, now, "WAITING_FOR_IDENTITY", "需要在 Apple 官网完成身份验证", { type: "WAIT", reason: "IDENTITY_CHALLENGE" }, phase);
  if (phase === "UNKNOWN") return outcome(current, now, "WAITING_FOR_PAGE", "等待可识别的 Apple 页面", { type: "WAIT", reason: "UNKNOWN_PAGE" }, phase);
  if (phase === "PRODUCT") {
    if (current.intent.entryMode === "bag") return stop(current, now, "BLOCKED", "购物袋模式不允许进入商品页或加购", phase);
    return outcome(current, now, "SELECTING_PRODUCT", "正在选配目标商品", { type: "ADVANCE", phase, allowedActions: ["SELECT_PRODUCT", "ADD_TO_BAG"] }, phase);
  }
  if (phase === "BAG") {
    const problem = cartProblem(observation, current.intent) || (observation.quantity !== undefined && observation.quantity !== 1 ? "购物袋总数量必须为 1" : "");
    if (problem) return stop(current, now, "BLOCKED", problem, phase);
    return outcome(current, now, "CHECKING_OUT", "购物袋已核对", { type: "ADVANCE", phase, allowedActions: ["GO_TO_CHECKOUT"] }, phase);
  }
  if (phase === "CHECKOUT") {
    const problem = (observation.product && productProblem(observation.product, current.intent.product))
      || (observation.cartItems !== undefined && cartProblem(observation, current.intent))
      || (observation.quantity !== undefined && observation.quantity !== 1 ? "订单数量必须为 1" : "")
      || (typeof observation.total === "number" && observation.total > current.intent.maxTotal ? "订单总价超过授权上限" : "");
    if (problem) return stop(current, now, "BLOCKED", problem, phase);
    return outcome(current, now, "CHECKING_OUT", "继续填写并核对结账信息", { type: "ADVANCE", phase, allowedActions: current.intent.fulfillment === "pickup" ? ["PICKUP_STEP", "CONTINUE_CHECKOUT"] : ["CONTINUE_CHECKOUT"] }, phase);
  }
  if (observation.issues !== undefined && (!Array.isArray(observation.issues) || observation.issues.length)) {
    const detail = Array.isArray(observation.issues) ? observation.issues.map(text).filter(Boolean).join("；").slice(0, 240) : "页面核验问题格式无效";
    return stop(current, now, "BLOCKED", detail || "订单页面仍有未解决的核验问题", phase);
  }
  const problem = reviewProblem(observation, current.intent);
  if (problem) return stop(current, now, "BLOCKED", problem, phase);
  if (current.intent.runMode === "review") return outcome(current, now, "READY_TO_SUBMIT", "订单已核对；预演模式停在最终提交前", { type: "WAIT", reason: "REVIEW_ONLY" }, phase);
  if (!current.intent.allowSubmit || !current.intent.acknowledgedTerms) {
    return outcome(current, now, "READY_TO_SUBMIT", "订单已核对；等待生成未付款订单及销售条款授权", { type: "WAIT", reason: "SUBMISSION_NOT_AUTHORIZED" }, phase);
  }
  const attemptId = `${current.intent.intentId}:${current.intent.revision}:${now}`;
  const submitting = {
    ...current,
    submitAttempt: {
      attemptId, intentId: current.intent.intentId, revision: current.intent.revision, startedAt: now,
      reviewedTotal: observation.total, currency: "CNY"
    }
  };
  return outcome(submitting, now, "SUBMITTING", "已锁定单次提交，等待订单回执", {
    type: "SUBMIT_ORDER", intentId: current.intent.intentId, revision: current.intent.revision, attemptId
  }, phase);
}
