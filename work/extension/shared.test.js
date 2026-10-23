import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  appleBaseURL,
  buildFulfillmentPath,
  groupProductsByModel,
  parseStockResponse,
  productPurchaseURL
} from "./shared.js";

const task = {
  areaCode: "cn",
  store: { StoreNumber: "R761", CityStoreName: "深圳万象城", District: "518001" },
  product: {
    Model: "iPhone 18 Pro",
    Capacity: "256GB",
    Color: "Silver",
    Code: "MJT84CH/A",
    Type: "iphone18pro"
  }
};

test("builds locale-specific product URLs", () => {
  assert.equal(appleBaseURL("cn"), "https://www.apple.com.cn");
  assert.equal(appleBaseURL("hk"), "https://www.apple.com/hk");
  assert.equal(productPurchaseURL(task), "https://www.apple.com.cn/shop/product/MJT84CH/A");
});

test("builds locale-specific inventory paths", () => {
  const cnPath = buildFulfillmentPath([task]);
  assert.match(cnPath, /^\/shop\/retail\/pickup-message\?/);
  assert.match(cnPath, /parts\.0=MJT84CH%2FA/);
  assert.equal(new URL(cnPath, appleBaseURL("cn")).searchParams.has("store"), false);
  assert.match(cnPath, /location=518001/);
  const hkPath = buildFulfillmentPath([{ ...task, areaCode: "hk" }]);
  assert.match(hkPath, /^\/hk\/shop\/retail\/pickup-message\?/);
  assert.equal(new URL(hkPath, appleBaseURL("hk")).searchParams.has("location"), false);
});

test("queries all SKUs in the same store while rejecting mixed regions and stores", () => {
  const second = { ...task, product: { ...task.product, Code: "MK2M4CH/A" } };
  const params = new URL(buildFulfillmentPath([task, second]), appleBaseURL("cn")).searchParams;
  assert.equal(params.get("pl"), "true");
  assert.equal(params.get("parts.0"), task.product.Code);
  assert.equal(params.get("parts.1"), second.product.Code);
  assert.equal(params.get("mts.1"), "regular");
  assert.throws(() => buildFulfillmentPath([]), /为空/);
  assert.throws(() => buildFulfillmentPath([task, { ...second, areaCode: "hk" }]), /同地区、同门店/);
  assert.throws(() => buildFulfillmentPath([task, { ...second, store: { StoreNumber: "R001" } }]), /同地区、同门店/);
});

test("uses bundled regional postal codes without guessing a location", async () => {
  for (const areaCode of ["cn", "hk", "jp", "sg", "us", "uk", "au"]) {
    const { stores } = JSON.parse(await readFile(new URL(`./data/stores/store_${areaCode}.json`, import.meta.url)));
    const url = new URL(buildFulfillmentPath([{ ...task, areaCode, store: stores[0] }]), appleBaseURL(areaCode));
    assert.equal(url.pathname, `${["cn", "us"].includes(areaCode) ? "" : "/" + areaCode}/shop/retail/pickup-message`);
    assert.equal(url.searchParams.get("location"), stores[0].District || null);
    if (areaCode === "jp") {
      assert.equal(url.searchParams.get("cppart"), "UNLOCKED_JP");
    } else if (areaCode === "cn") {
      assert.equal(url.searchParams.has("store"), false);
    } else {
      assert.equal(url.searchParams.get("store"), stores[0].StoreNumber);
    }
  }
  const badLocation = { ...task, store: { ...task.store, District: "深圳", City: "深圳" } };
  assert.equal(new URL(buildFulfillmentPath([badLocation]), appleBaseURL("cn")).searchParams.has("location"), false);
  for (const District of ["", "深圳", "12345", "1234567", "１２３４５６"]) {
    const params = new URL(buildFulfillmentPath([{ ...task, store: { ...task.store, District } }]), appleBaseURL("cn")).searchParams;
    assert.equal(params.get("store"), task.store.StoreNumber);
    assert.equal(params.has("location"), false);
  }
});

test("parses an available store response", () => {
  const payload = {
    body: {
      stores: [{
        storeNumber: "R761",
        partsAvailability: {
          "MJT84CH/A": { pickupDisplay: "available" }
        }
      }]
    }
  };
  assert.deepEqual(
    parseStockResponse(payload, "R761", "MJT84CH/A"),
    { known: true, available: true, pickupDisplay: "available" }
  );
});

const UNKNOWN = { known: false, available: false, pickupDisplay: "" };
const SKU = task.product.Code;
test("postal responses never use a neighboring store or ambiguous duplicate target stores", () => {
  const target = { storeNumber: "R761", partsAvailability: { [SKU]: { pickupDisplay: "unavailable" } } };
  const neighbor = { storeNumber: "R999", partsAvailability: { [SKU]: { pickupDisplay: "available" } } };
  assert.equal(parseStockResponse({ body: { stores: [neighbor, target] } }, "R761", SKU).available, false);
  for (const duplicate of [target, { ...target, partsAvailability: neighbor.partsAvailability }]) {
    assert.deepEqual(parseStockResponse({ body: { stores: [target, duplicate] } }, "R761", SKU), UNKNOWN);
  }
});
function storePayload(pickupDisplay, storeNumber = task.store.StoreNumber, code = SKU) {
  return { body: { stores: [{ storeNumber, partsAvailability: { [code]: { pickupDisplay } } }] } };
}

test("does not report availability without the exact requested store and SKU", () => {
  assert.deepEqual(parseStockResponse(storePayload("available", "R999"), "R761", SKU), UNKNOWN);
  assert.deepEqual(parseStockResponse(storePayload("available", "R761", "OTHER-SKU"), "R761", SKU), UNKNOWN);
  assert.deepEqual(parseStockResponse({ body: { stores: [] } }, "R761", SKU), UNKNOWN);
  assert.deepEqual(parseStockResponse({ body: { errorMessage: "Please try again" } }, "R761", SKU), UNKNOWN);
  assert.deepEqual(parseStockResponse(storePayload("available"), "", SKU), UNKNOWN);
  assert.deepEqual(parseStockResponse(storePayload("available"), "R761", ""), UNKNOWN);
});

test("global pickup eligibility cannot establish stock in a selected store", () => {
  const payload = { body: { content: { pickupMessage: {
    pickupEligibility: { [SKU]: { pickupDisplay: "available" } }
  } } } };
  assert.deepEqual(parseStockResponse(payload, "R761", SKU), UNKNOWN);
});

test("supports legacy store payloads but never falls back over an empty modern store list", () => {
  const stores = storePayload("available").body.stores;
  const legacy = { body: { content: { pickupMessage: { stores } } } };
  assert.equal(parseStockResponse(legacy, "R761", SKU).available, true);
  legacy.body.stores = [];
  assert.deepEqual(parseStockResponse(legacy, "R761", SKU), UNKNOWN);
});

test("unknown and missing statuses are not confirmed no-stock transitions", () => {
  for (const value of [undefined, null, "", "unknown", "temporarilyUnavailable", "availableSoon", true, {}]) {
    const parsed = parseStockResponse(storePayload(value), "R761", SKU);
    assert.equal(parsed.known, false, String(value));
    assert.equal(parsed.available, false, String(value));
  }
  assert.deepEqual(parseStockResponse(storePayload("unavailable"), "R761", SKU), {
    known: true, available: false, pickupDisplay: "unavailable"
  });
});

test("mainland Duo's eight real variants retain their mapping and exact purchase routes", async () => {
  const catalog = JSON.parse(await readFile(new URL("./data/products/product_data_cn.json", import.meta.url)));
  const expected = {
    "MK2M4CH/A": ["256GB", "星光白色"],
    "MK2N4CH/A": ["256GB", "夜空色"],
    "MK2P4CH/A": ["512GB", "星光白色"],
    "MK2Q4CH/A": ["512GB", "夜空色"],
    "MK2T4CH/A": ["1TB", "星光白色"],
    "MK2U4CH/A": ["1TB", "夜空色"],
    "MK2V4CH/A": ["2TB", "星光白色"],
    "MK2W4CH/A": ["2TB", "夜空色"]
  };
  const products = catalog.products["iPhone Duo"];
  assert.equal(products.length, 8);
  assert.equal(new Set(products.map((product) => product.Code)).size, 8);
  for (const product of products) {
    assert.deepEqual([product.Capacity, product.Color], expected[product.Code]);
    assert.equal(productPurchaseURL({ ...task, product }),
      "https://www.apple.com.cn/shop/buy-iphone/iphone-duo/" + product.Code.toLowerCase());
  }
});

test("separates products by their real model name", () => {
  const products = groupProductsByModel({
    "iPhone 18 Pro": [
      { Model: "iPhone 18 Pro Max", Code: "MAX" },
      { Model: "iPhone 18 Pro", Code: "PRO" }
    ]
  });
  assert.deepEqual(Object.keys(products), ["iPhone 18 Pro Max", "iPhone 18 Pro"]);
  assert.equal(products["iPhone 18 Pro"][0].Code, "PRO");
});

test("verified iPhone 17 test variant keeps its exact SKU and official product route", async () => {
  const catalog = JSON.parse(await readFile(new URL("./data/products/product_data_cn.json", import.meta.url)));
  const products = catalog.products["iPhone 17"] || [];
  const matches = products.filter(p => p.Code === "MG744CH/A");
  assert.equal(matches.length, 1);
  const p = matches[0];
  assert.deepEqual([p.Model, p.Capacity, p.Color], ["iPhone 17", "512GB", "青雾蓝色"]);
  assert.equal(productPurchaseURL({areaCode:"cn", product:p}), "https://www.apple.com.cn/shop/buy-iphone/iphone-17/mg744ch/a");
});
