package com.example.simpletagdisplay.gateway.tags;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.example.simpletagdisplay.common.protocol.ErrorCode;
import com.example.simpletagdisplay.gateway.security.ReadScope;
import org.junit.jupiter.api.Test;

/**
 * A provider name with leading or trailing white space is {@code INVALID_PATH} for every parser. Before,
 * {@code [ System]Gateway/X} parsed with the provider {@code " System"} (past {@code ctg.read.deniedProviders}:
 * {@code notFound}) while the browse/scope folder parser trimmed it to {@code System} ({@code OUT_OF_SCOPE}).
 */
class TagPathsProviderNameTest {

    private static final String[] PADDED = {"[ System]Gateway/SystemName", "[System ]Gateway/SystemName",
        "[ System ]Gateway/Performance/CPU Usage", "[ default]CTG/Temp", "[default ]CTG/Temp", "[\u00A0default]CTG/Temp",
        "[default\u2003]CTG/Temp", "[\tdefault]CTG/Temp", "[ ]CTG/Temp"};

    @Test
    void paddedProviderNamesAreInvalidForReadsWritesAndFolders() {
        for (String raw : PADDED) {
            assertEquals(ErrorCode.INVALID_PATH, TagPaths.parse(raw, "default").error(), raw);
            assertEquals(ErrorCode.INVALID_PATH, TagPaths.parse(raw).error(), raw + " (no default provider)");
            assertEquals(ErrorCode.INVALID_PATH, TagPaths.parseForWrite(raw, "default").error(), raw);
            assertTrue(ReadScope.parseFolder(raw, "default").isEmpty(), "folder parser agrees: " + raw);
            String providerOnly = raw.substring(0, raw.indexOf(']') + 1);
            assertTrue(ReadScope.parseFolder(providerOnly, "default").isEmpty(), "provider root agrees: " + providerOnly);
        }
    }

    @Test
    void normalProviderSpellingsStillParse() {
        assertEquals("[System]Gateway/SystemName", TagPaths.parse("[System]Gateway/SystemName", "default").path().toStringFull());
        assertEquals("[default]CTG/Temp", TagPaths.parse("[~]CTG/Temp", "default").path().toStringFull());
        assertEquals("[default]CTG/Temp", TagPaths.parse("CTG/Temp", "default").path().toStringFull());
        assertTrue(TagPaths.parse("  [default]CTG/Temp  ", "default").ok(), "white space around the whole path is trimmed");
        assertTrue(TagPaths.parse("[my provider]CTG/Temp", "default").ok(), "inner blanks are part of a valid name");
        assertEquals("[default]", ReadScope.folderKey(ReadScope.parseFolder("[default]", "default").get()));
        assertEquals("[default]", ReadScope.folderKey(ReadScope.parseFolder("[~]", "default").get()));
        assertEquals("[system]", ReadScope.folderKey(ReadScope.parseFolder("[System]/", "default").get()));
    }

    @Test
    void providerNameRule() {
        assertTrue(TagPaths.isValidProviderName("default"));
        assertTrue(TagPaths.isValidProviderName("~"));
        assertTrue(TagPaths.isValidProviderName("Edge Provider 2"));
        for (String bad : new String[] {null, "", " ", " default", "default ", "\u00A0x", "x\u3000", "de\u0007fault", "\nx"}) {
            assertFalse(TagPaths.isValidProviderName(bad), String.valueOf(bad));
        }
    }
}