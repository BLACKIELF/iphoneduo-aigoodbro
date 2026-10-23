import com.sun.net.httpserver.*;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.io.*;
import java.net.*;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.time.*;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.concurrent.*;

/** Local authenticated inventory daemon. Notification protocol follows Apple-Monitor. */
public final class AppleHelper implements AutoCloseable {
    static final String VERSION = "1018v1";
    static final int PORT = 17371, MAX_BODY = 1_048_576;
    static final Set<String> AREAS = Set.of("cn", "hk", "jp", "sg", "us", "uk", "au");
    static final Set<Integer> INTERVALS = Set.of(30, 60, 120, 300);
    static final DateTimeFormatter TIME = DateTimeFormatter.ofPattern("HH:mm:ss").withZone(ZoneId.of("Asia/Shanghai"));
    record Reply(int status, String body, String retryAfter) {
        Reply(int status, String body) { this(status, body, ""); }
    }
    interface Network { CompletableFuture<Reply> send(URI uri, String method, String body); }
    final Object lock = new Object();
    final Path stateFile;
    final byte[] token;
    final Network network;
    final java.util.function.LongSupplier clock;
    final ScheduledExecutorService worker = Executors.newScheduledThreadPool(2, runnable -> {
        Thread thread = new Thread(runnable, "apple-helper-worker"); thread.setDaemon(true); return thread;
    });
    final Set<CompletableFuture<?>> requests = new HashSet<>();
    List<Map<String,Object>> tasks = new ArrayList<>();
    Map<String,Object> settings = normalizeSettings(Map.of());
    Map<String,Object> items = new LinkedHashMap<>();
    List<Object> log = new ArrayList<>();
    String lastCheck = "";
    boolean monitoring, checking, manualRun, closed;
    long generation;
    long retryAt;
    int consecutiveFailures;
    ScheduledFuture<?> scheduled;
    HttpServer server;
    ExecutorService httpExecutor;

    public static void main(String[] args) throws Exception {
        if (args.length == 1 && args[0].equals("--self-test")) { AppleHelperTest.main(new String[0]); return; }
        if (args.length >= 1 && args[0].equals("--native-messaging")) { runNativeMessaging(args); return; }
        if (args.length != 0) throw new IllegalArgumentException("不支持的启动参数");
        Path stateDir = Path.of(requiredEnv("APPLE_HELPER_STATE_DIR"));
        Path tokenFile = Path.of(requiredEnv("APPLE_HELPER_TOKEN_FILE"));
        String secret = Files.readString(tokenFile, StandardCharsets.UTF_8).trim();
        if (!secret.matches("[A-Za-z0-9_+=/-]{32,256}")) throw new IllegalArgumentException("本地配对密钥格式无效");
        if (!Files.isDirectory(stateDir)) throw new IOException("状态目录不存在");
        AppleHelper app = new AppleHelper(stateDir, secret, liveNetwork());
        app.startHttp(PORT);
        Runtime.getRuntime().addShutdownHook(new Thread(app::close));
        System.out.println("Apple 购买助手 " + VERSION + " 后台已就绪（仅本机）");
    }

    static void runNativeMessaging(String[] args) {
        String expectedOrigin = "chrome-extension://agooghaedakdaimodmlajgkgondpjjil/";
        if (args.length > 1 && !args[1].equals(expectedOrigin)) {
            System.exit(1);
        }
        try {
            Path tokenFile;
            String envToken = System.getenv("APPLE_HELPER_TOKEN_FILE");
            if (envToken != null && !envToken.isBlank()) {
                tokenFile = Path.of(envToken);
            } else if (System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win")) {
                String localAppData = System.getenv("LOCALAPPDATA");
                Path base = localAppData != null ? Path.of(localAppData) : Path.of(System.getProperty("user.home"), "AppData", "Local");
                tokenFile = base.resolve("ApplePurchaseHelper").resolve("token");
            } else {
                tokenFile = Path.of(System.getProperty("user.home"), "Library", "Application Support", "ApplePurchaseHelper", "token");
            }
            if (!Files.exists(tokenFile)) {
                writeNativeResponse("{\"ok\":false,\"error\":\"后台配对密钥不存在，请先运行安装程序\"}".getBytes(StandardCharsets.UTF_8));
                return;
            }
            String token = Files.readString(tokenFile, StandardCharsets.UTF_8).trim();
            InputStream in = System.in;
            byte[] header = new byte[4];
            while (in.readNBytes(header, 0, 4) == 4) {
                int length = (header[0] & 0xFF) | ((header[1] & 0xFF) << 8) | ((header[2] & 0xFF) << 16) | ((header[3] & 0xFF) << 24);
                if (length <= 0 || length > 1024 * 1024) break;
                byte[] messageBytes = in.readNBytes(length);
                if (messageBytes.length != length) break;
                
                byte[] responseBytes;
                try {
                    HttpURLConnection conn = (HttpURLConnection) new URI("http://127.0.0.1:17371/command").toURL().openConnection(Proxy.NO_PROXY);
                    conn.setRequestMethod("POST");
                    conn.setRequestProperty("Authorization", "Bearer " + token);
                    conn.setRequestProperty("Content-Type", "application/json");
                    conn.setDoOutput(true);
                    conn.setConnectTimeout(5000);
                    conn.setReadTimeout(12000);
                    try (OutputStream os = conn.getOutputStream()) {
                        os.write(messageBytes);
                    }
                    int code = conn.getResponseCode();
                    InputStream respIn = code >= 200 && code < 300 ? conn.getInputStream() : conn.getErrorStream();
                    responseBytes = respIn != null ? respIn.readAllBytes() : "{\"ok\":false,\"error\":\"后台未响应\"}".getBytes(StandardCharsets.UTF_8);
                } catch (Exception err) {
                    responseBytes = "{\"ok\":false,\"error\":\"Java 后台未连接，请先双击 start_backend.bat 启动后台\"}".getBytes(StandardCharsets.UTF_8);
                }
                writeNativeResponse(responseBytes);
            }
        } catch (Exception ignored) {
            System.exit(0);
        }
    }

    static void writeNativeResponse(byte[] responseBytes) throws IOException {
        int respLen = responseBytes.length;
        byte[] respHeader = new byte[] {
            (byte) (respLen & 0xFF),
            (byte) ((respLen >> 8) & 0xFF),
            (byte) ((respLen >> 16) & 0xFF),
            (byte) ((respLen >> 24) & 0xFF)
        };
        System.out.write(respHeader);
        System.out.write(responseBytes);
        System.out.flush();
    }
    static String requiredEnv(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) throw new IllegalArgumentException("缺少启动配置 " + name);
        return value;
    }
    static Network liveNetwork() {
        HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10))
            .followRedirects(HttpClient.Redirect.NEVER).proxy(new ProxySelector() {
                public List<Proxy> select(URI uri) { return List.of(Proxy.NO_PROXY); }
                public void connectFailed(URI uri, SocketAddress address, IOException failure) {}
            }).build();
        return (uri, method, body) -> {
            HttpRequest.Builder builder = HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(10))
                .header("Accept", "application/json")
                .header("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/145.0.0.0 Safari/537.36");
            if (method.equals("POST")) builder.header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(body));
            else builder.GET();
            CompletableFuture<HttpResponse<String>> http = client.sendAsync(builder.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            CompletableFuture<Reply> result = http.thenApply(response -> {
                if (response.body().length() > 2 * MAX_BODY) throw new CompletionException(new IOException("响应过大"));
                return new Reply(response.statusCode(), response.body(), response.headers().firstValue("Retry-After").orElse(""));
            });
            result.whenComplete((reply, error) -> { if (result.isCancelled()) http.cancel(true); });
            return result;
        };
    }
    AppleHelper(Path directory, String secret, Network network) throws IOException {
        this(directory, secret, network, System::currentTimeMillis);
    }
    AppleHelper(Path directory, String secret, Network network, java.util.function.LongSupplier clock) throws IOException {
        stateFile = directory.resolve("state.json"); token = secret.getBytes(StandardCharsets.UTF_8); this.network = network; this.clock = clock;
        load();
        synchronized (lock) { if (monitoring) schedule(0); }
    }
    void startHttp(int port) throws IOException {
        System.setProperty("sun.net.httpserver.maxReqTime", "15");
        System.setProperty("sun.net.httpserver.maxRspTime", "15");
        server = HttpServer.create(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), port), 16);
        httpExecutor = Executors.newFixedThreadPool(8);
        server.setExecutor(httpExecutor);
        server.createContext("/", this::handleHttp);
        server.start();
    }
    void handleHttp(HttpExchange exchange) throws IOException {
        try {
            String path = exchange.getRequestURI().getPath();
            String host = exchange.getRequestHeaders().getFirst("Host");
            String expectedHost = "127.0.0.1:" + server.getAddress().getPort();
            if (!exchange.getRemoteAddress().getAddress().isLoopbackAddress() || !expectedHost.equals(host) ||
                exchange.getRequestHeaders().containsKey("Origin")) {
                respond(exchange, 403, map("ok", false, "error", "仅允许本机配对桥接访问")); return;
            }
            if (path.equals("/health") && exchange.getRequestMethod().equals("GET") && exchange.getRequestURI().getQuery() == null) {
                respond(exchange, 200, map("ok", true, "version", VERSION)); return;
            }
            if (!path.equals("/command") || !exchange.getRequestMethod().equals("POST") || exchange.getRequestURI().getQuery() != null) {
                respond(exchange, 404, map("ok", false, "error", "接口不存在")); return;
            }
            List<String> auth = exchange.getRequestHeaders().get("Authorization");
            if (auth == null || auth.size() != 1 || !authorized(auth.get(0))) {
                respond(exchange, 401, map("ok", false, "error", "本地配对验证失败")); return;
            }
            String contentType = exchange.getRequestHeaders().getFirst("Content-Type");
            if (contentType == null || !contentType.toLowerCase(Locale.ROOT).matches("application/json(?:\\s*;.*)?")) {
                respond(exchange, 415, map("ok", false, "error", "请求必须使用 JSON")); return;
            }
            byte[] body = exchange.getRequestBody().readNBytes(MAX_BODY + 1);
            if (body.length > MAX_BODY) { respond(exchange, 413, map("ok", false, "error", "请求过大")); return; }
            Map<String,Object> command = object(Json.parse(new String(body, StandardCharsets.UTF_8)), "命令");
            respond(exchange, 200, command(command));
        } catch (IllegalArgumentException error) {
            respond(exchange, 400, map("ok", false, "error", safeError(error)));
        } catch (Exception error) {
            respond(exchange, 500, map("ok", false, "error", "本地后台操作失败，请检查状态目录权限"));
        } finally { exchange.close(); }
    }
    boolean authorized(String header) {
        if (header == null || !header.startsWith("Bearer ") || header.length() > 300) return false;
        return MessageDigest.isEqual(token, header.substring(7).getBytes(StandardCharsets.UTF_8));
    }
    static void respond(HttpExchange exchange, int status, Object body) throws IOException {
        byte[] bytes = Json.stringify(body).getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        exchange.getResponseHeaders().set("Cache-Control", "no-store");
        exchange.getResponseHeaders().set("X-Content-Type-Options", "nosniff");
        exchange.sendResponseHeaders(status, bytes.length);
        exchange.getResponseBody().write(bytes);
    }
    Map<String,Object> command(Map<String,Object> input) throws IOException {
        String action = text(input.get("action"), "操作", 20, true);
        if (!Set.of("status", "sync", "start", "stop", "check").contains(action)) throw new IllegalArgumentException("未知操作");
        // Validate everything before changing any live state.
        List<Map<String,Object>> suppliedTasks = input.containsKey("tasks") ? normalizeTasks(input.get("tasks")) : null;
        Map<String,Object> suppliedSettings = input.containsKey("notificationSettings") ? normalizeSettings(input.get("notificationSettings")) : null;
        synchronized (lock) {
            if (closed) throw new IllegalArgumentException("后台已停止");
            if (action.equals("status")) return snapshot();
            if (action.equals("check")) { if (!tasks.isEmpty() && !checking && retryAt <= clock.getAsLong()) { manualRun = !monitoring; schedule(0); } return snapshot(); }
            if (action.equals("start") && (suppliedTasks == null ? tasks : suppliedTasks).isEmpty())
                throw new IllegalArgumentException("请先添加至少一个监控任务");
            if (action.equals("stop")) {
                invalidate(); monitoring = false; clearDeliveries(); addLog("监控已暂停"); persistCommand(); return snapshot();
            }
            boolean changed = suppliedTasks != null && !Json.stringify(tasks).equals(Json.stringify(suppliedTasks)) ||
                suppliedSettings != null && !Json.stringify(settings).equals(Json.stringify(suppliedSettings));
            boolean notificationChanged = suppliedSettings != null && !notificationKey(settings).equals(notificationKey(suppliedSettings));
            if (changed || action.equals("start")) invalidate();
            if (suppliedTasks != null) { tasks = suppliedTasks; reconcileItems(); }
            if (suppliedSettings != null) {
                if (retryAt > clock.getAsLong() && !settings.get("intervalSeconds").equals(suppliedSettings.get("intervalSeconds")))
                    retryAt = Math.max(retryAt, saturatedAdd(clock.getAsLong(), ((Number) suppliedSettings.get("intervalSeconds")).longValue() * 1000));
                settings = suppliedSettings;
            }
            // Stop/start, task replacement and configuration edits retain an endpoint cooldown.
            // Only a successful inventory round resets its consecutive-failure history.
            if (notificationChanged) clearDeliveries();
            if (action.equals("start")) { monitoring = true; addLog("Java 后台监控已启动"); }
            if (tasks.isEmpty()) monitoring = false;
            persistCommand();
            if (monitoring && (changed || action.equals("start"))) schedule(0);
            return snapshot();
        }
    }
    void invalidate() {
        generation++; checking = false; manualRun = false;
        if (scheduled != null) scheduled.cancel(false);
        for (CompletableFuture<?> request : requests) request.cancel(true);
        requests.clear();
    }
    void schedule(long delayMillis) {
        if (closed || (!monitoring && !manualRun) || tasks.isEmpty()) return;
        if (scheduled != null) scheduled.cancel(false);
        long expected = generation;
        scheduled = worker.schedule(() -> check(expected), Math.max(delayMillis, Math.max(0, retryAt - clock.getAsLong())), TimeUnit.MILLISECONDS);
    }
    void check(long expected) {
        List<Map<String,Object>> active;
        synchronized (lock) {
            if (!active(expected) || checking) return;
            if (retryAt > clock.getAsLong()) { schedule(0); return; }
            checking = true; active = new ArrayList<>(tasks);
        }
        try {
            boolean allSuccessful = true;
            boolean coolingDown = false;
            Map<String,List<Map<String,Object>>> groups = new LinkedHashMap<>();
            for (Map<String,Object> task : active) {
                String group = task.get("areaCode") + ":" + object(task.get("store"), "门店").get("StoreNumber");
                groups.computeIfAbsent(group, key -> new ArrayList<>()).add(task);
            }
            for (List<Map<String,Object>> group : groups.values()) {
                if (coolingDown) break;
                Reply reply = null; Object payload = null; String error = null;
                try {
                    // Only requested stores get observations; later stores retain their prior state during cooldown.
                    reply = request(expected, fulfillmentURI(group), "GET", "");
                    if (reply.status() == 503 || reply.status() == 429) {
                        synchronized (lock) {
                            if (!active(expected)) return;
                            consecutiveFailures = Math.min(4, consecutiveFailures + 1);
                            long now = clock.getAsLong();
                            retryAt = Math.max(saturatedAdd(now, retryDelayMillis(consecutiveFailures,
                                ((Number) settings.get("intervalSeconds")).intValue())), retryAfterAt(reply.retryAfter(), now));
                        }
                        coolingDown = true;
                    }
                    if (reply.status() != 403 && reply.status() != 541) {
                        if (reply.status() != 200) error = "Apple 库存接口返回 HTTP " + reply.status();
                        else { try { payload = Json.parse(reply.body()); } catch (IllegalArgumentException e) { error = "Apple 库存接口未返回有效 JSON"; } }
                    }
                } catch (CancellationException e) { return; }
                catch (Exception e) { error = "Apple 库存网络连接失败或超时"; }
                if (payload == null) allSuccessful = false;
                for (Map<String,Object> task : group) {
                    synchronized (lock) {
                        if (!active(expected)) return;
                        Map<String,Object> previous = optionalObject(items.get(task.get("id")));
                        Stock stock = payload == null ? new Stock(false, false, "") : parseStock(payload, store(task), sku(task));
                        String status, detail;
                        if (error != null) { status = "查询异常"; detail = error + (coolingDown ? "；库存未知，等待重试" : ""); }
                        else if (reply != null && (reply.status() == 403 || reply.status() == 541)) {
                            status = "需官网验证"; detail = "请打开 Apple 官网手动完成验证；若后台仍被限制，请暂停并使用官网查询";
                        } else if (!stock.known()) {
                            status = stock.display().equals("ineligible") ? "暂不可自提" : "查询异常";
                            detail = stock.display().equals("ineligible") ? "Apple 官网暂未开放该商品的门店取货" : "响应中没有该门店或 SKU 的明确库存状态";
                        } else { status = stock.available() ? "有货" : "无货"; detail = stock.display(); }
                        Map<String,Object> item = itemState(task, previous, status, detail, stock.known() ? stock.available() : null);
                        if (monitoring && stock.known()) item.put("lastMonitoredAvailable", stock.available());
                        if (!status.equals(previous.get("status")) || !detail.equals(previous.get("detail")))
                            addLog(label(task) + "：" + status + (stock.known() ? "" : " · " + detail));
                        if (stock.known() && !stock.available()) item.remove("notificationDelivery");
                        if (monitoring && stock.known() && stock.available() && !Boolean.TRUE.equals(monitoredAvailability(previous))) {
                            if (!Boolean.FALSE.equals(settings.get("soundAlert"))) playAlertSound();
                            Map<String,Object> channels = new LinkedHashMap<>();
                            if (!settings.get("barkUrl").equals("")) channels.put("Bark", deliveryChannel());
                            if (!settings.get("feishuWebhook").equals("")) channels.put("飞书 / Lark", deliveryChannel());
                            if (!channels.isEmpty()) item.put("notificationDelivery", map("eventId", UUID.randomUUID().toString(), "channels", channels));
                        }
                        items.put((String) task.get("id"), item); persist();
                    }
                    if (payload != null) deliver(expected, task);
                }
            }
            synchronized (lock) {
                if (active(expected) && allSuccessful) { consecutiveFailures = 0; retryAt = 0; }
            }
        } catch (Exception e) {
            synchronized (lock) { if (active(expected)) { addLog("后台状态保存失败，监控已暂停"); monitoring = false; } }
        } finally {
            synchronized (lock) {
                if (expected == generation) {
                    checking = false; manualRun = false; lastCheck = Instant.now().toString();
                    try { persist(); } catch (IOException e) { monitoring = false; addLog("状态保存失败，监控已暂停"); }
                    if (monitoring) schedule(((Number) settings.get("intervalSeconds")).longValue() * 1000);
                }
            }
        }
    }
    static long retryDelayMillis(int failures, int intervalSeconds) {
        return Math.max(intervalSeconds * 1000L, switch (failures) { case 1 -> 60_000L; case 2 -> 120_000L; case 3 -> 240_000L; default -> 300_000L; });
    }
    static long saturatedAdd(long now, long delay) { return delay > Long.MAX_VALUE - now ? Long.MAX_VALUE : now + delay; }
    static long retryAfterAt(String value, long now) {
        if (value == null || value.isBlank()) return 0;
        String header = value.trim();
        if (header.matches("[0-9]+")) {
            long seconds;
            try { seconds = Long.parseLong(header); } catch (NumberFormatException overflow) { return 0; }
            // Ignore values outside the ISO timestamp range supported by the extension's Date.
            // They must not wrap into a short delay or hide a live cooldown from the UI.
            if (seconds > (8_640_000_000_000_000L - now) / 1000) return 0;
            return now + seconds * 1000;
        }
        try { return Math.max(now, ZonedDateTime.parse(header, DateTimeFormatter.RFC_1123_DATE_TIME).toInstant().toEpochMilli()); }
        catch (DateTimeException | ArithmeticException invalid) { return 0; }
    }
    static Map<String,Object> deliveryChannel() { return map("attempts", 0, "nextRetryAt", 0, "succeeded", false); }
    void deliver(long expected, Map<String,Object> task) throws IOException {
        for (String channel : List.of("Bark", "飞书 / Lark")) {
            Map<String,Object> delivery, config; String eventId;
            synchronized (lock) {
                if (!active(expected) || !monitoring) return;
                Map<String,Object> item = optionalObject(items.get(task.get("id")));
                if (!Boolean.TRUE.equals(item.get("available"))) return;
                Map<String,Object> event = optionalObject(item.get("notificationDelivery"));
                delivery = optionalObject(optionalObject(event.get("channels")).get(channel));
                if (delivery.isEmpty() || Boolean.TRUE.equals(delivery.get("succeeded")) || number(delivery.get("attempts")) >= 4 ||
                    number(delivery.get("nextRetryAt")) > System.currentTimeMillis()) continue;
                delivery.put("attempts", number(delivery.get("attempts")) + 1);
                delivery.put("nextRetryAt", System.currentTimeMillis() + 60_000);
                eventId = (String) event.get("eventId"); config = new LinkedHashMap<>(settings); persist();
            }
            String failure = null;
            try {
                Map<String,Object> product = object(task.get("product"), "产品");
                String title = object(task.get("store"), "门店").get("CityStoreName") + " 有货";
                String message = product.get("Model") + " " + product.get("Capacity") + " " + product.get("Color");
                URI uri; String method, body;
                if (channel.equals("Bark")) {
                    uri = barkURI((String) config.get("barkUrl"), title, message, purchaseURL(task)); method = "GET"; body = "";
                } else {
                    Map<String,Object> payload = map("msg_type", "text", "content", map("text", title + "\n" + message + "\n" + purchaseURL(task)));
                    String secret = (String) config.get("feishuSecret");
                    if (!secret.isEmpty()) {
                        String timestamp = Long.toString(Instant.now().getEpochSecond());
                        payload.put("timestamp", timestamp); payload.put("sign", signature(secret, timestamp));
                    }
                    uri = URI.create((String) config.get("feishuWebhook")); method = "POST"; body = Json.stringify(payload);
                }
                Reply reply = request(expected, uri, method, body);
                validateNotificationReply(channel, reply);
            } catch (CancellationException e) { return; }
            catch (Exception e) { failure = "服务未确认成功（网络、HTTP 或业务状态异常）"; }
            synchronized (lock) {
                if (!active(expected)) return;
                Map<String,Object> event = optionalObject(optionalObject(items.get(task.get("id"))).get("notificationDelivery"));
                if (!eventId.equals(event.get("eventId"))) return;
                if (failure == null) { delivery.put("succeeded", true); addLog(channel + " 已提醒：" + label(task)); }
                else {
                    addLog(channel + " 推送失败：" + failure);
                    if (number(delivery.get("attempts")) >= 4) addLog(channel + " 重试已达 3 次，下次真实补货后重新提醒");
                }
                persist();
            }
        }
    }
    Reply request(long expected, URI uri, String method, String body) throws Exception {
        CompletableFuture<Reply> future;
        synchronized (lock) {
            if (!active(expected)) throw new CancellationException();
            // Dispatch and pause share the same lock: nothing can begin after stop returns.
            future = network.send(uri, method, body); requests.add(future);
        }
        try { return future.get(11, TimeUnit.SECONDS); }
        finally { synchronized (lock) { requests.remove(future); if (!future.isDone()) future.cancel(true); } }
    }
    boolean active(long expected) { return !closed && (monitoring || manualRun) && expected == generation; }
    static String notificationKey(Map<String,Object> config) {
        return Json.stringify(List.of(config.get("barkUrl"), config.get("feishuWebhook"), config.get("feishuSecret")));
    }
    void clearDeliveries() { for (Object value : items.values()) optionalObject(value).remove("notificationDelivery"); }
    void reconcileItems() {
        Map<String,Object> retained = new LinkedHashMap<>();
        for (Map<String,Object> task : tasks) {
            Map<String,Object> previous = optionalObject(items.get(task.get("id")));
            retained.put((String) task.get("id"), identity(task).equals(previous.get("identity")) ? previous :
                map("identity", identity(task), "status", "等待", "detail", "", "available", null));
        }
        items = retained;
    }
    static Map<String,Object> itemState(Map<String,Object> task, Map<String,Object> previous, String status, String detail, Boolean available) {
        Map<String,Object> item = new LinkedHashMap<>(previous);
        item.put("identity", identity(task)); item.put("status", status); item.put("detail", detail);
        item.put("available", available); item.put("checkedAt", Instant.now().toString());
        // A paused one-shot can update the UI without consuming the first monitoring notification.
        item.put("lastMonitoredAvailable", monitoredAvailability(previous));
        if (available != null) { item.put("lastKnownAvailable", available); item.put("lastKnownAt", item.get("checkedAt")); }
        else if (previous.get("available") instanceof Boolean) item.put("lastKnownAvailable", previous.get("available"));
        return item;
    }
    static Boolean known(Map<String,Object> item) {
        Object value = item.get("available") instanceof Boolean ? item.get("available") : item.get("lastKnownAvailable");
        return value instanceof Boolean b ? b : null;
    }
    static Boolean monitoredAvailability(Map<String,Object> item) {
        if (item.containsKey("lastMonitoredAvailable")) return item.get("lastMonitoredAvailable") instanceof Boolean value ? value : null;
        return known(item);
    }
    void addLog(String message) {
        if (!log.isEmpty() && message.equals(optionalObject(log.getLast()).get("message"))) return;
        log.add(map("time", TIME.format(Instant.now()), "message", message));
        if (log.size() > 120) log.removeFirst();
    }
    Map<String,Object> snapshot() {
        return object(Json.parse(Json.stringify(map("ok", true, "monitoring", monitoring, "tasks", tasks,
            "notificationSettings", settings, "monitorState", map("running", monitoring, "checking", checking,
                "lastCheck", lastCheck, "retryAt", retryAt > clock.getAsLong() ? Instant.ofEpochMilli(retryAt).toString() : "",
                "consecutiveFailures", consecutiveFailures, "items", items, "log", log)))), "状态");
    }
    void persist() throws IOException {
        Path temporary;
        try {
            temporary = Files.createTempFile(stateFile.getParent(), ".state-", ".json",
                PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
        } catch (UnsupportedOperationException ignored) {
            temporary = Files.createTempFile(stateFile.getParent(), ".state-", ".json");
        }
        try {
            Files.writeString(temporary, Json.stringify(snapshot()), StandardCharsets.UTF_8);
            Files.move(temporary, stateFile, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } finally { Files.deleteIfExists(temporary); }
    }
    void persistCommand() throws IOException {
        try { persist(); }
        catch (IOException error) {
            // Fail closed after a disk error: never report running when no future check exists.
            invalidate(); monitoring = false; clearDeliveries();
            addLog("配置保存失败，后台已暂停；请检查状态目录权限或磁盘空间后重新启动监控");
            throw error;
        }
    }
    void load() throws IOException {
        if (!Files.exists(stateFile)) return;
        try {
            if (Files.size(stateFile) > 4L * MAX_BODY) throw new IllegalArgumentException("状态过大");
            Map<String,Object> state = object(Json.parse(Files.readString(stateFile)), "状态");
            tasks = normalizeTasks(state.getOrDefault("tasks", List.of()));
            settings = normalizeSettings(state.getOrDefault("notificationSettings", Map.of()));
            Map<String,Object> monitor = optionalObject(state.get("monitorState"));
            items = optionalObject(monitor.get("items"));
            if (monitor.get("log") instanceof List<?> entries) log = new ArrayList<>(entries.subList(Math.max(0, entries.size() - 120), entries.size()));
            lastCheck = monitor.get("lastCheck") instanceof String time ? time : "";
            consecutiveFailures = (int) Math.max(0, Math.min(4, number(monitor.get("consecutiveFailures"))));
            try { retryAt = Instant.parse(monitor.get("retryAt") instanceof String time ? time : "").toEpochMilli(); }
            catch (DateTimeException | ArithmeticException invalid) { retryAt = 0; }
            reconcileItems(); monitoring = Boolean.TRUE.equals(state.get("monitoring")) && !tasks.isEmpty();
            if (monitoring) addLog("Java 后台已恢复监控");
        } catch (IllegalArgumentException error) {
            tasks = new ArrayList<>(); settings = normalizeSettings(Map.of()); items = new LinkedHashMap<>(); log = new ArrayList<>();
            monitoring = false; addLog("保存的配置无法读取，后台保持暂停；请重新同步任务");
        }
    }
    @Override public void close() {
        synchronized (lock) { closed = true; invalidate(); }
        if (server != null) server.stop(0);
        if (httpExecutor != null) httpExecutor.shutdownNow();
        worker.shutdownNow();
    }

    static List<Map<String,Object>> normalizeTasks(Object input) {
        if (!(input instanceof List<?> list) || list.size() > 100) throw new IllegalArgumentException("任务必须为数组，最多 100 项");
        List<Map<String,Object>> result = new ArrayList<>(); Set<String> ids = new HashSet<>(); Set<String> identities = new HashSet<>();
        for (Object raw : list) {
            Map<String,Object> task = object(raw, "任务"), product = object(task.get("product"), "产品"), store = object(task.get("store"), "门店");
            String id = text(task.get("id"), "任务 ID", 150, true), area = text(task.get("areaCode"), "地区", 2, true);
            if (!AREAS.contains(area)) throw new IllegalArgumentException("不支持的地区");
            String storeId = text(store.get("StoreNumber"), "门店编号", 20, true), code = text(product.get("Code"), "产品 SKU", 60, true);
            if (!id.matches("[A-Za-z0-9_:.-]+") || !storeId.matches("R[0-9]{1,8}") || !code.matches("[A-Za-z0-9][A-Za-z0-9/-]{1,59}"))
                throw new IllegalArgumentException("任务 ID、门店编号或 SKU 无效");
            Map<String,Object> cleanProduct = map("Code", code, "Type", text(product.get("Type"), "产品类型", 60, false),
                "Model", text(product.get("Model"), "产品名称", 200, false), "Capacity", text(product.get("Capacity"), "容量", 60, false),
                "Color", text(product.get("Color"), "颜色", 100, false));
            if (product.containsKey("PurchasePath")) cleanProduct.put("PurchasePath", text(product.get("PurchasePath"), "购买路径", 300, false));
            Map<String,Object> clean = map("id", id, "areaCode", area, "areaTitle", text(task.get("areaTitle"), "地区名称", 50, false),
                "store", map("StoreNumber", storeId, "CityStoreName", text(store.get("CityStoreName"), "门店名称", 200, false),
                    "District", text(store.get("District"), "邮编", 30, false)), "product", cleanProduct);
            if (!ids.add(id) || !identities.add(identity(clean))) throw new IllegalArgumentException("监控任务不能重复");
            purchaseURL(clean); result.add(clean);
        }
        return result;
    }
    static void playAlertSound() {
        try {
            String os = System.getProperty("os.name", "").toLowerCase();
            if (os.contains("mac")) {
                new ProcessBuilder("/usr/bin/afplay", "/System/Library/Sounds/Glass.aiff").start();
            } else if (os.contains("win")) {
                new ProcessBuilder("powershell", "-c", "[console]::beep(1000, 300); [console]::beep(1400, 400)").start();
            }
        } catch (Exception ignored) {}
        try {
            java.awt.Toolkit.getDefaultToolkit().beep();
        } catch (Throwable ignored) {}
    }
    static Map<String,Object> normalizeSettings(Object input) {
        Map<String,Object> raw = object(input, "通知设置");
        String bark = text(raw.get("barkUrl"), "Bark 地址", 4096, false), webhook = text(raw.get("feishuWebhook"), "飞书 Webhook", 4096, false),
            secret = text(raw.get("feishuSecret"), "飞书签名密钥", 4096, false);
        Object intervalRaw = raw.getOrDefault("intervalSeconds", 30);
        int interval;
        try { interval = new java.math.BigDecimal(intervalRaw.toString()).intValueExact(); }
        catch (Exception error) { throw new IllegalArgumentException("检查间隔无效"); }
        if (interval < 1 || interval > 3600) throw new IllegalArgumentException("检查间隔只支持 1 到 3600 秒");
        boolean soundAlert = Boolean.parseBoolean(String.valueOf(raw.getOrDefault("soundAlert", true)));
        if (!bark.isEmpty()) {
            URI uri = safeURI(bark);
            if (!"api.day.app".equals(uri.getHost()) || !uri.getPath().matches("/[^/]+(?:/.*)?")) throw new IllegalArgumentException("Bark 地址必须使用 api.day.app 官方 HTTPS 地址");
        }
        if (!webhook.isEmpty()) {
            URI uri = safeURI(webhook);
            if (!Set.of("open.feishu.cn", "open.larksuite.com").contains(uri.getHost()) || uri.getQuery() != null ||
                !uri.getPath().matches("/open-apis/bot/v2/hook/[A-Za-z0-9_-]+")) throw new IllegalArgumentException("飞书 Webhook 必须使用飞书或 Lark 官方机器人地址");
        } else if (!secret.isEmpty()) throw new IllegalArgumentException("填写飞书签名密钥前请填写 Webhook");
        return map("barkUrl", bark, "feishuWebhook", webhook, "feishuSecret", secret, "intervalSeconds", interval, "soundAlert", soundAlert);
    }
    static URI safeURI(String text) {
        try {
            URI uri = URI.create(text);
            if (!"https".equals(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null || uri.getPort() != -1 || uri.getFragment() != null)
                throw new IllegalArgumentException();
            return uri;
        } catch (IllegalArgumentException error) { throw new IllegalArgumentException("通知地址必须使用有效 HTTPS，且不能含账号、端口或片段"); }
    }
    static URI fulfillmentURI(List<Map<String,Object>> tasks) {
        if (tasks.isEmpty()) throw new IllegalArgumentException("监控任务为空");
        Map<String,Object> first = tasks.getFirst(); String area = (String) first.get("areaCode");
        StringBuilder query = new StringBuilder("pl=true");
        for (int index = 0; index < tasks.size(); index++) {
            Map<String,Object> task = tasks.get(index);
            if (!task.get("areaCode").equals(area) || !store(task).equals(store(first))) throw new IllegalArgumentException("查询只能包含同地区同门店");
            query.append("&mts.").append(index).append("=regular&parts.").append(index).append('=').append(encode(sku(task)));
        }
        String postal = (String) object(first.get("store"), "门店").get("District");
        Map<String,String> patterns = Map.of("cn", "[0-9]{6}", "jp", "[0-9]{3}-[0-9]{4}", "sg", "[0-9]{6}",
            "us", "[0-9]{5}(?:-[0-9]{4})?", "uk", "(?i)[A-Z]{1,2}[0-9][A-Z0-9]? [0-9][A-Z]{2}", "au", "[0-9]{4}");
        boolean validPostal = patterns.containsKey(area) && postal.matches(patterns.get(area));
        if (validPostal) query.append("&location=").append(encode(postal));
        if (area.equals("jp")) query.append("&cppart=UNLOCKED_JP");
        else if (!area.equals("cn") || !validPostal) query.append("&store=").append(encode(store(first)));
        return URI.create(appleBase(area) + "/shop/retail/pickup-message?" + query);
    }
    static String appleBase(String area) {
        if (!AREAS.contains(area)) throw new IllegalArgumentException("不支持的地区");
        return area.equals("cn") ? "https://www.apple.com.cn" : "https://www.apple.com" + (area.equals("us") ? "" : "/" + area);
    }
    static String purchaseURL(Map<String,Object> task) {
        Map<String,Object> product = object(task.get("product"), "产品"); String type = (String) product.get("Type");
        String base = appleBase((String) task.get("areaCode"));
        Map<String,String> watch = Map.of("watchs12", "/shop/buy-watch/apple-watch", "watchse3", "/shop/buy-watch/apple-watch-se", "watchultra4", "/shop/buy-watch/apple-watch-ultra");
        if (watch.containsKey(type)) {
            String defaultPath = watch.get(type), path = (String) product.getOrDefault("PurchasePath", defaultPath);
            if ((!path.equals(defaultPath) && !path.startsWith(defaultPath + "/")) || path.contains("..") || path.contains("?") || path.contains("#"))
                throw new IllegalArgumentException("手表购买路径无效");
            return base + path;
        }
        return base + (type.equals("iphoneduo") ? "/shop/buy-iphone/iphone-duo/" + sku(task).toLowerCase(Locale.ROOT) : "/shop/product/" + sku(task));
    }
    record Stock(boolean known, boolean available, String display) {}
    static Stock parseStock(Object payload, String storeNumber, String productCode) {
        Map<String,Object> body = optionalObject(optionalObject(payload).get("body"));
        Object candidates = body.get("stores");
        if (!(candidates instanceof List<?>)) candidates = optionalObject(optionalObject(body.get("content")).get("pickupMessage")).get("stores");
        Map<String,Object> target = null;
        if (candidates instanceof List<?> stores) for (Object value : stores) {
            Map<String,Object> store = optionalObject(value);
            if (!storeNumber.equals(store.get("storeNumber"))) continue;
            if (target != null) return new Stock(false, false, "");
            target = store;
        }
        if (target != null) {
            Map<String,Object> part = optionalObject(optionalObject(target.get("partsAvailability")).get(productCode));
            Object display = part.get("pickupDisplay");
            if (!(display instanceof String)) display = optionalObject(optionalObject(part.get("messageTypes")).get("regular")).get("pickupDisplay");
            String text = display instanceof String string ? string : "";
            return new Stock(text.equals("available") || text.equals("unavailable"), text.equals("available"), text);
        }
        return new Stock(false, false, "");
    }
    static URI barkURI(String raw, String title, String message, String link) {
        URI uri = URI.create(raw); List<String> query = new ArrayList<>();
        if (uri.getRawQuery() != null) for (String pair : uri.getRawQuery().split("&")) {
            String key = URLDecoder.decode(pair.split("=", 2)[0], StandardCharsets.UTF_8);
            if (!Set.of("title", "body", "url").contains(key)) query.add(pair);
        }
        query.add("title=" + encode(title)); query.add("body=" + encode(message)); query.add("url=" + encode(link));
        return URI.create(raw.split("\\?", 2)[0] + "?" + String.join("&", query));
    }
    static String signature(String secret, String timestamp) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec((timestamp + "\n" + secret).getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        return Base64.getEncoder().encodeToString(mac.doFinal(new byte[0]));
    }
    static void validateNotificationReply(String channel, Reply reply) {
        if (reply.status() < 200 || reply.status() >= 300) throw new IllegalArgumentException("通知 HTTP 状态异常");
        Map<String,Object> payload = object(Json.parse(reply.body()), "通知响应");
        Object raw = payload.getOrDefault("code", payload.get("StatusCode"));
        if (!(raw instanceof Number) || new java.math.BigDecimal(raw.toString()).compareTo(java.math.BigDecimal.valueOf(channel.equals("Bark") ? 200 : 0)) != 0)
            throw new IllegalArgumentException("通知业务状态异常");
    }
    static String store(Map<String,Object> task) { return (String) object(task.get("store"), "门店").get("StoreNumber"); }
    static String sku(Map<String,Object> task) { return (String) object(task.get("product"), "产品").get("Code"); }
    static String identity(Map<String,Object> task) { return task.get("areaCode") + ":" + store(task) + ":" + sku(task); }
    static String label(Map<String,Object> task) { return object(task.get("store"), "门店").get("CityStoreName") + " · " + object(task.get("product"), "产品").get("Model"); }
    static String encode(String value) { return URLEncoder.encode(value, StandardCharsets.UTF_8); }
    static String text(Object value, String label, int limit, boolean required) {
        if (value == null && !required) return "";
        if (!(value instanceof String string) || string.length() > limit || required && string.isBlank() ||
            value instanceof String s && s.chars().anyMatch(c -> c < 32 || c == 127)) throw new IllegalArgumentException(label + "格式无效");
        return ((String) value).trim();
    }
    @SuppressWarnings("unchecked") static Map<String,Object> object(Object value, String label) {
        if (!(value instanceof Map<?,?>)) throw new IllegalArgumentException(label + "必须是对象"); return (Map<String,Object>) value;
    }
    static Map<String,Object> optionalObject(Object value) { return value instanceof Map<?,?> ? object(value, "值") : new LinkedHashMap<>(); }
    static long number(Object value) { return value instanceof Number n ? n.longValue() : 0; }
    static Map<String,Object> map(Object... entries) {
        Map<String,Object> result = new LinkedHashMap<>(); for (int i = 0; i < entries.length; i += 2) result.put((String) entries[i], entries[i + 1]); return result;
    }
    static String safeError(IllegalArgumentException error) {
        // Our validation errors contain labels only. URI/parser exception text is never returned.
        String message = error.getMessage(); return message != null && message.length() <= 160 && !message.contains("://") ? message : "请求参数无效";
    }
}
