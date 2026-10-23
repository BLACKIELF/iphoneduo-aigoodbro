import java.net.*;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import java.util.function.BooleanSupplier;

/** Deterministic fixtures only: never sends to Apple, Bark, Feishu, or Lark. */
public final class AppleHelperTest {
    static int assertions;
    static final String TOKEN = "fixture-local-token-1234567890-abcdef";
    static final List<Path> TEMP = new ArrayList<>();
    public static void main(String[] args) throws Exception {
        try {
            jsonTests(); validationTests(); postalQueryTests(); stockTests(); postalStockIdentityTests(); notificationProtocolTests();
            lifecycleTests(); manualCheckTests(); cancellationTests(); recoveryTests(); persistenceFailureTests(); notificationLifecycleTests();
            inventoryRetryTests(); deferredStoreStateTests(); retryAfterTests(); httpTests();
            System.out.println("PASS " + assertions + " backend assertions (fixtures and localhost only)");
        } finally {
            for (Path directory : TEMP) try (var paths = Files.walk(directory)) {
                for (Path path : paths.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(path);
            }
        }
    }
    static void check(boolean condition, String label) { assertions++; if (!condition) throw new AssertionError(label); }
    static void equal(Object actual, Object expected, String label) { check(Objects.equals(actual, expected), label + " expected=" + expected + " actual=" + actual); }
    interface Throwing { void run() throws Exception; }
    static void rejects(Throwing action, String label) throws Exception {
        boolean rejected = false; try { action.run(); } catch (IllegalArgumentException expected) { rejected = true; }
        check(rejected, label);
    }
    static Path directory() throws Exception { Path directory = Files.createTempDirectory("apple-helper-fixture-"); TEMP.add(directory); return directory; }
    static Map<String,Object> map(Object... values) { return AppleHelper.map(values); }
    static Map<String,Object> task() { return map("id", "task-1", "areaCode", "cn", "areaTitle", "中国大陆", "store",
        map("StoreNumber", "R123", "District", "100000", "CityStoreName", "测试门店"), "product",
        map("Code", "SKU123CH/A", "Type", "iphoneduo", "Model", "Fixture Phone", "Capacity", "256GB", "Color", "白色")); }
    static String stock(String status) { return Json.stringify(map("body", map("stores", List.of(map("storeNumber", "R123", "partsAvailability", map("SKU123CH/A", map("pickupDisplay", status))))))); }
    static AppleHelper.Reply reply(String status) { return new AppleHelper.Reply(200, stock(status)); }
    static void waitFor(BooleanSupplier condition, String label) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (!condition.getAsBoolean() && System.nanoTime() < deadline) Thread.sleep(5);
        check(condition.getAsBoolean(), label);
    }
    static boolean idle(AppleHelper app) { synchronized (app.lock) { return !app.checking; } }
    static Map<String,Object> item(AppleHelper app) { synchronized (app.lock) { return AppleHelper.optionalObject(app.items.get("task-1")); } }
    static void next(AppleHelper app, AtomicInteger calls) throws Exception {
        int before = calls.get(); app.command(map("action", "check")); waitFor(() -> calls.get() > before && idle(app), "manual check finishes");
    }
    static void jsonTests() throws Exception {
        String source = "{\"a\":[true,false,null,-12.5e2,\"中文\\n\\u263a\"],\"empty\":{}}";
        equal(Json.stringify(Json.parse(Json.stringify(Json.parse(source)))), Json.stringify(Json.parse(source)), "JSON round trip");
        for (String invalid : List.of("", "{", "[1,]", "{\"a\":1,}", "{\"a\":1,\"a\":2}", "01", "-", "1.", "+1", "NaN", "true false", "\"a\n\"", "\"\\x\"", "\"\\uXYZ1\"", "\"\\u+123\"", "[".repeat(70) + "]".repeat(70)))
            rejects(() -> Json.parse(invalid), "reject malformed JSON");
        rejects(() -> Json.stringify(Double.NaN), "reject nonfinite JSON");
        equal(Json.parse(Json.stringify("😀\b\f\t\r\\\"")), "😀\b\f\t\r\\\"", "unicode/control string round trip");
    }
    static void validationTests() throws Exception {
        equal(AppleHelper.normalizeTasks(List.of(task())).size(), 1, "valid task");
        rejects(() -> AppleHelper.normalizeTasks(List.of(task(), task())), "duplicate tasks rejected");
        rejects(() -> AppleHelper.normalizeTasks(Collections.nCopies(101, task())), "task limit");
        Map<String,Object> invalidTask = task(); invalidTask.put("areaCode", "zz");
        rejects(() -> AppleHelper.normalizeTasks(List.of(invalidTask)), "invalid area");
        Map<String,Object> invalidSku = task(); AppleHelper.object(invalidSku.get("product"), "product").put("Code", "../../private");
        rejects(() -> AppleHelper.normalizeTasks(List.of(invalidSku)), "unsafe SKU");
        equal(AppleHelper.normalizeSettings(Map.of()).get("intervalSeconds"), 30, "default interval");
        for (int interval : List.of(1, 10, 30, 60, 120, 300)) equal(AppleHelper.normalizeSettings(map("intervalSeconds", interval)).get("intervalSeconds"), interval, "allowed interval");
        rejects(() -> AppleHelper.normalizeSettings(map("intervalSeconds", 30.1)), "fraction interval rejected");
        rejects(() -> AppleHelper.normalizeSettings(map("intervalSeconds", 0)), "non-positive interval rejected");
        rejects(() -> AppleHelper.normalizeSettings(map("intervalSeconds", -5)), "negative interval rejected");
        rejects(() -> AppleHelper.normalizeSettings(map("feishuSecret", "secret")), "orphan secret rejected");
        for (String url : List.of("http://api.day.app/key", "https://evil.example/key", "https://api.day.app.evil.example/key", "https://x@api.day.app/key", "https://api.day.app:443/key", "https://api.day.app/key#fragment", "https://api.day.app/"))
            rejects(() -> AppleHelper.normalizeSettings(map("barkUrl", url)), "unsafe Bark URL");
        for (String url : List.of("https://open.feishu.cn/open-apis/bot/v2/hook/test", "https://open.larksuite.com/open-apis/bot/v2/hook/test"))
            equal(AppleHelper.normalizeSettings(map("feishuWebhook", url)).get("feishuWebhook"), url, "official webhook accepted");
        rejects(() -> AppleHelper.normalizeSettings(map("feishuWebhook", "https://open.feishu.cn/open-apis/bot/v2/hook/a?x=1")), "webhook query rejected");
        String uri = AppleHelper.fulfillmentURI(AppleHelper.normalizeTasks(List.of(task()))).toString();
        check(uri.contains("/shop/retail/pickup-message?") && uri.contains("pl=true") && uri.contains("parts.0=SKU123CH%2FA") && uri.contains("mts.0=regular") && uri.contains("location=100000"), "modern pickup query and postal location");
        Map<String,Object> japan = task(); japan.put("areaCode", "jp"); AppleHelper.object(japan.get("store"), "store").put("District", "100-0001");
        check(AppleHelper.fulfillmentURI(AppleHelper.normalizeTasks(List.of(japan))).toString().contains("/jp/shop/retail/pickup-message?") && AppleHelper.fulfillmentURI(AppleHelper.normalizeTasks(List.of(japan))).toString().contains("cppart=UNLOCKED_JP"), "Japan query");
    }
    static void postalQueryTests() throws Exception {
        for (String postal : List.of("100000", " 100000 ")) {
            Map<String,Object> input = task(); AppleHelper.object(input.get("store"), "store").put("District", postal);
            URI uri = AppleHelper.fulfillmentURI(AppleHelper.normalizeTasks(List.of(input)));
            equal(uri.getHost(), "www.apple.com.cn", "mainland query uses mainland host");
            check(uri.getRawQuery().contains("location=100000") && !uri.getRawQuery().contains("store="), "mainland valid postal query uses location without store");
        }
        for (String postal : List.of("", "10000", "1000000", "12345A", "100-000", "１２３４５６")) {
            Map<String,Object> input = task(); AppleHelper.object(input.get("store"), "store").put("District", postal);
            String query = AppleHelper.fulfillmentURI(AppleHelper.normalizeTasks(List.of(input))).getRawQuery();
            check(query.contains("store=R123") && !query.contains("location="), "mainland missing or invalid postal falls back to exact store: " + postal);
        }
        Map<String,Object> missing = task(); AppleHelper.object(missing.get("store"), "store").remove("District");
        String missingQuery = AppleHelper.fulfillmentURI(AppleHelper.normalizeTasks(List.of(missing))).getRawQuery();
        check(missingQuery.contains("store=R123") && !missingQuery.contains("location="), "mainland omitted postal falls back to exact store");
        for (var entry : Map.of("jp", "100-0001", "sg", "100000", "us", "10001", "uk", "SW1A 1AA", "au", "2000").entrySet()) {
            Map<String,Object> input = task(); input.put("areaCode", entry.getKey());
            AppleHelper.object(input.get("store"), "store").put("District", entry.getValue());
            String query = AppleHelper.fulfillmentURI(AppleHelper.normalizeTasks(List.of(input))).getRawQuery();
            check(query.contains("location=" + AppleHelper.encode(entry.getValue())), "other region retains valid postal: " + entry.getKey());
            check(entry.getKey().equals("jp") ? query.contains("cppart=UNLOCKED_JP") && !query.contains("store=") : query.contains("store=R123"), "other region retains store or Japan unlock behavior: " + entry.getKey());
            AppleHelper.object(input.get("store"), "store").put("District", "invalid");
            String invalidQuery = AppleHelper.fulfillmentURI(AppleHelper.normalizeTasks(List.of(input))).getRawQuery();
            check(!invalidQuery.contains("location=") && (entry.getKey().equals("jp") ? invalidQuery.contains("cppart=UNLOCKED_JP") && !invalidQuery.contains("store=") : invalidQuery.contains("store=R123")), "other region retains invalid postal behavior: " + entry.getKey());
        }
        Map<String,Object> hongKong = task(); hongKong.put("areaCode", "hk");
        String hkQuery = AppleHelper.fulfillmentURI(AppleHelper.normalizeTasks(List.of(hongKong))).getRawQuery();
        check(hkQuery.contains("store=R123") && !hkQuery.contains("location="), "Hong Kong retains store-only query");
        Map<String,Object> second = task(); second.put("id", "task-2"); AppleHelper.object(second.get("product"), "product").put("Code", "SKU456CH/A");
        String batch = AppleHelper.fulfillmentURI(AppleHelper.normalizeTasks(List.of(task(), second))).getRawQuery();
        check(batch.contains("parts.0=SKU123CH%2FA") && batch.contains("parts.1=SKU456CH%2FA") && batch.contains("location=100000") && !batch.contains("store="), "mainland batch retains both exact SKUs in location-only query");
        AppleHelper.object(second.get("store"), "store").put("StoreNumber", "R999");
        rejects(() -> AppleHelper.fulfillmentURI(AppleHelper.normalizeTasks(List.of(task(), second))), "location-only query still rejects mixed target stores");
    }
    static void stockTests() throws Exception {
        for (String value : List.of("available", "unavailable", "ineligible", "unknown")) {
            AppleHelper.Stock stock = AppleHelper.parseStock(Json.parse(stock(value)), "R123", "SKU123CH/A");
            equal(stock.known(), Set.of("available", "unavailable").contains(value), "stock known only for exact states");
            equal(stock.available(), value.equals("available"), "stock availability");
        }
        check(!AppleHelper.parseStock(Json.parse(stock("available")), "R999", "SKU123CH/A").known(), "does not borrow another store's inventory");
        check(!AppleHelper.parseStock(Json.parse(stock("available")), "R123", "OTHER").known(), "does not borrow another SKU's inventory");
        Object legacy = map("body", map("content", map("pickupMessage", map("stores", List.of(map("storeNumber", "R123", "partsAvailability", map("SKU123CH/A", map("messageTypes", map("regular", map("pickupDisplay", "available"))))))))));
        check(AppleHelper.parseStock(legacy, "R123", "SKU123CH/A").available(), "legacy message shape");
        Map<String,Object> old = AppleHelper.itemState(task(), Map.of(), "有货", "available", true);
        Map<String,Object> unknown = AppleHelper.itemState(task(), old, "查询异常", "unknown", null);
        equal(unknown.get("available"), null, "unknown has no asserted availability");
        equal(AppleHelper.known(unknown), true, "unknown preserves last-known availability");
    }
    static void postalStockIdentityTests() {
        for (boolean legacy : List.of(false, true)) {
            for (String targetStatus : List.of("available", "unavailable")) {
                Map<String,Object> target = map("storeNumber", "R123", "partsAvailability", map("SKU123CH/A", map("pickupDisplay", targetStatus)));
                Map<String,Object> neighbor = map("storeNumber", "R999", "partsAvailability", map("SKU123CH/A", map("pickupDisplay", targetStatus.equals("available") ? "unavailable" : "available")));
                for (List<Object> stores : List.of(List.<Object>of(neighbor, target), List.<Object>of(target, neighbor))) {
                    AppleHelper.Stock parsed = AppleHelper.parseStock(postalStockPayload(stores, legacy), "R123", "SKU123CH/A");
                    check(parsed.known() && parsed.available() == targetStatus.equals("available"), "postal response uses exact target store despite neighboring inventory");
                }
                for (Object duplicate : List.of(target, neighborWithTargetId(neighbor), map("storeNumber", "R123"))) {
                    for (List<Object> stores : List.of(List.<Object>of(target, neighbor, duplicate), List.<Object>of(duplicate, neighbor, target))) {
                        AppleHelper.Stock parsed = AppleHelper.parseStock(postalStockPayload(stores, legacy), "R123", "SKU123CH/A");
                        check(!parsed.known() && !parsed.available(), "duplicate target store is unknown even with matching, conflicting, or incomplete entries");
                    }
                }
                check(!AppleHelper.parseStock(postalStockPayload(List.of(neighbor), legacy), "R123", "SKU123CH/A").known(), "postal response missing target store cannot borrow neighbor stock");
                Map<String,Object> missingSku = map("storeNumber", "R123", "partsAvailability", map("OTHER", map("pickupDisplay", "available")));
                check(!AppleHelper.parseStock(postalStockPayload(List.of(neighbor, missingSku), legacy), "R123", "SKU123CH/A").known(), "postal response missing target SKU cannot borrow other SKU or neighbor stock");
            }
        }
    }
    static Map<String,Object> neighborWithTargetId(Map<String,Object> neighbor) {
        Map<String,Object> duplicate = new LinkedHashMap<>(neighbor); duplicate.put("storeNumber", "R123"); return duplicate;
    }
    static Object postalStockPayload(List<Object> stores, boolean legacy) {
        return map("body", legacy ? map("content", map("pickupMessage", map("stores", stores))) : map("stores", stores));
    }
    static void notificationProtocolTests() throws Exception {
        equal(AppleHelper.signature("fixture-secret", "1700000000"), "eSSBpPPdWfBl7avPl9BWSBfQOnLGZ91Xn8G5oZis0sc=", "Feishu timestamp-newline-secret HMAC empty payload");
        String bark = AppleHelper.barkURI("https://api.day.app/key?group=apple&title=old", "中文", "消息", "https://www.apple.com.cn/").toString();
        check(bark.contains("group=apple") && !bark.contains("title=old") && bark.contains("title=%E4%B8%AD%E6%96%87"), "Bark URL merges official query");
        AppleHelper.validateNotificationReply("Bark", new AppleHelper.Reply(200, "{\"code\":200}"));
        AppleHelper.validateNotificationReply("飞书 / Lark", new AppleHelper.Reply(200, "{\"StatusCode\":0}"));
        rejects(() -> AppleHelper.validateNotificationReply("Bark", new AppleHelper.Reply(302, "{\"code\":200}")), "redirect response not accepted");
        rejects(() -> AppleHelper.validateNotificationReply("Bark", new AppleHelper.Reply(200, "{\"code\":400}")), "Bark business failure");
        rejects(() -> AppleHelper.validateNotificationReply("飞书 / Lark", new AppleHelper.Reply(200, "{\"code\":1}")), "Feishu business failure");
        rejects(() -> AppleHelper.validateNotificationReply("飞书 / Lark", new AppleHelper.Reply(200, "{}")), "missing business status rejected");
        rejects(() -> AppleHelper.validateNotificationReply("飞书 / Lark", new AppleHelper.Reply(200, "{\"code\":0.1}")), "fraction business status rejected");
    }
    static void manualCheckTests() throws Exception {
        AtomicInteger queries = new AtomicInteger(), sends = new AtomicInteger();
        try (AppleHelper app = new AppleHelper(directory(), TOKEN, (uri, method, body) -> {
            if (uri.getHost().equals("www.apple.com.cn")) { queries.incrementAndGet(); return CompletableFuture.completedFuture(reply("available")); }
            sends.incrementAndGet(); return CompletableFuture.completedFuture(new AppleHelper.Reply(200, "{\"code\":200}"));
        })) {
            app.command(map("action", "sync", "tasks", List.of(task()), "notificationSettings", map("barkUrl", "https://api.day.app/fixture")));
            Thread.sleep(25); equal(queries.get(), 0, "sync while paused does not query");
            app.command(map("action", "check")); waitFor(() -> queries.get() == 1 && idle(app), "paused manual check executes once");
            equal(item(app).get("status"), "有货", "manual check updates inventory");
            equal(app.command(map("action", "status")).get("monitoring"), false, "manual check remains paused");
            equal(sends.get(), 0, "paused manual check never sends external notifications");
            synchronized (app.lock) { check(!app.manualRun && (app.scheduled == null || app.scheduled.isDone()), "manual check schedules no next polling"); }
            app.command(map("action", "start")); waitFor(() -> queries.get() == 2 && idle(app), "monitor starts after manual availability");
            equal(sends.get(), 1, "manual observed availability does not consume initial monitored notification");
            next(app, queries); equal(sends.get(), 1, "subsequent monitored availability deduplicates notification");
            app.command(map("action", "stop"));
        }
    }
    static void lifecycleTests() throws Exception {
        AtomicInteger calls = new AtomicInteger(); AtomicReference<String> display = new AtomicReference<>("available");
        try (AppleHelper app = new AppleHelper(directory(), TOKEN, (uri, method, body) -> { calls.incrementAndGet(); return CompletableFuture.completedFuture(reply(display.get())); })) {
            app.command(map("action", "check")); Thread.sleep(25); equal(calls.get(), 0, "idle check does not query");
            rejects(() -> app.command(map("action", "start")), "empty start rejected");
            app.command(map("action", "start", "tasks", List.of(task())));
            waitFor(() -> calls.get() == 1 && idle(app), "start checks asynchronously");
            equal(item(app).get("status"), "有货", "available status");
            check(!item(app).containsKey("notificationDelivery"), "no external channels means no delivery");
            display.set("ineligible"); next(app, calls); equal(item(app).get("status"), "暂不可自提", "ineligible status");
            equal(item(app).get("lastKnownAvailable"), true, "ineligible preserves known state");
            display.set("unavailable"); next(app, calls); equal(item(app).get("status"), "无货", "unavailable status");
            app.command(map("action", "sync", "tasks", List.of()));
            equal(app.command(map("action", "status")).get("monitoring"), false, "empty sync pauses");
            check(app.items.isEmpty(), "removed task states purged");
            check(Files.getPosixFilePermissions(app.stateFile).equals(java.nio.file.attribute.PosixFilePermissions.fromString("rw-------")), "state private 0600");
        }
        for (int status : List.of(403, 541)) {
            AtomicInteger request = new AtomicInteger();
            try (AppleHelper app = new AppleHelper(directory(), TOKEN, (uri, method, body) -> { request.incrementAndGet(); return CompletableFuture.completedFuture(new AppleHelper.Reply(status, "not json")); })) {
                app.command(map("action", "start", "tasks", List.of(task()))); waitFor(() -> request.get() == 1 && idle(app), "blocked query finishes");
                equal(item(app).get("status"), "需官网验证", "Apple challenge remains manual");
            }
        }
    }
    static void cancellationTests() throws Exception {
        AtomicInteger calls = new AtomicInteger(); CompletableFuture<AppleHelper.Reply> pending = new CompletableFuture<>();
        try (AppleHelper app = new AppleHelper(directory(), TOKEN, (uri, method, body) -> { calls.incrementAndGet(); return pending; })) {
            long before = System.nanoTime(); app.command(map("action", "start", "tasks", List.of(task())));
            check(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - before) < 1000, "start does not wait for inventory");
            waitFor(() -> calls.get() == 1, "pending inventory dispatched");
            app.command(map("action", "stop")); check(pending.isCancelled(), "stop cancels in-flight request");
            Thread.sleep(25); equal(app.command(map("action", "status")).get("monitoring"), false, "late completion cannot resume monitor");
        }
        AtomicInteger sends = new AtomicInteger(); CompletableFuture<AppleHelper.Reply> pendingBark = new CompletableFuture<>();
        try (AppleHelper app = new AppleHelper(directory(), TOKEN, (uri, method, body) -> {
            if (uri.getHost().equals("www.apple.com.cn")) return CompletableFuture.completedFuture(reply("available"));
            sends.incrementAndGet(); return pendingBark;
        })) {
            app.command(map("action", "start", "tasks", List.of(task()), "notificationSettings", map("barkUrl", "https://api.day.app/fixture", "feishuWebhook", "https://open.feishu.cn/open-apis/bot/v2/hook/fixture")));
            waitFor(() -> sends.get() == 1, "Bark request began"); app.command(map("action", "stop"));
            check(pendingBark.isCancelled(), "pause cancels pending notification"); Thread.sleep(30);
            equal(sends.get(), 1, "pause prevents following channel dispatch");
            check(!item(app).containsKey("notificationDelivery"), "pause clears retry queue");
        }
    }
    static void recoveryTests() throws Exception {
        Path directory = directory(); AtomicInteger calls = new AtomicInteger();
        AppleHelper.Network fake = (uri, method, body) -> { calls.incrementAndGet(); return CompletableFuture.completedFuture(reply("available")); };
        try (AppleHelper app = new AppleHelper(directory, TOKEN, fake)) {
            app.command(map("action", "start", "tasks", List.of(task()))); waitFor(() -> calls.get() == 1 && idle(app), "initial persisted check");
        }
        try (AppleHelper recovered = new AppleHelper(directory, TOKEN, fake)) {
            waitFor(() -> calls.get() == 2 && idle(recovered), "daemon restart resumes persisted monitoring");
            equal(recovered.command(map("action", "status")).get("monitoring"), true, "running flag recovered");
            recovered.command(map("action", "stop"));
        }
        try (AppleHelper stopped = new AppleHelper(directory, TOKEN, fake)) {
            Thread.sleep(25); equal(calls.get(), 2, "persisted pause remains idle");
            equal(stopped.command(map("action", "status")).get("monitoring"), false, "pause recovered");
        }
    }
    static void notificationLifecycleTests() throws Exception {
        AtomicInteger stockCalls = new AtomicInteger(), barkCalls = new AtomicInteger(), feishuCalls = new AtomicInteger();
        AtomicReference<String> display = new AtomicReference<>("available");
        try (AppleHelper app = new AppleHelper(directory(), TOKEN, (uri, method, body) -> {
            if (uri.getHost().equals("www.apple.com.cn")) { stockCalls.incrementAndGet(); return CompletableFuture.completedFuture(reply(display.get())); }
            if (uri.getHost().equals("api.day.app")) {
                int attempt = barkCalls.incrementAndGet(); return CompletableFuture.completedFuture(new AppleHelper.Reply(200, attempt == 1 ? "{\"code\":500}" : "{\"code\":200}"));
            }
            feishuCalls.incrementAndGet(); return CompletableFuture.completedFuture(new AppleHelper.Reply(200, "{\"code\":0}"));
        })) {
            app.command(map("action", "start", "tasks", List.of(task()), "notificationSettings", map("barkUrl", "https://api.day.app/fixture", "feishuWebhook", "https://open.feishu.cn/open-apis/bot/v2/hook/fixture")));
            waitFor(() -> stockCalls.get() == 1 && idle(app), "first notification round");
            equal(barkCalls.get(), 1, "Bark initial delivery"); equal(feishuCalls.get(), 1, "Bark failure does not block Feishu");
            String eventBefore = (String) AppleHelper.optionalObject(item(app).get("notificationDelivery")).get("eventId");
            Map<String,Object> extra = task(); extra.put("id", "task-2"); AppleHelper.object(extra.get("product"), "product").put("Code", "OTHER123CH/A");
            app.command(map("action", "sync", "tasks", List.of(task(), extra)));
            equal(AppleHelper.optionalObject(item(app).get("notificationDelivery")).get("eventId"), eventBefore, "adding another task preserves pending event");
            waitFor(() -> stockCalls.get() >= 2 && idle(app), "sync refresh completes");
            app.command(map("action", "sync", "tasks", List.of(task()), "notificationSettings", map("barkUrl", "https://api.day.app/fixture", "feishuWebhook", "https://open.feishu.cn/open-apis/bot/v2/hook/fixture", "intervalSeconds", 60)));
            equal(AppleHelper.optionalObject(item(app).get("notificationDelivery")).get("eventId"), eventBefore, "same destinations and interval change preserve pending event");
            waitFor(() -> stockCalls.get() >= 3 && idle(app), "interval sync refresh completes");
            next(app, stockCalls); equal(barkCalls.get(), 1, "failed channel respects retry delay"); equal(feishuCalls.get(), 1, "successful channel deduplicated");
            synchronized (app.lock) {
                Map<String,Object> channels = AppleHelper.optionalObject(AppleHelper.optionalObject(item(app).get("notificationDelivery")).get("channels"));
                AppleHelper.optionalObject(channels.get("Bark")).put("nextRetryAt", 0);
            }
            next(app, stockCalls); equal(barkCalls.get(), 2, "failed channel retries independently"); equal(feishuCalls.get(), 1, "retry does not repeat successful channel");
            display.set("unknown"); next(app, stockCalls); display.set("available"); next(app, stockCalls);
            equal(barkCalls.get(), 2, "unknown then available does not duplicate stock event");
            display.set("unavailable"); next(app, stockCalls); display.set("available"); next(app, stockCalls);
            equal(barkCalls.get(), 3, "real restock creates fresh event"); equal(feishuCalls.get(), 2, "real restock sends each channel");
            app.command(map("action", "sync", "notificationSettings", Map.of()));
            check(!item(app).containsKey("notificationDelivery"), "configuration change cancels queued deliveries");
            app.command(map("action", "stop"));
        }
    }
    static void persistenceFailureTests() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        try (AppleHelper app = new AppleHelper(directory(), TOKEN, (uri, method, body) -> {
            calls.incrementAndGet(); return CompletableFuture.completedFuture(reply("unavailable"));
        })) {
            app.command(map("action", "start", "tasks", List.of(task())));
            waitFor(() -> calls.get() == 1 && idle(app), "initial check before disk failure");
            Files.delete(app.stateFile); Files.createDirectory(app.stateFile);
            boolean failed = false;
            try { app.command(map("action", "sync", "notificationSettings", map("intervalSeconds", 60))); }
            catch (java.io.IOException expected) { failed = true; }
            check(failed, "unwritable state target reports failure");
            equal(app.command(map("action", "status")).get("monitoring"), false, "disk failure never reports fake monitoring");
            synchronized (app.lock) { check(!app.checking && (app.scheduled == null || app.scheduled.isCancelled() || app.scheduled.isDone()), "disk failure leaves no active check"); }
            check(Json.stringify(app.log).contains("配置保存失败"), "disk failure remains visible in memory log");
        }
    }
    static void inventoryRetryTests() throws Exception {
        AtomicLong now = new AtomicLong(System.currentTimeMillis());
        AtomicInteger queries = new AtomicInteger(), sends = new AtomicInteger();
        AtomicReference<AppleHelper.Reply> response = new AtomicReference<>(reply("available"));
        Path directory = directory();
        AppleHelper.Network fake = (uri, method, body) -> {
            if (uri.getHost().equals("www.apple.com.cn")) { queries.incrementAndGet(); return CompletableFuture.completedFuture(response.get()); }
            sends.incrementAndGet(); return CompletableFuture.completedFuture(new AppleHelper.Reply(200, "{\"code\":500}"));
        };
        long retainedRetry;
        try (AppleHelper app = new AppleHelper(directory, TOKEN, fake, now::get)) {
            app.command(map("action", "start", "tasks", List.of(task()), "notificationSettings", map("barkUrl", "https://api.day.app/fixture")));
            waitFor(() -> queries.get() == 1 && idle(app), "initial known inventory and failed notification");
            equal(sends.get(), 1, "notification fixture has a pending retry");
            synchronized (app.lock) {
                Map<String,Object> channels = AppleHelper.optionalObject(AppleHelper.optionalObject(item(app).get("notificationDelivery")).get("channels"));
                AppleHelper.optionalObject(channels.get("Bark")).put("nextRetryAt", 0);
            }
            response.set(new AppleHelper.Reply(503, "<html>temporarily unavailable</html>"));
            for (long delay : List.of(60_000L, 120_000L, 240_000L, 300_000L, 300_000L)) {
                next(app, queries);
                synchronized (app.lock) {
                    equal(app.retryAt - now.get(), delay, "503 consecutive backoff and cap");
                    equal(item(app).get("available"), null, "503 never exposes stale stock as current");
                    equal(item(app).get("lastKnownAvailable"), true, "historical stock retained only as historical");
                    check(item(app).get("detail").toString().contains("503"), "503 remains visible in detail");
                }
                int before = queries.get();
                app.command(map("action", "check")); app.command(map("action", "start"));
                Thread.sleep(15); equal(queries.get(), before, "manual check and start cannot bypass cooldown");
                now.set(app.retryAt);
            }
            equal(sends.get(), 1, "503 cannot retry stale in-stock notification");
            response.set(reply("unavailable")); next(app, queries);
            synchronized (app.lock) {
                equal(app.consecutiveFailures, 0, "successful round resets consecutive failures");
                equal(app.retryAt, 0L, "successful round clears cooldown");
                long delay = app.scheduled.getDelay(TimeUnit.MILLISECONDS);
                check(delay > 28_000 && delay <= 30_000, "success resumes configured normal interval");
            }
            response.set(new AppleHelper.Reply(429, "rate limited")); next(app, queries);
            equal(app.retryAt - now.get(), 60_000L, "429 starts backoff at 60 seconds after recovery");
            int before = queries.get();
            app.command(map("action", "sync", "notificationSettings", map("intervalSeconds", 300)));
            equal(app.retryAt - now.get(), 300_000L, "larger user interval extends existing cooldown");
            retainedRetry = app.retryAt;
            app.command(map("action", "sync", "tasks", List.of()));
            app.command(map("action", "start", "tasks", List.of(task())));
            app.command(map("action", "check")); Thread.sleep(15);
            equal(queries.get(), before, "removing and replacing tasks cannot clear endpoint cooldown");
            equal(AppleHelper.optionalObject(app.snapshot().get("monitorState")).get("retryAt"), java.time.Instant.ofEpochMilli(retainedRetry).toString(), "status exposes ISO retry time");
        }
        int before = queries.get();
        try (AppleHelper recovered = new AppleHelper(directory, TOKEN, fake, now::get)) {
            equal(recovered.retryAt, retainedRetry, "restart restores cooldown deadline");
            equal(recovered.consecutiveFailures, 1, "restart restores consecutive failures");
            recovered.command(map("action", "check")); recovered.command(map("action", "start"));
            Thread.sleep(15); equal(queries.get(), before, "restart and commands do not dispatch during cooldown");
            ScheduledFuture<?> scheduled = recovered.scheduled;
            recovered.command(map("action", "stop"));
            check(scheduled.isCancelled(), "stop cancels pending cooldown timer immediately");
            equal(recovered.retryAt, retainedRetry, "stop preserves cooldown for a later start");
            now.set(retainedRetry); Thread.sleep(15); equal(queries.get(), before, "stopped cooldown does not resume itself");
            equal(AppleHelper.optionalObject(recovered.snapshot().get("monitorState")).get("retryAt"), "", "expired cooldown hidden from status");
        }
        equal(AppleHelper.retryDelayMillis(1, 300), 300_000L, "backoff is never shorter than user interval");
        // A 503 in the first store must also defer later stores in that polling round.
        AtomicInteger groupCalls = new AtomicInteger();
        try (AppleHelper app = new AppleHelper(directory(), TOKEN, (uri, method, body) -> {
            groupCalls.incrementAndGet(); return CompletableFuture.completedFuture(new AppleHelper.Reply(503, "unavailable"));
        }, now::get)) {
            Map<String,Object> other = task(); other.put("id", "task-2"); AppleHelper.object(other.get("store"), "store").put("StoreNumber", "R456");
            app.command(map("action", "start", "tasks", List.of(task(), other)));
            waitFor(() -> groupCalls.get() == 1 && idle(app), "batch handles temporary failure");
            equal(groupCalls.get(), 1, "later store does not bypass endpoint cooldown");
            equal(AppleHelper.optionalObject(app.items.get("task-2")).get("available"), null, "deferred store inventory is unknown");
            equal(app.consecutiveFailures, 1, "deferred stores do not inflate failure count");
        }
    }
    static void deferredStoreStateTests() throws Exception {
        for (int status : List.of(429, 503)) for (boolean successfulPrefix : List.of(false, true)) {
            AtomicLong now = new AtomicLong(System.currentTimeMillis());
            AtomicInteger calls = new AtomicInteger();
            Map<String,Object> prefix = task(); prefix.put("id", "prefix");
            AppleHelper.object(prefix.get("store"), "store").put("StoreNumber", "R111");
            AppleHelper.object(prefix.get("product"), "product").put("Code", "BEFORECH/A");
            Map<String,Object> sameStore = task(); sameStore.put("id", "same-store");
            AppleHelper.object(sameStore.get("product"), "product").put("Code", "SKU456CH/A");
            List<Map<String,Object>> tasks = new ArrayList<>();
            if (successfulPrefix) tasks.add(prefix);
            tasks.add(task()); tasks.add(sameStore);
            for (int index = 0; index < 3; index++) {
                Map<String,Object> deferred = task(); deferred.put("id", "deferred-" + index);
                AppleHelper.object(deferred.get("store"), "store").put("StoreNumber", "R" + (456 + index));
                tasks.add(deferred);
            }
            AppleHelper.Network fake = (uri, method, body) -> {
                calls.incrementAndGet();
                if (uri.getRawQuery().contains("parts.0=BEFORECH%2FA"))
                    return CompletableFuture.completedFuture(new AppleHelper.Reply(200, Json.stringify(map("body", map("stores", List.of(map("storeNumber", "R111", "partsAvailability", map("BEFORECH/A", map("pickupDisplay", "unavailable")))))))));
                return CompletableFuture.completedFuture(new AppleHelper.Reply(status, "temporary", "180"));
            };
            try (AppleHelper app = new AppleHelper(directory(), TOKEN, fake, now::get)) {
                app.command(map("action", "sync", "tasks", tasks));
                Map<String,Object> retained = new LinkedHashMap<>();
                synchronized (app.lock) {
                    for (Map<String,Object> current : tasks) {
                        String id = (String) current.get("id");
                        if (!id.startsWith("deferred-")) continue;
                        if (!id.equals("deferred-2")) {
                            boolean available = id.equals("deferred-0");
                            Map<String,Object> old = AppleHelper.itemState(current, Map.of(), available ? "有货" : "无货", available ? "available" : "unavailable", available);
                            old.put("checkedAt", "2026-10-16T00:00:00Z"); old.put("lastKnownAt", "2026-10-16T00:00:00Z");
                            app.items.put(id, old);
                        }
                        retained.put(id, Json.parse(Json.stringify(app.items.get(id))));
                    }
                }
                app.command(map("action", "start"));
                int expectedCalls = successfulPrefix ? 2 : 1;
                waitFor(() -> calls.get() == expectedCalls && idle(app), "temporary failure finishes only requested store groups");
                equal(calls.get(), expectedCalls, "temporary failure dispatches no deferred stores");
                for (var entry : retained.entrySet())
                    equal(app.items.get(entry.getKey()), entry.getValue(), "unrequested store retains exact status, availability, and check timestamps: " + entry.getKey());
                for (String id : List.of("task-1", "same-store")) {
                    Map<String,Object> failed = AppleHelper.optionalObject(app.items.get(id));
                    equal(failed.get("status"), "查询异常", "actually requested group records temporary failure for each SKU");
                    equal(failed.get("available"), null, "actually failed inventory is unknown");
                    check(failed.get("detail").toString().contains(Integer.toString(status)), "actually failed group records correct HTTP status");
                    check(failed.containsKey("checkedAt"), "actually requested group receives a check timestamp");
                }
                if (successfulPrefix) equal(AppleHelper.optionalObject(app.items.get("prefix")).get("status"), "无货", "completed earlier store keeps its real response");
                equal(app.retryAt, now.get() + 180_000L, "batch cooldown retains server Retry-After");
                equal(app.consecutiveFailures, 1, "one failed request counts once across deferred stores");
                check(app.scheduled.getDelay(TimeUnit.MILLISECONDS) > 178_000, "normal monitoring waits for whole-batch cooldown");
                app.command(map("action", "check")); Thread.sleep(15);
                equal(calls.get(), expectedCalls, "manual check cannot query deferred stores during cooldown");
                Map<String,Object> persisted = AppleHelper.object(Json.parse(Files.readString(app.stateFile)), "state");
                Map<String,Object> persistedItems = AppleHelper.optionalObject(AppleHelper.optionalObject(persisted.get("monitorState")).get("items"));
                for (var entry : retained.entrySet())
                    equal(persistedItems.get(entry.getKey()), entry.getValue(), "persisted deferred store keeps original observation");
            }
        }
    }
    static void retryAfterTests() throws Exception {
        long now = java.time.Instant.parse("2026-10-16T10:00:00Z").toEpochMilli();
        equal(AppleHelper.retryAfterAt("600", now), now + 600_000, "Retry-After delay seconds");
        equal(AppleHelper.retryAfterAt(" 600 ", now), now + 600_000, "Retry-After surrounding whitespace");
        equal(AppleHelper.retryAfterAt("Fri, 16 Oct 2026 10:15:00 GMT", now), now + 900_000, "Retry-After HTTP date");
        equal(AppleHelper.retryAfterAt("Fri, 16 Oct 2026 09:00:00 GMT", now), now, "past HTTP date cannot become a negative delay");
        for (String invalid : List.of("", "-1", "1.5", "tomorrow")) equal(AppleHelper.retryAfterAt(invalid, now), 0L, "invalid Retry-After ignored");
        equal(AppleHelper.retryAfterAt("999999999999999999999999999999999999", now), 0L, "unrepresentable Retry-After ignored without overflow");
        equal(AppleHelper.retryAfterAt(Long.toString(Long.MAX_VALUE / 1000), now), 0L, "deadline addition cannot overflow");
        long maximumSeconds = (8_640_000_000_000_000L - now) / 1000;
        equal(AppleHelper.retryAfterAt(Long.toString(maximumSeconds), now), now + maximumSeconds * 1000, "largest displayable delay is respected");
        equal(AppleHelper.retryAfterAt(Long.toString(maximumSeconds + 1), now), 0L, "timestamp outside UI Date range is invalid");
        AtomicInteger calls = new AtomicInteger();
        AtomicLong clock = new AtomicLong(now);
        for (String header : List.of("600", "Fri, 16 Oct 2026 10:15:00 GMT", "1", "invalid")) {
            int before = calls.get();
            try (AppleHelper app = new AppleHelper(directory(), TOKEN, (uri, method, body) -> {
                calls.incrementAndGet(); return CompletableFuture.completedFuture(new AppleHelper.Reply(503, "unavailable", header));
            }, clock::get)) {
                app.command(map("action", "start", "tasks", List.of(task())));
                waitFor(() -> calls.get() == before + 1 && idle(app), "Retry-After response handled");
                equal(app.retryAt, Math.max(now + 60_000, AppleHelper.retryAfterAt(header, now)), "scheduled retry respects both server and local backoff");
            }
        }
    }
    static void httpTests() throws Exception {
        try (AppleHelper app = new AppleHelper(directory(), TOKEN, (uri, method, body) -> CompletableFuture.failedFuture(new AssertionError("idle never uses network")))) {
            app.startHttp(0); String base = "http://127.0.0.1:" + app.server.getAddress().getPort();
            HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build();
            HttpResponse<String> health = client.send(HttpRequest.newBuilder(URI.create(base + "/health")).GET().build(), HttpResponse.BodyHandlers.ofString());
            equal(health.statusCode(), 200, "health available"); equal(AppleHelper.object(Json.parse(health.body()), "health").size(), 2, "health leaks no task or config");
            check(health.headers().firstValue("access-control-allow-origin").isEmpty(), "no permissive CORS");
            for (String bearer : List.of("", "Bearer wrong")) equal(http(client, base, bearer, null, "{\"action\":\"status\"}").statusCode(), 401, "auth required");
            equal(http(client, base, "Bearer " + TOKEN, null, "{\"action\":\"status\"}").statusCode(), 200, "authenticated status");
            equal(http(client, base, "Bearer " + TOKEN, "https://example.com", "{\"action\":\"status\"}").statusCode(), 403, "webpage Origin refused");
            equal(http(client, base, "Bearer " + TOKEN, null, "{").statusCode(), 400, "invalid JSON refused");
            equal(http(client, base, "Bearer " + TOKEN, null, " ".repeat(AppleHelper.MAX_BODY + 1)).statusCode(), 413, "oversized body refused");
            check(app.authorized("Bearer " + TOKEN) && !app.authorized("Bearer " + TOKEN + "x"), "exact token validation");
        }
    }
    static HttpResponse<String> http(HttpClient client, String base, String bearer, String origin, String body) throws Exception {
        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(base + "/command")).timeout(Duration.ofSeconds(5))
            .header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8));
        if (!bearer.isEmpty()) builder.header("Authorization", bearer);
        if (origin != null) builder.header("Origin", origin);
        return client.send(builder.build(), HttpResponse.BodyHandlers.ofString());
    }
}
