package com.example.simpletagdisplay.gateway.security;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

import com.example.simpletagdisplay.common.protocol.ErrorCode;
import com.example.simpletagdisplay.gateway.ModuleSettings;
import com.example.simpletagdisplay.gateway.tags.TagPaths;
import com.inductiveautomation.ignition.common.tags.model.TagPath;
import com.inductiveautomation.perspective.gateway.api.SessionScope;
import org.junit.jupiter.api.Test;

/** Gateway floor policy. */
class FloorPolicyTest {

    private static final UserContext ANON = UserContext.of(false, null, List.of(), Set.of(), SessionScope.Client, true);
    private static final UserContext OPERATOR = UserContext.of(true, "operator", List.of("Operator"), Set.of(), SessionScope.Client, true);
    private static final UserContext ENGINEER = UserContext.of(true, "engineer", List.of("Engineer", "Operator"), Set.of(),
        SessionScope.Client, true);

    private static FloorPolicy policy(Map<String, String> props, List<String> warnings) {
        return FloorPolicy.from(ModuleSettings.Settings.read(props::get, w -> { }), warnings::add);
    }

    private static TagPath path(String raw) {
        return TagPaths.parse(raw, "default").path();
    }

    @Test
    void defaultsAllowAnonymousAndDenyTheSystemProvider() {
        FloorPolicy p = policy(Map.of(), new ArrayList<>());
        // No login floor by default; tag write permissions still decide (native Perspective parity)
        assertEquals(Optional.empty(), p.checkWrite(ANON, path("[default]CTG/TempSP")));
        assertEquals(Optional.empty(), p.checkWrite(OPERATOR, path("[default]CTG/TempSP")));
        assertEquals(Optional.of(ErrorCode.INVALID_PATH), p.checkWrite(OPERATOR, path("[System]Gateway/SystemName")));
        assertEquals(Optional.of(ErrorCode.INVALID_PATH), p.checkWrite(OPERATOR, path("[SYSTEM]Gateway/SystemName")));
        assertTrue(p.readProviderDenied("System"));
        assertTrue(p.readProviderDenied("system"));
        assertFalse(p.readProviderDenied("default"));
    }

    @Test
    void loginFloorCanBeEnabledExplicitly() {
        FloorPolicy p = policy(Map.of("ctg.write.requireAuthenticated", "true"), new ArrayList<>());
        assertEquals(Optional.of(ErrorCode.AUTH_REQUIRED), p.checkWrite(ANON, path("[default]CTG/TempSP")));
        assertEquals("ctg.write.requireAuthenticated", p.writeBlock(ANON, path("[default]CTG/TempSP")).get().setting());
        assertEquals(Optional.empty(), p.checkWrite(OPERATOR, path("[default]CTG/TempSP")));
    }

    @Test
    void roleFloorsMatchExactly() {
        FloorPolicy p = policy(Map.of("ctg.write.requiredRoles", "Operator", "ctg.configEdit.requiredRoles", "Engineer"),
            new ArrayList<>());
        assertEquals(Optional.empty(), p.checkWrite(OPERATOR, path("[default]CTG/TempSP")));
        assertEquals(Optional.of(ErrorCode.FORBIDDEN_ROLE), p.checkConfigEdit(OPERATOR, path("[default]CTG/TempSP")));
        assertEquals(Optional.empty(), p.checkConfigEdit(ENGINEER, path("[default]CTG/TempSP")));
        FloorPolicy lower = policy(Map.of("ctg.write.requiredRoles", "operator"), new ArrayList<>());
        assertEquals(Optional.of(ErrorCode.FORBIDDEN_ROLE), lower.checkWrite(OPERATOR, path("[default]CTG/TempSP")),
            "role names are case-sensitive");
    }

    @Test
    void allowedRootsLimitTheWriteScope() {
        List<String> w = new ArrayList<>();
        FloorPolicy p = policy(Map.of("ctg.write.allowedRoots", "[default]CTG, [default]Area 2/Pumps"), w);
        assertTrue(w.isEmpty());
        assertEquals(Optional.empty(), p.checkWrite(OPERATOR, path("[default]CTG/TempSP")));
        assertEquals(Optional.empty(), p.checkWrite(OPERATOR, path("[default]ctg/tempsp")));
        assertEquals(Optional.empty(), p.checkWrite(OPERATOR, path("[default]Area 2/Pumps/P1/Speed")));
        assertEquals(Optional.of(ErrorCode.OUT_OF_SCOPE), p.checkWrite(OPERATOR, path("[default]CTGX/TempSP")));
        assertEquals(Optional.of(ErrorCode.OUT_OF_SCOPE), p.checkWrite(OPERATOR, path("[default]Area 2/Valves/V1")));
        assertEquals(Optional.of(ErrorCode.OUT_OF_SCOPE), p.checkWrite(OPERATOR, path("[other]CTG/TempSP")));
    }

    @Test
    void invalidAllowedRootsFailClosed() {
        List<String> w = new ArrayList<>();
        FloorPolicy p = policy(Map.of("ctg.write.allowedRoots", "CTG, [default]../x"), w);
        assertEquals(3, w.size(), "two invalid entries + the fail-closed notice: " + w);
        assertEquals(Optional.of(ErrorCode.OUT_OF_SCOPE), p.checkWrite(OPERATOR, path("[default]CTG/TempSP")));
    }

    @Test
    void floorOrderIsAuthThenRolesThenProviderThenRoots() {
        FloorPolicy p = policy(Map.of("ctg.write.requiredRoles", "Engineer", "ctg.write.allowedRoots", "[default]CTG"),
            new ArrayList<>());
        assertEquals(Optional.of(ErrorCode.AUTH_REQUIRED), p.checkWrite(ANON, path("[System]X")));
        assertEquals(Optional.of(ErrorCode.FORBIDDEN_ROLE), p.checkWrite(OPERATOR, path("[System]X")));
        assertEquals(Optional.of(ErrorCode.INVALID_PATH), p.checkWrite(ENGINEER, path("[System]X")));
        assertEquals(Optional.of(ErrorCode.OUT_OF_SCOPE), p.checkWrite(ENGINEER, path("[default]Other/X")));
    }
}
