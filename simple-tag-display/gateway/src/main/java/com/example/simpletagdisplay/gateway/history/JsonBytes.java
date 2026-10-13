package com.example.simpletagdisplay.gateway.history;

import java.io.IOException;
import java.io.OutputStream;

/**
 * Minimal streaming JSON writer straight into a reused byte buffer.
 *
 * <h2>Why not Gson's {@code JsonWriter}</h2>
 * {@code JsonWriter} over an {@code OutputStreamWriter} allocates for every number: {@code Long.toString} /
 * {@code Double.toString} build a String, and the writer's {@code StreamEncoder} wraps each one in a fresh
 * {@code char[]} + {@code HeapCharBuffer} before encoding it. A 500 k-point response therefore creates about a million
 * short-lived objects; under concurrent load, hundreds of thousands of {@code HeapCharBuffer}s and as many
 * {@code char[]} can be alive at once (hundreds of MB of retained heap at the peak). This writer formats integers
 * digit by digit into its own buffer (no allocation), writes integral doubles the same way, and only falls back to
 * {@code Double.toString} for fractional values (one short-lived String, no encoder objects). Output goes out in
 * {@value #BUFFER}-byte blocks.
 *
 * <h2>Rules</h2>
 * Strict JSON: strings are escaped (quote, backslash, control characters, U+2028/U+2029) and UTF-8 encoded; doubles
 * must be finite (callers apply {@code safeNumber}: non-finite → {@link #nullValue()}). Commas and colons are placed
 * automatically from a small nesting stack. Not thread-safe; one instance per response.
 */
final class JsonBytes {

    static final int BUFFER = 64 * 1024;
    private static final int MAX_DEPTH = 32;
    /** Integral doubles below this magnitude are written as {@code <digits>.0} without allocating. */
    private static final double INTEGRAL_FAST_MAX = 1e15;
    private static final byte[] HEX = "0123456789abcdef".getBytes(java.nio.charset.StandardCharsets.US_ASCII);

    private final OutputStream out;
    private final byte[] buf;
    private int pos;
    private final byte[] digits = new byte[20];
    // Nesting stack: true = the next element is the first of its container.
    private final boolean[] first = new boolean[MAX_DEPTH];
    private int depth;
    private boolean afterName;

    JsonBytes(OutputStream out) {
        this(out, BUFFER);
    }

    JsonBytes(OutputStream out, int bufferSize) {
        this.out = out;
        this.buf = new byte[Math.max(64, bufferSize)];
    }

    // ---- structure ------------------------------------------------------------------------------------------

    JsonBytes beginObject() throws IOException {
        beforeValue();
        push();
        raw((byte) '{');
        return this;
    }

    JsonBytes endObject() throws IOException {
        depth--;
        raw((byte) '}');
        return this;
    }

    JsonBytes beginArray() throws IOException {
        beforeValue();
        push();
        raw((byte) '[');
        return this;
    }

    JsonBytes endArray() throws IOException {
        depth--;
        raw((byte) ']');
        return this;
    }

    JsonBytes name(String name) throws IOException {
        comma();
        string(name);
        raw((byte) ':');
        afterName = true;
        return this;
    }

    // ---- values ---------------------------------------------------------------------------------------------

    JsonBytes value(String s) throws IOException {
        if (s == null) {
            return nullValue();
        }
        beforeValue();
        string(s);
        return this;
    }

    JsonBytes value(boolean b) throws IOException {
        beforeValue();
        ascii(b ? "true" : "false");
        return this;
    }

    JsonBytes value(long n) throws IOException {
        beforeValue();
        longDigits(n);
        return this;
    }

    /** A finite double (callers map non-finite values to {@link #nullValue()}). */
    JsonBytes value(double d) throws IOException {
        if (!Double.isFinite(d)) {
            throw new IllegalArgumentException("non-finite number");
        }
        beforeValue();
        if (d == Math.rint(d) && Math.abs(d) < INTEGRAL_FAST_MAX) {
            if (d == 0d && Double.doubleToRawLongBits(d) != 0L) {
                ascii("-0.0");
            } else {
                longDigits((long) d);
                raw((byte) '.');
                raw((byte) '0');
            }
        } else {
            ascii(Double.toString(d));      // e.g. 21.5, 1.0E15, 3.4E-5: valid JSON numbers
        }
        return this;
    }

    JsonBytes nullValue() throws IOException {
        beforeValue();
        ascii("null");
        return this;
    }

    /** Writes everything buffered to the stream and flushes it (the stream is not closed). */
    void flush() throws IOException {
        drain();
        out.flush();
    }

    // ---- internals ------------------------------------------------------------------------------------------

    private void push() {
        if (depth >= MAX_DEPTH) {
            throw new IllegalStateException("nesting too deep");
        }
        first[depth++] = true;
    }

    private void comma() throws IOException {
        if (depth > 0) {
            if (first[depth - 1]) {
                first[depth - 1] = false;
            } else {
                raw((byte) ',');
            }
        }
    }

    private void beforeValue() throws IOException {
        if (afterName) {
            afterName = false;
        } else {
            comma();
        }
    }

    private void longDigits(long n) throws IOException {
        if (n == Long.MIN_VALUE) {
            ascii("-9223372036854775808");
            return;
        }
        if (n < 0) {
            raw((byte) '-');
            n = -n;
        }
        int i = digits.length;
        do {
            digits[--i] = (byte) ('0' + (int) (n % 10));
            n /= 10;
        } while (n != 0);
        ensure(digits.length - i);
        System.arraycopy(digits, i, buf, pos, digits.length - i);
        pos += digits.length - i;
    }

    /** ASCII-only text (numbers, literals). */
    private void ascii(String s) throws IOException {
        int n = s.length();
        ensure(n);
        for (int i = 0; i < n; i++) {
            buf[pos++] = (byte) s.charAt(i);
        }
    }

    private void string(String s) throws IOException {
        raw((byte) '"');
        int n = s.length();
        for (int i = 0; i < n; i++) {
            char c = s.charAt(i);
            if (c == '"' || c == '\\') {
                raw((byte) '\\');
                raw((byte) c);
            } else if (c < 0x20 || c == 0x2028 || c == 0x2029) {
                switch (c) {
                    case '\n':
                        raw((byte) '\\');
                        raw((byte) 'n');
                        break;
                    case '\r':
                        raw((byte) '\\');
                        raw((byte) 'r');
                        break;
                    case '\t':
                        raw((byte) '\\');
                        raw((byte) 't');
                        break;
                    default:
                        ensure(6);
                        buf[pos++] = '\\';
                        buf[pos++] = 'u';
                        buf[pos++] = HEX[(c >> 12) & 0xF];
                        buf[pos++] = HEX[(c >> 8) & 0xF];
                        buf[pos++] = HEX[(c >> 4) & 0xF];
                        buf[pos++] = HEX[c & 0xF];
                }
            } else if (c < 0x80) {
                raw((byte) c);
            } else if (c < 0x800) {
                ensure(2);
                buf[pos++] = (byte) (0xC0 | (c >> 6));
                buf[pos++] = (byte) (0x80 | (c & 0x3F));
            } else if (Character.isHighSurrogate(c) && i + 1 < n && Character.isLowSurrogate(s.charAt(i + 1))) {
                int cp = Character.toCodePoint(c, s.charAt(++i));
                ensure(4);
                buf[pos++] = (byte) (0xF0 | (cp >> 18));
                buf[pos++] = (byte) (0x80 | ((cp >> 12) & 0x3F));
                buf[pos++] = (byte) (0x80 | ((cp >> 6) & 0x3F));
                buf[pos++] = (byte) (0x80 | (cp & 0x3F));
            } else if (Character.isSurrogate(c)) {
                ensure(3);                  // lone surrogate: U+FFFD (what a UTF-8 encoder substitutes)
                buf[pos++] = (byte) 0xEF;
                buf[pos++] = (byte) 0xBF;
                buf[pos++] = (byte) 0xBD;
            } else {
                ensure(3);
                buf[pos++] = (byte) (0xE0 | (c >> 12));
                buf[pos++] = (byte) (0x80 | ((c >> 6) & 0x3F));
                buf[pos++] = (byte) (0x80 | (c & 0x3F));
            }
        }
        raw((byte) '"');
    }

    private void raw(byte b) throws IOException {
        if (pos == buf.length) {
            drain();
        }
        buf[pos++] = b;
    }

    private void ensure(int n) throws IOException {
        if (pos + n > buf.length) {
            drain();
        }
    }

    private void drain() throws IOException {
        if (pos > 0) {
            out.write(buf, 0, pos);
            pos = 0;
        }
    }
}
