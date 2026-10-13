package com.example.simpletagdisplay.gateway.ops;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeoutException;
import java.util.function.BiConsumer;
import java.util.function.Function;

import com.example.simpletagdisplay.common.protocol.ErrorCode;
import com.example.simpletagdisplay.gateway.GatewayServices;
import com.example.simpletagdisplay.gateway.delegate.CallContext;
import com.example.simpletagdisplay.gateway.delegate.PropsSnapshot;
import com.example.simpletagdisplay.gateway.security.ReadScope;
import com.example.simpletagdisplay.gateway.security.UserContext;
import com.example.simpletagdisplay.gateway.tags.HistoryAvailability;
import com.example.simpletagdisplay.gateway.tags.TagMetaReader;
import com.example.simpletagdisplay.gateway.tags.TagPaths;
import com.example.simpletagdisplay.gateway.tags.ValueCodec;
import com.example.simpletagdisplay.gateway.trend.TrendListStore;
import com.example.simpletagdisplay.gateway.util.Json;
import com.example.simpletagdisplay.gateway.util.RateLimitedLog;
import com.inductiveautomation.ignition.common.gson.JsonArray;
import com.inductiveautomation.ignition.common.gson.JsonElement;
import com.inductiveautomation.ignition.common.gson.JsonNull;
import com.inductiveautomation.ignition.common.gson.JsonObject;
import com.inductiveautomation.ignition.common.gson.JsonPrimitive;
import com.inductiveautomation.ignition.common.model.values.QualifiedValue;
import com.inductiveautomation.ignition.common.model.values.QualityCode;
import com.inductiveautomation.ignition.common.sqltags.model.types.DataType;
import com.inductiveautomation.ignition.common.tags.model.TagManager;
import com.inductiveautomation.ignition.common.tags.model.TagPath;
import com.inductiveautomation.ignition.common.util.LoggerEx;

/**
 * The Click To Graph Chart's gateway rules and actions, independent of the transport. {@code CtgChartDelegate} owns
 * the state (pens, subscriptions, tokens); this class holds everything that can be stated as a function of trusted
 * props, user and tag facts, so the snapshot's advisory capabilities and the real actions use one implementation (the
 * same pattern as {@link DisplayGates}).
 *
 * <h2>Gates (all read the <b>trusted</b> {@link PropsSnapshot}; fail closed on malformed values)</h2>
 * <pre>
 *   trend edits (chart.trendAdd / trendRemove / trendClear)
 *     enabled false                                     → DISABLED
 *     trendEdit.enabled false, or no trend group        → ACTION_DISABLED
 *     binding lint on enabled / trendEdit               → BOUND_BIDIRECTIONAL
 *     trendEdit.access                                  → AUTH_REQUIRED / FORBIDDEN_ROLE
 *     adds only: ReadScope.allows(key, runtime=true)    → OUT_OF_SCOPE (per path; ctg.read.deniedProviders included)
 *   browse (chart.browse) — root `enabled` does NOT apply (viewing only)
 *     tagBrowser.enabled false (absent = true)          → ACTION_DISABLED
 *     binding lint on tagBrowser                        → BOUND_BIDIRECTIONAL
 *     tagBrowser.access                                 → AUTH_REQUIRED / FORBIDDEN_ROLE
 * </pre>
 *
 * <h2>Pen classification (PenInfo.status)</h2>
 * One batched read with the user's context of {@code base, .TagType, .DataType, .EngUnit, .EngLow, .EngHigh,
 * .FormatString, .Documentation, .HistoryEnabled, .HistoryProvider} →
 * {@code notFound | accessDenied | invalidPath (not an AtomicTag) | unsupportedType | noHistory | ok}
 * ({@link #classify}). The delegate adds {@code invalidPath} (path rules), {@code outOfScope} (read scope) and
 * {@code overLimit} (pen cap, new-path budget).
 */
public final class ChartOps {

    private static final LoggerEx TREND = LoggerEx.newBuilder().build("SimpleTagDisplay.Trend");

    /** History aggregations the route accepts (schema enum of {@code query.aggregation}); {@code chart.snapshot.limits}. */
    public static final List<String> AGGREGATIONS = List.of("LastValue", "SimpleAverage", "Average", "Minimum", "Maximum",
        "MinMax", "Range", "Count", "Sum", "StdDev", "Variance", "DurationOn", "DurationOff", "CountOn", "CountOff", "PctGood",
        "PctBad");

    /** Meta keys read per pen, in read order ({@link TagMetaReader} keys). */
    public static final List<String> PEN_META_KEYS = List.of(TagMetaReader.VALUE, TagMetaReader.TAG_TYPE,
        TagMetaReader.DATA_TYPE, TagMetaReader.ENG_UNIT, TagMetaReader.ENG_LOW, TagMetaReader.ENG_HIGH,
        TagMetaReader.FORMAT_STRING, TagMetaReader.DOCUMENTATION, TagMetaReader.HISTORY_ENABLED,
        TagMetaReader.HISTORY_PROVIDER);

    /** Meta keys of the trend-add fresh read. */
    private static final List<String> TREND_ADD_KEYS = List.of(TagMetaReader.VALUE, TagMetaReader.TAG_TYPE,
        TagMetaReader.DATA_TYPE, TagMetaReader.HISTORY_ENABLED, TagMetaReader.HISTORY_PROVIDER);

    private ChartOps() {
    }

    /** What a chart action needs from its delegate. Called on the session queue unless noted. */
    public interface Host {
        /** The current trusted snapshot (re-read after every async hop). */
        PropsSnapshot props();

        /** The current user (compare {@code generation()} after a hop). */
        UserContext user();

        String defaultProvider();

        /** The session's tag manager (project scoped). */
        TagManager tagManager();

        GatewayServices services();

        UUID sessionId();

        /** The chart's current read scope. */
        ReadScope scope();

        /** Continue on the session queue when {@code f} completes or times out (only while the delegate runs). */
        <T> void onQueue(CompletableFuture<T> f, long timeoutMs, BiConsumer<T, Throwable> cb);

        /** History availability of a tag from its metadata (cached provider list). */
        HistoryAvailability.Status history(TagMetaReader.Meta meta);

        RateLimitedLog warnings();

        LoggerEx logger();

        String describe();

        /**
         * The gateway's tag provider names, read now (any thread). Empty when unknown — callers then treat every
         * provider as existing (the tag manager decides).
         */
        default java.util.Collection<String> providerNames() {
            return List.of();
        }
    }

    /** The module-wide meta cache; its per-session entries die with the session and on a user change. */
    public static ChartMetaCache metaCache(GatewayServices services) {
        return services.shared(ChartMetaCache.class, () -> {
            ChartMetaCache c = new ChartMetaCache();
            services.onSessionEnd(c::evictSession);
            services.onUserChange(c::evictSession);
            return c;
        });
    }

    // =========================================================================================================
    // Gates
    // =========================================================================================================

    /**
     * The chart's trend group: the trusted {@code trendGroup} normalized; null = "ignore the session trend list"
     * (null, empty or a non-string value). Absent = the schema default "default".
     */
    public static String trendGroup(PropsSnapshot p) {
        String raw = p.isPresent("trendGroup") ? p.string("trendGroup", null) : "default";
        return TagPaths.normTrendGroup(raw, true);
    }

    /** Trend-list mutation gate (see the class comment); {@code group} null = the chart ignores the trend list. */
    public static Optional<ErrorCode> trendEditGate(PropsSnapshot p, UserContext u, String group) {
        if (!p.gateFlag("enabled", true)) {
            return Optional.of(ErrorCode.DISABLED);
        }
        if (!p.gateFlag("trendEdit.enabled", true) || group == null) {
            return Optional.of(ErrorCode.ACTION_DISABLED);
        }
        Optional<ErrorCode> lint = p.lintGate("enabled", "trendEdit");
        if (lint.isPresent()) {
            return lint;
        }
        return p.access("trendEdit", false).evaluate(u);
    }

    /** Tag browser gate (see the class comment). The root {@code enabled} does not apply: browsing changes nothing. */
    public static Optional<ErrorCode> browseGate(PropsSnapshot p, UserContext u) {
        if (!p.gateFlag("tagBrowser.enabled", ReadScope.TAG_BROWSER_ENABLED_DEFAULT)) {
            return Optional.of(ErrorCode.ACTION_DISABLED);
        }
        Optional<ErrorCode> lint = p.lintGate("tagBrowser");
        if (lint.isPresent()) {
            return lint;
        }
        return p.access("tagBrowser", false).evaluate(u);
    }

    /**
     * {@code annotations {allowed, editAllowed, moderateAllowed, ownOnly, reason}} from the gates alone; the delegate
     * uses {@link AnnotationOps#capability} with the historian's support.
     */
    public static JsonObject annotationsCapability(PropsSnapshot p, UserContext u) {
        return AnnotationOps.capability(p, u, false);
    }

    /** {@code {allowed, reason}} of a gate result. */
    public static JsonObject capability(Optional<ErrorCode> gate) {
        JsonObject o = new JsonObject();
        o.addProperty("allowed", gate.isEmpty());
        if (gate.isEmpty()) {
            o.add("reason", JsonNull.INSTANCE);
        } else {
            o.addProperty("reason", gate.get().name());
        }
        return o;
    }

    // =========================================================================================================
    // Pen metadata and classification
    // =========================================================================================================

    /** Paths of one pen's meta read, keyed {@code "<prefix><metaKey>"}. */
    public static Map<String, TagPath> metaReads(String prefix, TagPath base, List<String> keys) {
        Map<String, TagPath> out = new LinkedHashMap<>();
        for (String k : keys) {
            TagPath p = TagMetaReader.path(base, k, null);
            if (p != null) {
                out.put(prefix + k, p);
            }
        }
        return out;
    }

    /** The values of one pen out of a batched read ({@code "<prefix><metaKey>"} → metaKey). */
    public static Map<String, QualifiedValue> slice(Map<String, QualifiedValue> all, String prefix) {
        Map<String, QualifiedValue> out = new HashMap<>();
        for (Map.Entry<String, QualifiedValue> e : all.entrySet()) {
            if (e.getKey().startsWith(prefix)) {
                out.put(e.getKey().substring(prefix.length()), e.getValue());
            }
        }
        return out;
    }

    /** True for the data types a chart pen can draw (numeric and Boolean scalars). */
    public static boolean trendableType(DataType dt) {
        return dt != null && !dt.isArray() && (dt.isNumeric() || dt == DataType.Boolean);
    }

    /**
     * Classifies a pen from its meta read (see the class comment). Missing reads (null value) count as
     * {@code notFound}; an unknown data type does not block (the history route decides per pen).
     *
     * @param history history availability of the tag ({@link Host#history})
     */
    public static ChartMetaCache.PenMeta classify(Map<String, QualifiedValue> read,
                                                  Function<TagMetaReader.Meta, HistoryAvailability.Status> history) {
        QualifiedValue value = read.get(TagMetaReader.VALUE);
        QualityCode q = value == null ? null : value.getQuality();
        if (q == null || TagPaths.isNotFound(q)) {
            return new ChartMetaCache.PenMeta("notFound", null, null, null);
        }
        if (TagPaths.isAccessDenied(q)) {
            return new ChartMetaCache.PenMeta("accessDenied", null, null, null);
        }
        TagMetaReader.Meta meta = new TagMetaReader.Meta(read);
        String tagType = meta.tagType();
        DataType dt = meta.dataType();
        JsonObject m = metaJson(meta);
        if (tagType != null && !meta.isAtomicTag()) {
            return new ChartMetaCache.PenMeta("invalidPath", m, null, dt);
        }
        HistoryAvailability.Status hs = history.apply(meta);
        JsonObject h = new JsonObject();
        h.addProperty("available", hs.available());
        h.add("provider", hs.toJson().get("provider"));
        if (dt != null && !trendableType(dt)) {
            return new ChartMetaCache.PenMeta("unsupportedType", m, h, dt);
        }
        if (!hs.available()) {
            return new ChartMetaCache.PenMeta("unsupportedType".equals(hs.reason()) ? "unsupportedType" : "noHistory", m, h, dt);
        }
        return new ChartMetaCache.PenMeta("ok", m, h, dt);
    }

    /**
     * The tag facts of one {@code chart.trendAdd} candidate (fresh user-context read): path/quality/tag-type rules
     * ({@link DisplayGates#tagFacts}), then — in the same order as {@link #classify} — the data type before history,
     * so a non-historized String tag is {@code UNSUPPORTED_TYPE} here and {@code unsupportedType} as a pen. Null =
     * trendable.
     */
    static ErrorCode trendAddFacts(Map<String, QualifiedValue> read,
                                   Function<TagMetaReader.Meta, HistoryAvailability.Status> history) {
        TagMetaReader.Meta meta = new TagMetaReader.Meta(read);
        ErrorCode code = DisplayGates.tagFacts(read.get(TagMetaReader.VALUE), meta, true, false, false);
        if (code != null) {
            return code;
        }
        DataType dt = meta.dataType();
        if (dt != null && !trendableType(dt)) {
            return ErrorCode.UNSUPPORTED_TYPE;
        }
        HistoryAvailability.Status hs = history.apply(meta);
        if (!hs.available()) {
            return "unsupportedType".equals(hs.reason()) ? ErrorCode.UNSUPPORTED_TYPE : ErrorCode.NO_HISTORY;
        }
        return null;
    }

    /** PenInfo {@code meta}: {@code {dataType, engUnit, engLow, engHigh, formatString, documentation}}. */
    static JsonObject metaJson(TagMetaReader.Meta meta) {
        JsonObject full = meta.toJson();
        JsonObject o = new JsonObject();
        for (String k : List.of("dataType", "engUnit", "engLow", "engHigh", "formatString", "documentation")) {
            o.add(k, full.has(k) ? full.get(k) : JsonNull.INSTANCE);
        }
        return o;
    }

    // =========================================================================================================
    // Pen names
    // =========================================================================================================

    /** Input of {@link #penNames}: the explicit {@code name} prop (may be empty) and the canonical path (or null). */
    public static final class NameInput {
        final String explicit;
        final TagPath path;
        final String raw;

        public NameInput(String explicit, TagPath path, String raw) {
            this.explicit = explicit == null ? "" : explicit.trim();
            this.path = path;
            this.raw = raw == null ? "" : raw;
        }
    }

    /**
     * Pen labels: the explicit name when set; else the <b>shortest unique path suffix</b> among the chart's effective
     * pens ("Temp"; "Area1/Temp" and "Area2/Temp" when two pens share the tag name; the full path when even that
     * collides). Explicit names count as taken. A pen with an invalid path shows its raw text.
     */
    public static List<String> penNames(List<NameInput> pens) {
        int n = pens.size();
        String[] names = new String[n];
        Map<String, Integer> explicitTaken = new HashMap<>();
        List<Integer> open = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            NameInput p = pens.get(i);
            if (!p.explicit.isEmpty()) {
                names[i] = p.explicit;
                explicitTaken.merge(p.explicit.toLowerCase(Locale.ROOT), 1, Integer::sum);
            } else if (p.path == null) {
                names[i] = p.raw;
            } else {
                open.add(i);
            }
        }
        for (int k = 1; !open.isEmpty(); k++) {
            Map<String, Integer> counts = new HashMap<>();
            Map<Integer, String> candidate = new HashMap<>();
            for (int i : open) {
                String s = suffix(pens.get(i).path, k);
                candidate.put(i, s);
                counts.merge(s.toLowerCase(Locale.ROOT), 1, Integer::sum);
            }
            List<Integer> next = new ArrayList<>();
            for (int i : open) {
                String s = candidate.get(i);
                String lower = s.toLowerCase(Locale.ROOT);
                boolean full = k > pens.get(i).path.getPathLength();
                if ((counts.get(lower) == 1 && !explicitTaken.containsKey(lower)) || full) {
                    names[i] = s;   // unique, or nothing longer exists (the same tag twice keeps its full path)
                } else {
                    next.add(i);
                }
            }
            open = next;
        }
        List<String> out = new ArrayList<>(n);
        for (String s : names) {
            out.add(s);
        }
        return out;
    }

    /** Last {@code k} components joined by "/"; past the full length the full path including the provider. */
    static String suffix(TagPath p, int k) {
        int len = p.getPathLength();
        if (k > len) {
            return p.toStringFull();
        }
        StringBuilder b = new StringBuilder();
        for (int i = len - k; i < len; i++) {
            if (b.length() > 0) {
                b.append('/');
            }
            b.append(p.getPathComponent(i));
        }
        return b.toString();
    }

    // =========================================================================================================
    // Live values (chart.values)
    // =========================================================================================================

    /**
     * {@code {v, q:{code,name,level}, t}} of a live value: Boolean as 1/0, numbers as JSON numbers (non-finite →
     * null), anything else null; {@code t} = the tag timestamp (gateway clock), {@code fallbackT} when the value has
     * none. A value whose quality says access denied carries no {@code v} at all (nothing about a tag the user may not
     * read leaves the gateway).
     */
    public static JsonObject liveValue(QualifiedValue qv, long fallbackT) {
        JsonObject o = new JsonObject();
        QualityCode q = qv == null ? null : qv.getQuality();
        Object v = qv == null ? null : qv.getValue();
        if (q != null && TagPaths.isAccessDenied(q)) {
            o.add("v", JsonNull.INSTANCE);
        } else if (v instanceof Boolean) {
            o.addProperty("v", ((Boolean) v) ? 1 : 0);
        } else if (v instanceof Number) {
            o.add("v", Json.safeNumber(((Number) v).doubleValue()));
        } else {
            o.add("v", JsonNull.INSTANCE);
        }
        o.add("q", ValueCodec.quality(q));
        long t = qv != null && qv.getTimestamp() != null ? qv.getTimestamp().getTime() : fallbackT;
        o.addProperty("t", t);
        return o;
    }

    // =========================================================================================================
    // chart.trendAdd / chart.trendRemove / chart.trendClear
    // =========================================================================================================

    /** Result of the static (no tag I/O) per-path pass of {@code chart.trendAdd}. */
    static final class TrendAddPrecheck {
        /** normalized key → canonical path, first spelling of each tag, in request order */
        final Map<String, TagPath> candidates = new LinkedHashMap<>();
        final JsonArray rejected = new JsonArray();
        final JsonArray duplicates = new JsonArray();
        /** raw path → its error (the single-path reply) */
        final Map<String, ErrorCode> singleError = new HashMap<>();
    }

    /**
     * The static per-path pass of {@code chart.trendAdd} (pure; JUnit): path rules ({@code INVALID_PATH}), duplicates
     * (the same tag named again later in the batch, in any spelling: reported in {@code duplicates} as
     * {@code {tagPath, sameAs}} instead of being dropped silently; the first entry's outcome is the tag's outcome),
     * read scope ({@code OUT_OF_SCOPE}). Every path sent ends up in exactly one of
     * {@code candidates}, {@code rejected} or {@code duplicates}.
     */
    static TrendAddPrecheck trendAddPrecheck(List<String> raws, String defaultProvider, ReadScope scope) {
        TrendAddPrecheck out = new TrendAddPrecheck();
        Map<String, String> firstSpelling = new HashMap<>();   // normalized key -> canonical path of its first entry
        for (String raw : raws) {
            TagPaths.Parsed parsed = TagPaths.parse(raw, defaultProvider);
            if (!parsed.ok()) {
                out.rejected.add(rejection(clip(raw), ErrorCode.INVALID_PATH));
                out.singleError.put(raw, ErrorCode.INVALID_PATH);
                continue;
            }
            String key = TagPaths.normalizedKey(parsed.path());
            String first = firstSpelling.putIfAbsent(key, parsed.path().toStringFull());
            if (first != null) {
                out.duplicates.add(duplicate(clip(raw), first));
                continue;
            }
            if (!scope.allows(key, true)) {
                out.rejected.add(rejection(parsed.path().toStringFull(), ErrorCode.OUT_OF_SCOPE));
                out.singleError.put(raw, ErrorCode.OUT_OF_SCOPE);
                continue;
            }
            out.candidates.put(key, parsed.path());
        }
        return out;
    }

    /** One batch entry that repeats an earlier entry's tag. */
    private static JsonObject duplicate(String tagPath, String sameAs) {
        JsonObject d = new JsonObject();
        d.addProperty("tagPath", tagPath);
        d.addProperty("sameAs", sameAs);
        return d;
    }

    /** One path refused by a batch add. */
    private static JsonObject rejection(String tagPath, ErrorCode code) {
        JsonObject r = new JsonObject();
        r.addProperty("tagPath", tagPath);
        r.addProperty("code", code.name());
        r.addProperty("message", code.defaultMessage());
        return r;
    }

    /**
     * {@code chart.trendAdd {tagPath}} or {@code {tagPaths:[...]}} (1..{@code ctg.trend.maxPens}, one MUTATE token for
     * the batch). Gates → per path: path rules ({@code INVALID_PATH}), read scope ({@code OUT_OF_SCOPE}) → one batched
     * fresh read with the user's context → user generation ({@code AUTH_CHANGED}) and the gates again on the current
     * snapshot → per path: tag facts ({@code TAG_NOT_FOUND}, {@code ACCESS_DENIED}, {@code INVALID_PATH}), history
     * ({@code NO_HISTORY}, {@code UNSUPPORTED_TYPE}), scope again → add ({@code TREND_LIST_FULL}).
     * <pre>
     *   single: {group, count, max}                    (or the error of the path)
     *   batch:  {group, added:[path], rejected:[{tagPath, code, message}], duplicates?:[{tagPath, sameAs}], count, max}
     * </pre>
     */
    public static void trendAdd(CallContext cc, Host h) {
        JsonObject b = cc.body();
        int max = h.services().settings().get().trendMaxPens();
        boolean batch = b.has("tagPaths");
        List<String> raws = new ArrayList<>();
        if (batch) {
            JsonElement arr = b.get("tagPaths");
            if (arr == null || !arr.isJsonArray() || arr.getAsJsonArray().size() == 0 || arr.getAsJsonArray().size() > max) {
                fail(cc, h, ErrorCode.BAD_REQUEST, null, "tagPaths size");
                return;
            }
            for (JsonElement e : arr.getAsJsonArray()) {
                if (e == null || !e.isJsonPrimitive() || !e.getAsJsonPrimitive().isString()) {
                    fail(cc, h, ErrorCode.BAD_REQUEST, null, "tagPaths item");
                    return;
                }
                raws.add(e.getAsString());
            }
        } else {
            String one = Json.string(b, "tagPath", null);
            if (one == null) {
                fail(cc, h, ErrorCode.BAD_REQUEST, null, "missing tagPath");
                return;
            }
            raws.add(one);
        }
        String group = trendGroup(cc.props());
        Optional<ErrorCode> gate = trendEditGate(cc.props(), cc.user(), group);
        if (gate.isPresent()) {
            fail(cc, h, gate.get(), null, "trendEdit gate");
            return;
        }

        // Static per-path checks (no tag I/O).
        TrendAddPrecheck pre = trendAddPrecheck(raws, h.defaultProvider(), h.scope());
        JsonArray rejected = pre.rejected;
        JsonArray duplicates = pre.duplicates;
        Map<String, TagPath> candidates = pre.candidates;
        Map<String, ErrorCode> singleError = pre.singleError;
        if (candidates.isEmpty()) {
            if (!batch) {
                fail(cc, h, singleError.values().iterator().next(), null, "trendAdd path");
            } else {
                replyBatch(cc, h, group, new JsonArray(), rejected, duplicates, max);
            }
            return;
        }

        // One batched fresh read for every candidate (user context).
        Map<String, TagPath> reads = new LinkedHashMap<>();
        List<String> keys = new ArrayList<>(candidates.keySet());
        for (int i = 0; i < keys.size(); i++) {
            reads.putAll(metaReads(i + "|", candidates.get(keys.get(i)), TREND_ADD_KEYS));
        }
        CompletableFuture<Map<String, QualifiedValue>> f;
        try {
            f = TagMetaReader.read(h.tagManager(), reads, cc.user().securityContext());
        } catch (RuntimeException e) {
            h.warnings().warn("trendAdd.read", "Tag read for chart.trendAdd failed on " + h.describe(), e);
            cc.fail(ErrorCode.INTERNAL);
            return;
        }
        h.onQueue(f, h.services().settings().get().readTimeoutMs(), (m, err) -> {
            if (err != null || m == null) {
                if (err instanceof TimeoutException) {
                    cc.fail(ErrorCode.TIMEOUT);
                } else {
                    h.warnings().warn("trendAdd.read", "Tag read for chart.trendAdd failed on " + h.describe(), err);
                    cc.fail(ErrorCode.INTERNAL);
                }
                return;
            }
            // TOCTOU: the same user, the same group, the gates on the snapshot as it is now.
            UserContext user = h.user();
            if (user.generation() != cc.user().generation()) {
                fail(cc, h, ErrorCode.AUTH_CHANGED, null, "trendAdd auth changed");
                return;
            }
            PropsSnapshot now = h.props();
            String groupNow = trendGroup(now);
            if (!java.util.Objects.equals(group, groupNow)) {
                fail(cc, h, ErrorCode.STALE_TARGET, null, "trendAdd group changed");
                return;
            }
            Optional<ErrorCode> again = trendEditGate(now, user, groupNow);
            if (again.isPresent()) {
                fail(cc, h, again.get(), null, "trendEdit gate after read");
                return;
            }
            ReadScope scopeNow = h.scope();
            TrendListStore store = h.services().trendStore();
            JsonArray added = new JsonArray();
            ErrorCode firstError = singleError.isEmpty() ? null : singleError.values().iterator().next();
            boolean full = false;
            for (int i = 0; i < keys.size(); i++) {
                String key = keys.get(i);
                TagPath path = candidates.get(key);
                String full0 = path.toStringFull();
                Map<String, QualifiedValue> one = slice(m, i + "|");
                ErrorCode code = trendAddFacts(one, h::history);
                if (code == null && !scopeNow.allows(key, true)) {
                    code = ErrorCode.OUT_OF_SCOPE;
                }
                if (code == null && full) {
                    code = ErrorCode.TREND_LIST_FULL;
                }
                if (code == null) {
                    TrendListStore.AddResult r = store.add(h.sessionId(), groupNow, full0, user.userName());
                    if (r == TrendListStore.AddResult.FULL || r == TrendListStore.AddResult.GROUPS_FULL) {
                        full = true;
                        code = ErrorCode.TREND_LIST_FULL;
                    } else if (r == TrendListStore.AddResult.ADDED) {
                        TREND.debugf("chart trend add session=%s group=%s user=%s tag=%s", h.sessionId(), groupNow,
                            Json.sanitizeForLog(user.userName()), Json.sanitizeForLog(full0));
                    }
                }
                if (code == null) {
                    added.add(full0);
                } else {
                    rejected.add(rejection(full0, code));
                    if (firstError == null) {
                        firstError = code;
                    }
                }
            }
            if (batch) {
                replyBatch(cc, h, groupNow, added, rejected, duplicates, max);
            } else if (added.size() == 0) {
                JsonObject d = null;
                if (firstError == ErrorCode.TREND_LIST_FULL) {
                    d = new JsonObject();
                    d.addProperty("max", max);
                }
                fail(cc, h, firstError == null ? ErrorCode.INTERNAL : firstError, d, "trendAdd");
            } else {
                JsonObject data = new JsonObject();
                data.addProperty("group", groupNow);
                data.addProperty("count", store.get(h.sessionId(), groupNow).size());
                data.addProperty("max", max);
                cc.reply(data);
            }
        });
    }

    /**
     * Batch reply. {@code duplicates} (an optional, additive field) lists the entries that named a tag already named
     * earlier in the same batch, as {@code {tagPath: <as sent, clipped>, sameAs: <canonical path of the first entry>}};
     * it is present only when non-empty, so {@code added.length + rejected.length + duplicates.length} always equals the
     * number of paths sent.
     */
    private static void replyBatch(CallContext cc, Host h, String group, JsonArray added, JsonArray rejected,
                                   JsonArray duplicates, int max) {
        JsonObject data = new JsonObject();
        data.addProperty("group", group);
        data.add("added", added);
        data.add("rejected", rejected);
        if (duplicates.size() > 0) {
            data.add("duplicates", duplicates);
        }
        data.addProperty("count", h.services().trendStore().get(h.sessionId(), group).size());
        data.addProperty("max", max);
        cc.reply(data);
    }

    /** {@code chart.trendRemove {tagPath}} → {@code {group, count}}. Same gates as add; no scope or history check. */
    public static void trendRemove(CallContext cc, Host h) {
        String raw = Json.string(cc.body(), "tagPath", null);
        if (raw == null) {
            fail(cc, h, ErrorCode.BAD_REQUEST, null, "missing tagPath");
            return;
        }
        String group = trendGroup(cc.props());
        Optional<ErrorCode> gate = trendEditGate(cc.props(), cc.user(), group);
        if (gate.isPresent()) {
            fail(cc, h, gate.get(), null, "trendEdit gate");
            return;
        }
        TagPaths.Parsed parsed = TagPaths.parse(raw, h.defaultProvider());
        if (!parsed.ok()) {
            fail(cc, h, ErrorCode.INVALID_PATH, null, "trendRemove path");
            return;
        }
        TrendListStore store = h.services().trendStore();
        String full = parsed.path().toStringFull();
        if (store.remove(h.sessionId(), group, full)) {
            TREND.debugf("chart trend remove session=%s group=%s user=%s tag=%s", h.sessionId(), group,
                Json.sanitizeForLog(cc.user().userName()), Json.sanitizeForLog(full));
        }
        JsonObject data = new JsonObject();
        data.addProperty("group", group);
        data.addProperty("count", store.get(h.sessionId(), group).size());
        cc.reply(data);
    }

    /** {@code chart.trendClear {}} → {@code {group, count:0}}. */
    public static void trendClear(CallContext cc, Host h) {
        String group = trendGroup(cc.props());
        Optional<ErrorCode> gate = trendEditGate(cc.props(), cc.user(), group);
        if (gate.isPresent()) {
            fail(cc, h, gate.get(), null, "trendEdit gate");
            return;
        }
        TrendListStore store = h.services().trendStore();
        store.clear(h.sessionId(), group);
        TREND.debugf("chart trend clear session=%s group=%s user=%s", h.sessionId(), group,
            Json.sanitizeForLog(cc.user().userName()));
        JsonObject data = new JsonObject();
        data.addProperty("group", group);
        data.addProperty("count", store.get(h.sessionId(), group).size());
        cc.reply(data);
    }

    // =========================================================================================================
    // Helpers
    // =========================================================================================================

    /** Validation failure: reply with the code, log at DEBUG only (a client must not be able to trigger a WARN). */
    static void fail(CallContext cc, Host h, ErrorCode code, JsonObject details, String where) {
        h.logger().debugf("%s %s refused: %s on %s", cc.name(), where, code, h.describe());
        cc.fail(code, details);
    }

    /** A client path echoed in a rejection: at most 256 characters, control characters replaced. */
    static String clip(String raw) {
        String s = raw == null ? "" : raw.replaceAll("\\p{Cntrl}", "?");
        return s.length() > 256 ? s.substring(0, 256) : s;
    }

    /** JSON string or null. */
    static JsonElement str(String s) {
        return s == null ? JsonNull.INSTANCE : new JsonPrimitive(s);
    }
}
