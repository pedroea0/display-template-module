package com.example.simpletagdisplay.gateway.tags;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.example.simpletagdisplay.common.protocol.ErrorCode;
import com.inductiveautomation.ignition.common.model.values.QualityCode;
import org.junit.jupiter.api.Test;

/** Path rules v2. */
class TagPathsV2Test {

    private static ErrorCode read(String raw) {
        TagPaths.Parsed p = TagPaths.parse(raw, "default");
        return p.ok() ? null : p.error();
    }

    private static ErrorCode write(String raw) {
        TagPaths.Parsed p = TagPaths.parseForWrite(raw, "default");
        return p.ok() ? null : p.error();
    }

    @Test
    void qualifiedPathsAreRejected() {
        assertEquals(ErrorCode.INVALID_PATH, read("histprov:Core Historian:/prov:default:/tag:CTG/Temp"));
        assertEquals(ErrorCode.INVALID_PATH, read("prov:default:/tag:CTG/Temp"));
        assertEquals(ErrorCode.INVALID_PATH, read("tag:/CTG/Temp"));
    }

    @Test
    void dotSegmentsAreRejected() {
        assertEquals(ErrorCode.INVALID_PATH, read("[default]CTG/../Secret"));
        assertEquals(ErrorCode.INVALID_PATH, read("[default]CTG/./Temp"));
        assertEquals(ErrorCode.INVALID_PATH, read("[default]../CTG/Temp"));
        assertEquals(ErrorCode.INVALID_PATH, read("[default]CTG/ .. /Temp"));
        assertEquals(ErrorCode.INVALID_PATH, read("[.]Temp"));
    }

    @Test
    void controlCharactersAndLengthAreRejected() {
        assertEquals(ErrorCode.INVALID_PATH, read("[default]CTG/Te\u0000mp"));
        assertEquals(ErrorCode.INVALID_PATH, read("[default]CTG/Temp\r\n"  + "x"));
        assertEquals(ErrorCode.INVALID_PATH, read("[default]" + "a".repeat(TagPaths.MAX_LENGTH)));
        assertEquals(null, read("[default]" + "a".repeat(TagPaths.MAX_LENGTH - "[default]".length())));
    }

    @Test
    void onlyTheValuePropertyIsAllowed() {
        assertEquals(null, read("[default]CTG/Temp.Value"));
        assertEquals(null, read("[default]CTG/Temp.value"));
        assertEquals(ErrorCode.INVALID_PATH, read("[default]CTG/Temp.Quality"));
        assertEquals(ErrorCode.INVALID_PATH, read("[default]CTG/Temp.EngHigh"));
    }

    @Test
    void alarmPathsAreRejectedButAFolderNamedAlarmsIsAllowed() {
        assertEquals(ErrorCode.INVALID_PATH, read("[default]CTG/Temp/Alarms.HasActive"));
        assertEquals(ErrorCode.INVALID_PATH, read("[default]CTG/Temp/Alarms/High.SetpointA"));
        assertEquals(ErrorCode.INVALID_PATH, read("[default]CTG/Temp/alarms/High.Mode"));
        assertEquals(null, read("[default]CTG/Alarms/Horn"), "a plain folder named Alarms (decided by .TagType later)");
        assertEquals(null, write("[default]CTG/Alarms/Horn"));
    }

    @Test
    void canonicalFormResolvesTheProviderAndDropsValue() {
        TagPaths.Parsed tilde = TagPaths.parse("[~]CTG/Temp.Value", "default");
        TagPaths.Parsed empty = TagPaths.parse("CTG/Temp", "default");
        TagPaths.Parsed full = TagPaths.parse("[default]ctg/TEMP", "default");
        assertTrue(tilde.ok() && empty.ok() && full.ok());
        assertEquals("[default]CTG/Temp", tilde.path().toStringFull());
        assertEquals("[default]ctg/temp", TagPaths.normalizedKey(tilde.path()));
        assertEquals(TagPaths.normalizedKey(tilde.path()), TagPaths.normalizedKey(empty.path()));
        assertEquals(TagPaths.normalizedKey(tilde.path()), TagPaths.normalizedKey(full.path()));
        assertEquals("default", TagPaths.providerKey(empty.path()));
    }

    @Test
    void writeRulesAddTypesAndArrayElements() {
        assertEquals(null, read("[default]_types_/U/M"), "reading a UDT definition member is a read concern of tag security");
        assertEquals(ErrorCode.INVALID_PATH, write("[default]_types_/U/M"));
        assertEquals(ErrorCode.INVALID_PATH, write("[default]_TYPES_/U/M"));
        assertEquals(ErrorCode.INVALID_PATH, write("[default]CTG/Arr[3]"));
        assertEquals(null, write("[default]CTG/TempSP"));
        assertEquals(null, write("CTG/TempSP"));
    }

    @Test
    void arrayElementReadNeverThrows() {
        // Unverified: whether TagPathParser yields a node for "Tag[3]". Record the behaviour only.
        TagPaths.Parsed p = TagPaths.parse("[default]CTG/Arr[3]", "default");
        assertTrue(p.ok() || p.error() == ErrorCode.INVALID_PATH);
    }

    @Test
    void isUnderComparesWholeSegments() {
        assertTrue(TagPaths.isUnder("[default]ctg/temp", "[default]ctg"));
        assertTrue(TagPaths.isUnder("[default]ctg", "[default]ctg"));
        assertFalse(TagPaths.isUnder("[default]ctgx/temp", "[default]ctg"));
        assertFalse(TagPaths.isUnder("[other]ctg/temp", "[default]ctg"));
    }

    @Test
    void accessDeniedAcceptsBothCodes() {
        assertTrue(TagPaths.isAccessDenied(QualityCode.Bad_AccessDenied));
        assertTrue(TagPaths.isAccessDenied(QualityCode.Bad_Unauthorized));
        assertFalse(TagPaths.isAccessDenied(QualityCode.Good));
        assertFalse(TagPaths.isAccessDenied(QualityCode.Bad_NotFound));
        assertTrue(TagPaths.isNotFound(QualityCode.Bad_NotFound));
    }
}
