package com.example.simpletagdisplay.gateway.delegate;

import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.BiConsumer;

import com.example.simpletagdisplay.common.DisplayTemplateComponent;
import com.example.simpletagdisplay.common.protocol.ErrorCode;
import com.example.simpletagdisplay.common.protocol.Protocol;
import com.example.simpletagdisplay.gateway.GatewayServices;
import com.example.simpletagdisplay.gateway.ModuleSettings;
import com.example.simpletagdisplay.gateway.audit.CtgAudit;
import com.example.simpletagdisplay.gateway.delegate.HandlerRegistry.RateClass;
import com.example.simpletagdisplay.gateway.ops.DisplayGates;
import com.example.simpletagdisplay.gateway.ops.DisplayOps;
import com.example.simpletagdisplay.gateway.ops.SettingsFanOut;
import com.example.simpletagdisplay.gateway.perspective.PerspectiveInternals;
import com.example.simpletagdisplay.gateway.security.SecurityKeys;
import com.example.simpletagdisplay.gateway.security.UserContext;
import com.example.simpletagdisplay.gateway.tags.HistoryAvailability;
import com.example.simpletagdisplay.gateway.tags.TagMetaReader;
import com.example.simpletagdisplay.gateway.tags.TagPaths;
import com.example.simpletagdisplay.gateway.tags.TagSubscriber;
import com.example.simpletagdisplay.gateway.tags.ValueCodec;
import com.example.simpletagdisplay.gateway.trend.TrendKey;
import com.example.simpletagdisplay.gateway.trend.TrendListListener;
import com.example.simpletagdisplay.gateway.trend.TrendListStore;
import com.example.simpletagdisplay.gateway.util.Json;
import com.example.simpletagdisplay.gateway.util.RateLimitedLog;
import com.example.simpletagdisplay.gateway.util.TokenBucket;
import com.inductiveautomation.ignition.common.gson.JsonArray;
import com.inductiveautomation.ignition.common.gson.JsonElement;
import com.inductiveautomation.ignition.common.gson.JsonNull;
import com.inductiveautomation.ignition.common.gson.JsonObject;
import com.inductiveautomation.ignition.common.model.values.QualifiedValue;
import com.inductiveautomation.ignition.common.model.values.QualityCode;
import com.inductiveautomation.ignition.common.sqltags.model.types.DataType;
import com.inductiveautomation.ignition.common.tags.model.TagManager;
import com.inductiveautomation.ignition.common.tags.model.TagPath;
import com.inductiveautomation.ignition.common.util.LoggerEx;
import com.inductiveautomation.ignition.gateway.audit.AuditProfile;
import com.inductiveautomation.perspective.common.api.ComponentEventDescriptor;
import com.inductiveautomation.perspective.gateway.api.Component;
import com.inductiveautomation.perspective.gateway.property.PropertyTreeChangeEvent;

/**
 * Gateway half of the Display Template.
 *
 * <h2>What the client receives</h2>
 * <pre>
 *   dt.snapshot  {status, tagPath, tagName, value, meta, history, alarms, capabilities, trend, writeLimits}
 *   dt.values    any subset of {value, meta, history, alarms, capabilities, trend, writeLimits} that changed
 *   ctg.hb       after ctg.display.heartbeatMs of silence (base class)
 * </pre>
 * {@code status} = loading | ok | noTagPath | invalidPath | notFound | accessDenied. For {@code accessDenied} the
 * value is sent without {@code v} and {@code meta}/{@code alarms}/{@code history} are null: nothing about a tag the
 * user may not read leaves the gateway. Sections are pushed only when their JSON changed.
 *
 * <h2>Conditional subscriptions</h2>
 * <pre>
 *   value                       always (only this one while notFound / accessDenied)
 *   alarmActive, alarmUnacked   alarms.colorMode "live", or "auto" and the tag has an alarm configuration
 *   alarmLowSp / alarmHighSp    bounds.enabled && bounds.useAlarmLimits && the alarm name is set (and valid)
 *   engLow, engHigh             (bounds.enabled && bounds.useEngLimits) || setpoint.enabled
 * </pre>
 * Everything else (DataType, FormatString, EngUnit, CanWrite, ReadOnly, Documentation, Tooltip, HistoryEnabled,
 * HistoryProvider, TagType, alarm presence) is one batched read on start, on every hello, every
 * {@code ctg.display.metaRefreshMs} and right after a successful config edit. A display with defaults on a tag
 * without alarms holds 1 subscription; with live alarms + bounds + setpoint on engineering limits, 5.
 *
 * <h2>Liveness</h2>
 * {@code ctg.hb} heartbeat (base); a 60 s self-check re-reads the value and, when it differs from what the
 * subscription delivered and no change event arrived meanwhile, resubscribes ({@code action=subscription-repair}
 * WARN, rate-limited). {@code tagPath} changes push a {@code loading} snapshot at once (old subscriptions are
 * released first, so the old tag's value can never appear under the new name) and resubscribe after a 250 ms
 * trailing debounce, each resubscription consuming a READ-class token.
 *
 * <h2>Actions</h2>
 * {@code dt.write}, {@code dt.configEdit}, {@code dt.trendAdd}, {@code dt.trendRemove}, {@code dt.auditQuery}:
 * {@link DisplayOps}. While {@code ctg.debug} is on, test hooks {@code dt.debug.info}, {@code dt.debug.killSubscription},
 * {@code dt.debug.selfCheck} answer; otherwise they are unknown messages.
 */
public final class DisplayTemplateDelegate extends CtgDelegateBase {

    /** Debug-only test hooks (they answer only while {@code ctg.debug} is on). */
    static final String DEBUG_INFO = "dt.debug.info";
    static final String DEBUG_KILL = "dt.debug.killSubscription";
    static final String DEBUG_SELF_CHECK = "dt.debug.selfCheck";

    private static final long TAG_PATH_DEBOUNCE_MS = 250L;
    private static final long SELF_CHECK_MS = 60_000L;
    private static final long META_RETRY_MS = 5_000L;
    private static final long PROFILE_CACHE_MS = 60_000L;

    /** Root keys watched for changes; the component's security keys ({@link SecurityKeys#DISPLAY}) live under them. */
    private static final String[] WATCHED = {"tagPath", "enabled", "trendGroup", "setpoint", "alarms", "bounds", "menu"};
    /** Paths whose binding configuration the binding probe reports (DEBUG). */
    private static final String[] PROBED = {"tagPath", "enabled", "setpoint", "setpoint.enabled", "setpoint.access",
        "setpoint.access.roles", "setpoint.limits.low", "menu.trend.enabled"};

    // ---- session-queue state ----------------------------------------------------------------------------
    private String defaultProvider;
    private String rawTagPath = "";
    private TagPath tagPath;                 // null when noTagPath / invalidPath
    private String status = "loading";
    private TagMetaReader.Meta meta = TagMetaReader.Meta.empty();
    private boolean metaLoaded;
    private long targetGen;                  // bumps on every retarget; reads of an older target are ignored
    private String repairedSignature;       // read/subscription difference of the last self-check repair
    private final Map<String, String> sent = new HashMap<>();
    private TrendKey trendKey;
    private ScheduledFuture<?> retargetTimer;
    private ScheduledFuture<?> metaRetry;
    private Optional<AuditProfile> profileCache = Optional.empty();
    private boolean profileFresh;
    private long profileAt;
    private final TokenBucket resubscribeTokens = new TokenBucket(RateClass.READ.perSecond(), RateClass.READ.burst());

    // ---- shared with tag / scheduler threads ------------------------------------------------------------------
    private final TagSubscriber subscriber;
    private final AtomicBoolean flushScheduled = new AtomicBoolean(false);
    private volatile long lastFlushAt;
    private volatile ScheduledFuture<?> metaTimer;
    private volatile ScheduledFuture<?> selfCheckTimer;
    private final TrendListListener trendListener = (key, paths, version) -> runOnQueue(this::onTrendChanged);
    private final Host host = new Host();
    /**
     * Settings reload → re-push what depends on settings: the advisory
     * {@code capabilities} follow the rebuilt floor policy and {@code ctg.audit.*} at once instead of at the next value
     * change, and {@code trend.max} follows {@code ctg.trend.maxPens}.
     */
    private final Runnable onSettingsChanged = () -> runOnQueue(this::settingsChanged);
    private volatile SettingsFanOut fanOut;

    public DisplayTemplateDelegate(Component component, GatewayServices services) {
        super(component, services, Protocol.KIND_DISPLAY, "displaytemplate",
            DisplayTemplateComponent.EVENTS.stream().map(ComponentEventDescriptor::getName).toList(),
            "SimpleTagDisplay.Display", SecurityKeys.DISPLAY);
        this.subscriber = new TagSubscriber(this::subscriptionTagManager, this::scheduleFlush,
            err -> warnings.warn("DisplayTemplateDelegate.subscribe", "Tag subscription failed on " + describe(), err));
    }

    /**
     * Tag manager for the subscriptions: the session's, or the gateway's while Perspective destroys a session whose
     * project was deleted (then {@code session().getTagManager()} is null, and releasing the listeners would fail
     * with an NPE). Paths are fully qualified and each listener carries the user's context, so it releases exactly
     * what was subscribed; a subscribe in that window uses the fallback too, which is harmless.
     */
    private TagManager subscriptionTagManager() {
        TagManager tm = session().getTagManager();
        return tm != null ? tm : services.gatewayContext().getTagManager();
    }

    // =========================================================================================================
    // Lifecycle
    // =========================================================================================================

    @Override
    protected void registerHandlers(HandlerRegistry r) {
        r.on(Protocol.DT_WRITE, RateClass.MUTATE, cc -> DisplayOps.write(cc, host));
        r.on(Protocol.DT_CONFIG_EDIT, RateClass.MUTATE, cc -> DisplayOps.configEdit(cc, host));
        r.on(Protocol.DT_TREND_ADD, RateClass.MUTATE, cc -> DisplayOps.trendAdd(cc, host));
        r.on(Protocol.DT_TREND_REMOVE, RateClass.MUTATE, cc -> DisplayOps.trendRemove(cc, host));
        r.on(Protocol.DT_AUDIT_QUERY, RateClass.READ, cc -> DisplayOps.auditQuery(cc, host));
        r.on(DEBUG_INFO, RateClass.READ, this::debugInfo);
        r.on(DEBUG_KILL, RateClass.READ, this::debugKill);
        r.on(DEBUG_SELF_CHECK, RateClass.READ, this::debugSelfCheck);
    }

    @Override
    protected String snapshotEventName() {
        return Protocol.DT_SNAPSHOT;
    }

    @Override
    protected void start() {
        defaultProvider = PerspectiveInternals.projectDefaultTagProvider(services.gatewayContext(), session().getProjectName());
        watchProps(WATCHED);
        probeBindings(PROBED);
        enableHeartbeat();   // ctg.hb after ctg.display.heartbeatMs of silence (static tags push nothing)
        registerTrend();
        fanOut = SettingsFanOut.of(services);
        fanOut.add(onSettingsChanged);
        if (isClosed()) {
            // teardown ran off the queue while start() was running and may have read fanOut before it was set: the
            // callback must not stay in the module-wide fan-out holding this delegate
            fanOut.remove(onSettingsChanged);
            return;
        }
        scheduleMetaRefresh();
        selfCheckTimer = schedule(() -> runOnQueue(() -> selfCheck(null)), SELF_CHECK_MS, SELF_CHECK_MS);
        // tagPath is a security key: always the TRUSTED value (a browser write is reverted).
        beginTarget(props().string("tagPath", ""));
        loadTarget();
    }

    @Override
    protected void stop() {
        cancel(retargetTimer);
        cancel(metaRetry);
        cancel(metaTimer);
        cancel(selfCheckTimer);
        SettingsFanOut f = fanOut;
        if (f != null) {
            f.remove(onSettingsChanged);   // the instance from start(): services.shared() refuses once the module closed
        }
        subscriber.release();
        TrendKey k = trendKey;
        if (k != null) {
            services.trendStore().removeListener(k, trendListener);
        }
    }

    @Override
    protected void onHello(boolean resync) {
        push(Protocol.DT_SNAPSHOT, buildSnapshot());
        if (tagPath != null && metaLoaded) {
            readMeta(targetGen, false);   // meta re-read on every (re)sync
        }
    }

    @Override
    protected void onAuthChanged() {
        // Listener contexts are fixed at subscription time: resubscribe with the new user at once (DirectTagBinding
        // does the same). A user who may not read the tag now gets accessDenied. Capabilities follow in the snapshot
        // the base class pushes after this call.
        profileFresh = false;
        beginTarget(rawTagPath);
        loadTarget();
    }

    @Override
    protected void onPropsChanged(String rootKey, PropertyTreeChangeEvent event) {
        switch (rootKey) {
            case "tagPath":
                onTagPathMaybeChanged();
                return;
            case "trendGroup":
                registerTrend();
                pushSections();
                return;
            default:
                // enabled / setpoint / menu / alarms / bounds: conditional subscriptions, capabilities, limits.
                if (updateSubscriptions(true) && tagPath != null && metaLoaded) {
                    readMeta(targetGen, false);   // values for keys that were just added
                }
                pushSections();
        }
    }

    // =========================================================================================================
    // Target (tag path) handling
    // =========================================================================================================

    private void onTagPathMaybeChanged() {
        String raw = props().string("tagPath", "");
        if (keyOf(raw).equals(keyOf(rawTagPath))) {
            return;
        }
        beginTarget(raw);
        cancel(retargetTimer);
        retargetTimer = schedule(() -> runOnQueue(this::loadTarget), TAG_PATH_DEBOUNCE_MS, 0);
    }

    private String keyOf(String raw) {
        TagPaths.Parsed p = TagPaths.parse(raw, defaultProvider);
        return p.ok() ? TagPaths.normalizedKey(p.path()) : "!" + raw;
    }

    /**
     * Switches to {@code raw} immediately: the old subscriptions are released (and their values dropped) BEFORE the
     * {@code loading} snapshot goes out, so nothing of the previous tag can be pushed under the new name.
     */
    private void beginTarget(String raw) {
        if (isClosed()) {
            return;
        }
        rawTagPath = raw == null ? "" : raw;
        targetGen++;
        cancel(metaRetry);
        meta = TagMetaReader.Meta.empty();
        metaLoaded = false;
        repairedSignature = null;
        subscriber.apply(Map.of(), user().securityContext(), false);
        TagPaths.Parsed parsed = TagPaths.parse(rawTagPath, defaultProvider);
        if (!parsed.ok()) {
            tagPath = null;
            status = parsed.error() == ErrorCode.NO_TAG_PATH ? "noTagPath" : "invalidPath";
        } else {
            tagPath = parsed.path();
            status = "loading";
        }
        push(Protocol.DT_SNAPSHOT, buildSnapshot());
    }

    /** Reads the target's metadata, then subscribes (debounced caller; one READ token per resubscription). */
    private void loadTarget() {
        if (isClosed() || tagPath == null || metaLoaded) {
            return;
        }
        if (!resubscribeTokens.tryAcquire()) {
            cancel(retargetTimer);
            retargetTimer = schedule(() -> runOnQueue(this::loadTarget), TAG_PATH_DEBOUNCE_MS, 0);
            return;
        }
        readMeta(targetGen, true);
    }

    /** One batched read of the value, every meta property and the alarm properties in use (user context). */
    private void readMeta(long gen, boolean initial) {
        TagPath base = tagPath;
        if (base == null || isClosed()) {
            return;
        }
        Map<String, TagPath> reads = new LinkedHashMap<>();
        reads.put(TagMetaReader.VALUE, base);
        for (String k : TagMetaReader.metaKeys()) {
            reads.put(k, TagMetaReader.path(base, k, null));
        }
        reads.put(TagMetaReader.ALARM_ACTIVE, TagMetaReader.path(base, TagMetaReader.ALARM_ACTIVE, null));
        reads.put(TagMetaReader.ALARM_UNACKED, TagMetaReader.path(base, TagMetaReader.ALARM_UNACKED, null));
        if (boundsUseAlarms()) {
            reads.put(TagMetaReader.ALARM_LOW_SP, TagMetaReader.path(base, TagMetaReader.ALARM_LOW_SP, lowAlarmName()));
            reads.put(TagMetaReader.ALARM_HIGH_SP, TagMetaReader.path(base, TagMetaReader.ALARM_HIGH_SP, highAlarmName()));
        }
        CompletableFuture<Map<String, QualifiedValue>> f;
        try {
            f = TagMetaReader.read(session().getTagManager(), reads, user().securityContext());
        } catch (RuntimeException e) {
            warnings.warn("DisplayTemplateDelegate.meta", "Tag metadata read failed on " + describe(), e);
            retryMeta(gen, initial);
            return;
        }
        onQueue(f, services.settings().get().readTimeoutMs(), (m, err) -> afterMeta(gen, base, initial, m, err));
    }

    private void afterMeta(long gen, TagPath base, boolean initial, Map<String, QualifiedValue> m, Throwable err) {
        if (gen != targetGen || !base.equals(tagPath)) {
            return;   // re-pointed meanwhile
        }
        if (err != null || m == null || !m.containsKey(TagMetaReader.VALUE)) {
            logger.debugf("meta read failed on %s: %s", describe(), err == null ? "no value" : err.toString());
            retryMeta(gen, initial);
            return;
        }
        QualifiedValue value = m.get(TagMetaReader.VALUE);
        String newStatus = ValueCodec.status(value == null ? null : value.getQuality());
        boolean statusChanged = !newStatus.equals(status);
        status = newStatus;
        meta = new TagMetaReader.Meta(m);
        metaLoaded = true;
        refreshProfile(true);
        updateSubscriptions(!initial);
        long sg = subscriber.generation();
        for (String key : subscriber.paths().keySet()) {
            // After the first read the value only ever comes from the subscription: a periodic re-read must not
            // paper over a dead subscription (the self-check compares the two and repairs it with a WARN).
            if (initial || !TagMetaReader.VALUE.equals(key)) {
                subscriber.seed(sg, key, m.get(key));
            }
        }
        if (initial || statusChanged) {
            push(Protocol.DT_SNAPSHOT, buildSnapshot());
        } else {
            pushSections();
        }
    }

    private void retryMeta(long gen, boolean initial) {
        cancel(metaRetry);
        metaRetry = schedule(() -> runOnQueue(() -> {
            if (gen == targetGen) {
                readMeta(gen, initial);
            }
        }), META_RETRY_MS, 0);
    }

    /** Periodic meta re-read; the interval is the live {@code ctg.display.metaRefreshMs}. */
    private void scheduleMetaRefresh() {
        long ms = services.settings().get().displayMetaRefreshMs();
        metaTimer = schedule(() -> {
            runOnQueue(() -> {
                if (tagPath != null && metaLoaded) {
                    readMeta(targetGen, false);
                }
            });
            if (!isClosed()) {
                scheduleMetaRefresh();
            }
        }, ms, 0);
    }

    // =========================================================================================================
    // Conditional subscriptions
    // =========================================================================================================

    /** The keys this display needs right now (see the class comment). Session queue. */
    private Map<String, TagPath> wanted() {
        Map<String, TagPath> w = new LinkedHashMap<>();
        TagPath base = tagPath;
        if (base == null) {
            return w;
        }
        w.put(TagMetaReader.VALUE, base);
        if (!"ok".equals(status)) {
            return w;   // notFound / accessDenied / loading: the value only
        }
        if (alarmsLive()) {
            w.put(TagMetaReader.ALARM_ACTIVE, TagMetaReader.path(base, TagMetaReader.ALARM_ACTIVE, null));
            w.put(TagMetaReader.ALARM_UNACKED, TagMetaReader.path(base, TagMetaReader.ALARM_UNACKED, null));
        }
        if (boundsUseAlarms()) {
            putIfPath(w, TagMetaReader.ALARM_LOW_SP, TagMetaReader.path(base, TagMetaReader.ALARM_LOW_SP, lowAlarmName()));
            putIfPath(w, TagMetaReader.ALARM_HIGH_SP, TagMetaReader.path(base, TagMetaReader.ALARM_HIGH_SP, highAlarmName()));
        }
        boolean boundsEng = uiBool("bounds.enabled", false) && uiBool("bounds.useEngLimits", true);
        if (boundsEng || props().bool("setpoint.enabled", false)) {
            w.put(TagMetaReader.ENG_LOW, TagMetaReader.path(base, TagMetaReader.ENG_LOW, null));
            w.put(TagMetaReader.ENG_HIGH, TagMetaReader.path(base, TagMetaReader.ENG_HIGH, null));
        }
        return w;
    }

    private static void putIfPath(Map<String, TagPath> w, String key, TagPath p) {
        if (p != null) {
            w.put(key, p);
        }
    }

    /** Applies {@link #wanted()}; true when the subscribed set changed. Session queue. */
    private boolean updateSubscriptions(boolean carryOver) {
        boolean changed = subscriber.apply(wanted(), user().securityContext(), carryOver);
        if (changed && logger.isDebugEnabled()) {
            logger.debugf("subscriptions n=%d total=%d keys=%s on %s", subscriber.size(), TagSubscriber.totalSubscribed(),
                subscriber.paths().keySet(), describe());
        }
        return changed;
    }

    /** Live alarm colours: colorMode "live", or "auto" when the tag has an alarm configuration. */
    private boolean alarmsLive() {
        String mode = props().string("alarms.colorMode", "auto");
        return "live".equals(mode) || ("auto".equals(mode) && meta.hasAlarms());
    }

    private boolean boundsUseAlarms() {
        return uiBool("bounds.enabled", false) && uiBool("bounds.useAlarmLimits", true)
            && (TagMetaReader.validAlarmName(lowAlarmName()) || TagMetaReader.validAlarmName(highAlarmName()));
    }

    private String lowAlarmName() {
        return props().string("bounds.lowAlarmName", "").trim();
    }

    private String highAlarmName() {
        return props().string("bounds.highAlarmName", "").trim();
    }

    /** A UI-only boolean prop (not a security key) read from the live tree. Session queue. */
    private boolean uiBool(String path, boolean fallback) {
        JsonElement e = readProp(path);
        return e != null && e.isJsonPrimitive() && e.getAsJsonPrimitive().isBoolean() ? e.getAsBoolean() : fallback;
    }

    // =========================================================================================================
    // Coalesced value pushes
    // =========================================================================================================

    /** Tag thread: leading edge after idle, then at most one flush per {@code ctg.display.coalesceMs}. */
    private void scheduleFlush() {
        if (!flushScheduled.compareAndSet(false, true)) {
            return;
        }
        long coalesceMs = services.settings().get().displayCoalesceMs();
        long delay = Math.max(0, coalesceMs - (System.currentTimeMillis() - lastFlushAt));
        try {
            services.scheduler().schedule(this::flush, delay, TimeUnit.MILLISECONDS);
        } catch (RejectedExecutionException e) {
            flushScheduled.set(false);   // module stopping
        }
    }

    private void flush() {
        lastFlushAt = System.currentTimeMillis();
        flushScheduled.set(false);
        runOnQueue(this::flushOnQueue);
    }

    /** Session queue: a status change (tag deleted / created / permission) re-reads meta; else deltas. */
    private void flushOnQueue() {
        QualifiedValue v = subscriber.value(TagMetaReader.VALUE);
        if (v != null && metaLoaded) {
            String st = ValueCodec.status(v.getQuality());
            if (!st.equals(status)) {
                status = st;
                updateSubscriptions(true);
                push(Protocol.DT_SNAPSHOT, buildSnapshot());
                readMeta(targetGen, false);
                return;
            }
        }
        pushSections();
    }

    // =========================================================================================================
    // Snapshot and sections
    // =========================================================================================================

    @Override
    protected JsonObject buildSnapshot() {
        JsonObject s = new JsonObject();
        s.addProperty("status", status);
        if (tagPath != null) {
            s.addProperty("tagPath", tagPath.toStringFull());
            s.addProperty("tagName", TagPaths.tagName(tagPath));
        } else {
            s.addProperty("tagPath", rawTagPath);
            s.addProperty("tagName", "");
        }
        Map<String, JsonElement> sections = sections();
        sent.clear();
        for (Map.Entry<String, JsonElement> e : sections.entrySet()) {
            s.add(e.getKey(), e.getValue());
            sent.put(e.getKey(), e.getValue().toString());
        }
        return s;
    }

    /** Pushes the sections whose JSON changed since they were last sent (push caps applied). Session queue. */
    private void pushSections() {
        if (!helloReceived()) {
            return;
        }
        JsonObject delta = new JsonObject();
        for (Map.Entry<String, JsonElement> e : sections().entrySet()) {
            String json = e.getValue().toString();
            if (!json.equals(sent.get(e.getKey()))) {
                delta.add(e.getKey(), e.getValue());
                sent.put(e.getKey(), json);
            }
        }
        if (delta.size() == 0) {
            return;
        }
        int max = services.settings().get().pushMaxBytes();
        if (delta.has("meta") && delta.toString().length() > max) {
            delta.remove("meta");      // meta deltas are dropped first; the next refresh resends them
            sent.remove("meta");
        }
        if (delta.has("value") && delta.toString().length() > max) {
            JsonObject v = new JsonObject();
            v.add("v", JsonNull.INSTANCE);
            v.addProperty("truncated", true);
            v.addProperty("summary", "value too large to send");
            delta.add("value", v);
        }
        if (delta.size() > 0) {
            push(Protocol.DT_VALUES, delta);
        }
    }

    private Map<String, JsonElement> sections() {
        Map<String, JsonElement> out = new LinkedHashMap<>();
        boolean ok = "ok".equals(status) && metaLoaded;
        TagMetaReader.Meta eff = effectiveMeta();
        out.put("value", valueJson(eff));
        out.put("meta", ok ? eff.toJson() : JsonNull.INSTANCE);
        out.put("history", ok ? host.history(eff).toJson() : JsonNull.INSTANCE);
        out.put("alarms", ok ? alarmsJson(eff) : JsonNull.INSTANCE);
        out.put("capabilities", capabilities(eff));
        // Heartbeat and tag-operation timeouts, so the client derives its silence limit and its
        // request deadlines from the gateway's settings; a live settings change is pushed like any other section.
        out.put("timing", timing(services.settings().get()));
        out.put("trend", trendJson());
        out.put("writeLimits", ok ? DisplayGates.limits(props(), eff.dataType(), eff).toJson() : JsonNull.INSTANCE);
        return out;
    }

    /** Metadata from the last read, overlaid with the subscribed meta keys (fresher). */
    private TagMetaReader.Meta effectiveMeta() {
        TagMetaReader.Meta m = meta;
        for (Map.Entry<String, QualifiedValue> e : subscriber.values().entrySet()) {
            if (!TagMetaReader.VALUE.equals(e.getKey())) {
                m = m.with(e.getKey(), e.getValue());
            }
        }
        return m;
    }

    /** Current value: the subscription's, else the meta read's (between read and first event). */
    private QualifiedValue currentValue() {
        QualifiedValue v = subscriber.value(TagMetaReader.VALUE);
        return v != null ? v : meta.raw(TagMetaReader.VALUE);
    }

    private JsonElement valueJson(TagMetaReader.Meta eff) {
        if (tagPath == null || "loading".equals(status)) {
            return JsonNull.INSTANCE;
        }
        QualifiedValue v = currentValue();
        if (v == null) {
            return JsonNull.INSTANCE;
        }
        if ("accessDenied".equals(status) || TagPaths.isAccessDenied(v.getQuality())) {
            JsonObject o = new JsonObject();   // never the value of a tag the user may not read
            o.add("v", JsonNull.INSTANCE);
            o.add("q", ValueCodec.quality(v.getQuality()));
            return o;
        }
        DataType dt = eff.dataType();
        return ValueCodec.encode(v, dt == null ? null : dt.name(), services.settings().get().pushMaxValueBytes());
    }

    private JsonObject alarmsJson(TagMetaReader.Meta eff) {
        boolean live = alarmsLive();
        JsonObject o = new JsonObject();
        o.addProperty("live", live);
        String active = live ? eff.alarmPriority(TagMetaReader.ALARM_ACTIVE) : null;
        String unacked = live ? eff.alarmPriority(TagMetaReader.ALARM_UNACKED) : null;
        o.addProperty("hasActive", active != null);
        o.addProperty("hasUnacked", unacked != null);
        o.addProperty("highestActivePriority", active);
        o.addProperty("highestUnackedPriority", unacked);
        JsonObject limits = new JsonObject();
        boolean use = boundsUseAlarms();
        limits.add("low", use ? alarmLimit(lowAlarmName(), eff.good(TagMetaReader.ALARM_LOW_SP)) : JsonNull.INSTANCE);
        limits.add("high", use ? alarmLimit(highAlarmName(), eff.good(TagMetaReader.ALARM_HIGH_SP)) : JsonNull.INSTANCE);
        o.add("limits", limits);
        return o;
    }

    private static JsonElement alarmLimit(String name, Object sp) {
        if (!TagMetaReader.validAlarmName(name)) {
            return JsonNull.INSTANCE;
        }
        double d = ValueCodec.toDouble(sp);
        JsonObject o = new JsonObject();
        o.addProperty("name", name);
        o.add("value", Json.safeNumber(d));
        return o;
    }

    private JsonObject trendJson() {
        JsonObject o = new JsonObject();
        TrendKey k = trendKey;
        String group = k == null ? "default" : k.group();
        List<TrendListStore.Entry> entries = k == null ? List.of() : services.trendStore().get(k.sessionId(), group);
        String key = tagPath == null ? null : TagPaths.normalizedKey(tagPath);
        boolean trending = key != null && entries.stream().anyMatch(e -> e.key().equals(key));
        o.addProperty("group", group);
        o.addProperty("trending", trending);
        o.addProperty("count", entries.size());
        o.addProperty("max", services.settings().get().trendMaxPens());
        return o;
    }

    // =========================================================================================================
    // Capabilities (advisory; every action re-checks — DisplayGates is the single source of truth)
    // =========================================================================================================

    private JsonObject capabilities(TagMetaReader.Meta eff) {
        UserContext u = user();
        PropsSnapshot p = props();
        ModuleSettings.Settings s = services.settings().get();
        Optional<AuditProfile> profile = auditProfile();
        boolean auditMissingRequired = audit().refuses(s.auditRequired(), profile);   // no profile, or a full audit writer
        boolean ready = "ok".equals(status) && metaLoaded;
        QualifiedValue cur = currentValue();

        // write
        DisplayGates.Target w = DisplayGates.write(p, u, services.floorPolicy(), defaultProvider, auditMissingRequired);
        ErrorCode wr = w.error() != null ? w.error() : statusReason();
        if (wr == null && ready) {
            wr = DisplayGates.tagFacts(cur, eff, p.bool("setpoint.allowOnBadQuality", false), true, true);
            if (wr == null && Boolean.FALSE.equals(eff.canWrite())) {
                wr = ErrorCode.WRITE_DENIED;   // advisory: .CanWrite is evaluated for this user (tag Write Permissions)
            }
            if (wr == null) {
                DisplayGates.Limits lim = DisplayGates.limits(p, eff.dataType(), eff);
                wr = lim.applies() ? lim.error() : null;
            }
            if (wr == null) {
                wr = DisplayGates.stepConfigError(p);
            }
        }
        JsonObject write = capability(wr, ready);
        gatewayDetails(write, w, wr, DisplayGates.writeOverrides(p, services.floorPolicy(), defaultProvider), u);
        write.addProperty("audit", profile.isPresent() ? "profile" : "none");

        // config edit
        DisplayGates.Target c = DisplayGates.configEdit(p, u, services.floorPolicy(), defaultProvider, auditMissingRequired);
        ErrorCode cr = c.error() != null ? c.error() : statusReason();
        if (cr == null && ready) {
            cr = DisplayGates.tagFacts(cur, eff, true, false, false);
        }

        // trend
        DisplayGates.Target t = DisplayGates.trend(p, u, defaultProvider);
        ErrorCode tr = t.error() != null ? t.error() : statusReason();
        if (tr == null && ready) {
            tr = DisplayGates.tagFacts(cur, eff, true, false, false);
            boolean trending = trendJson().get("trending").getAsBoolean();
            if (tr == null && !trending) {
                HistoryAvailability.Status hs = host.history(eff);
                if (!hs.available()) {
                    tr = "unsupportedType".equals(hs.reason()) ? ErrorCode.UNSUPPORTED_TYPE : ErrorCode.NO_HISTORY;
                }
            }
        }

        // change history
        // change history: the rows carry values, so it follows the read status exactly like the other actions
        // (accessDenied / notFound → not allowed; dt.auditQuery re-checks Read with a fresh user-context read)
        DisplayGates.Target h = DisplayGates.changeHistory(p, u, defaultProvider, profile.isPresent());
        ErrorCode hr = h.error() != null ? h.error() : statusReason();
        if (hr == null && ready) {
            hr = DisplayGates.tagFacts(cur, eff, true, false, false);
        }

        JsonObject configEdit = capability(cr, ready);
        gatewayDetails(configEdit, c, cr, DisplayGates.configEditOverrides(p, services.floorPolicy(), defaultProvider), u);

        JsonObject o = new JsonObject();
        o.add("write", write);
        o.add("configEdit", configEdit);
        o.add("trend", capability(tr, ready));
        o.add("changeHistory", capability(hr, ready));
        return o;
    }

    /**
     * Gateway-side details of a capability: {@code setting} = the gateway setting that refuses an action the component
     * itself allows (so the bubble / tooltip can name it), and, in Designer sessions only, {@code overrides} = the
     * gateway settings that make this component's access config stricter for its tag, whoever the user is (the
     * Designer hint). Runtime sessions never get {@code overrides}: it names the gateway's floor configuration.
     */
    private static void gatewayDetails(JsonObject cap, DisplayGates.Target gate, ErrorCode reason, List<String> overrides,
                                       UserContext u) {
        if (gate.setting() != null && reason == gate.error()) {
            cap.addProperty("setting", gate.setting());
        }
        if (u.isDesigner() && !overrides.isEmpty()) {
            JsonArray a = new JsonArray();
            overrides.forEach(a::add);
            cap.add("overrides", a);
        }
    }

    /** {@code {allowed, reason}}; while the tag is still loading nothing is allowed and the reason is null. */
    private static JsonObject capability(ErrorCode reason, boolean ready) {
        JsonObject o = new JsonObject();
        o.addProperty("allowed", reason == null && ready);
        if (reason == null) {
            o.add("reason", JsonNull.INSTANCE);
        } else {
            o.addProperty("reason", reason.name());
        }
        return o;
    }

    /** Reason implied by the display status (null for ok / loading). */
    private ErrorCode statusReason() {
        switch (status) {
            case "notFound":
                return ErrorCode.TAG_NOT_FOUND;
            case "accessDenied":
                return ErrorCode.ACCESS_DENIED;
            case "noTagPath":
                return ErrorCode.NO_TAG_PATH;
            case "invalidPath":
                return ErrorCode.INVALID_PATH;
            default:
                return null;
        }
    }

    // =========================================================================================================
    // Trend list
    // =========================================================================================================

    /** (Re)registers for the session trend list of the trusted {@code trendGroup}. Session queue. */
    private void registerTrend() {
        UUID sid = sessionId();
        if (sid == null || isClosed()) {
            return;
        }
        String group = TagPaths.normTrendGroup(props().string("trendGroup", "default"), false);
        TrendKey k = new TrendKey(sid, group);
        if (k.equals(trendKey)) {
            return;
        }
        if (trendKey != null) {
            services.trendStore().removeListener(trendKey, trendListener);
        }
        trendKey = k;
        services.trendStore().addListener(k, trendListener);
    }

    private void onTrendChanged() {
        pushSections();
    }

    /**
     * Session queue, after a settings reload that changed something ({@link SettingsFanOut}). The audit profile is looked
     * up again ({@code ctg.audit.fallbackProfile} may have changed) and every section is recomputed; only sections whose
     * JSON changed are pushed (usually {@code capabilities}, sometimes {@code trend}), so a reload that does not concern
     * this display sends nothing.
     */
    private void settingsChanged() {
        if (isClosed()) {
            return;
        }
        profileFresh = false;
        pushSections();
    }

    // =========================================================================================================
    // Self-check
    // =========================================================================================================

    /**
     * Re-reads the value; if it differs from what the subscription delivered and no change event arrived while
     * reading, the subscription is considered dead: resubscribe, push the read value, WARN
     * {@code action=subscription-repair} (rate-limited). {@code cc} (debug hook) gets {@code {repaired}}.
     */
    private void selfCheck(CallContext cc) {
        TagPath base = tagPath;
        if (base == null || !"ok".equals(status) || !metaLoaded || subscriber.size() == 0) {
            replyRepaired(cc, false, "not subscribed");
            return;
        }
        long gen = targetGen;
        long events = subscriber.eventCount();
        QualifiedValue last = subscriber.value(TagMetaReader.VALUE);
        CompletableFuture<List<QualifiedValue>> f;
        try {
            f = session().getTagManager().readAsync(List.of(base), user().securityContext());
        } catch (RuntimeException e) {
            replyRepaired(cc, false, "read failed");
            return;
        }
        onQueue(f, services.settings().get().readTimeoutMs(), (vals, err) -> {
            if (err != null || vals == null || vals.isEmpty() || gen != targetGen) {
                replyRepaired(cc, false, "read failed");
                return;
            }
            QualifiedValue now = vals.get(0);
            if (subscriber.eventCount() != events || !differs(last, now)) {
                replyRepaired(cc, false, "healthy");
                return;
            }
            // Not every difference is a dead subscription. Only a Good read is evidence of the tag's real value (a
            // UDT definition member reads Bad_Unsupported while its subscription delivers the default value, Good),
            // and a difference that survives a resubscription unchanged is a semantic difference between read and
            // subscription, not a lost listener: repair once, then stop (DEBUG only).
            boolean readGood = now.getQuality() != null && now.getQuality().isGood();
            String signature = signature(last) + " | " + signature(now);
            if (!readGood || signature.equals(repairedSignature)) {
                logger.debugf("self-check: read/subscription difference (%s) on %s is not evidence of a dead subscription",
                    Json.sanitizeForLog(signature), describe());
                replyRepaired(cc, false, "not evidence");
                return;
            }
            repairedSignature = signature;
            warnings.warn("subscription-repair", "action=subscription-repair " + describe()
                + ": the tag value changed but the subscription delivered nothing; resubscribed");
            subscriber.apply(Map.of(), user().securityContext(), false);
            updateSubscriptions(false);
            subscriber.seed(subscriber.generation(), TagMetaReader.VALUE, now);
            readMeta(targetGen, false);
            pushSections();
            replyRepaired(cc, true, "repaired");
        });
    }

    private static void replyRepaired(CallContext cc, boolean repaired, String why) {
        if (cc != null) {
            JsonObject d = new JsonObject();
            d.addProperty("repaired", repaired);
            d.addProperty("result", why);
            cc.reply(d);
        }
    }

    private static String signature(QualifiedValue q) {
        if (q == null) {
            return "none";
        }
        return (q.getQuality() == null ? "?" : q.getQuality().getName()) + "=" + ValueCodec.plain(q.getValue());
    }

    private static boolean differs(QualifiedValue a, QualifiedValue b) {
        if (a == null || b == null) {
            return a != b;
        }
        QualityCode qa = a.getQuality();
        QualityCode qb = b.getQuality();
        if ((qa == null ? 0 : qa.getCode()) != (qb == null ? 0 : qb.getCode())) {
            return true;
        }
        Object va = a.getValue();
        Object vb = b.getValue();
        if (va instanceof Number && vb instanceof Number) {
            return Double.compare(((Number) va).doubleValue(), ((Number) vb).doubleValue()) != 0;
        }
        if (va != null && vb != null && (va.getClass().isArray() || vb.getClass().isArray())) {
            // arrays (Float8Array ...): compare contents, never references
            return !ValueCodec.plain(va).equals(ValueCodec.plain(vb));
        }
        return !Objects.equals(va, vb);
    }

    // =========================================================================================================
    // Debug hooks (only while ctg.debug is on; otherwise indistinguishable from unknown messages)
    // =========================================================================================================

    private boolean debugOff(CallContext cc) {
        if (!services.debugEnabled()) {
            cc.fail(ErrorCode.UNKNOWN_MESSAGE);
            return true;
        }
        return false;
    }

    /** {@code dt.debug.info {}} → subscription counters. */
    private void debugInfo(CallContext cc) {
        if (debugOff(cc)) {
            return;
        }
        JsonObject d = new JsonObject();
        d.addProperty("status", status);
        d.addProperty("subscriptions", subscriber.size());
        d.addProperty("totalSubscriptions", TagSubscriber.totalSubscribed());
        JsonArray keys = new JsonArray();
        subscriber.paths().keySet().forEach(keys::add);
        d.add("keys", keys);
        d.addProperty("generation", subscriber.generation());
        d.addProperty("events", subscriber.eventCount());
        cc.reply(d);
    }

    /** {@code dt.debug.killSubscription {key?}}: silently drops one listener (tests the self-check repair). */
    private void debugKill(CallContext cc) {
        if (debugOff(cc)) {
            return;
        }
        String key = Json.string(cc.body(), "key", TagMetaReader.VALUE);
        boolean killed = subscriber.killForTest(key);
        logger.infof("debug: subscription %s killed=%s on %s", Json.sanitizeForLog(key), killed, describe());
        JsonObject d = new JsonObject();
        d.addProperty("killed", killed);
        cc.reply(d);
    }

    /** {@code dt.debug.selfCheck {}}: runs the 60 s self-check now. */
    private void debugSelfCheck(CallContext cc) {
        if (debugOff(cc)) {
            return;
        }
        selfCheck(cc);
    }

    /** Debug-only delay (ms) from system property {@code name}, 0..30000; 0 unless {@code ctg.debug} is on. */
    private long debugDelay(String name) {
        if (!services.debugEnabled()) {
            return 0;
        }
        try {
            return Math.max(0, Math.min(30_000, Long.parseLong(System.getProperty(name, "0").trim())));
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    // =========================================================================================================
    // Helpers
    // =========================================================================================================

    /** Audit profile (project, else fallback), cached for a minute. Session queue. */
    private Optional<AuditProfile> auditProfile() {
        refreshProfile(false);
        return profileCache;
    }

    private void refreshProfile(boolean force) {
        long now = System.currentTimeMillis();
        if (force || !profileFresh || now - profileAt >= PROFILE_CACHE_MS) {
            profileCache = audit().profile(component);
            profileAt = now;
            profileFresh = true;
        }
    }

    private CtgAudit audit() {
        return services.shared(CtgAudit.class, () -> new CtgAudit(services.gatewayContext(), services.scheduler(),
            x -> services.settings().get().auditFallbackProfile()));
    }

    private HistoryAvailability historyAvailability() {
        return services.shared(HistoryAvailability.class, HistoryAvailability::new);
    }

    /** Schedules on the module scheduler; {@code periodMs > 0} = fixed delay. Null when the module is stopping. */
    private ScheduledFuture<?> schedule(Runnable task, long delayMs, long periodMs) {
        if (isClosed()) {
            return null;
        }
        try {
            return periodMs > 0
                ? services.scheduler().scheduleWithFixedDelay(task, delayMs, periodMs, TimeUnit.MILLISECONDS)
                : services.scheduler().schedule(task, delayMs, TimeUnit.MILLISECONDS);
        } catch (RejectedExecutionException e) {
            return null;
        }
    }

    private static void cancel(ScheduledFuture<?> f) {
        if (f != null) {
            f.cancel(false);
        }
    }

    /** {@link DisplayOps.Host} over this delegate. */
    private final class Host implements DisplayOps.Host {
        @Override
        public PropsSnapshot props() {
            return DisplayTemplateDelegate.this.props();
        }

        @Override
        public UserContext user() {
            return DisplayTemplateDelegate.this.user();
        }

        @Override
        public String defaultProvider() {
            return defaultProvider;
        }

        @Override
        public TagManager tagManager() {
            return session().getTagManager();
        }

        @Override
        public GatewayServices services() {
            return services;
        }

        @Override
        public Component component() {
            return component;
        }

        @Override
        public CtgAudit audit() {
            return DisplayTemplateDelegate.this.audit();
        }

        @Override
        public Optional<AuditProfile> auditProfile() {
            return DisplayTemplateDelegate.this.auditProfile();
        }

        @Override
        public <T> void onQueue(CompletableFuture<T> f, long timeoutMs, BiConsumer<T, Throwable> cb) {
            DisplayTemplateDelegate.this.onQueue(f, timeoutMs, cb);
        }

        @Override
        public void fire(String event, JsonObject payload) {
            if (!isClosed()) {
                component.fireEvent(DisplayOps.EVENT_TYPE, event, payload);
            }
        }

        @Override
        public UUID sessionId() {
            return DisplayTemplateDelegate.this.sessionId();
        }

        @Override
        public String trendGroup() {
            return TagPaths.normTrendGroup(props().string("trendGroup", "default"), false);
        }

        @Override
        public HistoryAvailability.Status history(TagMetaReader.Meta m) {
            return historyAvailability().check(m, () -> session().getTagHistoryManager().getTagHistoryProviders());
        }

        @Override
        public void configEdited() {
            if (tagPath != null && metaLoaded) {
                readMeta(targetGen, false);
            }
        }

        @Override
        public RateLimitedLog warnings() {
            return warnings;
        }

        @Override
        public LoggerEx logger() {
            return logger;
        }

        @Override
        public String describe() {
            return DisplayTemplateDelegate.this.describe();
        }

        @Override
        public long debugReadDelayMs() {
            return debugDelay("ctg.debug.dt.readDelayMs");
        }

        @Override
        public long debugWriteDelayMs() {
            return debugDelay("ctg.debug.dt.writeDelayMs");
        }
    }
}
