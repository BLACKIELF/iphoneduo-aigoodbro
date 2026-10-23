import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, webcrypto } from "node:crypto";
import { normalizeNotificationSettings, feishuSignature, sendBark, sendFeishu, dispatchStockNotifications } from "./notifications.js";

const settings = { barkUrl: "https://api.day.app/test-key", feishuWebhook: "https://open.feishu.cn/open-apis/bot/v2/hook/test-hook", feishuSecret: "", intervalSeconds: 30 };
const notification = { title: "门店有货", message: "iPhone 测试", link: "https://www.apple.com.cn/shop/product/TEST" };
const jsonResponse = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });

test("notification settings accept only supported HTTPS endpoints and intervals", () => {
  assert.equal(normalizeNotificationSettings().intervalSeconds, 30);
  assert.equal(normalizeNotificationSettings().soundAlert, true);
  for (const intervalSeconds of [1, 2, 10, 30, 60, 120, 300]) assert.equal(normalizeNotificationSettings({ intervalSeconds }).intervalSeconds, intervalSeconds);
  for (const barkUrl of ["http://api.day.app/key", "https://evil.example/key", "https://api.day.app@evil.example/key", "https://api.day.app/", "https://api.day.app/key#frag"]) {
    assert.throws(() => normalizeNotificationSettings({ barkUrl }));
  }
  for (const feishuWebhook of ["https://open.feishu.cn/anything", "https://open.feishu.cn/open-apis/bot/v2/hook/", "https://open.feishu.cn.evil.example/open-apis/bot/v2/hook/key", "https://open.feishu.cn/open-apis/bot/v2/hook/key?redirect=evil"]) {
    assert.throws(() => normalizeNotificationSettings({ feishuWebhook }));
  }
  assert.equal(normalizeNotificationSettings({ ...settings, feishuWebhook: settings.feishuWebhook.replace("open.feishu.cn", "open.larksuite.com") }).intervalSeconds, 30);
  assert.throws(() => normalizeNotificationSettings({ intervalSeconds: 0 }));
  assert.throws(() => normalizeNotificationSettings({ intervalSeconds: -1 }));
  assert.throws(() => normalizeNotificationSettings({ intervalSeconds: 4000 }));
  assert.throws(() => normalizeNotificationSettings({ feishuSecret: "secret-without-hook" }));
});

test("Feishu signature matches HMAC-SHA256 of empty body using timestamp + newline + secret as key", async () => {
  const expected = createHmac("sha256", "1700000000\nfixture-secret").update("").digest("base64");
  assert.equal(await feishuSignature("fixture-secret", "1700000000", webcrypto), expected);
});

test("unsigned and signed Feishu payloads follow upstream contract and reject redirects", async () => {
  const requests = [];
  const deps = { cryptoImpl: webcrypto, now: () => 1700000000000, fetchImpl: async (url, options) => { requests.push({ url, options }); return jsonResponse({ code: 0 }); } };
  await sendFeishu(settings, notification, deps);
  const unsigned = JSON.parse(requests[0].options.body);
  assert.equal(unsigned.msg_type, "text");
  assert.equal(unsigned.content.text, "门店有货\niPhone 测试\n" + notification.link);
  assert.equal("sign" in unsigned, false);
  assert.equal("timestamp" in unsigned, false);
  assert.equal(requests[0].options.redirect, "error");
  assert.equal(requests[0].options.credentials, "omit");
  await sendFeishu({ ...settings, feishuSecret: "fixture-secret" }, notification, deps);
  const signed = JSON.parse(requests[1].options.body);
  assert.equal(signed.timestamp, "1700000000");
  assert.equal(signed.sign, createHmac("sha256", "1700000000\nfixture-secret").update("").digest("base64"));
});

test("Bark and Feishu require both HTTP and business success", async () => {
  await sendBark(settings, notification, { fetchImpl: async () => jsonResponse({ code: 200 }) });
  await sendFeishu(settings, notification, { fetchImpl: async () => jsonResponse({ StatusCode: 0 }) });
  await assert.rejects(sendBark(settings, notification, { fetchImpl: async () => jsonResponse({ code: 400 }) }), /未确认/);
  await assert.rejects(sendFeishu(settings, notification, { fetchImpl: async () => jsonResponse({ code: 9499, msg: "SECRET" }) }), /未确认/);
  await assert.rejects(sendFeishu(settings, notification, { fetchImpl: async () => jsonResponse({ code: 0 }, 403) }), /HTTP 403/);
  await assert.rejects(sendBark(settings, notification, { fetchImpl: async () => jsonResponse({}) }), /未确认/);
});

test("network and timeout errors do not reveal webhook tokens or secrets", async () => {
  await assert.rejects(sendFeishu(settings, notification, { fetchImpl: async () => { throw new Error(settings.feishuWebhook + " TOKEN"); } }), { message: "网络连接失败" });
  await assert.rejects(sendFeishu(settings, notification, { timeoutMs: 2, fetchImpl: async (_url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("TOKEN")))) }), /请求超时/);
});

test("channel failures are isolated and each dispatch checks current authorization", async () => {
  const requested = [];
  const results = await dispatchStockNotifications({
    settings, notification, canSend: async () => true,
    createDesktop: async () => { throw new Error("platform details"); },
    dependencies: { fetchImpl: async (url) => { requested.push(url); return jsonResponse(url.includes("day.app") ? { code: 400 } : { code: 0 }); } }
  });
  assert.equal(requested.length, 2);
  assert.equal(results.find(r => r.channel === "桌面").ok, false);
  assert.equal(results.find(r => r.channel === "Bark").ok, false);
  assert.equal(results.find(r => r.channel === "飞书 / Lark").ok, true);
  const skipped = await dispatchStockNotifications({ settings, notification, canSend: async () => false, createDesktop: async () => assert.fail("must not send"), dependencies: { fetchImpl: async () => assert.fail("must not fetch") } });
  assert.equal(skipped.every(r => r.skipped), true);
});

test("a stop during Feishu signing prevents the outgoing webhook", async () => {
  let signing = true;
  const result = await sendFeishu({ ...settings, feishuSecret: "secret" }, notification, {
    cryptoImpl: { subtle: { importKey: async () => ({}), sign: async () => { signing = false; return new ArrayBuffer(32); } } },
    canSend: async () => signing,
    fetchImpl: async () => assert.fail("must not send after stop")
  });
  assert.equal(result.skipped, true);
});
