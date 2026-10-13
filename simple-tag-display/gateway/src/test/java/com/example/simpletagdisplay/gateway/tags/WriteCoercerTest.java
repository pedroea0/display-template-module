package com.example.simpletagdisplay.gateway.tags;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.example.simpletagdisplay.common.protocol.ErrorCode;
import com.inductiveautomation.ignition.common.gson.JsonElement;
import com.inductiveautomation.ignition.common.gson.JsonNull;
import com.inductiveautomation.ignition.common.gson.JsonParser;
import com.inductiveautomation.ignition.common.gson.JsonPrimitive;
import com.inductiveautomation.ignition.common.sqltags.model.types.DataType;
import org.junit.jupiter.api.Test;

/** JSON → tag value by DataType. */
class WriteCoercerTest {

    private static JsonElement j(String json) {
        return JsonParser.parseString(json);
    }

    private static Object ok(String json, DataType t) {
        WriteCoercer.Result r = WriteCoercer.coerce(j(json), t, 255);
        assertTrue(r.ok(), json + " as " + t + " -> " + r.error());
        return r.value();
    }

    private static void bad(String json, DataType t, ErrorCode expected) {
        WriteCoercer.Result r = WriteCoercer.coerce(j(json), t, 255);
        assertFalse(r.ok(), json + " as " + t + " should fail");
        assertEquals(expected, r.error(), json + " as " + t);
    }

    @Test
    void integersAreExactAndRangeChecked() {
        assertEquals((byte) 127, ok("127", DataType.Int1));
        bad("128", DataType.Int1, ErrorCode.INVALID_VALUE);
        assertEquals((short) -32768, ok("-32768", DataType.Int2));
        bad("32768", DataType.Int2, ErrorCode.INVALID_VALUE);
        assertEquals(2147483647, ok("2147483647", DataType.Int4));
        bad("2147483648", DataType.Int4, ErrorCode.INVALID_VALUE);
        assertEquals(9007199254740993L, ok("9007199254740993", DataType.Int8), "no double rounding");
        assertEquals(9223372036854775807L, ok("\"9223372036854775807\"", DataType.Int8));
        bad("\"9223372036854775808\"", DataType.Int8, ErrorCode.INVALID_VALUE);
        assertEquals(5, ok("5.0", DataType.Int4), "integral value with a zero fraction");
        assertEquals(-3, ok("\"-3\"", DataType.Int4));
        assertEquals(7, ok("\"+7\"", DataType.Int4));
    }

    @Test
    void integerRejections() {
        bad("1.5", DataType.Int4, ErrorCode.INVALID_VALUE);
        bad("\"1.5\"", DataType.Int4, ErrorCode.INVALID_VALUE);
        bad("\"0x10\"", DataType.Int4, ErrorCode.INVALID_VALUE);
        bad("\"1e3\"", DataType.Int4, ErrorCode.INVALID_VALUE);
        bad("\"\"", DataType.Int4, ErrorCode.INVALID_VALUE);
        bad("\" \"", DataType.Int4, ErrorCode.INVALID_VALUE);
        bad("true", DataType.Int4, ErrorCode.INVALID_VALUE);
        bad("\"12abc\"", DataType.Int4, ErrorCode.INVALID_VALUE);
    }

    @Test
    void floats() {
        assertEquals(72.5, ok("72.5", DataType.Float8));
        assertEquals(72.5, ok("\"72.5\"", DataType.Float8));
        assertEquals(-0.5, ok("\"-.5\"", DataType.Float8));
        assertEquals(1500.0, ok("\"1.5e3\"", DataType.Float8));
        assertEquals(0.25f, ok("0.25", DataType.Float4));
        for (String s : new String[] {"\"NaN\"", "\"Infinity\"", "\"0x1p3\"", "\"1d\"", "\"1,5\"", "\"1e400\"", "\"abc\"", "\"\""}) {
            bad(s, DataType.Float8, ErrorCode.INVALID_VALUE);
        }
        bad("1e300", DataType.Float4, ErrorCode.INVALID_VALUE);
        WriteCoercer.Result nan = WriteCoercer.coerce(new JsonPrimitive(Double.NaN), DataType.Float8, 255);
        assertEquals(ErrorCode.INVALID_VALUE, nan.error());
    }

    @Test
    void booleans() {
        assertEquals(true, ok("true", DataType.Boolean));
        assertEquals(false, ok("\"FALSE\"", DataType.Boolean));
        assertEquals(true, ok("1", DataType.Boolean));
        assertEquals(false, ok("\"0\"", DataType.Boolean));
        bad("2", DataType.Boolean, ErrorCode.INVALID_VALUE);
        bad("\"yes\"", DataType.Boolean, ErrorCode.INVALID_VALUE);
        bad("0.5", DataType.Boolean, ErrorCode.INVALID_VALUE);
    }

    @Test
    void strings() {
        assertEquals("Pump 101", ok("\"Pump 101\"", DataType.String));
        assertEquals("42", ok("42", DataType.String));
        assertEquals("true", ok("true", DataType.Text));
        WriteCoercer.Result tooLong = WriteCoercer.coerce(new JsonPrimitive("123456789"), DataType.String, 8);
        assertEquals(ErrorCode.INVALID_VALUE, tooLong.error());
        assertTrue(WriteCoercer.coerce(new JsonPrimitive("12345678"), DataType.String, 8).ok());
    }

    @Test
    void unsupportedTypesAndShapes() {
        for (DataType t : new DataType[] {DataType.DateTime, DataType.DataSet, DataType.Document, DataType.Float8Array,
                DataType.StringArray, DataType.ByteArray}) {
            bad("1", t, ErrorCode.UNSUPPORTED_TYPE);
        }
        assertEquals(ErrorCode.UNSUPPORTED_TYPE, WriteCoercer.coerce(j("1"), null, 255).error());
        bad("[1]", DataType.Float8, ErrorCode.INVALID_VALUE);
        bad("{\"v\":1}", DataType.Float8, ErrorCode.INVALID_VALUE);
        assertEquals(ErrorCode.INVALID_VALUE, WriteCoercer.coerce(JsonNull.INSTANCE, DataType.Float8, 255).error());
        assertEquals(ErrorCode.INVALID_VALUE, WriteCoercer.coerce(null, DataType.Float8, 255).error());
    }

    @Test
    void sameValueAcrossNumberTypes() {
        assertTrue(WriteCoercer.sameValue(1, 1.0));
        assertTrue(WriteCoercer.sameValue((short) 3, 3L));
        assertFalse(WriteCoercer.sameValue(1, 1.5));
        assertTrue(WriteCoercer.sameValue("a", "a"));
        assertFalse(WriteCoercer.sameValue(true, 1));
        assertTrue(WriteCoercer.sameValue(null, null));
        assertFalse(WriteCoercer.sameValue(null, 0));
    }

    @Test
    void typeClassification() {
        assertTrue(WriteCoercer.isWritableType(DataType.Int2));
        assertTrue(WriteCoercer.isWritableType(DataType.Text));
        assertFalse(WriteCoercer.isWritableType(DataType.Int4Array));
        assertTrue(WriteCoercer.isNumeric(DataType.Float4));
        assertFalse(WriteCoercer.isNumeric(DataType.Boolean));
        assertTrue(WriteCoercer.isIntegral(DataType.Int8));
        assertFalse(WriteCoercer.isIntegral(DataType.Float8));
    }
}
