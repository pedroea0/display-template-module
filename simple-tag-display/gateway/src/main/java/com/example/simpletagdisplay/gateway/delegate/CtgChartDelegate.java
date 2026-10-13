package com.example.simpletagdisplay.gateway.delegate;

import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BiConsumer;
import java.util.function.Predicate;

import com.example.simpletagdisplay.common.CtgChartComponent;
import com.example.simpletagdisplay.common.protocol.ErrorCode;
import com.example.simpletagdisplay.common.protocol.Protocol;
import com.example.simpletagdisplay.gateway.GatewayServices;
import com.example.simpletagdisplay.gateway.ModuleSettings;
import com.example.simpletagdisplay.gateway.annotations.AnnotationService;
import com.example.simpletagdisplay.gateway.audit.CtgAudit;
import com.example.simpletagdisplay.gateway.browse.TagBrowseService;
import com.example.simpletagdisplay.gateway.delegate.HandlerRegistry.RateClass;
import com.example.simpletagdisplay.gateway.history.BucketLadder;
import com.example.simpletagdisplay.gateway.history.HistoryService;
import com.example.simpletagdisplay.gateway.history.HistoryTokenStore;
import com.example.simpletagdisplay.gateway.ops.AnnotationOps;
import com.example.simpletagdisplay.gateway.ops.ChartMetaCache;
import com.example.simpletagdisplay.gateway.ops.ChartOps;
import com.example.simpletagdisplay.gateway.ops.SettingsFanOut;
import com.example.simpletagdisplay.gateway.ops.DesignPens;
import com.example.simpletagdisplay.gateway.perspective.PerspectiveInternals;
import com.example.simpletagdisplay.gateway.security.ReadScope;
import com.example.simpletagdisplay.gateway.security.SecurityKeys;
import com.example.simpletagdisplay.gateway.security.TrustedProps;
import com.example.simpletagdisplay.gateway.security.UserContext;
import com.example.simpletagdisplay.gateway.tags.HistoryAvailability;
import com.example.simpletagdisplay.gateway.tags.TagMetaReader;
import com.example.simpletagdisplay.gateway.tags.TagPaths;
import com.example.simpletagdisplay.gateway.tags.TagSubscriber;
import com.example.simpletagdisplay.gateway.trend.TrendKey;
import com.example.simpletagdisplay.gateway.trend.TrendListListener;
import com.example.simpletagdisplay.gateway.trend.TrendListStore;
import com.example.simpletagdisplay.gateway.util.Json;
import com.example.simpletagdisplay.gateway.util.RateLimitedLog;
import com.inductiveautomation.ignition.common.gson.JsonArray;
import com.inductiveautomation.ignition.common.gson.JsonElement;
import com.inductiveautomation.ignition.common.gson.JsonNull;
import com.inductiveautomation.ignition.common.gson.JsonObject;
import com.inductiveautomation.ignition.common.model.values.QualifiedValue;
import com.inductiveautomation.ignition.common.model.values.QualityCode;
import com.inductiveautomation.ignition.common.tags.model.TagManager;
import com.inductiveautomation.ignition.common.tags.model.TagPath;
import com.inductiveautomation.ignition.common.util.LoggerEx;
import com.inductiveautomation.ignition.gateway.audit.AuditProfile;
import com.inductiveautomation.ignition.gateway.historian.TagHistoryManager;
import com.inductiveautomation.perspective.common.api.ComponentEventDescriptor;
import com.inductiveautomation.perspective.gateway.api.Component;
import com.inductiveautomation.perspective.gateway.property.PropertyTreeChangeEvent;

/**
 * Gateway half of the Click To Graph Chart.
 *
 * <h2>What the client receives</h2>
 * <pre>
 *   chart.snapshot  {pens:[PenInfo], trend:{group, paths, max}, trendEdit, readScope, tagBrowser, annotations,
 *                    limits:{...}, history:{url, token, expiresAt} | null}
 *   chart.pens      {pens, trend, trendEdit, readScope, tagBrowser, annotations, reason}   only when it changed
 *   chart.values    {values:{penKey:{v, q:{code,name,level}, t}}}                          ≤ 1 per ctg.chart.liveCoalesceMs
 *   chart.token     {url, token, expiresAt}                                                rotation / auth / annotations
 *   ctg.hb          after ctg.display.heartbeatMs of silence (base class)
 * </pre>
 *
 * <h2>Effective pens</h2>
 * The enabled entries of the {@code pens} prop (key {@code "p:<index>"}) followed by the session trend list of the
 * chart's {@code trendGroup} (key {@code "t:<normalized path>"}, stable across reorders) minus tags already among the
 * static pens. Each pen gets one status:
 * <pre>
 *   overLimit        position ≥ ctg.trend.maxPens, or over the new-path budget (ctg.chart.maxNewPathsPerMinute)
 *   invalidPath      path rules (TagPaths), or not an AtomicTag
 *   outOfScope       ReadScope.allows(key, runtime) false — no metadata, no subscription, no history
 *   loading          metadata not read yet. Transient: snapshots and chart.pens wait for an in-flight read (at most
 *                    ctg.read.timeoutMs); it is only sent when a read failed (retried after 5 s) and in the snapshot
 *                    the base class pushes right after a login/logout
 *   notFound | accessDenied | unsupportedType | noHistory | ok     from the user-context meta read (ChartOps.classify)
 * </pre>
 * Metadata comes from the session-level {@link ChartMetaCache} (60 s TTL, keyed by the user's permission identity);
 * misses are read in one batched {@code readAsync} with the user's context. A pen is "runtime" when its tag was not in
 * {@code pens} as the Designer configured it ({@link DesignPens}: the start value plus the <em>delta</em> of every
 * later change whose origin is not {@code Browser} — a binding on {@code pens[0].name} adopts nothing, one on
 * {@code pens[1].tagPath} adopts that entry's tag only; in the Designer every change counts). Trend-list pens are
 * always in scope.
 *
 * <h2>Reconciliation</h2>
 * Changes of {@code pens}, {@code trendGroup}, the trend list (a display's Trend Tag in any tab of the session, or
 * this chart's own adds) and of security props are debounced 250 ms (trailing, at most 1 s after the first change),
 * then one {@link #reconcile} rebuilds the scope, the pen list and the subscriptions and pushes {@code chart.pens}
 * if — and only if — its JSON changed. A burst of five trend adds therefore yields one push.
 *
 * <h2>Live values</h2>
 * One {@link TagSubscriber} subscription per distinct tag of the pens whose status is {@code ok}, {@code notFound}
 * or {@code noHistory}, with the user's security context. {@code ok} and {@code noHistory} pens push
 * {@code chart.values} with the tag timestamp (Boolean as 1/0), coalesced to {@code ctg.chart.liveCoalesceMs}. The
 * subscriptions use the session's tag manager, or the gateway's while Perspective destroys the session of a deleted
 * project ({@link #subscriptionTagManager}); that fallback also serves a subscribe in that window, which is harmless
 * (fully qualified paths, the user's security context on every listener). A quality
 * flip (tag deleted / created / access lost) invalidates that tag's metadata and reconciles, so statuses follow the
 * tag without polling.
 *
 * <h2>History tokens</h2>
 * Every token this delegate issues carries {@link #penGate}, which consults the delegate's <em>current</em>
 * {@link ReadScope} — props, auth and trend-list changes apply to tokens already issued. A login/logout revokes the
 * session's tokens (base class / {@code GatewayServices.authChanged}); {@link #onAuthChanged} drops every subscription
 * at once (no value of the previous user's tags is pushed after the change), clears the pen statuses, reissues and
 * pushes a token, and re-reads the metadata with the new user.
 *
 * <h2>Actions</h2>
 * {@code chart.trendAdd} / {@code trendRemove} / {@code trendClear} ({@link ChartOps}), {@code chart.browse}
 * ({@link TagBrowseService}), {@code chart.token}, {@code chart.annotationSave} / {@code chart.annotationDelete}
 * ({@link AnnotationOps}; the annotation capability in snapshots also says {@code ANNOTATIONS_UNSUPPORTED} once
 * every pen's historian is known not to support annotations). While {@code ctg.debug} is on, {@code chart.debug.info} answers with
 * counters (subscriptions, meta reads, new-path budget, scope); otherwise it is an unknown message.
 */
public final class CtgChartDelegate extends CtgDelegateBase {

    /** Debug-only message: internal counters for diagnostics and tests. */
    static final String DEBUG_INFO = "chart.debug.info";

    /** A token with less than this left is replaced when a snapshot is built (the client renews at 2 min too). */
    private static final long TOKEN_RENEW_BEFORE_MS = 120_000L;
    private static final long PEN_DEBOUNCE_MS = 250L;
    private static final long PEN_MAX_WAIT_MS = 1_000L;
    private static final long META_REFRESH_MS = 300_000L;
    private static final long META_RETRY_MS = 5_000L;
    private static final long BUDGET_WINDOW_MS = 60_000L;
    private static final int MAX_SEEN_KEYS = 4_096;
    /**
     * Pens past {@code ctg.trend.maxPens} that are still listed (as {@code overLimit}); every further entry of a
     * (client-written) {@code pens} array is only counted ({@code overLimitCount}) — bounds the work and the size of
     * {@code chart.pens} / {@code chart.snapshot} whatever the array length.
     */
    static final int OVER_LIMIT_LISTED = 32;
    /** Longest raw tagPath / explicit name echoed in a PenInfo (a valid path is at most TagPaths.MAX_LENGTH). */
    private static final int MAX_ECHO_CHARS = TagPaths.MAX_LENGTH;

    private static final String STATUS_LOADING = "loading";

    /** Non-security roots watched for the pen list (security roots are watched by the base class). */
    private static final String[] WATCHED = {"pens"};
    private static final String[] PROBED = {"pens", "enabled", "trendGroup", "readScope.allowRuntimePens",
        "readScope.allowedRoots", "tagBrowser.enabled", "trendEdit.enabled"};

    private static final AtomicBoolean DESIGNER_TOKEN_REFUSED_LOGGED = new AtomicBoolean(false);
    private static final AtomicBoolean SESSION_FULL_LOGGED = new AtomicBoolean(false);

    /** One effective pen as of the last reconciliation. Session queue only. */
    private static final class Pen {
        final String key;
        final String source;
        final Integer index;
        final String raw;
        final String explicitName;
        final TagPath path;          // canonical, null when invalid
        final String nkey;           // normalized key, null when invalid
        final boolean runtime;
        String status;               // null while undecided inside reconcile()
        ChartMetaCache.PenMeta meta;

        Pen(String key, String source, Integer index, String raw, String explicitName, TagPath path, boolean runtime) {
            this.key = key;
            this.source = source;
            this.index = index;
            this.raw = raw == null ? "" : raw;
            this.explicitName = explicitName == null ? "" : explicitName;
            this.path = path;
            this.nkey = path == null ? null : TagPaths.normalizedKey(path);
            this.runtime = runtime;
        }
    }

    // ---- session-queue state ----------------------------------------------------------------------------
    private HistoryTokenStore.TokenInfo token;
    private boolean tokenAnnotations;
    /** The last issue was refused by the per-session cap (transient). */
    private boolean tokenSessionFull;
    private String defaultProvider;
    /** Shadow of the Designer-configured pens; never rebuilt from the live array outside the Designer. */
    private DesignPens design = DesignPens.EMPTY;
    private Set<String> designKeys = Set.of();
    private TrendKey trendKey;
    private List<Pen> pens = List.of();
    /** Enabled pens beyond the listed ones ({@link #OVER_LIMIT_LISTED}), as of the last reconciliation. */
    private int overLimitCount;
    private String lastPensJson;
    private String pendingReason = "props";
    private boolean snapshotPending;
    private long firstDirtyAt;
    private ScheduledFuture<?> debounceTimer;
    private ScheduledFuture<?> retryTimer;
    private ScheduledFuture<?> budgetTimer;
    private final Set<String> pendingKeys = new HashSet<>();
    private final Map<String, Long> failedUntil = new HashMap<>();
    /**
     * Last value pushed per pen key (chart.values deltas): normalized key, a NUL separator, value signature. Pruned on every
     * publish to the pens the client was told are {@code ok} under the same tag, so a pen that leaves (disabled,
     * outOfScope, overLimit, removed) and comes back under the same key gets its current value again (a static tag
     * would otherwise never be re-sent).
     */
    private final Map<String, String> lastLive = new HashMap<>();
    /** Pens the last published PenInfo list shows as {@code ok}: pen key → normalized key. Values go only to these. */
    private Map<String, String> publishedOk = Map.of();
    /** Signature of the last value examined per tag (quality flips are acted on once per change). */
    private final Map<String, String> lastSeen = new HashMap<>();
    private final LinkedHashSet<String> seenKeys = new LinkedHashSet<>();
    private long budgetWindowStart;
    private int budgetUsed;
    private boolean budgetWarned;
    private long metaReadPaths;
    private long metaReadBatches;
    private long reconciles;
    private long valuesPushed;

    // ---- shared with tag / scheduler / Jetty threads ------------------------------------------------------------
    private final AtomicReference<ReadScope> scope = new AtomicReference<>(ReadScope.NONE);
    /** The pen gate of every token this delegate issues: the CURRENT scope (history route, any thread). */
    private final HistoryTokenStore.PenGate penGate = key -> scope.get().allows(key);
    private final TagSubscriber subscriber;
    private final AtomicBoolean flushScheduled = new AtomicBoolean(false);
    private volatile long lastFlushAt;
    private volatile ScheduledFuture<?> metaTimer;
    private final TrendListListener trendListener = (key, paths, version) -> runOnQueue(() -> requestReconcile("trend"));
    private final Host host = new Host();
    private final TagBrowseService browser = new TagBrowseService();
    /** Audit profile cache (annotation changes; same TTL as the display delegate's). Session queue. */
    private static final long PROFILE_CACHE_MS = 60_000L;
    private Optional<AuditProfile> profileCache;
    private long profileAt;
    /**
     * Settings reload → re-evaluate scope, pens and subscriptions (so {@code ctg.read.deniedProviders},
     * {@code ctg.trend.maxPens}, … reach a running chart within the 250 ms debounce instead of at its next change), and
     * a changed {@code limits} object reaches the running chart at once (see {@link #settingsChanged()}).
     */
    private final Runnable onSettingsChanged = () -> runOnQueue(this::settingsChanged);
    private volatile SettingsFanOut fanOut;
    /** JSON of the {@code limits} the client has (the last snapshot's); session queue. */
    private String lastLimitsJson;

    public CtgChartDelegate(Component component, GatewayServices services) {
        super(component, services, Protocol.KIND_CHART, "ctgchart",
            CtgChartComponent.EVENTS.stream().map(ComponentEventDescriptor::getName).toList(),
            "SimpleTagDisplay.Chart", SecurityKeys.CHART);
        this.subscriber = new TagSubscriber(this::subscriptionTagManager, this::scheduleFlush,
            err -> warnings.warn("CtgChartDelegate.subscribe", "Tag subscription failed on " + describe(), err));
    }

    /**
     * Tag manager for the live-value subscriptions: the session's, or, while Perspective destroys a session whose
     * project was deleted ({@code session().getTagManager()} returns null), the gateway's, so the stop still releases
     * the listeners (same fallback as {@code DisplayTemplateDelegate}).
     */
    private TagManager subscriptionTagManager() {
        TagManager tm = session().getTagManager();
        return tm != null ? tm : services.gatewayContext().getTagManager();
    }

    // =========================================================================================================
    // Lifecycle
    // =========================================================================================================

    @Override
    protected void registerHandlers(HandlerRegistry registry) {
        registry.on(Protocol.CHART_TOKEN, RateClass.TOKEN, cc -> {
            HistoryTokenStore.TokenInfo t = issueToken();
            if (t == null) {
                // sessionFull is transient (BUSY: the client keeps retrying); anything else is not
                cc.fail(tokenSessionFull ? ErrorCode.BUSY : ErrorCode.SESSION_MISMATCH);
            } else {
                cc.reply(historyCredentials(t));
            }
        });
        registry.on(Protocol.CHART_TREND_ADD, RateClass.MUTATE, cc -> ChartOps.trendAdd(cc, host));
        registry.on(Protocol.CHART_TREND_REMOVE, RateClass.MUTATE, cc -> ChartOps.trendRemove(cc, host));
        registry.on(Protocol.CHART_TREND_CLEAR, RateClass.MUTATE, cc -> ChartOps.trendClear(cc, host));
        registry.on(Protocol.CHART_BROWSE, RateClass.READ, cc -> browser.browse(cc, host, providerNames()));
        registry.on(DEBUG_INFO, RateClass.READ, this::debugInfo);
        registry.on(Protocol.CHART_ANNOTATION_SAVE, RateClass.MUTATE, cc -> AnnotationOps.save(cc, host));
        registry.on(Protocol.CHART_ANNOTATION_DELETE, RateClass.MUTATE, cc -> AnnotationOps.delete(cc, host));
    }

    @Override
    protected String snapshotEventName() {
        return Protocol.CHART_SNAPSHOT;
    }

    @Override
    protected void start() {
        defaultProvider = PerspectiveInternals.projectDefaultTagProvider(services.gatewayContext(), session().getProjectName());
        // Every pen present at start is a Designer pen (view config, popup/page params; start values are adopted).
        setDesign(DesignPens.of(readProp("pens"), this::keyOf));
        watchProps(WATCHED);
        probeBindings(PROBED);
        enableHeartbeat();   // static pens push nothing: the client watchdog still sees the chart alive
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
        reconcile(false);    // metadata reads start now, so the hello snapshot is usually complete at once
    }

    @Override
    protected void stop() {
        // Every step runs even when an earlier one throws: a failure in the subscriber release or
        // the settings fan-out must not skip browser.stop(), which returns a running tag search's gateway-wide
        // admission slot (4 leaked slots = every search on the gateway BUSY until a module restart). The first
        // failure is rethrown afterwards, so the base teardown still logs it.
        teardownSteps(
            () -> {
                cancel(debounceTimer);
                cancel(retryTimer);
                cancel(budgetTimer);
                cancel(metaTimer);
            },
            () -> {
                SettingsFanOut f = fanOut;
                if (f != null) {
                    f.remove(onSettingsChanged);   // the instance from start(): services.shared() refuses once the module closed
                }
            },
            subscriber::release,
            browser::stop,      // a running tag search returns its admission slot
            () -> {
                TrendKey k = trendKey;
                if (k != null) {
                    services.trendStore().removeListener(k, trendListener);
                }
            });
        // Tokens are revoked by the base teardown (owner = this delegate); prop subscriptions likewise.
    }

    /** Runs every step in order; a RuntimeException of one step does not skip the next; the first is rethrown. */
    static void teardownSteps(Runnable... steps) {
        RuntimeException first = null;
        for (Runnable step : steps) {
            try {
                step.run();
            } catch (RuntimeException e) {
                if (first == null) {
                    first = e;
                } else {
                    first.addSuppressed(e);
                }
            }
        }
        if (first != null) {
            throw first;
        }
    }

    @Override
    protected JsonObject welcomeLimits() {
        JsonObject l = new JsonObject();
        l.addProperty("maxPens", services.settings().get().trendMaxPens());
        return l;
    }

    /**
     * Hello (first or resync): the snapshot goes out as soon as every pen's metadata is known (cache hit or the read
     * started at {@link #start()}), at the latest after {@code ctg.read.timeoutMs}; live values are re-sent after it.
     */
    @Override
    protected void onHello(boolean resync) {
        snapshotPending = true;
        lastLive.clear();
        lastPensJson = null;
        reconcile(true);
    }

    @Override
    protected void onAuthChanged() {
        // The first delegate of the session that saw the change revoked every token of the session; issue ours anew.
        if (helloReceived()) {
            HistoryTokenStore.TokenInfo t = issueToken();
            if (t != null) {
                push(Protocol.CHART_TOKEN, historyCredentials(t));
            }
        } else {
            token = null;
        }
        // Nothing read with the previous user's context may reach the client any more: drop the subscriptions now
        // (listener contexts are fixed at subscription time), forget statuses, re-read with the new user. The base
        // class pushes the snapshot after this call; it shows the pens as "loading" until the reads complete.
        subscriber.apply(Map.of(), user().securityContext(), false);
        browser.authChanged();   // a tag search of the previous user ends now (AUTH_CHANGED), its results are dropped
        lastLive.clear();
        lastSeen.clear();
        failedUntil.clear();
        reconcile(false);
    }

    @Override
    protected void onPropsChanged(String rootKey, PropertyTreeChangeEvent event) {
        switch (rootKey) {
            case "pens":
                // Designer pens: in the Designer every change is adopted, so the whole array is
                // re-read. Elsewhere only the delta a non-Browser change (Binding, Script, Project) wrote at its path
                // is adopted — re-reading the live array would also adopt every entry a browser wrote earlier
                // (a binding on pens[0].name would launder runtime pens into Designer pens).
                if (user().isDesigner()) {
                    setDesign(DesignPens.of(readProp("pens"), this::keyOf));
                } else if (!TrustedProps.clientControlled(event.origin)) {
                    // (A BindingWriteback from a bidirectional binding on another prop relays a
                    // client value, like a Browser write; neither becomes a Designer pen.)
                    setDesign(design.apply(event.path == null ? null : event.path.toString(), causalValue(event),
                        this::keyOf));
                }
                requestReconcile("props");
                return;
            case "trendGroup":
                registerTrend();
                requestReconcile("props");
                return;
            case "annotations":
                refreshTokenForAnnotations();
                requestReconcile("scope");
                return;
            default:
                // enabled / trendEdit / readScope / tagBrowser: scope and capabilities (a reverted browser write
                // leaves the trusted values unchanged, so nothing is pushed for it)
                requestReconcile("scope");
        }
    }

    // =========================================================================================================
    // Reconciliation
    // =========================================================================================================

    /** Debounced reconcile: 250 ms trailing, at most {@value #PEN_MAX_WAIT_MS} ms after the first request. */
    private void requestReconcile(String reason) {
        if (isClosed()) {
            return;
        }
        if (debounceTimer == null || debounceTimer.isDone()) {
            pendingReason = reason;
        }
        long now = System.currentTimeMillis();
        if (firstDirtyAt == 0) {
            firstDirtyAt = now;
        }
        long delay = Math.min(PEN_DEBOUNCE_MS, Math.max(0, firstDirtyAt + PEN_MAX_WAIT_MS - now));
        cancel(debounceTimer);
        debounceTimer = schedule(() -> runOnQueue(() -> reconcile(true)), delay);
    }

    /**
     * Rebuilds scope, pens and subscriptions from the current props, trend list and metadata; starts metadata reads
     * for misses; publishes when {@code publish} and nothing the snapshot waits for is missing. Session queue.
     */
    private void reconcile(boolean publish) {
        if (isClosed()) {
            return;
        }
        cancel(debounceTimer);
        firstDirtyAt = 0;
        reconciles++;
        ReadScope sc = rebuildScope();
        UserContext u = user();
        String identity = ChartMetaCache.identity(u);
        ChartMetaCache cache = ChartOps.metaCache(services);
        long now = System.currentTimeMillis();
        List<Pen> next = candidates(sc);
        Map<String, TagPath> toRead = new LinkedHashMap<>();
        for (Pen p : next) {
            if (p.status != null) {
                continue;
            }
            ChartMetaCache.PenMeta pm = cache.get(sessionId(), identity, p.nkey);
            if (pm != null) {
                p.meta = pm;
                p.status = pm.status();
                continue;
            }
            p.status = STATUS_LOADING;
            Long until = failedUntil.get(p.nkey);
            if (!pendingKeys.contains(p.nkey) && (until == null || until <= now)) {
                toRead.put(p.nkey, p.path);
            }
        }
        pens = next;
        updateSubscriptions();
        if (!toRead.isEmpty()) {
            readMeta(toRead, identity, u.generation());
        }
        // While metadata of a pen is being read, the push waits for it (the read's completion reconciles again):
        // one push per change, never a "loading" flash for a pen whose status is a few milliseconds away.
        if (publish && !waitingForMeta()) {
            publish();
        }
    }

    /** True while a pen's metadata is being read (failed reads do not count: they are retried later). */
    private boolean waitingForMeta() {
        for (Pen p : pens) {
            if (STATUS_LOADING.equals(p.status) && pendingKeys.contains(p.nkey)) {
                return true;
            }
        }
        return false;
    }

    /** The effective pens with every status that needs no tag I/O already decided. */
    private List<Pen> candidates(ReadScope sc) {
        int max = services.settings().get().trendMaxPens();
        int listed = max + OVER_LIMIT_LISTED;
        int unlisted = 0;
        List<Pen> out = new ArrayList<>();
        Set<String> staticKeys = new HashSet<>();
        JsonElement raw = readProp("pens");
        if (raw != null && raw.isJsonArray()) {
            int index = 0;
            for (JsonElement e : raw.getAsJsonArray()) {
                int i = index++;
                if (e == null || !e.isJsonObject()) {
                    continue;
                }
                JsonObject o = e.getAsJsonObject();
                if (!Json.bool(o, "enabled", true)) {
                    continue;   // disabled pens are neither queried nor shown
                }
                if (out.size() >= listed) {
                    unlisted++;   // counted only: never parsed, named or pushed
                    continue;
                }
                String tagPath = Json.string(o, "tagPath", "");
                TagPaths.Parsed parsed = TagPaths.parse(tagPath, defaultProvider);   // the full text (> MAX_LENGTH is invalid)
                TagPath path = parsed.ok() ? parsed.path() : null;
                boolean runtime = path != null && !designKeys.contains(TagPaths.normalizedKey(path));
                Pen p = new Pen("p:" + i, "pens", i, clipEcho(tagPath), clipEcho(Json.string(o, "name", "")), path,
                    runtime);
                if (p.nkey != null) {
                    staticKeys.add(p.nkey);
                }
                out.add(p);
            }
        }
        String group = ChartOps.trendGroup(props());
        if (group != null) {
            for (TrendListStore.Entry entry : services.trendStore().get(sessionId(), group)) {
                if (staticKeys.contains(entry.key())) {
                    continue;
                }
                if (out.size() >= listed) {
                    unlisted++;
                    continue;
                }
                TagPaths.Parsed parsed = TagPaths.parse(entry.path(), defaultProvider);
                out.add(new Pen("t:" + entry.key(), "trend", null, entry.path(), "", parsed.ok() ? parsed.path() : null,
                    false));
            }
        }
        for (int k = 0; k < out.size(); k++) {
            Pen p = out.get(k);
            if (k >= max) {
                p.status = "overLimit";
            } else if (p.path == null) {
                p.status = "invalidPath";
            } else if (!sc.allows(p.nkey, p.runtime)) {
                p.status = "outOfScope";
            } else if (!admit(p.nkey)) {
                p.status = "overLimit";
            }
        }
        overLimitCount = unlisted;
        return out;
    }

    private static String clipEcho(String s) {
        return s == null || s.length() <= MAX_ECHO_CHARS ? s : s.substring(0, MAX_ECHO_CHARS);
    }

    /**
     * New-path budget per delegate: a tag this delegate has not handled before costs one unit of
     * {@code ctg.chart.maxNewPathsPerMinute}; over the budget the pen is {@code overLimit} (one WARN per minute) and
     * the pens are reconciled again when the window ends.
     */
    private boolean admit(String key) {
        if (seenKeys.contains(key)) {
            return true;
        }
        long now = System.currentTimeMillis();
        if (now - budgetWindowStart >= BUDGET_WINDOW_MS) {
            budgetWindowStart = now;
            budgetUsed = 0;
            budgetWarned = false;
        }
        int max = services.settings().get().chartMaxNewPathsPerMinute();
        if (budgetUsed >= max) {
            if (!budgetWarned) {
                budgetWarned = true;
                warnings.warn("pen-budget", "action=pen-budget " + describe() + ": more than " + max
                    + " new pen paths within a minute (ctg.chart.maxNewPathsPerMinute); further pens are overLimit");
                cancel(budgetTimer);
                budgetTimer = schedule(() -> runOnQueue(() -> requestReconcile("budget")),
                    Math.max(0, budgetWindowStart + BUDGET_WINDOW_MS - now) + 10);
            }
            return false;
        }
        budgetUsed++;
        seenKeys.add(key);
        if (seenKeys.size() > MAX_SEEN_KEYS) {
            Iterator<String> it = seenKeys.iterator();
            it.next();
            it.remove();
        }
        return true;
    }

    /** One batched meta read (user context) for the pens in {@code toRead} (normalized key → path). */
    private void readMeta(Map<String, TagPath> toRead, String identity, long userGen) {
        List<String> keys = new ArrayList<>(toRead.keySet());
        Map<String, TagPath> reads = new LinkedHashMap<>();
        for (int i = 0; i < keys.size(); i++) {
            reads.putAll(ChartOps.metaReads(i + "|", toRead.get(keys.get(i)), ChartOps.PEN_META_KEYS));
        }
        pendingKeys.addAll(keys);
        metaReadPaths += keys.size();
        metaReadBatches++;
        CompletableFuture<Map<String, QualifiedValue>> f;
        try {
            f = TagMetaReader.read(session().getTagManager(), reads, user().securityContext());
        } catch (RuntimeException e) {
            pendingKeys.removeAll(keys);
            warnings.warn("CtgChartDelegate.meta", "Pen metadata read failed on " + describe(), e);
            metaFailed(keys);
            return;
        }
        onQueue(f, services.settings().get().readTimeoutMs(), (m, err) -> {
            pendingKeys.removeAll(keys);
            if (user().generation() != userGen) {
                reconcile(true);   // the user changed meanwhile: these results belong to the previous user
                return;
            }
            if (err != null || m == null) {
                logger.debugf("pen meta read failed on %s: %s", describe(), err == null ? "no result" : err.toString());
                metaFailed(keys);
                return;
            }
            ChartMetaCache cache = ChartOps.metaCache(services);
            for (int i = 0; i < keys.size(); i++) {
                ChartMetaCache.PenMeta pm = ChartOps.classify(ChartOps.slice(m, i + "|"), host::history);
                cache.put(sessionId(), identity, keys.get(i), pm);
                failedUntil.remove(keys.get(i));
            }
            reconcile(true);
        });
    }

    /** A meta read failed or timed out: retry in {@value #META_RETRY_MS} ms; a waiting push goes out now ("loading"). */
    private void metaFailed(Collection<String> keys) {
        long until = System.currentTimeMillis() + META_RETRY_MS;
        for (String k : keys) {
            failedUntil.put(k, until);
        }
        cancel(retryTimer);
        retryTimer = schedule(() -> runOnQueue(() -> reconcile(true)), META_RETRY_MS + 10);
        if (!waitingForMeta()) {
            publish();
        }
    }

    /** Periodic metadata refresh (every 5 min; the cache TTL makes the next reconcile re-read). */
    private void scheduleMetaRefresh() {
        metaTimer = schedule(() -> {
            runOnQueue(() -> {
                Set<String> keys = new HashSet<>();
                for (Pen p : pens) {
                    if (p.nkey != null) {
                        keys.add(p.nkey);
                    }
                }
                ChartOps.metaCache(services).invalidate(sessionId(), keys);
                requestReconcile("meta");
            });
            if (!isClosed()) {
                scheduleMetaRefresh();
            }
        }, META_REFRESH_MS);
    }

    /** Snapshot (after a hello) or {@code chart.pens} when its content changed. Session queue. */
    private void publish() {
        if (!helloReceived()) {
            return;
        }
        if (snapshotPending) {
            snapshotPending = false;
            push(Protocol.CHART_SNAPSHOT, buildSnapshot());
            scheduleFlush();   // live values after the snapshot
            return;
        }
        JsonObject m = pensMessage();
        String json = m.toString();
        if (json.equals(lastPensJson)) {
            return;
        }
        lastPensJson = json;
        m.addProperty("reason", pendingReason);
        push(Protocol.CHART_PENS, m);
        markPublished();
    }

    /**
     * Statuses whose pens get {@code chart.values}: {@code ok}, and {@code noHistory} (a pen
     * without history still has a current value, which the pen table's "Current" column and the live edge show; only
     * its history is unavailable). Both are subscribed; a pen of any other status never receives a value.
     */
    static boolean liveStatus(String status) {
        return "ok".equals(status) || "noHistory".equals(status);
    }

    /**
     * The client now knows the current pen list: remember which pens it shows as live ({@link #liveStatus}), forget
     * the last-pushed value of every other pen key (or of a key that now points at another tag), and flush so the
     * (re)announced live pens get their current value even when it does not change again. Session queue.
     */
    private void markPublished() {
        Map<String, String> ok = new HashMap<>();
        for (Pen p : pens) {
            if (liveStatus(p.status) && p.nkey != null) {
                ok.put(p.key, p.nkey);
            }
        }
        publishedOk = ok;
        lastLive.entrySet().removeIf(e -> {
            String nkey = ok.get(e.getKey());
            return nkey == null || !e.getValue().startsWith(nkey + "\u0000");
        });
        if (!ok.isEmpty() && !lastLive.keySet().containsAll(ok.keySet())) {
            scheduleFlush();
        }
    }

    /** (Re)builds the read scope from the trusted props; tokens see the new scope at once. Session queue. */
    private ReadScope rebuildScope() {
        PropsSnapshot p = props();
        String group = ChartOps.trendGroup(p);
        UUID sid = sessionId();
        TrendListStore store = services.trendStore();
        Predicate<String> trend = group == null ? key -> false
            : key -> store.get(sid, group).stream().anyMatch(e -> e.key().equals(key));
        ReadScope s = ReadScope.build(p, designKeys, trend, services.settings().get().readDeniedProviders(), defaultProvider,
            providerNames());
        scope.set(s);
        return s;
    }

    private void setDesign(DesignPens d) {
        design = d;
        designKeys = d.keys();
    }

    /** Normalized key of a raw pen {@code tagPath} (project default provider), or null when it is invalid. */
    private String keyOf(String rawTagPath) {
        TagPaths.Parsed parsed = TagPaths.parse(rawTagPath, defaultProvider);
        return parsed.ok() ? TagPaths.normalizedKey(parsed.path()) : null;
    }

    /** The value a prop change wrote at its own path (plain JSON; JsonNull when it was removed or is unreadable). */
    private static JsonElement causalValue(PropertyTreeChangeEvent event) {
        try {
            QualifiedValue q = event.readCausalValue();
            return plainJson(q == null ? null : q.getValue());
        } catch (RuntimeException e) {
            return JsonNull.INSTANCE;
        }
    }

    private List<String> providerNames() {
        try {
            List<String> names = services.gatewayContext().getTagManager().getTagProviderNames();
            return names == null ? List.of() : names;
        } catch (RuntimeException e) {
            logger.debugf("tag provider list unavailable: %s", e.toString());
            return List.of();
        }
    }

    // =========================================================================================================
    // Subscriptions and live values
    // =========================================================================================================

    /** Subscribes the distinct tags of the pens that are ok / notFound / noHistory (user context). Session queue. */
    private void updateSubscriptions() {
        Map<String, TagPath> wanted = new LinkedHashMap<>();
        for (Pen p : pens) {
            if ("ok".equals(p.status) || "notFound".equals(p.status) || "noHistory".equals(p.status)) {
                wanted.putIfAbsent(p.nkey, p.path);
            }
        }
        boolean changed = subscriber.apply(wanted, user().securityContext(), true);
        lastSeen.keySet().retainAll(wanted.keySet());
        if (changed) {
            logger.debugf("chart subscriptions n=%d total=%d on %s", subscriber.size(), TagSubscriber.totalSubscribed(),
                describe());
            if (!wanted.isEmpty()) {
                scheduleFlush();
            }
        }
    }

    /** Tag thread: leading edge after idle, then at most one flush per {@code ctg.chart.liveCoalesceMs}. */
    private void scheduleFlush() {
        if (!flushScheduled.compareAndSet(false, true)) {
            return;
        }
        long coalesceMs = services.settings().get().chartLiveCoalesceMs();
        long delay = Math.max(0, coalesceMs - (System.currentTimeMillis() - lastFlushAt));
        try {
            services.scheduler().schedule(() -> {
                lastFlushAt = System.currentTimeMillis();
                flushScheduled.set(false);
                runOnQueue(this::flushOnQueue);
            }, delay, TimeUnit.MILLISECONDS);
        } catch (RejectedExecutionException e) {
            flushScheduled.set(false);   // module stopping
        }
    }

    /**
     * Session queue: {@code chart.values} for the ok pens whose value, quality or timestamp changed since the last
     * push; quality flips (deleted / created / access lost or gained) re-classify the tag.
     */
    private void flushOnQueue() {
        if (!helloReceived() || snapshotPending) {
            return;   // publish() schedules a flush right after the snapshot
        }
        Map<String, QualifiedValue> vals = subscriber.values();
        if (vals.isEmpty()) {
            return;
        }
        JsonObject values = new JsonObject();
        Set<String> flipped = new LinkedHashSet<>();
        Map<String, String> seen = new HashMap<>();
        long now = System.currentTimeMillis();
        for (Pen p : pens) {
            QualifiedValue qv = p.nkey == null ? null : vals.get(p.nkey);
            if (qv == null) {
                continue;
            }
            QualityCode q = qv.getQuality();
            String sig = signature(qv);
            boolean changedTag = !sig.equals(lastSeen.get(p.nkey)) || flipped.contains(p.nkey);
            seen.put(p.nkey, sig);
            // Edge-triggered: a status that disagrees with a NEW value re-reads the metadata once; a lasting
            // disagreement (e.g. a quality the meta read classifies differently) does not loop.
            boolean gone = TagPaths.isNotFound(q) || TagPaths.isAccessDenied(q);
            if (changedTag && (("ok".equals(p.status) || "noHistory".equals(p.status)) && gone
                    || "notFound".equals(p.status) && q != null && !TagPaths.isNotFound(q))) {
                flipped.add(p.nkey);
                continue;
            }
            if (!liveStatus(p.status) || gone || !p.nkey.equals(publishedOk.get(p.key))) {
                continue;   // only pens the client was told are ok / noHistory (a pen's first value follows its PenInfo)
            }
            String live = p.nkey + "\u0000" + sig;
            if (!live.equals(lastLive.get(p.key))) {
                values.add(p.key, ChartOps.liveValue(qv, now));
                lastLive.put(p.key, live);
            }
        }
        lastSeen.putAll(seen);
        if (values.size() > 0) {
            JsonObject msg = new JsonObject();
            msg.add("values", values);
            valuesPushed++;
            push(Protocol.CHART_VALUES, msg);
        }
        if (!flipped.isEmpty()) {
            logger.debugf("pen tag state changed (%d tags) on %s: re-reading metadata", flipped.size(), describe());
            ChartOps.metaCache(services).invalidate(sessionId(), flipped);
            requestReconcile("meta");
        }
    }

    private static String signature(QualifiedValue qv) {
        QualityCode q = qv.getQuality();
        long t = qv.getTimestamp() == null ? 0 : qv.getTimestamp().getTime();
        return t + "|" + (q == null ? "?" : q.getCode()) + "|" + qv.getValue();
    }

    // =========================================================================================================
    // Snapshot and pens message
    // =========================================================================================================

    /**
     * Session queue, after a settings reload that changed something ({@link SettingsFanOut}). Scope, pens and
     * subscriptions are reconciled (debounced). When the {@code limits} the client has differ from the current ones
     * ({@code ctg.history.timeoutMs}, {@code minIntervalMs}, {@code maxConcurrentPerSession}, …), a new snapshot is
     * published at once — the only protocol message that carries {@code limits} — followed by the live
     * values as after a hello; the client applies it as a catch-up, not a reload (otherwise new limits would reach a
     * running chart only at its next resync).
     */
    private void settingsChanged() {
        if (isClosed()) {
            return;
        }
        if (limitsOutdated(helloReceived(), lastLimitsJson, services.settings().get())) {
            logger.debugf("limits changed on %s: snapshot re-published", describe());
            snapshotPending = true;
            lastLive.clear();
            lastPensJson = null;
            reconcile(true);
            return;
        }
        requestReconcile("scope");
    }

    /**
     * True when the client's {@code limits} ({@code sentJson}, from its last snapshot) differ from what
     * {@code settings} give now and the client can receive a snapshot (hello done). Package-private for JUnit.
     */
    static boolean limitsOutdated(boolean hello, String sentJson, ModuleSettings.Settings settings) {
        return hello && sentJson != null && !sentJson.equals(limits(settings).toString());
    }

    @Override
    protected JsonObject buildSnapshot() {
        JsonObject s = pensMessage();
        lastPensJson = s.toString();
        markPublished();
        JsonObject limits = limits(services.settings().get());
        lastLimitsJson = limits.toString();
        s.add("limits", limits);
        HistoryTokenStore.TokenInfo t = currentToken();
        s.add("history", t != null ? historyCredentials(t) : JsonNull.INSTANCE);
        if (t == null && tokenSessionFull) {
            // A transient refusal (the per-session cap); the client names it and keeps asking
            // (chart.token with backoff) until a slot frees
            s.addProperty("historyRefused", "sessionFull");
        }
        return s;
    }

    /** {@code {pens, trend, trendEdit, readScope, tagBrowser, annotations}} from the current state. Session queue. */
    private JsonObject pensMessage() {
        PropsSnapshot p = props();
        UserContext u = user();
        ModuleSettings.Settings s = services.settings().get();
        List<Pen> list = pens;
        List<ChartOps.NameInput> names = new ArrayList<>(list.size());
        for (Pen pen : list) {
            names.add(new ChartOps.NameInput(pen.explicitName, pen.path, pen.raw));
        }
        List<String> labels = ChartOps.penNames(names);
        JsonArray arr = new JsonArray();
        for (int i = 0; i < list.size(); i++) {
            arr.add(penInfo(list.get(i), labels.get(i)));
        }

        String group = ChartOps.trendGroup(p);
        JsonObject trend = new JsonObject();
        JsonArray paths = new JsonArray();
        if (group == null) {
            trend.add("group", JsonNull.INSTANCE);
        } else {
            trend.addProperty("group", group);
            for (TrendListStore.Entry e : services.trendStore().get(sessionId(), group)) {
                paths.add(e.path());
            }
        }
        trend.add("paths", paths);
        trend.addProperty("max", s.trendMaxPens());

        ReadScope sc = scope.get();
        JsonObject rs = new JsonObject();
        rs.addProperty("runtimePensAllowed", sc.runtimePensAllowed());
        JsonArray roots = new JsonArray();
        sc.rootLabels().forEach(roots::add);
        rs.add("roots", roots);

        JsonObject browse = ChartOps.capability(ChartOps.browseGate(p, u));
        browse.addProperty("rootPath", ReadScope.rootPath(p).orElse(""));

        JsonObject m = new JsonObject();
        m.add("pens", arr);
        if (overLimitCount > 0) {
            m.addProperty("overLimitCount", overLimitCount);   // enabled pens past the listed overLimit ones
        }
        m.add("trend", trend);
        m.add("trendEdit", ChartOps.capability(ChartOps.trendEditGate(p, u, group)));
        m.add("readScope", rs);
        m.add("tagBrowser", browse);
        m.add("annotations", AnnotationOps.capability(p, u, annotationsUnsupported(list)));
        return m;
    }

    /**
     * True when the chart has pens with history and every one of them uses a historian known not to support
     * annotations ({@link AnnotationService#unsupported}, learnt from history queries and saves).
     */
    private boolean annotationsUnsupported(List<Pen> list) {
        AnnotationService svc = AnnotationService.of(services);
        boolean any = false;
        for (Pen pen : list) {
            String provider = historyProvider(pen);
            if (!"ok".equals(pen.status) || provider == null) {
                continue;
            }
            if (!svc.unsupported(provider)) {
                return false;
            }
            any = true;
        }
        return any;
    }

    /** The historian of a pen from its metadata ({@code PenInfo.history.provider}); null when unknown. */
    private static String historyProvider(Pen pen) {
        JsonObject h = pen.meta == null ? null : pen.meta.history();
        JsonElement p = h == null ? null : h.get("provider");
        return p != null && p.isJsonPrimitive() && p.getAsJsonPrimitive().isString() ? p.getAsString() : null;
    }

    /** PenInfo: one entry of the {@code pens} array of {@code chart.pens} / {@code chart.snapshot}. */
    private static JsonObject penInfo(Pen pen, String name) {
        JsonObject info = new JsonObject();
        info.addProperty("key", pen.key);
        info.addProperty("source", pen.source);
        if (pen.index == null) {
            info.add("index", JsonNull.INSTANCE);
        } else {
            info.addProperty("index", pen.index);
        }
        info.addProperty("tagPath", pen.path != null ? pen.path.toStringFull() : pen.raw);
        info.addProperty("name", name);
        info.addProperty("status", pen.status == null ? STATUS_LOADING : pen.status);
        ChartMetaCache.PenMeta pm = pen.meta;
        JsonObject meta = pm == null ? null : pm.meta();
        JsonObject history = pm == null ? null : pm.history();
        info.add("meta", meta == null ? JsonNull.INSTANCE : meta);
        info.add("history", history == null ? JsonNull.INSTANCE : history);
        info.addProperty("trendable", "ok".equals(pen.status));
        return info;
    }

    /**
     * {@code chart.snapshot.limits}. Two members let the client pace its history requests:
     * {@code historyTimeoutMs} ({@code ctg.history.timeoutMs}, the gateway's query deadline; the client aborts a POST
     * a margin after it) and {@code historyBurst} (requests one history token may start back to back before the
     * {@code minIntervalMs} refill applies).
     */
    static JsonObject limits(ModuleSettings.Settings s) {
        JsonObject l = new JsonObject();
        l.addProperty("maxPens", s.trendMaxPens());
        l.addProperty("pointCountMin", s.historyPointCountMin());
        l.addProperty("pointCountMax", s.historyPointCountMax());
        l.addProperty("pointCountDefault", s.historyPointCountDefault());
        l.addProperty("maxRawPointsPerPen", s.historyMaxRawPointsPerPen());
        l.addProperty("maxPointsPerResponse", s.historyMaxPointsPerResponse());
        l.addProperty("maxRangeDays", s.historyMaxRangeDays());
        l.addProperty("maxRawRangeDays", s.historyMaxRawRangeDays());
        l.addProperty("minIntervalMs", s.historyMinIntervalMs());
        l.addProperty("historyBurst", HistoryService.REQUEST_BURST);
        l.addProperty("historyTimeoutMs", s.historyTimeoutMs());
        l.addProperty("minBucketMs", s.historyMinBucketMs());
        l.addProperty("maxConcurrentPerSession", s.historyMaxConcurrentPerSession());
        l.addProperty("liveCoalesceMs", s.chartLiveCoalesceMs());
        JsonArray ladder = new JsonArray();
        for (Long step : BucketLadder.steps()) {
            ladder.add(step);
        }
        l.add("bucketLadder", ladder);
        JsonArray aggs = new JsonArray();
        ChartOps.AGGREGATIONS.forEach(aggs::add);
        l.add("aggregations", aggs);
        return l;
    }

    // =========================================================================================================
    // Trend list
    // =========================================================================================================

    /** (Re)registers for the session trend list of the trusted {@code trendGroup} (none when the chart ignores it). */
    private void registerTrend() {
        UUID sid = sessionId();
        if (sid == null || isClosed()) {
            return;
        }
        String group = ChartOps.trendGroup(props());
        TrendKey k = group == null ? null : new TrendKey(sid, group);
        if (java.util.Objects.equals(k, trendKey)) {
            return;
        }
        if (trendKey != null) {
            services.trendStore().removeListener(trendKey, trendListener);
        }
        trendKey = k;
        if (k != null) {
            services.trendStore().addListener(k, trendListener);
        }
    }

    // =========================================================================================================
    // History token
    // =========================================================================================================

    /**
     * The current token, replaced when missing, revoked or close to expiry; null when none can be issued (a
     * Designer session whose remote address is unknown). Session queue.
     */
    private HistoryTokenStore.TokenInfo currentToken() {
        HistoryTokenStore.TokenInfo t = token;
        if (t != null && services.tokens().validate(t.token()).status() == HistoryTokenStore.Status.OK
                && t.expiresAt() - System.currentTimeMillis() > TOKEN_RENEW_BEFORE_MS) {
            return t;
        }
        return issueToken();
    }

    /**
     * Issues a new token for this delegate (the previous one keeps a 30 s grace) carrying {@link #penGate}; null
     * when the store refuses (a Designer session whose remote address is unknown: the history is then unavailable
     * in that Designer, which is safer than an unbound token). Session queue.
     */
    private HistoryTokenStore.TokenInfo issueToken() {
        // The annotation view gate, binding lint included.
        boolean annotations = AnnotationOps.viewGate(props()).isEmpty();
        try {
            token = services.tokens().issue(new HistoryTokenStore.IssueRequest(sessionId(), session().getProjectName(),
                session().scope(), ownerId(), component.getComponentAddressPath(), user().userName(),
                PerspectiveInternals.remoteAddr(session()), penGate, annotations));
            tokenAnnotations = annotations;
            tokenSessionFull = false;
        } catch (HistoryTokenStore.IssueRefused e) {
            token = null;
            tokenSessionFull = e.sessionFull();
            if (e.sessionFull()) {
                // The per-session cap never evicts other charts' current tokens; this chart waits.
                // The client retries chart.token with backoff (BUSY), so it resumes once one closes.
                if (SESSION_FULL_LOGGED.compareAndSet(false, true)) {
                    logger.warn("History token refused: this session already runs " + HistoryTokenStore.PER_SESSION
                        + " charts with live tokens (this chart retries and gets history once one closes; logged once)");
                }
            } else if (DESIGNER_TOKEN_REFUSED_LOGGED.compareAndSet(false, true)) {
                logger.warn("History token refused for a Designer session: its remote address is unknown"
                    + " (chart history is unavailable in that Designer; logged once)");
            }
        }
        return token;
    }

    /**
     * The annotation view gate ({@code annotations.enabled} + its binding lint) is part of the token:
     * reissue and push when it changed.
     */
    private void refreshTokenForAnnotations() {
        boolean now = AnnotationOps.viewGate(props()).isEmpty();
        if (token != null && helloReceived() && now != tokenAnnotations) {
            HistoryTokenStore.TokenInfo t = issueToken();
            if (t != null) {
                push(Protocol.CHART_TOKEN, historyCredentials(t));
            }
        }
    }

    /** Flat {@code {url, token, expiresAt, issuedAt}}. */
    static JsonObject historyCredentials(HistoryTokenStore.TokenInfo t) {
        JsonObject o = new JsonObject();
        o.addProperty("url", Protocol.HISTORY_URL);
        o.addProperty("token", t.token());
        o.addProperty("expiresAt", t.expiresAt());
        // issuedAt: the client renews at half the lifetime when that is shorter than its 120 s margin (with a TTL
        // of 120 s or less, every tick would renew otherwise)
        o.addProperty("issuedAt", t.issuedAt());
        return o;
    }

    // =========================================================================================================
    // Debug hook (only while ctg.debug is on; otherwise indistinguishable from an unknown message)
    // =========================================================================================================

    /** {@code chart.debug.info {}} → internal counters for diagnostics and tests. */
    private void debugInfo(CallContext cc) {
        if (!services.debugEnabled()) {
            cc.fail(ErrorCode.UNKNOWN_MESSAGE);
            return;
        }
        JsonObject d = new JsonObject();
        d.addProperty("subscriptions", subscriber.size());
        d.addProperty("totalSubscriptions", TagSubscriber.totalSubscribed());
        JsonArray keys = new JsonArray();
        subscriber.paths().keySet().forEach(keys::add);
        d.add("keys", keys);
        d.addProperty("metaReadPaths", metaReadPaths);
        d.addProperty("metaReadBatches", metaReadBatches);
        d.addProperty("reconciles", reconciles);
        d.addProperty("valuesPushed", valuesPushed);
        d.addProperty("seenKeys", seenKeys.size());
        d.addProperty("budgetUsed", budgetUsed);
        d.addProperty("budgetMax", services.settings().get().chartMaxNewPathsPerMinute());
        d.addProperty("pendingKeys", pendingKeys.size());
        d.addProperty("designKeys", designKeys.size());
        d.addProperty("designShadow", design.size());
        d.addProperty("listedPens", pens.size());
        d.addProperty("overLimitCount", overLimitCount);
        d.addProperty("publishedOk", publishedOk.size());
        d.addProperty("lastLive", lastLive.size());
        d.addProperty("scope", scope.get().toString());
        d.addProperty("metaCacheSize", ChartOps.metaCache(services).size());
        Map<String, Integer> counts = new LinkedHashMap<>();
        for (Pen p : pens) {
            counts.merge(p.status == null ? STATUS_LOADING : p.status, 1, Integer::sum);
        }
        JsonObject statuses = new JsonObject();
        counts.forEach(statuses::addProperty);
        d.add("statuses", statuses);
        cc.reply(d);
    }

    // =========================================================================================================
    // Helpers
    // =========================================================================================================

    /** Schedules on the module scheduler; null when the module is stopping. */
    private ScheduledFuture<?> schedule(Runnable task, long delayMs) {
        if (isClosed()) {
            return null;
        }
        try {
            return services.scheduler().schedule(task, delayMs, TimeUnit.MILLISECONDS);
        } catch (RejectedExecutionException e) {
            return null;
        }
    }

    private static void cancel(ScheduledFuture<?> f) {
        if (f != null) {
            f.cancel(false);
        }
    }

    private HistoryAvailability historyAvailability() {
        return services.shared(HistoryAvailability.class, HistoryAvailability::new);
    }

    /** The module-wide audit (shared with the display delegate). */
    private CtgAudit audit() {
        return services.shared(CtgAudit.class, () -> new CtgAudit(services.gatewayContext(), services.scheduler(),
            x -> services.settings().get().auditFallbackProfile()));
    }

    /** Audit profile (project, else fallback), cached for a minute (annotation changes only). Session queue. */
    private Optional<AuditProfile> auditProfile() {
        long now = System.currentTimeMillis();
        if (profileCache == null || now - profileAt >= PROFILE_CACHE_MS) {
            profileCache = audit().profile(component);
            profileAt = now;
        }
        return profileCache;
    }

    /**
     * The annotation rules' view of the effective pen with this normalized key: an {@code ok} pen wins over
     * another pen of the same tag; null when the tag is not on the chart. Session queue.
     */
    private AnnotationOps.PenRef annotationPen(String nk) {
        Pen found = null;
        for (Pen p : pens) {
            if (nk.equals(p.nkey) && (found == null || "ok".equals(p.status))) {
                found = p;
            }
        }
        return found == null ? null
            : new AnnotationOps.PenRef(found.status == null ? STATUS_LOADING : found.status, historyProvider(found));
    }

    /** {@link ChartOps.Host} / {@link AnnotationOps.Host} over this delegate. */
    private final class Host implements AnnotationOps.Host {
        @Override
        public AnnotationOps.PenRef annotationPen(String normalizedKey) {
            return CtgChartDelegate.this.annotationPen(normalizedKey);
        }

        @Override
        public TagHistoryManager historyManager() {
            return session().getTagHistoryManager();
        }

        @Override
        public AnnotationService annotations() {
            return AnnotationService.of(services);
        }

        @Override
        public CtgAudit audit() {
            return CtgChartDelegate.this.audit();
        }

        @Override
        public Optional<AuditProfile> auditProfile() {
            return CtgChartDelegate.this.auditProfile();
        }

        @Override
        public Component component() {
            return component;
        }

        @Override
        public PropsSnapshot props() {
            return CtgChartDelegate.this.props();
        }

        @Override
        public UserContext user() {
            return CtgChartDelegate.this.user();
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
        public UUID sessionId() {
            return CtgChartDelegate.this.sessionId();
        }

        @Override
        public ReadScope scope() {
            return scope.get();
        }

        @Override
        public <T> void onQueue(CompletableFuture<T> f, long timeoutMs, BiConsumer<T, Throwable> cb) {
            CtgChartDelegate.this.onQueue(f, timeoutMs, cb);
        }

        @Override
        public HistoryAvailability.Status history(TagMetaReader.Meta meta) {
            return historyAvailability().check(meta, () -> session().getTagHistoryManager().getTagHistoryProviders());
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
            return CtgChartDelegate.this.describe();
        }

        @Override
        public Collection<String> providerNames() {
            return CtgChartDelegate.this.providerNames();
        }
    }
}
