package com.example.simpletagdisplay.gateway.delegate;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Date;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BiConsumer;

import com.example.simpletagdisplay.common.protocol.ErrorCode;
import com.example.simpletagdisplay.gateway.GatewayServices;
import com.example.simpletagdisplay.gateway.ModuleSettings;
import com.example.simpletagdisplay.gateway.audit.CtgAudit;
import com.example.simpletagdisplay.gateway.ops.DisplayGates;
import com.example.simpletagdisplay.gateway.ops.DisplayOps;
import com.example.simpletagdisplay.gateway.security.BindingLint;
import com.example.simpletagdisplay.gateway.security.FloorPolicy;
import com.example.simpletagdisplay.gateway.security.UserContext;
import com.example.simpletagdisplay.gateway.tags.HistoryAvailability;
import com.example.simpletagdisplay.gateway.tags.TagMetaReader;
import com.example.simpletagdisplay.gateway.util.RateLimitedLog;
import com.inductiveautomation.ignition.common.gson.JsonElement;
import com.inductiveautomation.ignition.common.gson.JsonObject;
import com.inductiveautomation.ignition.common.gson.JsonParser;
import com.inductiveautomation.ignition.common.model.values.BasicQualifiedValue;
import com.inductiveautomation.ignition.common.model.values.QualifiedValue;
import com.inductiveautomation.ignition.common.model.values.QualityCode;
import com.inductiveautomation.ignition.common.tags.config.types.TagObjectType;
import com.inductiveautomation.ignition.common.tags.model.TagManager;
import com.inductiveautomation.ignition.common.tags.model.TagPath;
import com.inductiveautomation.ignition.common.util.LoggerEx;
import com.inductiveautomation.ignition.gateway.audit.AuditProfile;
import com.inductiveautomation.perspective.gateway.api.Component;
import com.inductiveautomation.perspective.gateway.api.SessionScope;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/**
 * A Designer whose communication mode is not Read/Write must never edit a tag's configuration. Drives the real
 * {@link DisplayOps#configEdit} with a fake host: the refusal comes from the gate before the fresh read (the tag
 * manager is never asked), and again from the gate after the read when the Designer turned read-only meanwhile. The
 * edit itself would go through the gateway's tag provider, which a unit test does not have: a writable Designer
 * therefore ends at {@code PROVIDER_UNRESOLVED}, proving it passed both gates, while a read-only one never gets that
 * far. Plus the gate order in {@link DisplayGates#configEdit}.
 */
class ConfigEditDesignerReadOnlyTest {

    private static final String PATH = "[default]CTG/TempSP";
    private static final UserContext DESIGNER_RW =
        UserContext.of(true, "engineer", List.of("Engineer"), Set.of(), SessionScope.Designer, true);
    private static final UserContext DESIGNER_RO =
        UserContext.of(true, "engineer", List.of("Engineer"), Set.of(), SessionScope.Designer, false);
    private static final UserContext DESIGNER_RO_VIEWER =
        UserContext.of(true, "viewer", List.of(), Set.of(), SessionScope.Designer, false);

    private final GatewayServices services = new GatewayServices(null, null, new ModuleSettings(k -> null));
    private final ScheduledExecutorService sched = Executors.newSingleThreadScheduledExecutor();
    private final CtgAudit audit = new CtgAudit(null, sched, x -> "");

    @AfterEach
    void close() {
        services.close();
        sched.shutdownNow();
    }

    private static PropsSnapshot props() {
        Map<String, JsonElement> m = new HashMap<>();
        JsonObject o = JsonParser.parseString("{\"tagPath\":\"" + PATH + "\",\"menu.configEdit.enabled\":true,"
            + "\"menu.configEdit.access.roles\":[\"Engineer\"]}").getAsJsonObject();
        o.entrySet().forEach(e -> m.put(e.getKey(), e.getValue()));
        return new PropsSnapshot(Collections.unmodifiableMap(m), BindingLint.LintReport.clean(), true);
    }

    /** Paths the fake tag manager was asked for (diagnostics of a failing assertion). */
    private static final List<String> seen = java.util.Collections.synchronizedList(new ArrayList<>());

    /** Counts readAsync calls and the other calls (an edit), which throw. */
    private static TagManager tagManager(AtomicInteger reads, AtomicInteger others) {
        return (TagManager) Proxy.newProxyInstance(TagManager.class.getClassLoader(), new Class<?>[] {TagManager.class},
            (proxy, m, args) -> {
                if (m.getName().equals("readAsync")) {
                    reads.incrementAndGet();
                    @SuppressWarnings("unchecked")
                    List<TagPath> paths = (List<TagPath>) args[0];
                    List<QualifiedValue> out = new ArrayList<>();
                    for (TagPath p : paths) {
                        String s = p.toStringFull().toLowerCase(java.util.Locale.ROOT);
                        Object v = s.contains("tagtype") ? TagObjectType.AtomicTag
                            : s.contains("engunit") ? "degC" : s.contains("englow") ? 0.0 : s.contains("enghigh") ? 100.0 : 1.0;
                        seen.add(s);
                        out.add(new BasicQualifiedValue(v, QualityCode.Good, new Date()));
                    }
                    return CompletableFuture.completedFuture(out);
                }
                if (m.getName().equals("toString")) {
                    return "fake TagManager";
                }
                others.incrementAndGet();
                throw new UnsupportedOperationException(m.getName());
            });
    }

    private class Host implements DisplayOps.Host {
        volatile UserContext user;
        final TagManager tm;

        Host(UserContext user, TagManager tm) {
            this.user = user;
            this.tm = tm;
        }

        @Override public PropsSnapshot props() { return ConfigEditDesignerReadOnlyTest.props(); }
        @Override public UserContext user() { return user; }
        @Override public String defaultProvider() { return "default"; }
        @Override public TagManager tagManager() { return tm; }
        @Override public GatewayServices services() { return services; }
        @Override public Component component() { return null; }
        @Override public CtgAudit audit() { return audit; }
        @Override public Optional<AuditProfile> auditProfile() { return Optional.empty(); }

        @Override
        public <T> void onQueue(CompletableFuture<T> f, long timeoutMs, BiConsumer<T, Throwable> cb) {
            try {
                cb.accept(f.get(5, TimeUnit.SECONDS), null);
            } catch (Exception e) {
                cb.accept(null, e.getCause() != null ? e.getCause() : e);
            }
        }

        @Override public void fire(String event, JsonObject payload) { }
        @Override public UUID sessionId() { return UUID.randomUUID(); }
        @Override public String trendGroup() { return "default"; }
        @Override public HistoryAvailability.Status history(TagMetaReader.Meta meta) { return null; }
        @Override public void configEdited() { }
        @Override public RateLimitedLog warnings() { return new RateLimitedLog(logger(), 1000); }
        @Override public LoggerEx logger() { return LoggerEx.newBuilder().build("ConfigEditDesignerReadOnlyTest"); }
        @Override public String describe() { return "test display"; }
        @Override public long debugReadDelayMs() { return 0; }
        @Override public long debugWriteDelayMs() { return 0; }
    }

    private static JsonObject run(Host host, UserContext caller) throws Exception {
        CompletableFuture<JsonObject> result = new CompletableFuture<>();
        JsonObject body = new JsonObject();
        body.addProperty("expectedTagPath", PATH);
        JsonObject changes = new JsonObject();
        changes.addProperty("engUnit", "degF");
        body.add("changes", changes);
        CallContext cc = new CallContext(null, null, caller, props(), "dt.configEdit", "1", body,
            HandlerRegistry.RateClass.MUTATE, result);
        DisplayOps.configEdit(cc, host);
        return result.get(10, TimeUnit.SECONDS);
    }

    private static String code(JsonObject r) {
        return r.has("error") ? r.getAsJsonObject("error").get("code").getAsString() : null;
    }

    @Test
    void aReadOnlyDesignerIsRefusedBeforeTheTagIsTouched() throws Exception {
        AtomicInteger reads = new AtomicInteger();
        AtomicInteger others = new AtomicInteger();
        JsonObject r = run(new Host(DESIGNER_RO, tagManager(reads, others)), DESIGNER_RO);
        assertFalse(r.get("ok").getAsBoolean(), r.toString());
        assertEquals("DESIGNER_READ_ONLY", code(r));
        assertEquals(0, reads.get(), "no fresh read for a refused edit");
        assertEquals(0, others.get(), "no edit");
    }

    @Test
    void aDesignerThatTurnsReadOnlyDuringTheReadIsRefusedAfterIt() throws Exception {
        AtomicInteger reads = new AtomicInteger();
        AtomicInteger others = new AtomicInteger();
        TagManager inner = tagManager(reads, others);
        // The Designer leaves Read/Write mode while the fresh read runs (the host's user flips inside readAsync).
        Host flip = new Host(DESIGNER_RW, null) {
            @Override
            public TagManager tagManager() {
                return (TagManager) Proxy.newProxyInstance(TagManager.class.getClassLoader(), new Class<?>[] {TagManager.class},
                    (proxy, m, args) -> {
                        if (m.getName().equals("readAsync")) {
                            user = DESIGNER_RO;
                        }
                        try {
                            return m.invoke(inner, args);
                        } catch (java.lang.reflect.InvocationTargetException e) {
                            throw e.getCause();
                        }
                    });
            }
        };
        JsonObject r = run(flip, DESIGNER_RW);
        assertEquals("DESIGNER_READ_ONLY", code(r), r + " paths " + seen);
        assertEquals(1, reads.get(), "refused by the gate after the fresh read");
        assertEquals(0, others.get(), "no edit");
    }

    @Test
    void aReadWriteDesignerPassesTheGate() throws Exception {
        AtomicInteger reads = new AtomicInteger();
        AtomicInteger others = new AtomicInteger();
        JsonObject r = run(new Host(DESIGNER_RW, tagManager(reads, others)), DESIGNER_RW);
        assertNotEquals("DESIGNER_READ_ONLY", code(r), r.toString());
        assertEquals(1, reads.get(), "control: a writable Designer reaches the fresh read");
        assertEquals("PROVIDER_UNRESOLVED", code(r),
            "control: past both gates, stopped only by the provider lookup of the edit (no gateway in a unit test)");
        assertEquals(0, others.get());
    }

    @Test
    void gateOrderRoleBeforeDesignerModeBeforeAudit() {
        FloorPolicy floor = FloorPolicy.from(ModuleSettings.Settings.defaults(), w -> { });
        assertEquals(ErrorCode.FORBIDDEN_ROLE, DisplayGates.configEdit(props(), DESIGNER_RO_VIEWER, floor, "default", false).error(),
            "a user without the role learns nothing about the Designer mode");
        assertEquals(ErrorCode.DESIGNER_READ_ONLY, DisplayGates.configEdit(props(), DESIGNER_RO, floor, "default", true).error(),
            "Designer mode before AUDIT_UNAVAILABLE");
        assertEquals(ErrorCode.AUDIT_UNAVAILABLE, DisplayGates.configEdit(props(), DESIGNER_RW, floor, "default", true).error());
        assertTrue(DisplayGates.configEdit(props(), DESIGNER_RW, floor, "default", false).ok());
    }
}
