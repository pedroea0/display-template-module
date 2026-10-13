package com.example.simpletagdisplay.gateway.history;

import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.Reader;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;

import com.inductiveautomation.ignition.common.gson.JsonArray;
import com.inductiveautomation.ignition.common.gson.JsonElement;
import com.inductiveautomation.ignition.common.gson.JsonNull;
import com.inductiveautomation.ignition.common.gson.JsonObject;
import com.inductiveautomation.ignition.common.gson.JsonPrimitive;
import com.inductiveautomation.ignition.common.gson.stream.JsonReader;
import com.inductiveautomation.ignition.common.gson.stream.JsonToken;

/**
 * Bounded, depth-limited JSON parsing of a request body.
 *
 * <ul>
 *   <li>The body is read through a counting stream that fails at {@code maxBytes + 1} bytes, whatever the client
 *       claimed in {@code Content-Length} (the route also rejects a too-large claim before reading).</li>
 *   <li>Parsing uses the (shaded) Gson streaming {@link JsonReader} in strict mode, into our own small tree builder:
 *       nesting deeper than {@code maxDepth} fails ({@code RequestContext.readBody()} + Gson's recursive tree
 *       parser would follow a 10 000-deep array into a {@link StackOverflowError}); duplicate object keys fail
 *       (no "last one wins" ambiguity between validators and consumers); numbers longer than 64 characters fail;
 *       anything after the top-level value fails.</li>
 *   <li>Numbers become {@link BigDecimal}-backed primitives; callers check ranges and finiteness themselves.</li>
 * </ul>
 * Every failure is a {@link BadJson} (→ 400) or {@link TooLarge} (→ 413); nothing else escapes.
 */
public final class BoundedJson {

    private static final int MAX_NUMBER_CHARS = 64;

    private BoundedJson() {
    }

    /** Malformed JSON, too deep, duplicate key, trailing data, bad number. */
    public static final class BadJson extends Exception {
        private static final long serialVersionUID = 1L;

        BadJson(String message) {
            super(message, null, false, false);
        }
    }

    /** More than {@code maxBytes} bytes. */
    public static final class TooLarge extends Exception {
        private static final long serialVersionUID = 1L;

        TooLarge() {
            super("body too large", null, false, false);
        }
    }

    /**
     * Parses one JSON value from {@code in} (UTF-8).
     *
     * @param maxBytes largest accepted body
     * @param maxDepth largest accepted nesting (the top-level value is depth 1)
     */
    public static JsonElement parse(InputStream in, long maxBytes, int maxDepth) throws BadJson, TooLarge {
        CountingInputStream counting = new CountingInputStream(in, maxBytes);
        try (Reader r = new InputStreamReader(counting, StandardCharsets.UTF_8)) {
            JsonReader reader = new JsonReader(r);
            reader.setLenient(false);
            JsonElement root = read(reader, 1, maxDepth);
            if (reader.peek() != JsonToken.END_DOCUMENT) {
                throw new BadJson("trailing data");
            }
            return root;
        } catch (LimitExceeded e) {
            throw new TooLarge();
        } catch (BadJson e) {
            throw e;
        } catch (IOException | RuntimeException | StackOverflowError e) {
            if (counting.exceeded) {
                throw new TooLarge();
            }
            throw new BadJson("malformed JSON");
        }
    }

    /** Parses a string (tests and small internal uses). */
    public static JsonElement parse(String json, long maxBytes, int maxDepth) throws BadJson, TooLarge {
        return parse(new java.io.ByteArrayInputStream(json.getBytes(StandardCharsets.UTF_8)), maxBytes, maxDepth);
    }

    private static JsonElement read(JsonReader r, int depth, int maxDepth) throws IOException, BadJson {
        if (depth > maxDepth) {
            throw new BadJson("too deep");
        }
        JsonToken t = r.peek();
        switch (t) {
            case BEGIN_OBJECT: {
                JsonObject o = new JsonObject();
                r.beginObject();
                while (r.hasNext()) {
                    String name = r.nextName();
                    if (o.has(name)) {
                        throw new BadJson("duplicate key");
                    }
                    o.add(name, read(r, depth + 1, maxDepth));
                }
                r.endObject();
                return o;
            }
            case BEGIN_ARRAY: {
                JsonArray a = new JsonArray();
                r.beginArray();
                while (r.hasNext()) {
                    a.add(read(r, depth + 1, maxDepth));
                }
                r.endArray();
                return a;
            }
            case STRING:
                return new JsonPrimitive(r.nextString());
            case NUMBER: {
                String s = r.nextString();
                if (s.length() > MAX_NUMBER_CHARS) {
                    throw new BadJson("number too long");
                }
                try {
                    return new JsonPrimitive(new BigDecimal(s));
                } catch (NumberFormatException e) {
                    throw new BadJson("bad number");
                }
            }
            case BOOLEAN:
                return new JsonPrimitive(r.nextBoolean());
            case NULL:
                r.nextNull();
                return JsonNull.INSTANCE;
            default:
                throw new BadJson("unexpected token " + t);
        }
    }

    /** Thrown by the counting stream; unchecked so it passes through the reader unchanged. */
    private static final class LimitExceeded extends RuntimeException {
        private static final long serialVersionUID = 1L;

        LimitExceeded() {
            super(null, null, false, false);
        }
    }

    /** Fails once more than {@code max} bytes were read. */
    static final class CountingInputStream extends FilterInputStream {
        private final long max;
        private long count;
        boolean exceeded;

        CountingInputStream(InputStream in, long max) {
            super(in);
            this.max = max;
        }

        private void add(long n) {
            if (n > 0) {
                count += n;
                if (count > max) {
                    exceeded = true;
                    throw new LimitExceeded();
                }
            }
        }

        @Override
        public int read() throws IOException {
            int b = super.read();
            if (b >= 0) {
                add(1);
            }
            return b;
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            int n = super.read(b, off, (int) Math.min(len, Math.max(1, max - count + 1)));
            add(n);
            return n;
        }

        @Override
        public long skip(long n) throws IOException {
            long s = super.skip(Math.min(n, Math.max(1, max - count + 1)));
            add(s);
            return s;
        }
    }
}
