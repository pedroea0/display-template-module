package com.example.simpletagdisplay.gateway.delegate;

import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Collection;
import java.util.EnumMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BiConsumer;
import java.util.regex.Pattern;

import com.example.simpletagdisplay.common.SchemaLoader;
import com.example.simpletagdisplay.common.SimpleTagDisplayModule;
import com.example.simpletagdisplay.common.protocol.ErrorCode;
import com.example.simpletagdisplay.common.protocol.Protocol;
import com.example.simpletagdisplay.gateway.GatewayServices;
import com.example.simpletagdisplay.gateway.ModuleSettings;
import com.example.simpletagdisplay.gateway.delegate.HandlerRegistry.Entry;
import com.example.simpletagdisplay.gateway.delegate.HandlerRegistry.RateClass;
import com.example.simpletagdisplay.gateway.security.BindingLint;
import com.example.simpletagdisplay.gateway.security.SecurityKeys;
import com.example.simpletagdisplay.gateway.security.TrustedProps;
import com.example.simpletagdisplay.gateway.security.UserContext;
import com.example.simpletagdisplay.gateway.util.Json;
import com.example.simpletagdisplay.gateway.util.RateLimitedLog;
import com.example.simpletagdisplay.gateway.util.TokenBucket;
import com.inductiveautomation.ignition.common.JsonPath;
import com.inductiveautomation.ignition.common.gson.JsonArray;
import com.inductiveautomation.ignition.common.gson.JsonElement;
import com.inductiveautomation.ignition.common.gson.JsonNull;
import com.inductiveautomation.ignition.common.gson.JsonObject;
import com.inductiveautomation.ignition.common.gson.JsonPrimitive;
import com.inductiveautomation.ignition.common.model.values.QualifiedValue;
import com.inductiveautomation.ignition.common.util.ExecutionQueue;
import com.inductiveautomation.ignition.common.util.LoggerEx;
import com.inductiveautomation.perspective.common.api.PropertyKey;
import com.inductiveautomation.perspective.common.api.PropertyType;
import com.inductiveautomation.perspective.common.config.PropertyConfig;
import com.inductiveautomation.perspective.common.property.Origin;
import com.inductiveautomation.perspective.gateway.api.Component;
import com.inductiveautomation.perspective.gateway.api.ComponentModelDelegate;
import com.inductiveautomation.perspective.gateway.api.EventManager;
import com.inductiveautomation.perspective.gateway.api.Session;
import com.inductiveautomation.perspective.gateway.api.SessionScope;
import com.inductiveautomation.perspective.gateway.messages.EventFiredMsg;
import com.inductiveautomation.perspective.gateway.property.PropertyTree;
import com.inductiveautomation.perspective.gateway.property.PropertyTreeChangeEvent;

/**
 * Gateway half of the v2 transport: shared machinery of every component delegate.
 *
 * <h2>What it does</h2>
 * <ul>
 *   <li><b>Envelope.</b> Validates inbound model events (size and nesting walk, {@code v}, {@code id}), enforces the
 *       per-delegate rate class of the message (token buckets: CONTROL 5/s burst 10, READ 10/s burst 20, MUTATE 2/s
 *       burst 5, TOKEN 1/s burst 3), de-duplicates MUTATE requests by id <em>at receipt</em>
 *       ({@link IdempotencyMap}), and dispatches to the handler registered for the name with a {@link CallContext}.
 *       Every outbound push carries {@code v}, {@code epoch}, {@code seq} and {@code serverNow}.</li>
 *   <li><b>Handshake.</b> {@code ctg.hello} → {@code ctg.welcome} + the subclass snapshot. Nothing is pushed before
 *       the first hello: a page running stale v1 JS has no client delegate and would log "No component model
 *       delegate exists" for every push.</li>
 *   <li><b>Common messages.</b> {@code ctg.ping} (clock / page watchdog), the debug-only {@code ctg.debug.fire} and
 *       {@code ctg.debug.reloadSettings}, the {@code ctg.hb} heartbeat
 *       ({@link #enableHeartbeat()}).</li>
 *   <li><b>Trusted props.</b> The security keys of the component ({@link SecurityKeys}) are kept in a
 *       {@link TrustedProps}: in a Client session a browser write to one of them, or a binding writeback from a
 *       bidirectional binding configured on another prop, is reverted and reported
 *       ({@code action=prop-tamper}); every other origin, and every change in the Designer, is adopted.
 *       {@link #props()} hands gates the trusted values plus the {@link BindingLint} verdicts.</li>
 *   <li><b>Binding lint.</b> At start the binding of every security leaf is classified; a gate
 *       key bound bidirectionally — or, with {@code ctg.security.rejectBoundGates} (default true), bound to anything
 *       a client can write — fails its gate closed ({@code BOUND_BIDIRECTIONAL}). One WARN per view and key
 *       ({@code action=security-key-bound}).</li>
 *   <li><b>User.</b> A {@link UserContext} rebuilt on every {@code WebAuthStatusChangeEvent}; session-wide
 *       reactions (auth generation, tokens, trend lists) are decided once per change by
 *       {@link GatewayServices#authChanged}.</li>
 *   <li><b>Lifecycle.</b> Registers with {@code LiveSessions} / the module's live-delegate set on start; every
 *       teardown path ({@code onShutdown}, module shutdown's {@link #forceStop()}) runs the same idempotent
 *       {@code teardown}, which also revokes the history tokens this delegate issued.</li>
 *   <li><b>Prop probe.</b> Every watched change is logged with its {@link Origin} on {@code SimpleTagDisplay.Probe}
 *       (DEBUG), kept for diagnosing where a prop change came from.</li>
 * </ul>
 *
 * <h2>Threading</h2>
 * {@code handleEvent} and property-tree callbacks run on the session {@link ExecutionQueue}. Every outbound
 * message is sent from that queue too ({@code send} hops onto it), so {@code seq} increases in the exact order
 * frames leave the gateway. Async continuations come back through {@link #onQueue} / {@link #runOnQueue}, which
 * drop the work when the delegate stopped. Tag-subsystem and scheduler threads never touch the property tree.
 *
 * <h2>Rules for handlers</h2>
 * A handler completes its call exactly once with {@link CallContext#reply} or {@link CallContext#fail}, from any
 * thread; the base sends the {@code ctg.reply}. Gates read security keys only from {@code cc.props()} (never from
 * the live tree), consult {@code cc.props().lintGate(...)}, then {@link GatewayServices#floorPolicy()}. Code that
 * hops off the queue compares {@code cc.user().generation()} with {@link #user()} when it comes back.
 */
public abstract class CtgDelegateBase extends ComponentModelDelegate {

    private static final Pattern ID = Pattern.compile(Protocol.ID_PATTERN);
    private static final SecureRandom RNG = new SecureRandom();
    private static final LoggerEx PROBE = LoggerEx.newBuilder().build("SimpleTagDisplay.Probe");
    private static final LoggerEx AUDIT = LoggerEx.newBuilder().build("SimpleTagDisplay.Audit");
    private static final String COMPONENT_EVENT_TYPE = "component";
    /** Deepest nesting a legitimate message has is ~4; anything past this is rejected before dispatch. */
    private static final int MAX_MESSAGE_DEPTH = 16;
    /** How often the heartbeat checks for silence (the silence threshold is {@code ctg.display.heartbeatMs}). */
    private static final long HEARTBEAT_CHECK_MS = 5_000L;

    protected final GatewayServices services;
    protected final LoggerEx logger;
    protected final RateLimitedLog warnings;

    private final String kind;
    private final String eventSchemaPrefix;
    private final Set<String> declaredEvents;
    private final List<String> securityPaths;
    private final Set<String> securityRoots;
    private final String epoch;
    private final String ownerId = UUID.randomUUID().toString();
    private final List<PropertyTree.Subscription> propSubs = new ArrayList<>();
    private final Map<RateClass, TokenBucket> buckets = new EnumMap<>(RateClass.class);
    private final IdempotencyMap idempotency = new IdempotencyMap();

    // ---- session-queue state ----------------------------------------------------------------------------
    private HandlerRegistry handlers;
    private long seq;
    private boolean hello;
    private boolean resyncPending;
    private long userGeneration;
    /** Build the page reported in its last hello; reused by the welcome re-sent after a login/logout. */
    private String clientBuild = "";
    private final Set<String> watchedRoots = new LinkedHashSet<>();

    // ---- read from any thread -------------------------------------------------------------------------------
    private volatile boolean closed;
    private volatile UserContext user;
    private volatile UUID sessionId;
    private volatile TrustedProps trusted;
    private volatile BindingLint.LintReport lint = BindingLint.LintReport.clean();
    /**
     * Last built trusted snapshot together with the inputs it was built from (immutable holder, published as one
     * reference). {@link #props()} reuses it only when the trusted map, the lint report and the settings object are
     * still the very same objects, so a snapshot built from stale inputs can never be served after a change.
     */
    private volatile PropsCache propsCache;
    private volatile long lastSentAt;
    private final AtomicBoolean tornDown = new AtomicBoolean(false);
    private final AtomicBoolean registered = new AtomicBoolean(false);
    private final AtomicReference<EventManager.Subscription> authSub = new AtomicReference<>();
    private final AtomicReference<ScheduledFuture<?>> heartbeat = new AtomicReference<>();

    /**
     * @param kind              "dt" or "chart" (must match {@code ctg.hello.component})
     * @param eventSchemaPrefix file prefix of the component's event schemas ("displaytemplate" / "ctgchart")
     * @param declaredEvents    component events declared on the descriptor (allow-list for {@code ctg.debug.fire})
     * @param loggerName        named logger for this component type
     * @param securityPaths     the component's security leaves ({@link SecurityKeys#DISPLAY} / {@link SecurityKeys#CHART})
     */
    protected CtgDelegateBase(Component component, GatewayServices services, String kind, String eventSchemaPrefix,
                              Collection<String> declaredEvents, String loggerName, List<String> securityPaths) {
        super(component);
        this.services = services;
        this.kind = kind;
        this.eventSchemaPrefix = eventSchemaPrefix;
        this.declaredEvents = Set.copyOf(declaredEvents);
        this.securityPaths = List.copyOf(securityPaths);
        this.securityRoots = SecurityKeys.roots(this.securityPaths);
        this.logger = LoggerEx.newBuilder().build(loggerName);
        this.warnings = new RateLimitedLog(this.logger, 60_000L);
        this.epoch = String.format("%06x", RNG.nextInt(0x1000000));
        for (RateClass rc : RateClass.values()) {
            buckets.put(rc, new TokenBucket(rc.perSecond(), rc.burst()));
        }
    }

    // =========================================================================================================
    // Subclass contract
    // =========================================================================================================

    /** Registers the component-specific message handlers. Called once on the session queue before {@link #start()}. */
    protected abstract void registerHandlers(HandlerRegistry registry);

    /** Starts subscriptions etc. Runs on the session queue; {@link #props()} and {@link #user()} are ready. */
    protected abstract void start();

    /** Releases everything {@link #start()} acquired. May run off the queue; must be thread-safe and idempotent. */
    protected abstract void stop();

    /** Full component state for hello / resync. Runs on the session queue. */
    protected abstract JsonObject buildSnapshot();

    /** {@code dt.snapshot} or {@code chart.snapshot}. */
    protected abstract String snapshotEventName();

    /** Extra fields for {@code ctg.welcome.limits} (component-specific). */
    protected JsonObject welcomeLimits() {
        return new JsonObject();
    }

    /** Hello received (and welcome sent). Default: push the full snapshot. Runs on the session queue. */
    protected void onHello(boolean resync) {
        push(snapshotEventName(), buildSnapshot());
    }

    /** The session user changed; {@link #user()} is already the new user. Default: nothing. Session queue. */
    protected void onAuthChanged() {
    }

    /**
     * A watched root prop changed with an origin other than {@link Origin#Delegate}. Runs on the session queue,
     * after {@link TrustedProps} decided about security leaves: read security keys from {@link #props()} only (a
     * reverted browser write is still in the live tree at this moment).
     */
    protected void onPropsChanged(String rootKey, PropertyTreeChangeEvent event) {
    }

    // =========================================================================================================
    // Lifecycle
    // =========================================================================================================

    @Override
    protected final void onStartup() {
        boolean inQueue = queue().isInQueue();
        logger.debugf("start %s epoch=%s inQueue=%s thread=%s", describe(), epoch, inQueue, Thread.currentThread().getName());
        if (inQueue) {
            startOnQueue();
        } else {
            queue().submit(this::startOnQueue);
        }
    }

    private void startOnQueue() {
        if (closed) {
            return;
        }
        try {
            Session s = session();
            sessionId = s.getSessionId();
            user = UserContext.of(s, ++userGeneration);
            services.delegateStarted(this, sessionId, s.scope(), s, user.userName());
            registered.set(true);
            initTrust();
            HandlerRegistry r = new HandlerRegistry();
            r.onUncorrelated(Protocol.HELLO, RateClass.CONTROL, this::handleHello);
            r.on(Protocol.PING, RateClass.CONTROL, cc -> cc.reply(pingReply()));
            r.on(Protocol.DEBUG_FIRE, RateClass.CONTROL, this::handleDebugFire);
            r.on(Protocol.DEBUG_RELOAD_SETTINGS, RateClass.CONTROL, this::handleDebugReloadSettings);
            registerHandlers(r);
            handlers = r;
            authSub.set(s.getEventManager().subscribe(Session.WebAuthStatusChangeEvent.class,
                e -> runOnQueue(() -> authChanged(e))));
            if (closed) {
                // onShutdown ran (off the queue) while we were starting: it may have missed these registrations.
                teardown("start-race");
                return;
            }
            start();
        } catch (RuntimeException e) {
            warnings.warn(getClass().getSimpleName() + ".start", "Delegate start failed for " + describe(), e);
        }
    }

    @Override
    protected final void onShutdown() {
        closed = true;
        logger.debugf("stop %s epoch=%s inQueue=%s thread=%s", describe(), epoch, queue().isInQueue(),
            Thread.currentThread().getName());
        teardown("shutdown");
    }

    /**
     * Module shutdown: stops this delegate as if Perspective had shut it down. Idempotent, thread-safe;
     * {@link GatewayServices#close()} calls it on the session queue when it can ({@link #submitForceStop}) and on its
     * own thread otherwise.
     */
    public final void forceStop() {
        closed = true;
        teardown("module-shutdown");
    }

    /**
     * Queues {@link #forceStop()} on the session queue and completes {@code done} after it ran. False when the queue
     * refused the task (the caller then runs {@link #forceStop()} itself).
     */
    public final boolean submitForceStop(CompletableFuture<Void> done) {
        try {
            queue().submit(() -> {
                try {
                    forceStop();
                } finally {
                    done.complete(null);
                }
            });
            return true;
        } catch (RuntimeException e) {
            return false;
        }
    }

    /** Every stop path ends here; runs its body exactly once. */
    private void teardown(String why) {
        if (!tornDown.compareAndSet(false, true)) {
            return;
        }
        ScheduledFuture<?> hb = heartbeat.getAndSet(null);
        if (hb != null) {
            hb.cancel(false);
        }
        idempotency.cancelPending();
        try {
            stop();
        } catch (RuntimeException e) {
            warnings.warn(getClass().getSimpleName() + ".stop", "Delegate stop failed for " + describe() + " (" + why + ")", e);
        }
        releaseAuthSub();
        synchronized (propSubs) {
            for (PropertyTree.Subscription s : propSubs) {
                try {
                    s.unsubscribe();
                } catch (RuntimeException ignored) {
                    // tree already disposed
                }
            }
            propSubs.clear();
        }
        if (registered.compareAndSet(true, false)) {
            services.delegateStopped(this, sessionId, ownerId);
        }
    }

    private void releaseAuthSub() {
        EventManager.Subscription a = authSub.getAndSet(null);
        if (a != null) {
            try {
                a.unsubscribe();
            } catch (RuntimeException ignored) {
                // session already gone
            }
        }
    }

    // =========================================================================================================
    // Inbound
    // =========================================================================================================

    /**
     * Entry point of every client → gateway model event. Always on the session queue (Perspective enforces it with
     * {@code requireInQueue}).
     */
    @Override
    public final void handleEvent(EventFiredMsg msg) {
        String name = "";
        String id = null;
        try {
            JsonObject body = msg.getEvent() == null ? new JsonObject() : msg.getEvent();
            name = msg.getEventName() == null ? "" : msg.getEventName();
            id = validId(body);
            if (closed || services.isClosed() || handlers == null) {
                error(id, ErrorCode.MODULE_STOPPING, null);
                return;
            }
            String limit = Json.exceedsLimits(body, Protocol.MAX_MESSAGE_CHARS, MAX_MESSAGE_DEPTH);
            if (limit != null) {
                logger.debugf("message %s rejected (%s) on %s", Json.sanitizeForLog(name), limit, describe());
                error(id, ErrorCode.BAD_REQUEST, null);
                return;
            }
            if (Json.integer(body, "v", -1) != Protocol.VERSION) {
                logger.debugf("protocol mismatch v=%s on %s", Json.sanitizeForLog(body.get("v")), describe());
                sendReload("protocol");
                return;
            }
            Entry entry = handlers.find(name);
            if (entry == null) {
                logger.debugf("unknown message %s on %s", Json.sanitizeForLog(name), describe());
                error(id, ErrorCode.UNKNOWN_MESSAGE, null);
                return;
            }
            if (entry.requiresId() && id == null) {
                logger.debugf("message %s without a valid id on %s", Json.sanitizeForLog(name), describe());
                error(null, ErrorCode.BAD_REQUEST, null);
                return;
            }
            if (!buckets.get(entry.rateClass()).tryAcquire()) {
                logger.debugf("rate limit %s for %s on %s", entry.rateClass(), Json.sanitizeForLog(name), describe());
                error(id, ErrorCode.RATE_LIMITED, null);
                return;
            }
            dispatch(entry, name, id, body);
        } catch (RuntimeException | StackOverflowError e) {
            warnings.warn(getClass().getSimpleName() + ".handleEvent", "Unexpected failure handling a "
                + Json.sanitizeForLog(name) + " message on " + describe(), e instanceof StackOverflowError ? null : e);
            error(id, ErrorCode.INTERNAL, null);
        }
    }

    /**
     * Runs the handler. MUTATE requests claim their id first: a duplicate (pending or completed) attaches to the
     * first request's reply and executes nothing.
     */
    private void dispatch(Entry entry, String name, String id, JsonObject body) {
        CompletableFuture<JsonObject> result;
        boolean execute = true;
        if (entry.rateClass() == RateClass.MUTATE && id != null) {
            IdempotencyMap.Claim claim = idempotency.claim(id, IdempotencyMap.fingerprint(name, body));
            if (claim == null) {
                error(id, ErrorCode.RATE_LIMITED, null);
                return;
            }
            if (claim.conflict()) {
                // The id is pending for a different request — never answer it with that one's reply.
                logger.debugf("%s id=%s reused for a different request on %s", Json.sanitizeForLog(name), id,
                    describe());
                error(id, ErrorCode.BAD_REQUEST, null);
                return;
            }
            result = claim.future();
            execute = claim.fresh();
            if (!execute) {
                logger.debugf("duplicate %s id=%s on %s: answered from the first request", Json.sanitizeForLog(name),
                    id, describe());
            }
        } else {
            result = new CompletableFuture<>();
        }
        if (id != null) {
            // Cancelled futures (delegate stopped) complete exceptionally: nothing is sent.
            result.whenComplete((reply, err) -> {
                if (reply != null) {
                    send(Protocol.REPLY, reply.deepCopy(), true);
                }
            });
        }
        if (!execute) {
            return;
        }
        CallContext cc = new CallContext(component, session(), user, props(), name, id, body, entry.rateClass(), result);
        try {
            entry.handler().handle(cc);
        } catch (RuntimeException | StackOverflowError e) {
            warnings.warn(getClass().getSimpleName() + ".handler." + name, "Handler failure for "
                + Json.sanitizeForLog(name) + " on " + describe(), e instanceof StackOverflowError ? null : e);
            cc.fail(ErrorCode.INTERNAL);
        }
    }

    private static String validId(JsonObject body) {
        String id = Json.string(body, "id", null);
        return id != null && ID.matcher(id).matches() ? id : null;
    }

    private void handleHello(CallContext cc) {
        JsonObject body = cc.body();
        String component = Json.string(body, "component", "");
        if (!kind.equals(component)) {
            // A display's JS talking to a chart delegate (or a forged hello): not a session we can serve.
            logger.debugf("hello for component '%s' on a %s delegate (%s)", Json.sanitizeForLog(component), kind, describe());
            error(cc.id(), ErrorCode.BAD_REQUEST, null);
            return;
        }
        boolean resync = Json.bool(body, "resync", false);
        String build = Json.string(body, "clientBuild", "");
        logger.debugf("hello resync=%s clientBuild=%s on %s", resync, Json.sanitizeForLog(build), describe());
        clientBuild = build == null ? "" : build.length() > 64 ? build.substring(0, 64) : build;   // only compared
        hello = true;
        resyncPending = false;
        if (!resync) {
            // A fresh client delegate (page load / reload / remount): none of its requests retries an earlier
            // page's, whose completed replies must not answer its reused ids.
            idempotency.clearCompleted();
        }
        send(Protocol.WELCOME, welcome(clientBuild), true);
        onHello(resync);
    }

    private JsonObject welcome(String clientBuild) {
        UserContext u = user;
        JsonObject w = new JsonObject();
        w.addProperty("protocol", Protocol.VERSION);
        w.addProperty("build", SimpleTagDisplayModule.RESOURCE_VERSION);
        JsonObject uj = new JsonObject();
        uj.addProperty("authenticated", u.authenticated());
        uj.addProperty("userName", u.userName());
        JsonArray roles = new JsonArray();
        u.roles().forEach(roles::add);
        uj.add("roles", roles);
        w.add("user", uj);
        w.addProperty("scope", u.isDesigner() ? "Designer" : "Client");
        w.addProperty("designerWritable", u.designerWritable());
        w.addProperty("staleClient", !SimpleTagDisplayModule.RESOURCE_VERSION.equals(clientBuild));
        w.addProperty("allowCrossOriginFrames", services.settings().get().securityAllowCrossOriginFrames());
        JsonObject limits = welcomeLimits();
        for (Map.Entry<String, JsonElement> e : timing(services.settings().get()).entrySet()) {
            limits.add(e.getKey(), e.getValue());
        }
        w.add("limits", limits);
        return w;
    }

    /**
     * The gateway's timing settings a client needs to size its own deadlines, sent in every
     * {@code ctg.welcome.limits} (the Display Template also gets them live in its {@code timing} section):
     * {@code heartbeatMs} ({@code ctg.display.heartbeatMs}: a client must not flag a silent but healthy component
     * STALE before a heartbeat could arrive, which is up to {@code heartbeatMs} + {@value #HEARTBEAT_CHECK_MS} ms after
     * the last push), {@code heartbeatCheckMs}, {@code readTimeoutMs} and {@code writeTimeoutMs} (a write first
     * re-reads the tag, then writes: its worst case is the sum, so a fixed client timeout would give up before the
     * gateway's own TIMEOUT could arrive).
     */
    public static JsonObject timing(ModuleSettings.Settings s) {
        JsonObject t = new JsonObject();
        t.addProperty("heartbeatMs", s.displayHeartbeatMs());
        t.addProperty("heartbeatCheckMs", HEARTBEAT_CHECK_MS);
        t.addProperty("readTimeoutMs", s.readTimeoutMs());
        t.addProperty("writeTimeoutMs", s.writeTimeoutMs());
        return t;
    }

    private static JsonObject pingReply() {
        JsonObject o = new JsonObject();
        o.addProperty("t", System.currentTimeMillis());
        return o;
    }

    /**
     * {@code ctg.debug.fire {event}}: proves {@code component.fireEvent("component", ...)}
     * reaches both gateway- and client-scoped event actions. Only while the {@code ctg.debug} system property is
     * true (read per call); otherwise indistinguishable from an unknown message. The event must be declared on the
     * descriptor and the payload is built here — anything the client put in its message is ignored.
     */
    private void handleDebugFire(CallContext cc) {
        if (!services.debugEnabled()) {
            cc.fail(ErrorCode.UNKNOWN_MESSAGE);
            return;
        }
        String event = Json.string(cc.body(), "event", "");
        if (!declaredEvents.contains(event)) {
            cc.fail(ErrorCode.BAD_REQUEST);
            return;
        }
        JsonObject payload = debugPayload(event, cc.user());
        logger.infof("ctg.debug.fire %s on %s by %s", event, describe(), Json.sanitizeForLog(cc.user().userName()));
        component.fireEvent(COMPONENT_EVENT_TYPE, event, payload);
        JsonObject data = new JsonObject();
        data.addProperty("event", event);
        data.add("payload", payload);
        cc.reply(data);
    }

    /** {@code ctg.debug.reloadSettings {}}: reload module settings now. Debug only. */
    private void handleDebugReloadSettings(CallContext cc) {
        if (!services.debugEnabled()) {
            cc.fail(ErrorCode.UNKNOWN_MESSAGE);
            return;
        }
        boolean changed = services.settings().reload();
        logger.infof("ctg.debug.reloadSettings on %s by %s (changed=%s)", describe(),
            Json.sanitizeForLog(cc.user().userName()), changed);
        JsonObject data = new JsonObject();
        data.addProperty("changed", changed);
        data.addProperty("rev", services.settings().get().settingsRev());
        cc.reply(data);
    }

    /** Gateway-built payload: every schema property with a neutral value of its type, then the debug markers. */
    private JsonObject debugPayload(String event, UserContext u) {
        JsonObject payload = new JsonObject();
        JsonObject schema = SchemaLoader.json("/schemas/events/" + eventSchemaPrefix + "." + event + ".json");
        JsonObject props = schema.has("properties") ? schema.getAsJsonObject("properties") : new JsonObject();
        for (Map.Entry<String, JsonElement> p : props.entrySet()) {
            payload.add(p.getKey(), neutralValue(p.getValue()));
        }
        payload.addProperty("tagPath", "__ctg_debug__");
        payload.addProperty("user", u.userName());
        payload.addProperty("timestamp", System.currentTimeMillis());
        payload.addProperty("debug", true);
        return payload;
    }

    private static JsonElement neutralValue(JsonElement propSchema) {
        if (!propSchema.isJsonObject() || !propSchema.getAsJsonObject().has("type")) {
            return JsonNull.INSTANCE;
        }
        JsonElement t = propSchema.getAsJsonObject().get("type");
        String type = t.isJsonPrimitive() ? t.getAsString() : "null";
        switch (type) {
            case "string":
                return new JsonPrimitive("");
            case "number":
            case "integer":
                return new JsonPrimitive(0);
            case "boolean":
                return new JsonPrimitive(false);
            default:
                return JsonNull.INSTANCE;
        }
    }

    // =========================================================================================================
    // Auth
    // =========================================================================================================

    private void authChanged(Object event) {
        if (closed) {
            return;
        }
        UserContext previous = user;
        user = UserContext.of(session(), ++userGeneration);
        services.authChanged(sessionId, event, user.userName());
        logger.debugf("auth change %s -> %s on %s", Json.sanitizeForLog(previous == null ? "?" : previous.userName()),
            Json.sanitizeForLog(user.userName()), describe());
        try {
            onAuthChanged();
        } catch (RuntimeException e) {
            warnings.warn(getClass().getSimpleName() + ".auth", "Auth change handling failed for " + describe(), e);
        }
        if (hello) {
            send(Protocol.WELCOME, welcome(clientBuild), true);   // a stale page stays flagged stale
            push(snapshotEventName(), buildSnapshot());
        }
    }

    // =========================================================================================================
    // Trusted props + binding lint
    // =========================================================================================================

    /** Session queue, once at start: trusted start values, lint verdicts, and the security-root subscriptions. */
    private void initTrust() {
        PropertyTree tree = component.getPropertyTreeOf(PropertyType.props);
        trusted = new TrustedProps(securityPaths, user.isDesigner(), path -> readLeaf(tree, path));
        trusted.initialize();
        BindingLint.LintReport report = inspectBindings(tree);
        lint = report;
        if (!report.inspected()) {
            if (services.firstLintWarning("lint-unavailable")) {
                AUDIT.info("Binding lint unavailable (Perspective property-config lookup failed); gates rely on the"
                    + " floor policy and trusted props only");
            }
        } else {
            warnRisky(report);
        }
        watchRoots(securityRoots);
    }

    /** Lint of the security leaves, their ancestors and the descendants of their current values. */
    private BindingLint.LintReport inspectBindings(PropertyTree tree) {
        return BindingLint.inspect(path -> component.getPropertyConfig(new PropertyKey(PropertyType.props, path)),
            path -> readLeaf(tree, path), securityPaths);
    }

    /**
     * One WARN per project, view, component and bound key ({@code action=security-key-bound}). The project is part of
     * the key: the same view path in a second project — e.g. a migrated copy — is a different
     * view and gets its own WARN.
     */
    private void warnRisky(BindingLint.LintReport report) {
        boolean reject = services.settings().get().securityRejectBoundGates();
        String project = projectName();
        for (BindingLint.Verdict v : report.risky()) {
            String key = lintWarningKey(project, viewPath(), component.getComponentAddressPath(), v.path());
            if (services.firstLintWarning(key)) {
                AUDIT.warnf("action=security-key-bound key=%s project=%s view=%s component=%s binding=%s source=%s"
                        + " bidirectional=%s userControlled=%s unverified=%s gate=%s", Json.sanitizeForLog(v.path()),
                    Json.sanitizeForLog(project),
                    Json.sanitizeForLog(viewPath()), Json.sanitizeForLog(component.getComponentAddressPath()),
                    Json.sanitizeForLog(v.type()), Json.sanitizeForLog(v.source()), v.bidirectional(),
                    v.userControlled(), v.unverified(),
                    v.failsClosed(reject) ? "closed" : "open (ctg.security.rejectBoundGates=false)");
            }
        }
    }

    /**
     * Session queue, on every {@code Origin.Binding} change under a security root: a binding configured on a node
     * that did not exist at start (e.g. {@code roles[3]} of a one-element array) creates that node with its first
     * value, so the lint walks the values again and merges any new verdict in (verdicts are never dropped).
     */
    private void relint() {
        BindingLint.LintReport current = lint;
        if (!current.inspected()) {
            return;   // lookup API unavailable: reported once at start
        }
        BindingLint.LintReport merged = current.merge(inspectBindings(component.getPropertyTreeOf(PropertyType.props)));
        if (merged != current) {
            lint = merged;
            warnRisky(merged);
        }
    }

    /**
     * The trusted security props plus lint verdicts. Safe from any thread: the trusted values are
     * copy-on-write ({@link TrustedProps}), and the cached snapshot is keyed by the identity of its inputs (trusted
     * map, lint report, settings), so it is rebuilt after every adopted change and settings reload without a
     * check-then-act race.
     */
    protected final PropsSnapshot props() {
        ModuleSettings.Settings s = services.settings().get();
        TrustedProps t = trusted;
        Map<String, JsonElement> values = t == null ? Map.of() : t.current();
        BindingLint.LintReport l = lint;
        PropsCache c = propsCache;
        if (c != null && c.values == values && c.lint == l && c.settings == s) {
            return c.snapshot;
        }
        PropsSnapshot p = new PropsSnapshot(t == null ? Map.of() : t.values(), l, s.securityRejectBoundGates());
        propsCache = new PropsCache(values, l, s, p);
        return p;
    }

    /** Immutable cache entry of {@link #props()}. */
    private static final class PropsCache {
        final Map<String, JsonElement> values;
        final BindingLint.LintReport lint;
        final ModuleSettings.Settings settings;
        final PropsSnapshot snapshot;

        PropsCache(Map<String, JsonElement> values, BindingLint.LintReport lint, ModuleSettings.Settings settings,
                   PropsSnapshot snapshot) {
            this.values = values;
            this.lint = lint;
            this.settings = settings;
            this.snapshot = snapshot;
        }
    }

    private void applyTrust(String rootKey, PropertyTreeChangeEvent ev) {
        TrustedProps t = trusted;
        if (t == null) {
            return;
        }
        List<TrustedProps.Revert> reverts = t.onChange(rootKey, ev.origin, ev.path == null ? null : ev.path.toString());
        if (reverts.isEmpty()) {
            return;
        }
        Origin origin = ev.origin;
        // Not from inside the change callback: the write would re-enter the tree's notification.
        runOnQueue(() -> restore(reverts, origin));
    }

    /**
     * Writes the trusted values back ({@link TrustedProps#restorePlan}: a parent object the client removed is
     * rebuilt from the trusted leaves below it) and only then reports {@code action=prop-tamper} for every leaf
     * that was actually restored (audit only on success). A leaf that could not be restored is
     * reported as {@code action=prop-tamper-unrestored}; its gate still uses the trusted value.
     */
    private void restore(List<TrustedProps.Revert> reverts, Origin origin) {
        PropertyTree tree = component.getPropertyTreeOf(PropertyType.props);
        TrustedProps t = trusted;
        Map<String, JsonElement> trustedValues = t == null ? Map.of() : t.values();
        List<TrustedProps.Write> plan = TrustedProps.restorePlan(reverts, path -> readLeaf(tree, path), trustedValues);
        UserContext u = user;
        for (TrustedProps.Write w : plan) {
            boolean written;
            try {
                if (w.value() == null) {
                    tree.remove(JsonPath.parse(w.path()), Origin.Delegate, this);
                } else {
                    tree.write(w.path(), w.value(), Origin.Delegate, this);
                }
                written = true;
            } catch (RuntimeException e) {
                logger.debugf("restore of %s failed on %s: %s", w.path(), describe(), e.toString());
                written = false;
            }
            for (String leaf : w.covers()) {
                // Restored = the leaf is back (or, for a key that was absent at start, gone again; or, for a leaf
                // shadowed by a non-object ancestor, shadowed by that ancestor again).
                boolean ok = written
                    && TrustedProps.isRestored(leaf, trustedValues.get(leaf), path -> readLeaf(tree, path));
                services.tamperLog().report(leaf, String.format(
                    "action=%s user=%s key=%s origin=%s view=%s component=%s session=%s host=%s%s",
                    ok ? "prop-tamper" : "prop-tamper-unrestored",
                    Json.sanitizeForLog(u == null ? "?" : u.userName()), leaf, origin, Json.sanitizeForLog(viewPath()),
                    Json.sanitizeForLog(component.getComponentAddressPath()), sessionId,
                    Json.sanitizeForLog(u == null ? "?" : u.remoteHost()),
                    w.path().equals(leaf) ? "" : " restoredVia=" + w.path()));
            }
        }
    }

    private static Optional<JsonElement> readLeaf(PropertyTree tree, String path) {
        Optional<QualifiedValue> q = tree.read(path);
        return q.map(v -> guardLeafJson(path, v));
    }

    /**
     * Numeric write-guard leaves whose binding quality matters: a bound limit / step guard whose
     * binding delivers a value of bad quality (a stale last value of a faulted tag) is read as JSON null, which
     * {@code DisplayGates} treats as "bound but unavailable" and refuses the write ({@code LIMITS_UNAVAILABLE}).
     */
    static final Set<String> QUALITY_GUARDED_LEAVES = Set.of("setpoint.limits.low", "setpoint.limits.high",
        "setpoint.maxStep", "setpoint.maxStepPercent");

    /** The plain JSON of a leaf's value; JSON null for a quality-guarded leaf whose quality is not Good. */
    static JsonElement guardLeafJson(String path, QualifiedValue v) {
        if (QUALITY_GUARDED_LEAVES.contains(path) && v.getQuality() != null && !v.getQuality().isGood()) {
            return JsonNull.INSTANCE;
        }
        return plainJson(v.getValue());
    }

    // =========================================================================================================
    // Outbound
    // =========================================================================================================

    /** Pushes a message to the client (dropped before the first hello, after stop and while the page is offline). */
    protected final void push(String name, JsonObject payload) {
        send(name, payload, false);
    }

    /** Error reply to request {@code id}, or an unsolicited {@code ctg.error} when {@code id} is null. */
    private void error(String id, ErrorCode code, JsonObject details) {
        send(id == null ? Protocol.ERROR : Protocol.REPLY, CallContext.errorReply(id, code, details), true);
    }

    private void sendReload(String reason) {
        JsonObject r = new JsonObject();
        r.addProperty("reason", reason);
        r.addProperty("serverProtocol", Protocol.VERSION);
        r.addProperty("serverBuild", SimpleTagDisplayModule.RESOURCE_VERSION);
        send(Protocol.RELOAD, r, true);
    }

    /**
     * Sends on the session queue (hopping onto it when called from another thread).
     *
     * @param force true for replies/errors/welcome: the client evidently has a v2 delegate (it just sent us
     *              something), so these go out even before the hello completed
     */
    private void send(String name, JsonObject payload, boolean force) {
        ExecutionQueue q = queue();
        if (q.isInQueue()) {
            sendOnQueue(name, payload, force);
        } else {
            try {
                q.submit(() -> sendOnQueue(name, payload, force));
            } catch (RuntimeException ignored) {
                // session gone
            }
        }
    }

    private void sendOnQueue(String name, JsonObject payload, boolean force) {
        if (closed || services.isClosed()) {
            return;
        }
        if (!hello && !force) {
            return;
        }
        if (!component.getPage().isConnected()) {
            // Perspective would drop the event (and WARN per drop); the client re-hellos on reconnect.
            resyncPending = true;
            return;
        }
        payload.addProperty("v", Protocol.VERSION);
        payload.addProperty("epoch", epoch);
        payload.addProperty("seq", ++seq);
        long now = System.currentTimeMillis();
        payload.addProperty("serverNow", now);
        lastSentAt = now;
        fireEvent(name, payload);
    }

    /**
     * Starts the {@code ctg.hb} heartbeat: an empty push whenever this delegate sent nothing for
     * {@code ctg.display.heartbeatMs} (live setting), so the client's watchdog can tell "quiet" from "dead".
     * Idempotent; stopped by teardown. Call from {@link #start()}.
     */
    protected final void enableHeartbeat() {
        if (heartbeat.get() != null || closed) {
            return;
        }
        try {
            ScheduledFuture<?> f = services.scheduler().scheduleWithFixedDelay(() -> {
                if (isClosed()) {
                    return;
                }
                long silence = System.currentTimeMillis() - lastSentAt;
                if (silence >= services.settings().get().displayHeartbeatMs()) {
                    runOnQueue(() -> {
                        if (hello && System.currentTimeMillis() - lastSentAt >= services.settings().get().displayHeartbeatMs()) {
                            push(Protocol.HEARTBEAT, new JsonObject());
                        }
                    });
                }
            }, HEARTBEAT_CHECK_MS, HEARTBEAT_CHECK_MS, TimeUnit.MILLISECONDS);
            if (!heartbeat.compareAndSet(null, f) || tornDown.get()) {
                f.cancel(false);
            }
        } catch (RejectedExecutionException e) {
            // module stopping
        }
    }

    // =========================================================================================================
    // Async helpers
    // =========================================================================================================

    /**
     * Runs {@code task} on the session queue if (and only if) the delegate is still running then. Safe from any
     * thread; a refused submit (session gone) is ignored.
     */
    protected final void runOnQueue(Runnable task) {
        if (isClosed()) {
            return;
        }
        try {
            queue().submit(() -> {
                if (!isClosed()) {
                    task.run();
                }
            });
        } catch (RuntimeException ignored) {
            // session gone
        }
    }

    /**
     * Continues on the session queue when {@code future} completes or after {@code timeoutMs}, whichever comes
     * first (then with a {@link TimeoutException}). The callback runs at most once and only while the delegate is
     * running. {@link CompletionException}/{@link ExecutionException} wrappers are removed.
     */
    protected final <T> void onQueue(CompletableFuture<T> future, long timeoutMs, BiConsumer<T, Throwable> callback) {
        AtomicBoolean fired = new AtomicBoolean(false);
        ScheduledFuture<?> timer;
        try {
            timer = services.scheduler().schedule(() -> {
                if (fired.compareAndSet(false, true)) {
                    runOnQueue(() -> callback.accept(null, new TimeoutException()));
                }
            }, timeoutMs, TimeUnit.MILLISECONDS);
        } catch (RejectedExecutionException e) {
            return;   // module stopping
        }
        future.whenComplete((v, err) -> {
            if (fired.compareAndSet(false, true)) {
                timer.cancel(false);
                Throwable cause = err;
                while ((cause instanceof CompletionException || cause instanceof ExecutionException) && cause.getCause() != null) {
                    cause = cause.getCause();
                }
                Throwable c = cause;
                runOnQueue(() -> callback.accept(v, c));
            }
        });
    }

    // =========================================================================================================
    // Props: subscriptions, probe, reading
    // =========================================================================================================

    /**
     * Subscribes root prop keys (in addition to the security roots, which the base watches itself). Every change is
     * logged with its origin on {@code SimpleTagDisplay.Probe} (DEBUG) and, unless it was our own
     * ({@link Origin#Delegate}), passed to {@link #onPropsChanged}. Session queue only; a key is subscribed once.
     */
    protected final void watchProps(String... rootKeys) {
        watchRoots(List.of(rootKeys));
    }

    private void watchRoots(Collection<String> rootKeys) {
        PropertyTree tree = component.getPropertyTreeOf(PropertyType.props);
        for (String key : rootKeys) {
            if (!watchedRoots.add(key)) {
                continue;
            }
            PropertyTree.Subscription s = tree.subscribe(key, Origin.ANY, ev -> onPropEvent(key, ev));
            synchronized (propSubs) {
                if (closed) {
                    // teardown (which may run off the queue) has already released the list: release this one here
                    try {
                        s.unsubscribe();
                    } catch (RuntimeException ignored) {
                        // tree already disposed
                    }
                } else {
                    propSubs.add(s);
                }
            }
        }
    }

    private void onPropEvent(String rootKey, PropertyTreeChangeEvent ev) {
        if (PROBE.isDebugEnabled()) {
            PROBE.debugf("prop-change component=%s key=%s path=%s origin=%s source=%s inQueue=%s thread=%s value=%s",
                describe(), rootKey, ev.path, ev.origin, ev.source == null ? "null" : ev.source.getClass().getSimpleName(),
                queue().isInQueue(), Thread.currentThread().getName(), Json.sanitizeForLog(ev.json));
        }
        if (closed || ev.origin == Origin.Delegate) {
            return;
        }
        try {
            if (securityRoots.contains(rootKey)) {
                // Re-lint only for binding writes at, above or below a security key; a binding
                // on a UI-only key under the same root (menu.trend.addLabel) needs no re-inspection.
                if (ev.origin == Origin.Binding
                        && TrustedProps.affectsAny(ev.path == null ? null : ev.path.toString(), securityPaths)) {
                    relint();
                }
                applyTrust(rootKey, ev);
            }
            onPropsChanged(rootKey, ev);
        } catch (RuntimeException e) {
            warnings.warn(getClass().getSimpleName() + ".props", "Prop change handling failed for " + describe(), e);
        }
    }

    /**
     * Binding diagnostics: logs, for each prop path, its current value and its binding configuration
     * ({@code component.getPropertyConfig}). DEBUG on {@code SimpleTagDisplay.Probe}; costs nothing otherwise.
     */
    protected final void probeBindings(String... propPaths) {
        if (!PROBE.isDebugEnabled()) {
            return;
        }
        PropertyTree tree = component.getPropertyTreeOf(PropertyType.props);
        for (String path : propPaths) {
            String value;
            try {
                value = tree.read(path).map(q -> plainJson(q.getValue()).toString()).orElse("<absent>");
            } catch (RuntimeException e) {
                value = "error:" + e.getClass().getSimpleName();
            }
            PROBE.debugf("binding-probe component=%s path=%s value=%s config=%s", describe(), path,
                Json.sanitizeForLog(value),
                describeConfig(() -> component.getPropertyConfig(new PropertyKey(PropertyType.props, path))));
        }
    }

    private static String describeConfig(java.util.function.Supplier<Optional<PropertyConfig>> lookup) {
        try {
            Optional<PropertyConfig> cfg = lookup.get();
            if (cfg.isEmpty()) {
                return "none";
            }
            PropertyConfig c = cfg.get();
            String binding = c.binding == null ? "none"
                : c.binding.type + (c.binding.isEnabled() ? "" : "(disabled)") + " " + Json.sanitizeForLog(c.binding.config);
            return "{binding=" + binding + ", access=" + c.getAccess() + ", persistent=" + c.persistent + "}";
        } catch (RuntimeException e) {
            return "error:" + e.getClass().getSimpleName();
        }
    }

    /**
     * Reads a prop (root key or dotted path) as plain JSON. Must run on the session queue. For security keys use
     * {@link #props()} instead — the live tree may hold a browser value that is about to be reverted.
     *
     * {@code PropertyTree.read()} returns the node as a {@link QualifiedValue}; containers come back as qualified
     * structures (observed on 8.3.10: an array prop reads as {@code QualifiedValue[]} whose elements wrap the
     * item objects), so the value is converted recursively by {@link #plainJson(Object)}.
     */
    protected final JsonElement readProp(String path) {
        PropertyTree tree = component.getPropertyTreeOf(PropertyType.props);
        Optional<QualifiedValue> q = tree.read(path);
        return q.isEmpty() ? JsonNull.INSTANCE : plainJson(q.get().getValue());
    }

    /**
     * Converts a property-tree value to plain JSON: unwraps {@link QualifiedValue}s, arrays/lists become JSON
     * arrays, maps become JSON objects, dates become epoch ms; anything else becomes its string form.
     */
    @SuppressWarnings("unchecked")
    static JsonElement plainJson(Object v) {
        if (v == null) {
            return JsonNull.INSTANCE;
        }
        if (v instanceof QualifiedValue) {
            return plainJson(((QualifiedValue) v).getValue());
        }
        if (v instanceof JsonElement) {
            return ((JsonElement) v).deepCopy();
        }
        if (v instanceof String) {
            return new JsonPrimitive((String) v);
        }
        if (v instanceof Boolean) {
            return new JsonPrimitive((Boolean) v);
        }
        if (v instanceof Number) {
            return new JsonPrimitive((Number) v);
        }
        if (v instanceof java.util.Date) {
            return new JsonPrimitive(((java.util.Date) v).getTime());
        }
        if (v instanceof Object[]) {
            JsonArray a = new JsonArray();
            for (Object o : (Object[]) v) {
                a.add(plainJson(o));
            }
            return a;
        }
        if (v instanceof Collection) {
            JsonArray a = new JsonArray();
            for (Object o : (Collection<Object>) v) {
                a.add(plainJson(o));
            }
            return a;
        }
        if (v instanceof Map) {
            JsonObject o = new JsonObject();
            for (Map.Entry<Object, Object> e : ((Map<Object, Object>) v).entrySet()) {
                o.add(String.valueOf(e.getKey()), plainJson(e.getValue()));
            }
            return o;
        }
        return new JsonPrimitive(String.valueOf(v));
    }

    /** String prop or {@code fallback}. Must run on the session queue (not for security keys: see {@link #props()}). */
    protected final String readStringProp(String path, String fallback) {
        JsonElement e = readProp(path);
        return e != null && e.isJsonPrimitive() ? e.getAsString() : fallback;
    }

    // =========================================================================================================
    // Accessors
    // =========================================================================================================

    protected final Session session() {
        return component.getSession();
    }

    protected final ExecutionQueue queue() {
        return component.getSession().queue();
    }

    /** Perspective session id (set at start). */
    protected final UUID sessionId() {
        return sessionId;
    }

    /** Current user (rebuilt on auth change). */
    protected final UserContext user() {
        return user;
    }

    /** Unique id of this delegate instance: owner of the history tokens it issues. */
    protected final String ownerId() {
        return ownerId;
    }

    /** True after teardown or module shutdown; async continuations must check it before touching anything. */
    protected final boolean isClosed() {
        return closed || services.isClosed();
    }

    /** True once the client said hello (and pushes are allowed). Session queue only. */
    protected final boolean helloReceived() {
        return hello;
    }

    /** Pushes were dropped while the page was disconnected; the client will re-hello. Session queue only. */
    protected final boolean resyncPending() {
        return resyncPending;
    }

    /** Dedupe key of the {@code security-key-bound} WARN: project, view, component address and key path. */
    static String lintWarningKey(String project, String view, String component, String keyPath) {
        return project + "|" + view + "|" + component + "|" + keyPath;
    }

    /** Project of the component's session ({@code "?"} when unavailable), for log lines and dedupe keys. */
    protected final String projectName() {
        try {
            String p = component.getSession().getProjectName();
            return p == null ? "?" : p;
        } catch (RuntimeException e) {
            return "?";
        }
    }

    /** Resource path of the view this component lives in (e.g. {@code "Overview/Main"}), for log lines. */
    protected final String viewPath() {
        try {
            String p = component.getView().getId().resourcePath;
            return p == null ? "?" : p;
        } catch (RuntimeException e) {
            return "?";
        }
    }

    /** Short identity for log lines: view, component address and session. */
    protected final String describe() {
        try {
            return kind + "@" + component.getView().getId() + "/" + component.getComponentAddressPath()
                + " session=" + session().getSessionId();
        } catch (RuntimeException e) {
            return kind + "@?";
        }
    }
}
