import java.math.BigDecimal;
import java.util.*;

/** Small strict JSON codec; no reflection, polymorphic types, or external dependencies. */
final class Json {
    static Object parse(String text) {
        Parser parser = new Parser(text);
        Object value = parser.value(0);
        parser.white();
        if (parser.pos != text.length()) throw new IllegalArgumentException("JSON 尾部内容无效");
        return value;
    }
    static String stringify(Object value) {
        StringBuilder result = new StringBuilder();
        write(result, value, 0);
        return result.toString();
    }
    private static void write(StringBuilder out, Object value, int depth) {
        if (depth > 64) throw new IllegalArgumentException("JSON 嵌套过深");
        if (value == null) { out.append("null"); return; }
        if (value instanceof String string) {
            out.append('"');
            for (int i = 0; i < string.length(); i++) {
                char c = string.charAt(i);
                switch (c) {
                    case '"' -> out.append("\\\""); case '\\' -> out.append("\\\\");
                    case '\n' -> out.append("\\n"); case '\r' -> out.append("\\r");
                    case '\t' -> out.append("\\t"); case '\b' -> out.append("\\b");
                    case '\f' -> out.append("\\f");
                    default -> {
                        if (c < 32 || Character.isSurrogate(c)) out.append(String.format("\\u%04x", (int)c));
                        else out.append(c);
                    }
                }
            }
            out.append('"'); return;
        }
        if (value instanceof Boolean) { out.append(value); return; }
        if (value instanceof Number number) {
            if (number instanceof Double d && !Double.isFinite(d) || number instanceof Float f && !Float.isFinite(f))
                throw new IllegalArgumentException("JSON 数字无效");
            out.append(number); return;
        }
        if (value instanceof Map<?, ?> map) {
            out.append('{'); boolean first = true;
            for (var entry : map.entrySet()) {
                if (!(entry.getKey() instanceof String)) throw new IllegalArgumentException("JSON 键必须为字符串");
                if (!first) out.append(','); first = false;
                write(out, entry.getKey(), depth + 1); out.append(':'); write(out, entry.getValue(), depth + 1);
            }
            out.append('}'); return;
        }
        if (value instanceof Iterable<?> list) {
            out.append('['); boolean first = true;
            for (Object item : list) { if (!first) out.append(','); first = false; write(out, item, depth + 1); }
            out.append(']'); return;
        }
        throw new IllegalArgumentException("JSON 类型不支持");
    }
    private static final class Parser {
        final String text; int pos;
        Parser(String text) { this.text = Objects.requireNonNull(text); }
        void white() { while (pos < text.length() && " \n\r\t".indexOf(text.charAt(pos)) >= 0) pos++; }
        IllegalArgumentException invalid() { return new IllegalArgumentException("JSON 格式无效"); }
        Object value(int depth) {
            if (depth > 64) throw new IllegalArgumentException("JSON 嵌套过深");
            white(); if (pos >= text.length()) throw invalid();
            char c = text.charAt(pos);
            if (c == '"') return string();
            if (c == '{') {
                pos++; Map<String,Object> result = new LinkedHashMap<>(); white();
                if (take('}')) return result;
                do {
                    white(); if (pos >= text.length() || text.charAt(pos) != '"') throw invalid();
                    String key = string(); white(); if (!take(':')) throw invalid();
                    if (result.containsKey(key)) throw invalid();
                    result.put(key, value(depth + 1)); white();
                    if (take('}')) return result;
                } while (take(','));
                throw invalid();
            }
            if (c == '[') {
                pos++; List<Object> result = new ArrayList<>(); white();
                if (take(']')) return result;
                do { result.add(value(depth + 1)); white(); if (take(']')) return result; } while (take(','));
                throw invalid();
            }
            for (String literal : List.of("true", "false", "null")) {
                if (text.startsWith(literal, pos)) {
                    pos += literal.length(); return literal.equals("null") ? null : literal.equals("true");
                }
            }
            int start = pos; take('-');
            if (!take('0')) { if (!digit19()) throw invalid(); while (digit()) pos++; }
            if (take('.')) { if (!digit()) throw invalid(); while (digit()) pos++; }
            if (take('e') || take('E')) { if (!take('+')) take('-'); if (!digit()) throw invalid(); while (digit()) pos++; }
            try { return new BigDecimal(text.substring(start, pos)); } catch (NumberFormatException e) { throw invalid(); }
        }
        boolean digit() { return pos < text.length() && text.charAt(pos) >= '0' && text.charAt(pos) <= '9'; }
        boolean digit19() { if (pos < text.length() && text.charAt(pos) >= '1' && text.charAt(pos) <= '9') { pos++; return true; } return false; }
        boolean take(char c) { if (pos < text.length() && text.charAt(pos) == c) { pos++; return true; } return false; }
        String string() {
            if (!take('"')) throw invalid(); StringBuilder result = new StringBuilder();
            while (pos < text.length()) {
                char c = text.charAt(pos++);
                if (c == '"') return result.toString();
                if (c < 32) throw invalid();
                if (c != '\\') { result.append(c); continue; }
                if (pos >= text.length()) throw invalid();
                char escape = text.charAt(pos++);
                switch (escape) {
                    case '"', '\\', '/' -> result.append(escape);
                    case 'n' -> result.append('\n'); case 'r' -> result.append('\r'); case 't' -> result.append('\t');
                    case 'b' -> result.append('\b'); case 'f' -> result.append('\f');
                    case 'u' -> {
                        if (pos + 4 > text.length()) throw invalid();
                        if (!text.substring(pos, pos + 4).matches("[0-9A-Fa-f]{4}")) throw invalid();
                        try { result.append((char) Integer.parseInt(text.substring(pos, pos + 4), 16)); }
                        catch (NumberFormatException e) { throw invalid(); }
                        pos += 4;
                    }
                    default -> throw invalid();
                }
            }
            throw invalid();
        }
    }
}
