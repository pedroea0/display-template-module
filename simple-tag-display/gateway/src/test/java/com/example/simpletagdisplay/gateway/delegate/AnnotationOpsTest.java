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
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.function.BiConsumer;

import com.example.simpletagdisplay.gateway.GatewayServices;
import com.example.simpletagdisplay.gateway.ModuleSettings;
import com.example.simpletagdisplay.gateway.annotations.AnnotationService;
import com.example.simpletagdisplay.gateway.audit.CtgAudit;
import com.example.simpletagdisplay.gateway.ops.AnnotationOps;
import com.example.simpletagdisplay.gateway.security.BindingLint;
import com.example.simpletagdisplay.gateway.security.ReadScope;
import com.example.simpletagdisplay.gateway.security.SecurityKeys;
import com.example.simpletagdisplay.gateway.security.TrustedProps;
import com.example.simpletagdisplay.gateway.security.UserContext;
import com.example.simpletagdisplay.gateway.tags.HistoryAvailability;
import com.example.simpletagdisplay.gateway.tags.TagMetaReader;
import com.example.simpletagdisplay.gateway.util.RateLimitedLog;
import com.inductiveautomation.ignition.common.QualifiedPath;
import com.inductiveautomation.ignition.common.QualifiedPathUtils;
import com.inductiveautomation.ignition.common.audit.AuditRecord;
import com.inductiveautomation.ignition.common.gson.JsonElement;
import com.inductiveautomation.ignition.common.gson.JsonObject;
import com.inductiveautomation.ignition.common.gson.JsonParser;
import com.inductiveautomation.ignition.common.model.values.BasicQualifiedValue;
import com.inductiveautomation.ignition.common.model.values.QualifiedValue;
import com.inductiveautomation.ignition.common.model.values.QualityCode;
import com.inductiveautomation.ignition.common.sqltags.history.annotations.Annotation;
import com.inductiveautomation.ignition.common.sqltags.history.annotations.TypeFilter;
import com.inductiveautomation.ignition.common.tags.model.TagManager;
import com.inductiveautomation.ignition.common.tags.model.TagPath;
import com.inductiveautomation.ignition.common.util.AuditStatus;
import com.inductiveautomation.ignition.common.util.LoggerEx;
import com.inductiveautomation.ignition.gateway.audit.AuditContext;
import com.inductiveautomation.ignition.gateway.audit.AuditProfile;
import com.inductiveautomation.ignition.gateway.historian.TagHistoryManager;
import com.inductiveautomation.perspective.gateway.api.Component;
import com.inductiveautomation.perspective.gateway.api.SessionScope;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/**
 * {@code chart.annotationSave} / {@code chart.annotationDelete} through the real {@link AnnotationOps} with a fake
 * chart host and an in-memory historian that behaves like the 8.3.10 Core Historian (same-id stores append versions,
 * deletes remove every version, queries match on the start): gates and author from the session, ownership
 * (NOT_OWNER) and quota, edit = delete + add (one visible entry), body rules, unsupported historian; claim + quota
 * given back on any exception before the store, INVALID_TIME, edits keeping a stored range.
 */
class AnnotationOpsTest {

    private static final String TEMP = "[default]CTG/Temp";
    private static final long TEN_DAYS_AGO = System.currentTimeMillis() - 10L * 86_400_000L;
    private static final UserContext ENGINEER = UserContext.of(true, "engineer", List.of("Engineer", "Operator"), Set.of(),
        SessionScope.Client, true);
    private static final UserContext OPERATOR = UserContext.of(true, "operator", List.of("Operator"), Set.of(),
        SessionScope.Client, true);
    private static final UserContext VIEWER = UserContext.of(true, "viewer", List.of(), Set.of(), SessionScope.Client, true);
    private static final UserContext ANON = UserContext.of(false, null, List.of(), Set.of(), SessionScope.Client, true);

    /** Module settings of the test (live: change a value, then {@code services.settings().reload()}). */
    private final Map<String, String> settings = new ConcurrentHashMap<>(Map.of("ctg.annotations.maxPerSessionPerHour", "3"));
    private final GatewayServices services = new GatewayServices(null, null, new ModuleSettings(settings::get));

    @AfterEach
    void close() {
        services.close();
    }

    /** In-memory historian (see the class comment); {@code unsupported} makes every call throw like a non-supporting one. */
    private static final class Historian {
        final List<Annotation> stored = new ArrayList<>();
        /** Stores not yet visible to queries (asynchronous storage, ~0.3 s on Core Historian); see {@link #lag}. */
        final List<Annotation> pending = new ArrayList<>();
        boolean unsupported;
        boolean lag;
        /** The store answers Bad for every entry and keeps nothing. */
        volatile boolean failStores;
        int stores;

        /** Makes the lagging stores visible. */
        synchronized void flush() {
            for (Annotation x : pending) {
                apply(x);
            }
            pending.clear();
        }

        private void apply(Annotation x) {
            if (x.isDeleted()) {
                stored.removeIf(y -> y.getStorageId().equals(x.getStorageId()));
            } else {
                stored.add(x);
            }
        }

        TagHistoryManager proxy() {
            return (TagHistoryManager) Proxy.newProxyInstance(TagHistoryManager.class.getClassLoader(),
                new Class<?>[] {TagHistoryManager.class}, (p, m, args) -> {
                    switch (m.getName()) {
                        case "queryAnnotations":
                            return query(args);
                        case "storeAnnotations":
                            return store(args);
                        case "toString":
                            return "in-memory historian";
                        default:
                            throw new UnsupportedOperationException(m.getName());
                    }
                });
        }

        @SuppressWarnings("unchecked")
        private synchronized Object query(Object[] a) {
            if (unsupported) {
                throw new UnsupportedOperationException("annotations not supported");
            }
            List<String> keys = new ArrayList<>();
            for (Object o : (List<Object>) a[0]) {
                keys.add(QualifiedPathUtils.fromTagPathNew((TagPath) o).toString().toLowerCase(Locale.ROOT));
            }
            long from = ((Date) a[1]).getTime();
            long to = ((Date) a[2]).getTime();
            TypeFilter tf = (TypeFilter) a[3];
            List<Annotation> out = new ArrayList<>();
            for (Annotation x : stored) {
                long s = x.getRangeStart().getTime();
                if (keys.contains(x.getPath().toString().toLowerCase(Locale.ROOT)) && s >= from && s <= to
                        && tf.isAllowed(x.getType())) {
                    out.add(x);
                }
            }
            return out;
        }

        @SuppressWarnings("unchecked")
        private synchronized Object store(Object[] a) {
            if (unsupported) {
                throw new UnsupportedOperationException("annotations not supported");
            }
            stores++;
            List<QualifiedValue> res = new ArrayList<>();
            for (Annotation x : (List<Annotation>) a[0]) {
                if (failStores) {
                    res.add(new BasicQualifiedValue(null, QualityCode.Bad, new Date()));
                    continue;
                }
                if (lag) {
                    pending.add(x);
                } else {
                    apply(x);
                }
                res.add(new BasicQualifiedValue(null, QualityCode.Good, new Date()));
            }
            return res;
        }

        synchronized List<AnnotationService.Note> notes() {
            List<AnnotationService.Note> out = new ArrayList<>();
            for (Annotation x : stored) {
                out.add(AnnotationService.parseData(x.getData()));
            }
            return out;
        }
    }

    private static TagManager fakeTags(QualityCode q) {
        return (TagManager) Proxy.newProxyInstance(TagManager.class.getClassLoader(), new Class<?>[] {TagManager.class},
            (proxy, m, args) -> {
                if (m.getName().equals("readAsync")) {
                    List<QualifiedValue> out = new ArrayList<>();
                    for (Object ignored : (List<?>) args[0]) {
                        out.add(new BasicQualifiedValue(q.isGood() ? 1.0 : null, q, new Date()));
                    }
                    return CompletableFuture.completedFuture(out);
                }
                throw new UnsupportedOperationException(m.getName());
            });
    }

    private static final Component COMPONENT = (Component) Proxy.newProxyInstance(Component.class.getClassLoader(),
        new Class<?>[] {Component.class}, (p, m, args) -> {
            if (m.getName().equals("getComponentAddressPath")) {
                return "root/chart";
            }
            if (m.getName().equals("getAuditSnapshot")) {
                return new AuditContext.Builder().setActor("engineer").setHost("h")
                    .setPath(QualifiedPath.of("prj", "CTG_Test"));                     // records reach a profile
            }
            throw new UnsupportedOperationException(m.getName());
        });

    private final class Host implements AnnotationOps.Host {
        volatile PropsSnapshot props;
        volatile UserContext user;
        final Historian historian;
        final Map<String, AnnotationOps.PenRef> pens = new HashMap<>();
        final UUID session = UUID.randomUUID();
        TagManager tm = fakeTags(QualityCode.Good);
        final CtgAudit audit = new CtgAudit(null, services.scheduler(), x -> "");
        /**
         * Fault injection: thrown by {@link #component()} (after claim + quota) / {@link #historyManager()}
         * (after begin) / {@link #onQueue} when called by {@code AnnotationOps.reply} (after the store call returned). A RuntimeException or an Error.
         */
        volatile Throwable componentFault;
        volatile Throwable historianFault;
        volatile Throwable queueFault;
        /** The audit profile (some tests capture the records); empty = logger only. */
        volatile Optional<AuditProfile> profile = Optional.empty();

        Host(PropsSnapshot props, UserContext user, Historian historian) {
            this.props = props;
            this.user = user;
            this.historian = historian;
            pens.put("[default]ctg/temp", new AnnotationOps.PenRef("ok", "Core Historian"));
            pens.put("[default]ctg/nohistory", new AnnotationOps.PenRef("noHistory", null));
        }

        @Override public AnnotationOps.PenRef annotationPen(String nk) { return pens.get(nk); }
        @Override
        public TagHistoryManager historyManager() {
            if (historianFault != null) {
                throw sneaky(historianFault);
            }
            return historian.proxy();
        }
        @Override public AnnotationService annotations() { return AnnotationService.of(services); }
        @Override public CtgAudit audit() { return audit; }
        @Override public Optional<AuditProfile> auditProfile() { return profile; }
        @Override
        public Component component() {
            if (componentFault != null) {
                throw sneaky(componentFault);
            }
            return COMPONENT;
        }
        @Override public PropsSnapshot props() { return props; }
        @Override public UserContext user() { return user; }
        @Override public String defaultProvider() { return "default"; }
        @Override public TagManager tagManager() { return tm; }
        @Override public GatewayServices services() { return services; }
        @Override public UUID sessionId() { return session; }
        @Override public ReadScope scope() { return ReadScope.NONE; }

        @Override
        public <T> void onQueue(CompletableFuture<T> f, long timeoutMs, BiConsumer<T, Throwable> cb) {
            if (queueFault != null && StackWalker.getInstance().walk(st -> st.skip(1).findFirst()
                    .map(fr -> fr.getMethodName().equals("reply")).orElse(false))) {
                throw sneaky(queueFault);                       // only the store reply's hop (not read / lookup)
            }
            try {
                cb.accept(f.get(5, TimeUnit.SECONDS), null);
            } catch (Exception e) {
                cb.accept(null, e.getCause() != null ? e.getCause() : e);
            }
        }

        @Override public HistoryAvailability.Status history(TagMetaReader.Meta meta) { return null; }
        @Override public RateLimitedLog warnings() { return new RateLimitedLog(logger(), 1000); }
        @Override public LoggerEx logger() { return LoggerEx.newBuilder().build("AnnotationOpsTest"); }
        @Override public String describe() { return "test chart"; }
    }

    /** Throws {@code t} as is (RuntimeException or Error) from a method that declares neither. */
    private static RuntimeException sneaky(Throwable t) {
        if (t instanceof Error) {
            throw (Error) t;
        }
        throw (RuntimeException) t;
    }

    /** Captures audit records. */
    private static final class Profile implements AuditProfile {
        final List<AuditRecord> records = Collections.synchronizedList(new ArrayList<>());

        @Override
        public void audit(AuditRecord r) {
            records.add(r);
        }

        @Override
        public List<AuditRecord> query(String a, String b, String c, String d, Date e, Date f, String g, Integer h) {
            return List.copyOf(records);
        }

        /** Waits (up to 5 s) for {@code n} records; they are written on the audit writer thread. */
        List<AuditRecord> await(int n) throws InterruptedException {
            for (int i = 0; i < 500 && records.size() < n; i++) {
                Thread.sleep(10);
            }
            return List.copyOf(records);
        }
    }

    /** Trusted snapshot in TrustedProps trust form. */
    private static PropsSnapshot tree(String json) {
        JsonObject root = JsonParser.parseString(json).getAsJsonObject();
        Map<String, JsonElement> m = new HashMap<>();
        for (String leaf : SecurityKeys.CHART) {
            TrustedProps.readTrustForm(leaf, path -> {
                JsonElement cur = root;
                for (String part : path.split("\\.")) {
                    if (cur == null || !cur.isJsonObject() || !cur.getAsJsonObject().has(part)) {
                        return Optional.empty();
                    }
                    cur = cur.getAsJsonObject().get(part);
                }
                return Optional.of(cur);
            }).ifPresent(v -> m.put(leaf, v));
        }
        return new PropsSnapshot(m, BindingLint.LintReport.clean(), true);
    }

    /** annotations on, editing for Operator (+ Engineer), optional moderation for Engineer and ownOnly. */
    private static PropsSnapshot props(boolean moderate, boolean ownOnly) {
        return tree("{\"annotations\":{\"enabled\":true,\"edit\":{\"enabled\":true,\"ownOnly\":" + ownOnly
            + ",\"access\":{\"roles\":[\"Operator\"]}},\"moderate\":{\"enabled\":" + moderate
            + ",\"access\":{\"roles\":[\"Engineer\"]}}}}");
    }

    private JsonObject call(Host h, String name, String body) throws Exception {
        CompletableFuture<JsonObject> result = new CompletableFuture<>();
        CallContext cc = new CallContext(null, null, h.user, h.props, name, "1",
            JsonParser.parseString(body).getAsJsonObject(), HandlerRegistry.RateClass.MUTATE, result);
        if (name.endsWith("Save")) {
            AnnotationOps.save(cc, h);
        } else {
            AnnotationOps.delete(cc, h);
        }
        return result.get(10, TimeUnit.SECONDS);
    }

    private JsonObject save(Host h, String body) throws Exception {
        return call(h, "chart.annotationSave", body);
    }

    private JsonObject delete(Host h, String body) throws Exception {
        return call(h, "chart.annotationDelete", body);
    }

    private static String code(JsonObject reply) {
        return reply.get("ok").getAsBoolean() ? "ok" : reply.getAsJsonObject("error").get("code").getAsString();
    }

    /** {@code error.details.reason} of an INVALID_TIME reply. */
    private static String reason(JsonObject reply) {
        return reply.getAsJsonObject("error").getAsJsonObject("details").get("reason").getAsString();
    }

    private static String note(String text) {
        return "{\"tagPath\":\"" + TEMP + "\",\"type\":\"note\",\"start\":1000000,\"text\":\"" + text + "\"}";
    }

    // ---- gates; author from the session -------------------------------------------------------------------------

    @Test
    void gatesRefuseViewerAnonymousAndDisabledCharts() throws Exception {
        Historian hist = new Historian();
        assertEquals("FORBIDDEN_ROLE", code(save(new Host(props(false, true), VIEWER, hist), note("x"))));
        assertEquals("AUTH_REQUIRED", code(save(new Host(props(false, true), ANON, hist), note("x"))));
        assertEquals("ACTION_DISABLED", code(save(new Host(tree("{\"annotations\":{\"enabled\":true}}"), ENGINEER, hist),
            note("x"))), "edit.enabled false");
        assertEquals("ACTION_DISABLED", code(save(new Host(tree("{}"), ENGINEER, hist), note("x"))), "annotations off");
        assertEquals("DISABLED", code(save(new Host(tree("{\"enabled\":false,\"annotations\":{\"enabled\":true,"
            + "\"edit\":{\"enabled\":true}}}"), ENGINEER, hist), note("x"))));
        assertEquals("FORBIDDEN_ROLE", code(delete(new Host(props(false, true), VIEWER, hist),
            "{\"tagPath\":\"" + TEMP + "\",\"annotationId\":\"" + UUID.randomUUID() + "\",\"start\":1}")));
        assertEquals(0, hist.stores, "nothing reached the historian");
    }

    @Test
    void authorComesFromTheSessionNeverFromTheClient() throws Exception {
        Historian hist = new Historian();
        Host h = new Host(props(false, true), OPERATOR, hist);
        // the real body carries the delegate envelope (v, id = request id, build): `id` is NOT the entry id
        JsonObject r = save(h, "{\"v\":2,\"id\":\"r17\",\"build\":\"2.0.0-x\",\"tagPath\":\"" + TEMP + "\",\"type\":\"note\",\"start\":1000000,\"text\":\"Pump tripped\","
            + "\"author\":\"engineer\",\"color\":\"#E8743B\"}");
        assertEquals("ok", code(r), r.toString());
        UUID id = UUID.fromString(r.getAsJsonObject("data").get("id").getAsString());
        assertEquals(TEMP, r.getAsJsonObject("data").get("tagPath").getAsString());
        assertTrue(r.getAsJsonObject("data").has("auditId"));
        assertEquals(1, hist.stored.size());
        Annotation a = hist.stored.get(0);
        assertEquals(id, a.getStorageId(), "the reply names the stored id");
        assertEquals("note", a.getType());
        assertEquals(1000000L, a.getRangeStart().getTime());
        AnnotationService.Note n = AnnotationService.parseData(a.getData());
        assertEquals("operator", n.author());
        assertEquals("Pump tripped", n.text());
        assertEquals("#E8743B", n.color());
    }

    @Test
    void rangeIsStoredWithItsEnd() throws Exception {
        Historian hist = new Historian();
        Host h = new Host(props(false, true), ENGINEER, hist);
        assertEquals("ok", code(save(h, "{\"tagPath\":\"" + TEMP + "\",\"type\":\"range\",\"start\":1000,\"end\":5000,"
            + "\"text\":\"Maintenance\"}")));
        assertEquals("range", hist.stored.get(0).getType());
        assertEquals(5000L, hist.stored.get(0).getRangeEnd().getTime());
    }

    // ---- edit = delete + add ------------------------------------------------------------------------------------

    @Test
    void editLeavesExactlyOneEntryUnderANewId() throws Exception {
        Historian hist = new Historian();
        Host h = new Host(props(false, true), ENGINEER, hist);
        String id = save(h, note("first")).getAsJsonObject("data").get("id").getAsString();
        JsonObject r = save(h, "{\"tagPath\":\"" + TEMP + "\",\"annotationId\":\"" + id + "\",\"type\":\"note\",\"start\":2000000,"
            + "\"oldStart\":1000000,\"text\":\"second\"}");
        assertEquals("ok", code(r), r.toString());
        String newId = r.getAsJsonObject("data").get("id").getAsString();
        assertFalse(newId.equals(id));
        assertEquals(1, hist.stored.size(), "the old versions were deleted");
        AnnotationService.Note n = hist.notes().get(0);
        assertEquals("second", n.text());
        assertEquals("engineer", n.author());
        assertEquals(2000000L, hist.stored.get(0).getRangeStart().getTime(), "moved to the new time");
        assertEquals("ANNOTATION_NOT_FOUND", code(save(h, "{\"tagPath\":\"" + TEMP + "\",\"annotationId\":\"" + id
            + "\",\"type\":\"note\",\"start\":2000000,\"text\":\"third\"}")), "the old id is gone");
    }

    @Test
    void secondChangeOfAReplacedIdIsRefusedBeforeTheHistorianShowsIt() throws Exception {
        // Two edits of one note whose lookups both ran before the first store became visible.
        Historian hist = new Historian();
        Host tab1 = new Host(props(false, true), ENGINEER, hist);
        Host tab2 = new Host(props(false, true), ENGINEER, hist);
        String id = save(tab1, note("first")).getAsJsonObject("data").get("id").getAsString();
        hist.lag = true;
        String edit = "{\"tagPath\":\"" + TEMP + "\",\"annotationId\":\"" + id + "\",\"type\":\"note\",\"start\":1000000,"
            + "\"text\":\"edit %s\"}";
        assertEquals("ok", code(save(tab1, String.format(edit, "A"))));
        assertEquals(1, hist.stored.size(), "the historian does not show the edit yet");
        assertEquals("ANNOTATION_NOT_FOUND", code(save(tab2, String.format(edit, "B"))), "already replaced");
        assertEquals("ANNOTATION_NOT_FOUND", code(delete(tab2, "{\"tagPath\":\"" + TEMP + "\",\"annotationId\":\"" + id
            + "\",\"start\":1000000}")), "a delete of the replaced id too");
        hist.flush();
        assertEquals(1, hist.stored.size(), "exactly one copy");
        assertEquals("edit A", hist.notes().get(0).text());
        assertEquals(2, hist.stores, "the refused changes never reached the historian");
    }

    @Test
    void aChangeThatNeverReachedTheHistorianFreesItsId() throws Exception {
        Historian hist = new Historian();
        Host h = new Host(props(false, true), ENGINEER, hist);
        String id = save(h, note("x")).getAsJsonObject("data").get("id").getAsString();
        String edit = "{\"tagPath\":\"" + TEMP + "\",\"annotationId\":\"" + id + "\",\"type\":\"note\",\"start\":1000000,"
            + "\"text\":\"y\"}";
        for (int i = 0; i < 2; i++) {
            assertEquals("ok", code(save(h, note("fill" + i))));
        }
        assertEquals("RATE_LIMITED", code(save(h, edit)), "quota (3) used up");
        assertEquals("ok", code(delete(h, "{\"tagPath\":\"" + TEMP + "\",\"annotationId\":\"" + id + "\",\"start\":1000000}")),
            "the refused edit released its claim");
    }

    @Test
    void editCollapsesForeignVersionsToo() throws Exception {
        Historian hist = new Historian();
        Host h = new Host(props(false, true), ENGINEER, hist);
        String id = save(h, note("v1")).getAsJsonObject("data").get("id").getAsString();
        // another tool appended a version under the same id (what a same-id store does on Core Historian)
        hist.stored.add(hist.stored.get(0).toBuilder().data(AnnotationService.dataJson("v2", "engineer", null, 1L, null, null)).build());
        assertEquals("ok", code(save(h, "{\"tagPath\":\"" + TEMP + "\",\"annotationId\":\"" + id
            + "\",\"type\":\"note\",\"start\":1000000,\"text\":\"v3\"}")));
        assertEquals(1, hist.stored.size());
        assertEquals("v3", hist.notes().get(0).text());
    }

    // ---- ownership, moderation, quota ----------------------------------------------------------------------------

    @Test
    void operatorCannotChangeTheEngineersNoteWithoutModeration() throws Exception {
        Historian hist = new Historian();
        Host eng = new Host(props(false, true), ENGINEER, hist);
        String id = save(eng, note("engineer's")).getAsJsonObject("data").get("id").getAsString();
        Host op = new Host(props(false, true), OPERATOR, hist);
        String edit = "{\"tagPath\":\"" + TEMP + "\",\"annotationId\":\"" + id + "\",\"type\":\"note\",\"start\":1000000,\"text\":\"mine\"}";
        String del = "{\"tagPath\":\"" + TEMP + "\",\"annotationId\":\"" + id + "\",\"start\":1000000}";
        assertEquals("NOT_OWNER", code(save(op, edit)));
        assertEquals("NOT_OWNER", code(delete(op, del)));
        assertEquals("engineer's", hist.notes().get(0).text());

        // moderation (Engineer role): the engineer may change the operator's note, and keeps the operator as author
        String opId = save(op, note("operator's")).getAsJsonObject("data").get("id").getAsString();
        Host mod = new Host(props(true, true), ENGINEER, hist);
        assertEquals("ok", code(save(mod, "{\"tagPath\":\"" + TEMP + "\",\"annotationId\":\"" + opId
            + "\",\"type\":\"note\",\"start\":1000000,\"text\":\"moderated\"}")));
        AnnotationService.Note moderated = hist.notes().stream().filter(n -> n.text().equals("moderated")).findFirst().get();
        assertEquals("operator", moderated.author(), "moderation keeps the attribution");

        // ownOnly false: anyone who may edit may change anyone's note
        Host open = new Host(props(false, false), OPERATOR, hist);
        assertEquals("ok", code(delete(open, del)));
        assertEquals(1, hist.stored.size());
    }

    @Test
    void foreignEntriesAreNotOwn() throws Exception {
        Historian hist = new Historian();
        Annotation foreign = Annotation.newBuilder()
            .path(QualifiedPathUtils.fromTagPathNew(com.example.simpletagdisplay.gateway.tags.TagPaths.parse(TEMP, "default").path()))
            .type("note").time(new Date(TEN_DAYS_AGO)).data("from a script").storageId(UUID.randomUUID()).build();
        hist.stored.add(foreign);
        Host eng = new Host(props(false, true), ENGINEER, hist);
        assertEquals("NOT_OWNER", code(delete(eng, "{\"tagPath\":\"" + TEMP + "\",\"annotationId\":\"" + foreign.getStorageId()
            + "\",\"start\":" + TEN_DAYS_AGO + "}")));
        assertEquals("ok", code(delete(new Host(props(true, true), ENGINEER, hist), "{\"tagPath\":\"" + TEMP + "\",\"annotationId\":\""
            + foreign.getStorageId() + "\"}")), "a moderator may; without start the id is searched over the chart range");
        assertTrue(hist.stored.isEmpty());
    }

    @Test
    void quotaPerSessionPerHour() throws Exception {
        Historian hist = new Historian();
        Host h = new Host(props(false, true), ENGINEER, hist);
        for (int i = 0; i < 3; i++) {
            assertEquals("ok", code(save(h, note("n" + i))));
        }
        JsonObject r = save(h, note("one too many"));
        assertEquals("RATE_LIMITED", code(r));
        assertEquals(3, r.getAsJsonObject("error").getAsJsonObject("details").get("max").getAsInt());
        assertEquals(3, hist.stored.size());
        Host other = new Host(props(false, true), ENGINEER, hist);
        assertEquals("ok", code(save(other, note("another session"))), "the quota is per session");
        assertEquals("ok", code(delete(h, "{\"tagPath\":\"" + TEMP + "\",\"annotationId\":\"" + hist.stored.get(0).getStorageId()
            + "\",\"start\":1000000}")), "deletes are not counted");
    }

    // ---- body and target rules -----------------------------------------------------------------------------------

    @Test
    void bodyRules() throws Exception {
        Host h = new Host(props(false, true), ENGINEER, new Historian());
        assertEquals("INVALID_VALUE", code(save(h, "{\"tagPath\":\"" + TEMP + "\",\"type\":\"marker\",\"start\":1,\"text\":\"x\"}")));
        assertEquals("INVALID_VALUE", code(save(h, "{\"tagPath\":\"" + TEMP + "\",\"type\":\"note\",\"start\":1,\"text\":\"x\","
            + "\"color\":\"red\"}")));
        assertEquals("INVALID_VALUE", code(save(h, "{\"tagPath\":\"" + TEMP + "\",\"type\":\"range\",\"start\":1,\"text\":\"x\"}")),
            "range without end");
        JsonObject order = save(h, "{\"tagPath\":\"" + TEMP + "\",\"type\":\"range\",\"start\":9,\"end\":5,"
            + "\"text\":\"x\"}");
        assertEquals("INVALID_TIME", code(order), "a time-specific code");
        assertEquals("order", reason(order));
        assertEquals("INVALID_VALUE", code(save(h, note("   "))), "empty text");
        assertEquals("BAD_REQUEST", code(save(h, "{\"tagPath\":\"" + TEMP + "\",\"type\":\"note\",\"start\":\"now\",\"text\":\"x\"}")));
        assertEquals("BAD_REQUEST", code(save(h, "{\"tagPath\":\"" + TEMP + "\",\"annotationId\":\"not-a-uuid\",\"type\":\"note\","
            + "\"start\":1,\"text\":\"x\"}")));
        assertEquals("BAD_REQUEST", code(delete(h, "{\"tagPath\":\"" + TEMP + "\"}")));
        // no note where no chart window can reach it
        long now = System.currentTimeMillis();
        JsonObject ahead = save(h, "{\"tagPath\":\"" + TEMP + "\",\"type\":\"note\",\"start\":"
            + (now + 2L * 86_400_000L) + ",\"text\":\"x\"}");
        assertEquals("INVALID_TIME", code(ahead), "more than a day ahead");
        assertEquals("future", reason(ahead));
        assertEquals("INVALID_TIME", code(save(h, "{\"tagPath\":\"" + TEMP + "\",\"type\":\"note\",\"start\":"
            + "253402300799000,\"text\":\"x\"}")), "year 9999");
        JsonObject tooLong = save(h, "{\"tagPath\":\"" + TEMP + "\",\"type\":\"range\",\"start\":1000,\"end\":"
            + (1000 + 401L * 86_400_000L) + ",\"text\":\"x\"}");
        assertEquals("INVALID_TIME", code(tooLong), "a range longer than ctg.history.maxRangeDays (400)");
        assertEquals("length", reason(tooLong));
        assertEquals(400, tooLong.getAsJsonObject("error").getAsJsonObject("details").get("maxRangeDays").getAsInt());
        assertEquals("The note's time is not allowed: check its start and end.",
            tooLong.getAsJsonObject("error").get("message").getAsString(), "not the tag-value text of INVALID_VALUE");
        assertEquals("ok", code(save(h, "{\"tagPath\":\"" + TEMP + "\",\"type\":\"note\",\"start\":"
            + (now + 3_600_000L) + ",\"text\":\"planned\"}")), "an hour ahead is fine");
    }

    @Test
    void targetMustBeAPenWithHistoryAndReadable() throws Exception {
        Historian hist = new Historian();
        Host h = new Host(props(false, true), ENGINEER, hist);
        assertEquals("STALE_TARGET", code(save(h, "{\"tagPath\":\"[default]CTG/Pressure\",\"type\":\"note\",\"start\":1,"
            + "\"text\":\"x\"}")), "not a pen of this chart");
        assertEquals("NO_HISTORY", code(save(h, "{\"tagPath\":\"[default]CTG/NoHistory\",\"type\":\"note\",\"start\":1,"
            + "\"text\":\"x\"}")));
        assertEquals("INVALID_PATH", code(save(h, "{\"tagPath\":\"[default]CTG/../Temp\",\"type\":\"note\",\"start\":1,"
            + "\"text\":\"x\"}")));
        h.tm = fakeTags(QualityCode.Bad_AccessDenied);
        assertEquals("ACCESS_DENIED", code(save(h, note("x"))));
        h.tm = fakeTags(QualityCode.Bad_NotFound);
        assertEquals("TAG_NOT_FOUND", code(save(h, note("x"))));
        assertEquals(0, hist.stores);
    }

    // ---- claim and quota given back on an early failure ------------------------------------------------------------

    @Test
    void anExceptionBeforeTheStoreGivesBackTheClaimAndTheQuota() throws Exception {
        // An exception between claim() and store() used to leave the note BUSY for CLAIM_MAX_MS (120 s)
        // and the session one save short.
        Historian hist = new Historian();
        Host h = new Host(props(false, true), ENGINEER, hist);
        String id = save(h, note("x")).getAsJsonObject("data").get("id").getAsString();          // quota 1 of 3
        String edit = "{\"tagPath\":\"" + TEMP + "\",\"annotationId\":\"" + id + "\",\"type\":\"note\",\"start\":1000000,"
            + "\"text\":\"y\"}";
        String del = "{\"tagPath\":\"" + TEMP + "\",\"annotationId\":\"" + id + "\",\"start\":1000000}";

        h.componentFault = new IllegalStateException("audit snapshot failed");                 // after claim + quota
        assertEquals("INTERNAL", code(save(h, edit)));
        assertEquals("INTERNAL", code(delete(h, del)));
        assertEquals("INTERNAL", code(save(h, note("add"))));
        h.componentFault = null;
        h.historianFault = new IllegalStateException("no historian manager");                  // after the audit began
        assertEquals("INTERNAL", code(save(h, note("add"))));
        h.historianFault = null;
        assertEquals(1, hist.stores, "none of the failed changes reached the historian");

        assertEquals("ok", code(save(h, edit)), "the id was released at once (not BUSY)");             // quota 2
        assertEquals("ok", code(save(h, note("third"))), "every failed save was refunded");            // quota 3
        assertEquals("RATE_LIMITED", code(save(h, note("fourth"))));
        assertEquals(2, hist.stored.size());
    }

    // ---- errors around the store; edits of stored ranges -----------------------------------------------------------

    @Test
    void anErrorIsAnsweredAndClosesTheAuditAttempt() throws Exception {
        // commit() caught only RuntimeException: an Error (here a LinkageError from a missing SDK class) left the
        // request unanswered and the audit attempt open.
        Historian hist = new Historian();
        Host h = new Host(props(false, true), ENGINEER, hist);
        Profile p = new Profile();
        h.profile = Optional.of(p);
        String id = save(h, note("x")).getAsJsonObject("data").get("id").getAsString();          // quota 1 of 3
        assertEquals(1, p.await(1).size());
        String edit = "{\"tagPath\":\"" + TEMP + "\",\"annotationId\":\"" + id + "\",\"type\":\"note\",\"start\":1000000,"
            + "\"text\":\"y\"}";
        String del = "{\"tagPath\":\"" + TEMP + "\",\"annotationId\":\"" + id + "\",\"start\":1000000}";

        h.historianFault = new NoClassDefFoundError("com/inductiveautomation/Missing");          // after the audit began
        assertEquals("INTERNAL", code(save(h, note("add"))), "an Error is answered");
        h.historianFault = null;
        List<AuditRecord> r = p.await(2);
        assertEquals(2, r.size(), "the begun attempt was closed");
        assertEquals(AuditStatus.BAD.getRawValue(), r.get(1).getStatusCode());

        h.componentFault = new AssertionError("audit snapshot");                                 // before begin
        assertEquals("INTERNAL", code(save(h, edit)));
        assertEquals("INTERNAL", code(delete(h, del)));
        h.componentFault = null;
        assertEquals(1, hist.stores, "none of the failed changes reached the historian");

        assertEquals("ok", code(save(h, edit)), "the claim was given back (not BUSY)");              // quota 2
        assertEquals("ok", code(save(h, note("third"))), "the quota was refunded");                   // quota 3
        assertEquals("RATE_LIMITED", code(save(h, note("fourth"))));
        assertEquals(4, p.await(4).size(), "no record for the two changes refused before the attempt began");
    }

    @Test
    void aFailureAfterTheStoreFollowsTheHistoriansAnswer() throws Exception {
        // An exception after store() returned used to record a BAD audit attempt and reply INTERNAL although the note
        // was stored. Now the reply, the claim and the audit record follow the historian's answer; the failure is logged.
        Historian hist = new Historian();
        Host h = new Host(props(false, true), ENGINEER, hist);
        Profile p = new Profile();
        h.profile = Optional.of(p);

        h.queueFault = new IllegalStateException("session queue closed");                     // after the store call
        JsonObject added = save(h, note("stored"));
        assertEquals("ok", code(added), "the stored note is answered ok: " + added);
        String id = added.getAsJsonObject("data").get("id").getAsString();
        assertEquals(TEMP, added.getAsJsonObject("data").get("tagPath").getAsString());
        assertTrue(added.getAsJsonObject("data").has("auditId"));
        assertEquals(1, hist.stored.size());

        h.queueFault = new AssertionError("an Error after the store");
        JsonObject edited = save(h, "{\"tagPath\":\"" + TEMP + "\",\"annotationId\":\"" + id
            + "\",\"type\":\"note\",\"start\":1000000,\"text\":\"edited\"}");
        assertEquals("ok", code(edited), edited.toString());
        String id2 = edited.getAsJsonObject("data").get("id").getAsString();
        assertEquals(1, hist.stored.size(), "edit = one entry");
        assertEquals("edited", hist.notes().get(0).text());

        hist.failStores = true;                                                                  // the historian says Bad
        JsonObject refused = save(h, note("refused"));
        assertEquals("WRITE_FAILED", code(refused), "the historian's answer, not INTERNAL: " + refused);
        hist.failStores = false;
        h.queueFault = null;

        List<AuditRecord> r = p.await(3);
        Thread.sleep(100);
        assertEquals(3, p.records.size(), "one record per change, no extra 'Exception' record");
        assertEquals(AuditStatus.GOOD.getRawValue(), r.get(0).getStatusCode());
        assertEquals(AuditStatus.GOOD.getRawValue(), r.get(1).getStatusCode());
        assertEquals(AuditStatus.BAD.getRawValue(), r.get(2).getStatusCode(), "BAD only because the historian said so");

        // the edit's claim was settled on the store's success: the replaced id is gone, the new one is free
        assertEquals("ANNOTATION_NOT_FOUND", code(save(h, "{\"tagPath\":\"" + TEMP + "\",\"annotationId\":\"" + id
            + "\",\"type\":\"note\",\"start\":1000000,\"text\":\"again\"}")));
        assertEquals("ok", code(delete(h, "{\"tagPath\":\"" + TEMP + "\",\"annotationId\":\"" + id2
            + "\",\"start\":1000000}")), "not BUSY");
        assertEquals(0, hist.stored.size());
    }

    @Test
    void editKeepingAStoredRangeIsNotHeldToALowerMaxRangeDays() throws Exception {
        // Lowering ctg.history.maxRangeDays used to make existing longer ranges uneditable (text-only edits refused);
        // now only edits that move or resize a range are held to the current bound.
        Historian hist = new Historian();
        Host h = new Host(props(false, true), ENGINEER, hist);
        long day = 86_400_000L;
        long start = TEN_DAYS_AGO;
        long end = start + 5 * day;
        String range = "{\"tagPath\":\"" + TEMP + "\",%s\"type\":\"range\",\"start\":%d,\"end\":%d,\"text\":\"%s\"}";
        String id = save(h, String.format(range, "", start, end, "Shutdown")).getAsJsonObject("data").get("id").getAsString();

        settings.put("ctg.history.maxRangeDays", "2");
        services.settings().reload();
        JsonObject text = save(h, String.format(range, "\"annotationId\":\"" + id + "\",", start, end, "Shutdown (planned)"));
        assertEquals("ok", code(text), "text-only edit of a stored 5-day range: " + text);
        String id2 = text.getAsJsonObject("data").get("id").getAsString();

        JsonObject moved = save(h, String.format(range, "\"annotationId\":\"" + id2 + "\",", start, end + 60_000L, "longer"));
        assertEquals("INVALID_TIME", code(moved), "resizing it is held to the current bound");
        assertEquals("length", reason(moved));
        assertEquals(2, moved.getAsJsonObject("error").getAsJsonObject("details").get("maxRangeDays").getAsInt());
        assertEquals("ok", code(save(h, String.format(range, "\"annotationId\":\"" + id2 + "\",", start, start + day,
            "shortened"))), "a resize within the bound is fine");
        assertEquals("INVALID_TIME", code(save(h, String.format(range, "", start, end, "new 5-day range"))),
            "new ranges are always held to it");
        assertEquals(1, hist.stored.size());
        assertEquals("shortened", hist.notes().get(0).text());
        assertEquals(start + day, hist.stored.get(0).getRangeEnd().getTime());
    }


    // ---- unsupported historian -----------------------------------------------------------------------------------

    @Test
    void unsupportedHistorianIsRefusedAndRemembered() throws Exception {
        Historian hist = new Historian();
        hist.unsupported = true;
        Host h = new Host(props(false, true), ENGINEER, hist);
        assertEquals("ANNOTATIONS_UNSUPPORTED", code(save(h, note("x"))));
        hist.unsupported = false;
        assertEquals("ANNOTATIONS_UNSUPPORTED", code(save(h, note("x"))), "remembered for 10 minutes: refused up front");
        assertEquals(0, hist.stores);
        JsonObject cap = AnnotationOps.capability(h.props, ENGINEER, true);
        assertFalse(cap.get("allowed").getAsBoolean());
        assertFalse(cap.get("editAllowed").getAsBoolean());
        assertEquals("ANNOTATIONS_UNSUPPORTED", cap.get("reason").getAsString());
    }

    @Test
    void capabilityCarriesOwnOnlyAndModeration() {
        JsonObject c = AnnotationOps.capability(props(true, true), ENGINEER, false);
        assertTrue(c.get("editAllowed").getAsBoolean());
        assertTrue(c.get("moderateAllowed").getAsBoolean());
        assertTrue(c.get("ownOnly").getAsBoolean());
        assertFalse(AnnotationOps.capability(props(true, true), OPERATOR, false).get("moderateAllowed").getAsBoolean());
        assertFalse(AnnotationOps.ownOnly(props(false, false)));
        assertTrue(AnnotationOps.ownOnly(tree("{\"annotations\":{\"edit\":{\"ownOnly\":\"no\"}}}")), "malformed = own only");
    }
}
