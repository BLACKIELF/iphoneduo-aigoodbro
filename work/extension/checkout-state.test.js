import assert from "node:assert/strict";
import test from "node:test";
import { validateCheckoutIntent, createCheckoutState, advanceCheckout, recoverCheckout } from "./checkout-state.js";

const product = { Code: "MJTF4CH/A", Model: "iPhone 18 Pro", Capacity: "512GB", Color: "冰川蓝色", Type: "iphone18pro" };
const intent = { intentId: "test-blue", revision: 1, product, areaCode: "cn", fulfillment: "delivery", quantity: 1, maxTotal: 11999, allowSubmit: true, acknowledgedTerms: true };
const review = { type: "OBSERVE", phase: "REVIEW", product, cartItems: [{ product, quantity: 1 }], quantity: 1, total: 11999, currency: "CNY", fulfillment: "delivery", paymentMethod: "alipay" };
const pickup = { storeNumber: "R683", storeName: "Apple 上海环球港", region: { state: "上海市", city: "上海市", address: "普陀区中山北路 3300 号" } };
const fresh = changes => createCheckoutState({ ...intent, ...changes }, 1000);
const advance = (observation, state = fresh()) => advanceCheckout(state, observation, 2000);

test("intent defaults to no submission and no accepted terms", () => {
  const { allowSubmit, acknowledgedTerms, ...raw } = intent;
  assert.equal(validateCheckoutIntent(raw).allowSubmit, false);
  assert.equal(validateCheckoutIntent(raw).acknowledgedTerms, false);
  for (const field of ["intentId", "revision", "product", "quantity", "maxTotal"]) {
    assert.throws(() => validateCheckoutIntent({ ...intent, [field]: null }), TypeError);
  }
  assert.throws(() => validateCheckoutIntent({ ...intent, allowSubmit: "true" }), /布尔/);
  assert.throws(() => validateCheckoutIntent({ ...intent, fulfillment: "pickup" }), /自提/);
  assert.throws(() => validateCheckoutIntent({ ...intent, quantity: 2 }), /一件/);
});

test("pickup schema, legacy defaults and explicit review mode are normalized", () => {
  assert.equal(validateCheckoutIntent(intent).entryMode, "product");
  assert.equal(validateCheckoutIntent(intent).runMode, "submit");
  const configured = validateCheckoutIntent({ ...intent, fulfillment: "pickup", pickup, entryMode: "bag", runMode: "review" });
  assert.equal(configured.pickup.slotPolicy, "earliest");
  assert.equal(configured.allowSubmit, false);
  assert.equal(configured.entryMode, "bag");
  for (const change of [{ storeNumber: "683" }, { storeNumber: "R-683" }, { storeName: "" }, { region: { ...pickup.region, city: "" } }, { slotPolicy: "random" }]) {
    assert.throws(() => validateCheckoutIntent({ ...intent, fulfillment: "pickup", pickup: { ...pickup, ...change } }), TypeError);
  }
  for (const change of [{ entryMode: "existing-bag" }, { runMode: "pay" }]) assert.throws(() => validateCheckoutIntent({ ...intent, ...change }), TypeError);
});

test("pickup review requires exact fulfillment and authoritative store identity", () => {
  const configured = fresh({ fulfillment: "pickup", pickup, entryMode: "bag" });
  const observation = { ...review, fulfillment: "pickup", pickupStoreNumber: "R683", pickupStoreName: "other display" };
  assert.equal(advance(observation, configured).effect.type, "SUBMIT_ORDER");
  assert.equal(advance({ ...observation, pickupStoreNumber: undefined, pickupStoreName: "  Apple  上海环球港  " }, configured).effect.type, "SUBMIT_ORDER");
  for (const change of [
    { fulfillment: "delivery" }, { pickupStoreNumber: "R999", pickupStoreName: pickup.storeName },
    { pickupStoreNumber: undefined, pickupStoreName: undefined },
    { pickupStoreNumber: undefined, pickupStoreName: "Apple 上海环球港附近门店" }
  ]) assert.equal(advance({ ...observation, ...change }, configured).state.status, "BLOCKED");
});

test("bag-only mode cannot select products and review mode can never submit", () => {
  assert.equal(advance({ type: "OBSERVE", phase: "PRODUCT" }, fresh({ entryMode: "bag" })).state.status, "BLOCKED");
  const result = advance(review, fresh({ runMode: "review", allowSubmit: true, acknowledgedTerms: true }));
  assert.equal(result.state.status, "READY_TO_SUBMIT");
  assert.equal(result.effect.type, "WAIT");
  assert.equal(result.effect.reason, "REVIEW_ONLY");
  assert.equal(result.state.submitAttempt, null);
  assert.ok(advance({ type: "OBSERVE", phase: "CHECKOUT" }, fresh({ fulfillment: "pickup", pickup })).effect.allowedActions.includes("PICKUP_STEP"));
});

test("direct intents reject unsupported products and mismatched iPhone family metadata", () => {
  const watch = { Code: "MEHY4CH/B", Model: "Apple Watch SE 3", Capacity: "40mm", Color: "铝金属 · 午夜色 · GPS", Type: "watchse3" };
  for (const candidate of [
    watch,
    { ...watch, BandStyle: "Nike 回环式运动表带", BandColor: "火花绿色", BandSize: "均码" },
    { ...watch, BandStyle: "运动型表带", BandColor: "黑色", BandSize: "S/M" },
    { ...watch, Type: "iphone18pro" },
    { ...product, Type: "watchse3" },
    { ...product, Model: "iPad Pro" },
    { ...product, Model: "iPhone 999", Type: "iphone999" },
    { ...product, Model: "iPhone 18 Pro Max" }
  ]) {
    assert.throws(() => validateCheckoutIntent({ ...intent, product: candidate }), /仅支持已适配的 iPhone/);
    assert.throws(() => createCheckoutState({ ...intent, product: candidate }, 1000), /仅支持已适配的 iPhone/);
  }
});

test("forged saved Watch intents cannot recover or reach submission even with matching review evidence", () => {
  const watch = { Code: "MEHY4CH/B", Model: "Apple Watch SE 3", Capacity: "40mm", Color: "铝金属 · 午夜色 · GPS", Type: "watchse3", BandStyle: "Nike 回环式运动表带", BandColor: "火花绿色", BandSize: "均码" };
  const forged = { ...fresh(), intent: { ...intent, product: watch } };
  const original = JSON.stringify(forged);
  for (const actual of [watch, { ...watch, BandStyle: "运动型表带", BandColor: "黑色", BandSize: "S/M" }]) {
    const observation = { ...review, product: actual, cartItems: [{ product: actual, quantity: 1 }] };
    assert.throws(() => advanceCheckout(forged, observation, 2000), /仅支持已适配的 iPhone/);
  }
  assert.throws(() => recoverCheckout(forged, 2000), /仅支持已适配的 iPhone/);
  assert.equal(JSON.stringify(forged), original);
  assert.equal(forged.submitAttempt, null);
});

test("product selection can start on a different unselected product page", () => {
  const result = advance({ type: "OBSERVE", phase: "PRODUCT", product: { ...product, Color: "银色" } });
  assert.equal(result.effect.type, "ADVANCE");
  assert.deepEqual(result.effect.allowedActions, ["SELECT_PRODUCT", "ADD_TO_BAG"]);
});

test("bag needs the exact sole product before checkout", () => {
  const good = advance({ ...review, phase: "BAG" });
  assert.deepEqual(good.effect.allowedActions, ["GO_TO_CHECKOUT"]);
  for (const cartItems of [undefined, [], [...review.cartItems, ...review.cartItems], [{ product, quantity: 2 }], [{ product: { ...product, Color: "银色" }, quantity: 1 }]]) {
    assert.equal(advance({ ...review, phase: "BAG", cartItems }).state.status, "BLOCKED");
  }
});

test("checkout can continue through partial information but never past known mismatch", () => {
  assert.deepEqual(advance({ type: "OBSERVE", phase: "CHECKOUT" }).effect.allowedActions, ["CONTINUE_CHECKOUT"]);
  assert.equal(advance({ ...review, phase: "CHECKOUT", total: 12000 }).state.status, "BLOCKED");
  assert.equal(advance({ ...review, phase: "CHECKOUT", quantity: 2 }).state.status, "BLOCKED");
});

test("review validates all evidence and refuses missing or changed values", () => {
  const failures = [
    { product: undefined }, { product: { ...product, Model: "iPhone 18 Pro Max" } },
    { product: { ...product, Code: "OTHERCH/A" } }, { product: { ...product, Capacity: "256GB" } },
    { product: { ...product, Color: "银色" } }, { cartItems: undefined }, { cartItems: [] },
    { cartItems: [...review.cartItems, ...review.cartItems] }, { quantity: undefined }, { quantity: 2 },
    { total: undefined }, { total: "11999" }, { total: 0 }, { total: -1 }, { total: NaN },
    { total: Infinity }, { total: 12000 }, { currency: undefined }, { currency: "USD" },
    { fulfillment: undefined }, { fulfillment: "pickup" }, { paymentMethod: undefined }, { paymentMethod: "card" }
  ];
  for (const change of failures) {
    const result = advance({ ...review, ...change });
    assert.equal(result.state.status, "BLOCKED", JSON.stringify(change));
    assert.equal(result.effect.type, "STOP");
    assert.equal(result.state.submitAttempt, null);
  }
});

test("submission needs both explicit switches and accepts an exact cap", () => {
  for (const switches of [{ allowSubmit: false }, { acknowledgedTerms: false }]) {
    assert.equal(advance(review, fresh(switches)).effect.type, "WAIT");
  }
  const result = advance(review);
  assert.equal(result.state.status, "SUBMITTING");
  assert.equal(result.effect.type, "SUBMIT_ORDER");
  assert.equal(result.effect.attemptId, result.state.submitAttempt.attemptId);
  assert.equal(result.effect.intentId, intent.intentId);
  assert.equal(result.effect.revision, intent.revision);
});

test("review issues block before a submission attempt can be consumed", () => {
  for (const issues of [["fulfillment-ambiguous"], ["pickup-store-mismatch", "extra-item"], [null], "invalid"]) {
    const result = advance({ ...review, issues });
    assert.equal(result.state.status, "BLOCKED");
    assert.equal(result.effect.type, "STOP");
    assert.equal(result.state.submitAttempt, null);
    assert.ok(result.state.reason);
    assert.ok(result.state.reason.length <= 240);
  }
  assert.equal(advance({ ...review, issues: [] }).effect.type, "SUBMIT_ORDER");
});

test("normalizes whitespace without accepting a different colour", () => {
  const result = advance({ ...review, product: { ...product, Model: " iPhone  18 Pro ", Capacity: "512 GB" } });
  assert.equal(result.effect.type, "SUBMIT_ORDER");
});

test("Glacier Blue names with and without 色 refer to the same exact colour", () => {
  for (const [expected, actual] of [["冰川蓝", "冰川蓝色"], ["冰川蓝色", "冰川蓝"]]) {
    const actualProduct = { ...product, Color: actual };
    const result = advance({ ...review, product: actualProduct, cartItems: [{ product: actualProduct, quantity: 1 }] }, fresh({ product: { ...product, Color: expected } }));
    assert.equal(result.effect.type, "SUBMIT_ORDER");
  }
  assert.equal(advance({ ...review, product: { ...product, Color: "蓝色" } }).state.status, "BLOCKED");
});

test("repeated observations never emit a second submit effect", () => {
  const first = advance(review);
  for (const phase of ["REVIEW", "BAG", "PRODUCT", "CHECKOUT", "UNKNOWN", "IDENTITY_CHALLENGE"]) {
    const next = advance({ ...review, phase }, first.state);
    assert.equal(next.effect.type, "STOP");
    assert.deepEqual(next.state.submitAttempt, first.state.submitAttempt);
  }
  assert.equal(advance(review, { ...first.state, status: "READY" }).state.status, "SUBMISSION_UNKNOWN");
});

test("recovery fences submission even when its click outcome is unknown", () => {
  const first = advance(review);
  const recovered = recoverCheckout(JSON.parse(JSON.stringify(first.state)), 3000);
  assert.equal(recovered.status, "SUBMISSION_UNKNOWN");
  assert.equal(advanceCheckout(recovered, review, 4000).effect.type, "STOP");
  assert.equal(first.state.status, "SUBMITTING");
});

test("verified unpaid receipt resolves uncertain submission and stops", () => {
  const pending = recoverCheckout(advance(review).state, 3000);
  const receipt = { type: "OBSERVE", phase: "ORDER_CREATED", product, orderNumber: "W1234567890", unpaid: true, receiptVerified: true };
  const result = advanceCheckout(pending, receipt, 4000);
  assert.equal(result.state.status, "ORDER_CREATED_UNPAID");
  assert.equal(result.state.orderNumber, "W1234567890");
  assert.equal(result.effect.type, "STOP");
  assert.equal(advance(review, result.state).effect.type, "STOP");
  assert.equal(advance(receipt).state.status, "BLOCKED");
});

test("incomplete, paid or wrong-product receipts cannot claim success", () => {
  const pending = advance(review).state;
  const receipt = { type: "OBSERVE", phase: "ORDER_CREATED", product, orderNumber: "W1234567890", unpaid: true, receiptVerified: true };
  for (const change of [{ receiptVerified: false }, { unpaid: false }, { orderNumber: "" }, { product: undefined }, { product: { ...product, Color: "银色" } }]) {
    assert.equal(advance({ ...receipt, ...change }, pending).state.status, "SUBMISSION_UNKNOWN");
  }
});

test("receipt without product requires an exact current attempt binding", () => {
  const pending = advance(review).state;
  const receipt = { type: "OBSERVE", phase: "ORDER_CREATED", orderNumber: "W1234567890", unpaid: true, receiptVerified: true };
  const receiptBinding = { intentId: intent.intentId, revision: intent.revision, attemptId: pending.submitAttempt.attemptId };
  assert.equal(advance({ ...receipt, receiptBinding }, pending).state.status, "ORDER_CREATED_UNPAID");
  for (const changes of [{ intentId: "previous-run" }, { revision: 2 }, { attemptId: "previous-attempt" }]) {
    assert.equal(advance({ ...receipt, receiptBinding: { ...receiptBinding, ...changes } }, pending).state.status, "SUBMISSION_UNKNOWN");
  }
});

test("pickup receipts reject explicit fulfillment or store conflicts even with a matching attempt binding", () => {
  const pending = advance({ ...review, fulfillment: "pickup", pickupStoreNumber: pickup.storeNumber }, fresh({ fulfillment: "pickup", pickup })).state;
  const receiptBinding = { intentId: intent.intentId, revision: intent.revision, attemptId: pending.submitAttempt.attemptId };
  const receipt = { type: "OBSERVE", phase: "ORDER_CREATED", product, orderNumber: "W1234567890", unpaid: true, receiptVerified: true, fulfillment: "pickup", pickupStoreNumber: pickup.storeNumber };
  assert.equal(advance(receipt, pending).state.status, "ORDER_CREATED_UNPAID");
  for (const change of [
    { fulfillment: "delivery" }, { pickupStoreNumber: "R999", pickupStoreName: pickup.storeName },
    { pickupStoreNumber: undefined, pickupStoreName: "Apple 其他门店" }
  ]) {
    for (const binding of [undefined, receiptBinding]) {
      const result = advance({ ...receipt, ...change, receiptBinding: binding }, pending);
      assert.equal(result.state.status, "SUBMISSION_UNKNOWN");
      assert.equal(result.effect.type, "STOP");
      assert.equal(advance(review, result.state).effect.type, "STOP");
    }
  }
});

test("pickup receipts with missing evidence need an exact attempt binding", () => {
  const pending = advance({ ...review, fulfillment: "pickup", pickupStoreNumber: pickup.storeNumber }, fresh({ fulfillment: "pickup", pickup })).state;
  const receipt = { type: "OBSERVE", phase: "ORDER_CREATED", product, orderNumber: "W1234567890", unpaid: true, receiptVerified: true };
  assert.equal(advance(receipt, pending).state.status, "SUBMISSION_UNKNOWN");
  assert.equal(advance({ ...receipt, fulfillment: "pickup", pickupStoreName: " Apple  上海环球港 " }, pending).state.status, "ORDER_CREATED_UNPAID");
  const receiptBinding = { intentId: intent.intentId, revision: intent.revision, attemptId: pending.submitAttempt.attemptId };
  assert.equal(advance({ ...receipt, receiptBinding }, pending).state.status, "ORDER_CREATED_UNPAID");
  assert.equal(advance({ ...receipt, receiptBinding: { ...receiptBinding, attemptId: "previous-attempt" } }, pending).state.status, "SUBMISSION_UNKNOWN");
});

test("cancelling a submitted attempt keeps uncertainty and completed receipts stay final", () => {
  const pending = advance(review).state;
  assert.equal(advance({ type: "CANCEL" }, pending).state.status, "SUBMISSION_UNKNOWN");
  const completed = advance({ type: "OBSERVE", phase: "ORDER_CREATED", product, orderNumber: "W1234567890", unpaid: true, receiptVerified: true }, pending).state;
  for (const event of [{ type: "CANCEL" }, { type: "BLOCK" }, { type: "OBSERVE", phase: "PAYMENT" }, review]) {
    const result = advance(event, completed);
    assert.equal(result.state.status, "ORDER_CREATED_UNPAID");
    assert.equal(result.state.orderNumber, completed.orderNumber);
    assert.equal(result.effect.type, "STOP");
  }
});

test("payment always stops without any payment action", () => {
  for (const state of [fresh(), advance(review).state]) {
    const result = advance({ type: "OBSERVE", phase: "PAYMENT" }, state);
    assert.equal(result.state.status, "PAYMENT_STOPPED");
    assert.equal(result.effect.type, "STOP");
    assert.equal(advance(review, result.state).effect.type, "STOP");
  }
});

test("cancel and block halt future automatic actions", () => {
  for (const type of ["CANCEL", "BLOCK"]) {
    const result = advance({ type, reason: "test" });
    assert.equal(result.effect.type, "STOP");
    assert.equal(advance(review, result.state).effect.type, "STOP");
  }
  assert.equal(advance({ type: "BLOCK" }, advance(review).state).state.status, "SUBMISSION_UNKNOWN");
});

test("unknown page and identity challenge wait without checkout actions", () => {
  for (const phase of ["UNKNOWN", "IDENTITY_CHALLENGE", "UNRECOGNISED"]) assert.equal(advance({ type: "OBSERVE", phase }).effect.type, "WAIT");
});

test("state decisions do not mutate caller-owned objects", () => {
  const state = fresh();
  const original = JSON.stringify(state);
  const originalReview = JSON.stringify(review);
  advance(review, state);
  assert.equal(JSON.stringify(state), original);
  assert.equal(JSON.stringify(review), originalReview);
  assert.notEqual(state.intent.product, product);
});
