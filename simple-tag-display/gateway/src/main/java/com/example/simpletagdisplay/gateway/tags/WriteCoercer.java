package com.example.simpletagdisplay.gateway.tags;

import java.math.BigDecimal;
import java.util.Locale;
import java.util.regex.Pattern;

import com.example.simpletagdisplay.common.protocol.ErrorCode;
import com.inductiveautomation.ignition.common.gson.JsonElement;
import com.inductiveautomation.ignition.common.gson.JsonPrimitive;
import com.inductiveautomation.ignition.common.sqltags.model.types.DataType;

/**
 * JSON value from a {@code dt.write} → the Java value for the tag's {@code DataType}. Pure, never throws.
 *
 * <table>
 *   <caption>coercion table</caption>
 *   <tr><th>DataType</th><th>accepted JSON</th><th>result</th></tr>
 *   <tr><td>Int1/Int2/Int4/Int8</td><td>integral number; string {@code ^[+-]?\d+$}</td>
 *       <td>Byte/Short/Integer/Long after an exact range check of the type width (BigDecimal); 1.5, NaN, out of
 *       range → {@code INVALID_VALUE}</td></tr>
 *   <tr><td>Float4/Float8</td><td>number; string {@code ^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$}</td>
 *       <td>Float/Double, finite (Float4: within float range); rejects {@code NaN}, {@code 0x1p3}, {@code 1d},
 *       {@code 1,5}</td></tr>
 *   <tr><td>Boolean</td><td>boolean; number 0/1; string true/false/1/0 (any case)</td><td>Boolean</td></tr>
 *   <tr><td>String/Text</td><td>string, number or boolean ({@code toString})</td>
 *       <td>String of at most {@code maxStringLength} characters</td></tr>
 *   <tr><td>everything else (DateTime, DataSet, Document, arrays)</td><td>–</td><td>{@code UNSUPPORTED_TYPE}</td></tr>
 * </table>
 * JSON numbers are taken from their exact decimal text ({@link JsonPrimitive#getAsBigDecimal()}), so
 * {@code 9007199254740993} reaches an Int8 tag unrounded; a string is accepted for integers so clients can send
 * values beyond 2^53 without losing digits.
 */
public final class WriteCoercer {

    private static final Pattern INTEGER = Pattern.compile("^[+-]?\\d+$");
    private static final Pattern DECIMAL = Pattern.compile("^[+-]?(\\d+\\.?\\d*|\\.\\d+)([eE][+-]?\\d+)?$");
    /** Longest numeric string considered (anything longer cannot be a valid value of any numeric type). */
    private static final int MAX_NUMBER_CHARS = 400;

    private WriteCoercer() {
    }

    /** Result of a coercion: a value, or an error code. */
    public static final class Result {
        private final Object value;
        private final ErrorCode error;

        private Result(Object value, ErrorCode error) {
            this.value = value;
            this.error = error;
        }

        static Result ok(Object v) {
            return new Result(v, null);
        }

        static Result fail(ErrorCode c) {
            return new Result(null, c);
        }

        public boolean ok() {
            return error == null;
        }

        /** Coerced value (Byte/Short/Integer/Long/Float/Double/Boolean/String). */
        public Object value() {
            return value;
        }

        /** {@code INVALID_VALUE} or {@code UNSUPPORTED_TYPE}; null when ok. */
        public ErrorCode error() {
            return error;
        }
    }

    /** True for the types a setpoint can write (numeric scalars, Boolean, String, Text). */
    public static boolean isWritableType(DataType t) {
        if (t == null || t.isArray()) {
            return false;
        }
        return isNumeric(t) || t == DataType.Boolean || t == DataType.String || t == DataType.Text;
    }

    /** Numeric scalar (Int1..Int8, Float4, Float8). */
    public static boolean isNumeric(DataType t) {
        return t != null && !t.isArray() && t.isNumeric();
    }

    /** Integral numeric scalar (Int1..Int8). */
    public static boolean isIntegral(DataType t) {
        return isNumeric(t) && !t.isFloatingPoint();
    }

    /**
     * Coerces {@code json} to {@code type}.
     *
     * @param maxStringLength String/Text limit ({@code setpoint.maxStringLength}, 1..4096)
     */
    public static Result coerce(JsonElement json, DataType type, int maxStringLength) {
        if (!isWritableType(type)) {
            return Result.fail(ErrorCode.UNSUPPORTED_TYPE);
        }
        if (json == null || json.isJsonNull() || !json.isJsonPrimitive()) {
            return Result.fail(ErrorCode.INVALID_VALUE);
        }
        JsonPrimitive p = json.getAsJsonPrimitive();
        if (type == DataType.Boolean) {
            return bool(p);
        }
        if (type == DataType.String || type == DataType.Text) {
            String s = p.getAsString();
            return s.length() > Math.max(1, maxStringLength) ? Result.fail(ErrorCode.INVALID_VALUE) : Result.ok(s);
        }
        BigDecimal d = decimal(p, type.isFloatingPoint());
        if (d == null) {
            return Result.fail(ErrorCode.INVALID_VALUE);
        }
        return type.isFloatingPoint() ? floating(d, type) : integral(d, type);
    }

    private static Result bool(JsonPrimitive p) {
        if (p.isBoolean()) {
            return Result.ok(p.getAsBoolean());
        }
        String s = p.getAsString().trim().toLowerCase(Locale.ROOT);
        if (p.isNumber()) {
            BigDecimal d = exact(p);
            if (d != null && d.compareTo(BigDecimal.ZERO) == 0) {
                return Result.ok(Boolean.FALSE);
            }
            if (d != null && d.compareTo(BigDecimal.ONE) == 0) {
                return Result.ok(Boolean.TRUE);
            }
            return Result.fail(ErrorCode.INVALID_VALUE);
        }
        switch (s) {
            case "true":
            case "1":
                return Result.ok(Boolean.TRUE);
            case "false":
            case "0":
                return Result.ok(Boolean.FALSE);
            default:
                return Result.fail(ErrorCode.INVALID_VALUE);
        }
    }

    /** Exact decimal of a JSON number or numeric string; null when not a valid number for the type family. */
    private static BigDecimal decimal(JsonPrimitive p, boolean floating) {
        if (p.isBoolean()) {
            return null;
        }
        if (p.isNumber()) {
            return exact(p);
        }
        String s = p.getAsString().trim();
        if (s.isEmpty() || s.length() > MAX_NUMBER_CHARS || !(floating ? DECIMAL : INTEGER).matcher(s).matches()) {
            return null;
        }
        try {
            return new BigDecimal(s);
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static BigDecimal exact(JsonPrimitive p) {
        try {
            String text = p.getAsString();
            if (text.length() > MAX_NUMBER_CHARS) {
                return null;
            }
            return new BigDecimal(text);
        } catch (NumberFormatException e) {
            return null;   // NaN / Infinity tokens
        }
    }

    private static Result integral(BigDecimal d, DataType type) {
        BigDecimal stripped = d.stripTrailingZeros();
        if (stripped.scale() > 0) {
            return Result.fail(ErrorCode.INVALID_VALUE);   // 1.5 for an integer tag
        }
        long min;
        long max;
        switch (type) {
            case Int1:
                min = Byte.MIN_VALUE;
                max = Byte.MAX_VALUE;
                break;
            case Int2:
                min = Short.MIN_VALUE;
                max = Short.MAX_VALUE;
                break;
            case Int4:
                min = Integer.MIN_VALUE;
                max = Integer.MAX_VALUE;
                break;
            default:
                min = Long.MIN_VALUE;
                max = Long.MAX_VALUE;
        }
        if (d.compareTo(BigDecimal.valueOf(min)) < 0 || d.compareTo(BigDecimal.valueOf(max)) > 0) {
            return Result.fail(ErrorCode.INVALID_VALUE);
        }
        long l = d.longValueExact();
        switch (type) {
            case Int1:
                return Result.ok((byte) l);
            case Int2:
                return Result.ok((short) l);
            case Int4:
                return Result.ok((int) l);
            default:
                return Result.ok(l);
        }
    }

    private static Result floating(BigDecimal d, DataType type) {
        double v = d.doubleValue();
        if (!Double.isFinite(v)) {
            return Result.fail(ErrorCode.INVALID_VALUE);
        }
        if (type == DataType.Float4) {
            float f = d.floatValue();
            return Float.isFinite(f) ? Result.ok(f) : Result.fail(ErrorCode.INVALID_VALUE);
        }
        return Result.ok(v);
    }

    /**
     * True when two coerced values are the same setpoint (options matching): numbers compare by value
     * across Java types (1 == 1.0), everything else by {@code equals}.
     */
    public static boolean sameValue(Object a, Object b) {
        if (a == null || b == null) {
            return a == b;
        }
        if (a instanceof Number && b instanceof Number) {
            return new BigDecimal(a.toString()).compareTo(new BigDecimal(b.toString())) == 0;
        }
        return a.equals(b);
    }
}
