package com.example.simpletagdisplay.gateway.delegate;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
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
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BiConsumer;

import com.example.simpletagdisplay.gateway.GatewayServices;
import com.example.simpletagdisplay.gateway.ModuleSettings;
import com.example.simpletagdisplay.gateway.audit.CtgAudit;
import com.example.simpletagdisplay.gateway.ops.DisplayOps;
import com.example.simpletagdisplay.gateway.security.BindingLint;
import com.example.simpletagdisplay.gateway.security.UserContext;
import com.example.simpletagdisplay.gateway.tags.HistoryAvailability;
import com.example.simpletagdisplay.gateway.tags.TagMetaReader;
import com.example.simpletagdisplay.gateway.util.RateLimitedLog;
import com.inductiveautomation.ignition.common.audit.AuditRecord;
import com.inductiveautomation.ignition.common.audit.DefaultAuditRecord;
import com.inductiveautomation.ignition.common.gson.JsonElement;
import com.inductiveautomation.ignition.common.gson.JsonObject;
import com.inductiveautomation.ignition.common.gson.JsonParser;
import com.inductiveautomation.ignition.common.model.values.BasicQualifiedValue;
import com.inductiveautomation.ignition.common.model.values.QualifiedValue;
import com.inductiveautomation.ignition.common.model.values.QualityCode;
import com.inductiveautomation.ignition.common.tags.config.types.TagObjectType;
import com.inductiveautomation.ignition.common.tags.model.TagManager;
import com.inductiveautomation.ignition.common.tags.model.TagPath;
import com.inductiveautomation.ignition.common.util.AuditStatus;
import com.inductiveautomation.ignition.common.util.LoggerEx;
import com.inductiveautomation.ignition.gateway.audit.AuditProfile;
import com.inductiveautomation.perspective.gateway.api.Component;
import com.inductiveautomation.perspective.gateway.api.SessionScope;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/**
 * {@code dt.auditQuery} returns audit rows that contain the written and previous VALUES, so a user without Read
 * permission on the tag must get {@code ACCESS_DENIED} and the audit profile must not even be queried. Drives the real
 * {@link DisplayOps#auditQuery} with a fake host whose tag manager answers like 8.3.10 does for a tag with Read
 * Permissions the caller lacks ({@code Bad_AccessDenied}).
 */
class AuditQueryAccessTest {

    private static final String SENTINEL = "424242.4242";
    private static final String PATH = "[default]CTG/SecretH";
    private static final UserContext OPERATOR =
        UserContext.of(true, "operator", List.of("Operator"), Set.of(), SessionScope.Client, true);

    private final GatewayServices services = new GatewayServices(null, null, new ModuleSettings(k -> null));

    @AfterEach
    void close() {
        services.close();
    }

    /** Audit profile holding one write of the sentinel; counts queries. */
    private static final class Profile implements AuditProfile {
        final AtomicInteger queries = new AtomicInteger();
        volatile Runnable duringQuery = () -> { };

        @Override
        public void audit(AuditRecord r) {
        }

        @Override
        public List<AuditRecord> query(String a, String b, String c, String d, Date e, Date f, String g, Integer h) {
            queries.incrementAndGet();
            duringQuery.run();
            return List.of(DefaultAuditRecord.newBuilder().action(CtgAudit.ACTION_WRITE).actionTarget(PATH)
                .actionValue(SENTINEL + " (was " + SENTINEL + ") [ui=popup] [auditId=0b6d1c64-6a59-4c0e-9d36-6f0b0a8c2f11]")
                .actor("engineer").actorHost("h").statusCode(AuditStatus.GOOD.getRawValue()).timestamp(new Date())
                .originatingSystem("g").build());
        }
    }

    /** A tag manager whose readAsync answers every path with {@code q} (value + TagType). */
    private static TagManager tagManager(QualityCode q, AtomicInteger reads) {
        return (TagManager) Proxy.newProxyInstance(TagManager.class.getClassLoader(), new Class<?>[] {TagManager.class},
            (proxy, m, args) -> {
                if (m.getName().equals("readAsync")) {
                    reads.incrementAndGet();
                    @SuppressWarnings("unchecked")
                    List<TagPath> paths = (List<TagPath>) args[0];
                    List<QualifiedValue> out = new ArrayList<>();
                    for (int i = 0; i < paths.size(); i++) {   // order of DisplayOps: value, then TagType
                        Object v = q.isGood() ? (i == 1 ? TagObjectType.AtomicTag : 1.0) : null;
                        out.add(new BasicQualifiedValue(v, q, new Date()));
                    }
                    return CompletableFuture.completedFuture(out);
                }
                if (m.getName().equals("toString")) {
                    return "fake TagManager";
                }
                throw new UnsupportedOperationException(m.getName());
            });
    }

    private final class Host implements DisplayOps.Host {
        volatile PropsSnapshot props;
        final TagManager tm;
        final Profile profile;

        Host(PropsSnapshot props, TagManager tm, Profile profile) {
            this.props = props;
            this.tm = tm;
            this.profile = profile;
        }

        @Override public PropsSnapshot props() { return props; }
        @Override public UserContext user() { return OPERATOR; }
        @Override public String defaultProvider() { return "default"; }
        @Override public TagManager tagManager() { return tm; }
        @Override public GatewayServices services() { return services; }
        @Override public Component component() { return null; }
        @Override public CtgAudit audit() { return null; }
        @Override public Optional<AuditProfile> auditProfile() { return Optional.of(profile); }

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
        @Override public LoggerEx logger() { return LoggerEx.newBuilder().build("AuditQueryAccessTest"); }
        @Override public String describe() { return "test display"; }
        @Override public long debugReadDelayMs() { return 0; }
        @Override public long debugWriteDelayMs() { return 0; }
    }

    private static PropsSnapshot props() {
        return props(PATH, true);
    }

    private static PropsSnapshot props(String tagPath, boolean historyEnabled) {
        Map<String, JsonElement> m = new HashMap<>();
        JsonObject o = JsonParser.parseString("{\"tagPath\":\"" + tagPath.replace("\\", "\\\\") + "\","
            + "\"menu.changeHistory.enabled\":" + historyEnabled + "}").getAsJsonObject();
        o.entrySet().forEach(e -> m.put(e.getKey(), e.getValue()));
        return new PropsSnapshot(Collections.unmodifiableMap(m), BindingLint.LintReport.clean(), true);
    }

    private JsonObject run(QualityCode q, Profile profile, AtomicInteger reads) throws Exception {
        return run(new Host(props(), tagManager(q, reads), profile));
    }

    private JsonObject run(Host host) throws Exception {
        CompletableFuture<JsonObject> result = new CompletableFuture<>();
        JsonObject body = new JsonObject();
        body.addProperty("expectedTagPath", PATH);
        CallContext cc = new CallContext(null, null, OPERATOR, props(), "dt.auditQuery", "1", body,
            HandlerRegistry.RateClass.READ, result);
        DisplayOps.auditQuery(cc, host);
        return result.get(10, TimeUnit.SECONDS);
    }

    /**
     * The target and the change-history gate are checked again when the profile query returns,
     * so a reply never carries rows of a tag the display no longer shows (or after change history was switched off).
     */
    @Test
    void targetOrGateChangedDuringTheQueryGetsNoRows() throws Exception {
        Profile profile = new Profile();
        Host host = new Host(props(), tagManager(QualityCode.Good, new AtomicInteger()), profile);
        profile.duringQuery = () -> host.props = props("[default]CTG/Other", true);
        JsonObject r = run(host);
        assertEquals("STALE_TARGET", r.getAsJsonObject("error").get("code").getAsString(), r.toString());
        assertFalse(r.toString().contains(SENTINEL));
        assertEquals(1, profile.queries.get());

        Profile profile2 = new Profile();
        Host host2 = new Host(props(), tagManager(QualityCode.Good, new AtomicInteger()), profile2);
        profile2.duringQuery = () -> host2.props = props(PATH, false);
        JsonObject r2 = run(host2);
        assertEquals("ACTION_DISABLED", r2.getAsJsonObject("error").get("code").getAsString(), r2.toString());
        assertFalse(r2.toString().contains(SENTINEL));
    }

    @Test
    void userWithoutReadPermissionGetsAccessDeniedAndNoRows() throws Exception {
        Profile profile = new Profile();
        AtomicInteger reads = new AtomicInteger();
        JsonObject r = run(QualityCode.Bad_AccessDenied, profile, reads);
        assertFalse(r.get("ok").getAsBoolean(), r.toString());
        assertEquals("ACCESS_DENIED", r.getAsJsonObject("error").get("code").getAsString());
        assertFalse(r.toString().contains(SENTINEL), "no audit value may leak: " + r);
        assertEquals(1, reads.get(), "a fresh user-context read decides");
        assertEquals(0, profile.queries.get(), "the audit profile is not queried for a user who may not read the tag");
    }

    @Test
    void missingTagIsTagNotFound() throws Exception {
        Profile profile = new Profile();
        JsonObject r = run(QualityCode.Bad_NotFound, profile, new AtomicInteger());
        assertEquals("TAG_NOT_FOUND", r.getAsJsonObject("error").get("code").getAsString());
        assertEquals(0, profile.queries.get());
    }

    @Test
    void readerGetsTheRows() throws Exception {
        Profile profile = new Profile();
        JsonObject r = run(QualityCode.Good, profile, new AtomicInteger());
        assertTrue(r.get("ok").getAsBoolean(), r.toString());
        assertEquals(1, r.getAsJsonObject("data").getAsJsonArray("rows").size());
        assertEquals(1, profile.queries.get());
    }
}
