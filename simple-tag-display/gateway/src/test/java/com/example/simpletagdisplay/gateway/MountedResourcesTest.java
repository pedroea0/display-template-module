package com.example.simpletagdisplay.gateway;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;

import org.junit.jupiter.api.Test;

/** The immutable-cache allow-list covers exactly existing, versioned files. */
class MountedResourcesTest {

    @Test
    void resourcePathsAreNormalised() {
        assertEquals("js/ctg-common.js", SimpleTagDisplayGatewayHook.normalizeResourcePath("js/ctg-common.js"));
        assertEquals("js/ctg-common.js", SimpleTagDisplayGatewayHook.normalizeResourcePath("/mounted/js/ctg-common.js?v=2.0.0-x"));
        assertEquals("js/ctg-common.js", SimpleTagDisplayGatewayHook.normalizeResourcePath("/simpletagdisplay/js/ctg-common.js"));
        assertEquals("build-id.txt", SimpleTagDisplayGatewayHook.normalizeResourcePath("/build-id.txt"));
    }

    @Test
    void everyAllowListedFileExists() {
        for (String p : SimpleTagDisplayGatewayHook.IMMUTABLE_RESOURCES) {
            assertTrue(Files.isRegularFile(Path.of("src/main/resources/mounted", p)), p);
        }
        assertEquals(7, SimpleTagDisplayGatewayHook.IMMUTABLE_RESOURCES.size());
    }

    @Test
    void immutableOnlyForAllowListedFilesRequestedWithTheCurrentVersion() {
        String cur = "2.0.0-abcdef12";
        String imm = "public, max-age=31536000, immutable";
        assertEquals(imm, SimpleTagDisplayGatewayHook.cacheControl("js/ctg-common.js", cur, cur));
        assertEquals("no-cache", SimpleTagDisplayGatewayHook.cacheControl("js/ctg-common.js", null, cur));
        assertEquals("no-cache", SimpleTagDisplayGatewayHook.cacheControl("js/ctg-common.js", "2.0.0-00000000", cur));
        assertEquals("no-cache", SimpleTagDisplayGatewayHook.cacheControl("build-id.txt", cur, cur));
        assertEquals("2.0.0-x", SimpleTagDisplayGatewayHook.queryParam("/js/a.js?x=1&v=2.0.0-x", "v"));
        assertEquals("2.0.0-x", SimpleTagDisplayGatewayHook.queryParam("?v=2.0.0-x", "v"));
        assertEquals(null, SimpleTagDisplayGatewayHook.queryParam("js/a.js", "v"));
        assertEquals(null, SimpleTagDisplayGatewayHook.queryParam("?vv=1", "v"));
    }
}
