package com.example.simpletagdisplay.gateway;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.WeakHashMap;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import java.util.function.Supplier;

import com.example.simpletagdisplay.gateway.delegate.CtgDelegateBase;
import com.example.simpletagdisplay.gateway.history.HistoryService;
import com.example.simpletagdisplay.gateway.history.HistoryTokenStore;
import com.example.simpletagdisplay.gateway.perspective.PerspectiveInternals;
import com.example.simpletagdisplay.gateway.security.FloorPolicy;
import com.example.simpletagdisplay.gateway.security.LiveSessions;
import com.example.simpletagdisplay.gateway.security.TrustedProps;
import com.example.simpletagdisplay.gateway.trend.SessionEvictionSubscriber;
import com.example.simpletagdisplay.gateway.trend.TrendListStore;
import com.example.simpletagdisplay.gateway.util.NamedThreadFactory;
import com.inductiveautomation.ignition.common.util.LoggerEx;
import com.inductiveautomation.ignition.gateway.model.GatewayContext;
import com.inductiveautomation.perspective.gateway.api.PerspectiveContext;
import com.inductiveautomation.perspective.gateway.api.SessionScope;

/**
 * Module-scoped service container: created in {@code startup()}, closed in
 * {@code shutdown()}. Every delegate gets the instance at construction; the history route, which Perspective may
 * mount before startup, looks it up per request through {@link #current()}.
 *
 * <h2>What it owns</h2>
 * <table>
 *   <caption>services</caption>
 *   <tr><td>{@link #settings()}</td><td>every {@code ctg.*} setting, live-reloadable (polled every 10 s via
 *       {@code ctg.settings.rev})</td></tr>
 *   <tr><td>{@link #floorPolicy()}</td><td>gateway floor for writes / config edits, rebuilt on reload</td></tr>
 *   <tr><td>{@link #liveSessions()}</td><td>our own registry of live Perspective sessions + auth generations</td></tr>
 *   <tr><td>{@link #tokens()}</td><td>history tokens</td></tr>
 *   <tr><td>{@link #trendStore()}</td><td>session trend lists</td></tr>
 *   <tr><td>{@link #history()}</td><td>the history service behind {@code POST /v2/history} and its {@code ctg-history}
 *       executor (fairness, budgets and caches live inside the service)</td></tr>
 *   <tr><td>{@link #scheduler()}</td><td>{@code ctg-sched}: coalesced pushes, timeouts, heartbeats, sweeps</td></tr>
 * </table>
 * We deliberately do not use Perspective's shared executors: our shutdown must stop our own threads without
 * touching anybody else's work.
 *
 * <h2>Session lifecycle</h2>
 * Delegates report start / stop / auth changes here ({@link #delegateStarted}, {@link #delegateStopped},
 * {@link #authChanged}); the session-wide reactions (trend lists cleared when the user changes, tokens revoked) are
 * decided here once per change, not per delegate. A session ends on {@code SessionShutdownEvent}
 * ({@link SessionEvictionSubscriber}) or, as a safety net, when the session sweep
 * ({@code ctg.session.sweepMs}, default 10 min) finds it dead
 * ({@link LiveSessions#sweep()}); {@link #sessionEnded} then evicts everything the module keeps for it and calls
 * the listeners registered with {@link #onSessionEnd}.
 *
 * <h2>Extension points</h2>
 * This class is kept deliberately stable. Features that need a module-wide object (audit/meta caches, history
 * chunk/permission caches, the session meta cache) obtain it through {@link #shared(Class, Supplier)} — created
 * once, closed with the module when it is {@link AutoCloseable} — and evict per-session state through
 * {@link #onSessionEnd(Consumer)} / {@link #onUserChange(Consumer)}. No new fields are needed here.
 *
 * <h2>Shutdown</h2>
 * {@link #close()} marks the module closed (delegates answer {@code MODULE_STOPPING} and stop pushing), force-stops
 * every live delegate on its session queue (best effort, 5 s overall), stops the history executor and the scheduler
 * and clears every store, so a module restart without a gateway restart leaks no tag listener and no thread.
 */
public final class GatewayServices implements AutoCloseable {

    private static final LoggerEx LOG = LoggerEx.newBuilder().build("SimpleTagDisplay.Gateway");

    private static final long SETTINGS_POLL_S = 10;
    private static final long TOKEN_SWEEP_S = 60;
    private static final long FORCE_STOP_WAIT_MS = 5_000;
    private static final int MAX_LINT_WARN_KEYS = 4_096;

    /** Current instance for code that cannot be handed one (routes); null while the module is stopped. */
    private static volatile GatewayServices current;

    private final GatewayContext gatewayContext;
    private final PerspectiveContext perspectiveContext;
    private final ModuleSettings settings;
    private volatile FloorPolicy floorPolicy;
    private final LiveSessions liveSessions;
    private final HistoryTokenStore tokens;
    private final TrendListStore trendStore;
    private final HistoryService history;
    private final ScheduledThreadPoolExecutor scheduler;
    private final SessionEvictionSubscriber evictionSubscriber;
    private final TrustedProps.TamperLog tamperLog;

    /** Live delegates (weak: a delegate Perspective dropped without onShutdown must not be kept alive by us). */
    private final Set<CtgDelegateBase> liveDelegates = Collections.synchronizedSet(Collections.newSetFromMap(new WeakHashMap<>()));
    private final List<Consumer<UUID>> sessionEndListeners = new CopyOnWriteArrayList<>();
    private final List<Consumer<UUID>> userChangeListeners = new CopyOnWriteArrayList<>();
    private final Map<Class<?>, Object> shared = new ConcurrentHashMap<>();
    private final Set<String> lintWarned = ConcurrentHashMap.newKeySet();

    private final AtomicBoolean closed = new AtomicBoolean(false);
    private final AtomicBoolean debugSeenOn = new AtomicBoolean(false);
    private volatile boolean busRegistered;

    public GatewayServices(GatewayContext gatewayContext, PerspectiveContext perspectiveContext, ModuleSettings settings) {
        this.gatewayContext = gatewayContext;
        this.perspectiveContext = perspectiveContext;
        this.settings = settings;
        this.floorPolicy = FloorPolicy.from(settings.get(), LOG::warn);
        this.liveSessions = new LiveSessions();
        this.tokens = new HistoryTokenStore(System::currentTimeMillis, () -> settings.get().tokenTtlMs(),
            () -> settings.get().tokenDesignerTtlMs(), liveSessions::isAlive);
        this.trendStore = new TrendListStore(() -> settings.get().trendMaxPens(), () -> settings.get().trendMaxGroupsPerSession());
        this.scheduler = new ScheduledThreadPoolExecutor(2, new NamedThreadFactory("ctg-sched"));
        this.scheduler.setRemoveOnCancelPolicy(true);
        this.scheduler.setExecuteExistingDelayedTasksAfterShutdownPolicy(false);
        this.history = new HistoryService(this);
        this.evictionSubscriber = new SessionEvictionSubscriber(this);
        this.tamperLog = new TrustedProps.TamperLog(() -> settings.get().securityTamperLogPerMin());
        settings.onReload(this::applySettings);
    }

    /**
     * Starts the background work: the {@code SessionShutdownEvent} subscriber on Perspective's event bus, the 10 s
     * settings/debug poll, the 60 s token sweep and the session sweep ({@code ctg.session.sweepMs}). Called once by
     * the hook after
     * construction.
     */
    public void start() {
        try {
            perspectiveContext.getEventBus().register(evictionSubscriber);
            busRegistered = true;
        } catch (RuntimeException e) {
            LOG.warn("Could not subscribe to Perspective session events; ended sessions are evicted by the session sweep", e);
        }
        // The "ctg.debug is ON" WARN is due when the switch is turned on, not on the first debug message.
        // ctg.debug and ctg.settings.rev are live system properties without change notification: sampled every 10 s.
        scheduler.scheduleWithFixedDelay(this::pollSettings, 0, SETTINGS_POLL_S, TimeUnit.SECONDS);
        scheduler.scheduleWithFixedDelay(this::sweepTokens, TOKEN_SWEEP_S, TOKEN_SWEEP_S, TimeUnit.SECONDS);
        scheduleSessionSweep(settings.get().sessionSweepMs());
    }

    public static void install(GatewayServices services) {
        current = services;
    }

    /** The running instance, or null while the module is stopped (routes answer 503). */
    public static GatewayServices current() {
        return current;
    }

    // =========================================================================================================
    // Accessors
    // =========================================================================================================

    public GatewayContext gatewayContext() {
        return gatewayContext;
    }

    public PerspectiveContext perspectiveContext() {
        return perspectiveContext;
    }

    /** Live settings; read {@code settings().get()} at the moment a value is needed. */
    public ModuleSettings settings() {
        return settings;
    }

    /** Current floor policy (rebuilt on every settings reload). */
    public FloorPolicy floorPolicy() {
        return floorPolicy;
    }

    public LiveSessions liveSessions() {
        return liveSessions;
    }

    public HistoryTokenStore tokens() {
        return tokens;
    }

    public TrendListStore trendStore() {
        return trendStore;
    }

    public HistoryService history() {
        return history;
    }

    /** Module scheduler ({@code ctg-sched-*}): coalesced pushes, timeouts, sweeps. Tasks must never block for long. */
    public ScheduledThreadPoolExecutor scheduler() {
        return scheduler;
    }

    /** Module-wide {@code action=prop-tamper} WARN limiter. */
    public TrustedProps.TamperLog tamperLog() {
        return tamperLog;
    }

    public boolean isClosed() {
        return closed.get();
    }

    /**
     * Live value of the {@code ctg.debug} system property. Read on every call so tests can switch the debug hooks
     * on and off without a restart ({@code java.lang.System.setProperty} from a gateway script); never set it in
     * {@code ignition.conf}. Logs one WARN each time it is seen switching on
     * (sampled every 10 s, so the WARN appears within 10 s of activation).
     */
    public boolean debugEnabled() {
        boolean on = Boolean.parseBoolean(System.getProperty("ctg.debug", "false"));
        if (on && debugSeenOn.compareAndSet(false, true)) {
            LOG.warn("ctg.debug is ON: test hooks enabled (ctg.debug.fire). Never leave this on in production.");
        } else if (!on) {
            debugSeenOn.set(false);
        }
        return on;
    }

    /**
     * Module-wide singleton of {@code type}, created by {@code factory} on first use (extension point; see the
     * class comment). Closed with the module when it implements {@link AutoCloseable}.
     */
    @SuppressWarnings("unchecked")
    public <T> T shared(Class<T> type, Supplier<T> factory) {
        if (isClosed()) {
            throw new IllegalStateException("module services are closed");
        }
        return (T) shared.computeIfAbsent(type, k -> factory.get());
    }

    /** Called with the session id whenever a session ends (event or sweep), after the module's own eviction. */
    public void onSessionEnd(Consumer<UUID> listener) {
        sessionEndListeners.add(listener);
    }

    /** Called with the session id when the logged-in user of a session changed (once per change). */
    public void onUserChange(Consumer<UUID> listener) {
        userChangeListeners.add(listener);
    }

    /**
     * True the first time a given (fixed, configuration-derived) key is seen; used for "one WARN per view" lint
     * messages. Bounded: the set is reset when it reaches {@value #MAX_LINT_WARN_KEYS} keys.
     */
    public boolean firstLintWarning(String key) {
        if (lintWarned.size() >= MAX_LINT_WARN_KEYS) {
            lintWarned.clear();
        }
        return lintWarned.add(key);
    }

    // =========================================================================================================
    // Session lifecycle (called by CtgDelegateBase and the eviction subscriber)
    // =========================================================================================================

    /** A delegate started (session queue). Registers it and performs user-change reactions when needed. */
    public LiveSessions.AuthChange delegateStarted(CtgDelegateBase d, UUID sessionId, SessionScope scope,
                                                   com.inductiveautomation.perspective.gateway.api.Session session,
                                                   String userName) {
        liveDelegates.add(d);
        LiveSessions.AuthChange change = liveSessions.register(sessionId, scope, session, userName);
        if (change.firstObserver() && change.userChanged()) {
            userChanged(sessionId);
        }
        return change;
    }

    /** A delegate stopped (any thread): unregister it and revoke the history tokens it issued. */
    public void delegateStopped(CtgDelegateBase d, UUID sessionId, String ownerId) {
        liveDelegates.remove(d);
        liveSessions.unregister(sessionId);
        tokens.revokeOwner(ownerId);
    }

    /**
     * A delegate saw {@code WebAuthStatusChangeEvent} (session queue). The first delegate per event bumps the
     * session's auth generation (old permission-cache entries die with it), revokes the session's history tokens
     * (each chart delegate reissues its own) and, when the user name changed, clears the session's trend lists.
     */
    public LiveSessions.AuthChange authChanged(UUID sessionId, Object event, String userName) {
        LiveSessions.AuthChange change = liveSessions.bumpAuth(sessionId, event, userName);
        if (change.firstObserver()) {
            tokens.revokeSession(sessionId);
            if (change.userChanged()) {
                userChanged(sessionId);
            }
        }
        return change;
    }

    private void userChanged(UUID sessionId) {
        if (settings.get().trendClearOnUserChange()) {
            int n = trendStore.clearSession(sessionId);
            LOG.debugf("user changed in session %s: %d trend entries cleared", sessionId, n);
        }
        tokens.revokeSession(sessionId);
        for (Consumer<UUID> l : userChangeListeners) {
            try {
                l.accept(sessionId);
            } catch (RuntimeException e) {
                LOG.warn("user-change listener failed", e);
            }
        }
    }

    /**
     * The session ended: evict everything the module keeps for it. Idempotent, any thread. A session the sweep already
     * ended is not ended again when Perspective's {@code SessionShutdownEvent} for it arrives later: the stores are
     * still checked (cheap, idempotent), but the session-end listeners and the log line run once — again only if
     * something was left to evict.
     */
    public void sessionEnded(UUID sessionId) {
        if (sessionId == null) {
            return;
        }
        evictEnded(sessionId, liveSessions.end(sessionId));
    }

    /**
     * The sweep's session end: ends {@code sessionId} only if it is still dead at this moment
     * ({@link LiveSessions#endIfDead}), and evicts its state only while it has not come back to life. Package-private
     * for JUnit.
     */
    void sweepEnd(UUID sessionId) {
        // "Dead" for LiveSessions means no module component for longer than the grace period — a live Perspective
        // session showing an alarm or home page for a few minutes would look dead and lose its trend lists, its
        // annotation quota and its caches. While Perspective still has the session it is not ended here (its
        // SessionShutdownEvent does that); only a failed lookup falls back to the delegate-count rule.
        if (perspectiveSessionOpen.apply(sessionId).orElse(false)) {
            return;
        }
        LiveSessions.SweepEnd r = liveSessions.endIfDead(sessionId);
        if (r == LiveSessions.SweepEnd.ALIVE) {
            return;
        }
        // The liveness re-check and the eviction run under the id's tombstone lock, which a registering
        // delegate passes before it adds its trend listener and gets its token. Between a lock-free re-check and the
        // eviction, a chart that came back could lose its new listener (Trend Tag never reached it) and its token.
        int[] n = liveSessions.underEndLock(sessionId, () -> {
            if (liveSessions.isAlive(sessionId)) {
                return null;                            // came back to life: its new delegates own the state
            }
            Runnable hook = beforeSweepEvict;
            if (hook != null) {
                hook.run();
            }
            return new int[] {tokens.revokeSession(sessionId), trendStore.evictSession(sessionId)};
        });
        if (n != null) {
            afterEnd(sessionId, r == LiveSessions.SweepEnd.FIRST, n[0], n[1]);
        }
    }

    /** JUnit only: runs inside the sweep's eviction, after the liveness re-check. */
    volatile Runnable beforeSweepEvict;

    /**
     * Does Perspective still have the session? Empty = unknown (lookup failed / no context). Package-private and
     * replaceable for JUnit.
     */
    volatile java.util.function.Function<UUID, Optional<Boolean>> perspectiveSessionOpen =
        id -> PerspectiveInternals.sessionOpen(perspectiveContext(), id);

    private void evictEnded(UUID sessionId, boolean first) {
        afterEnd(sessionId, first, tokens.revokeSession(sessionId), trendStore.evictSession(sessionId));
    }

    private void afterEnd(UUID sessionId, boolean first, int t, int e) {
        if (!first && t == 0 && e == 0) {
            return;                                     // already ended (sweep, then SessionShutdownEvent)
        }
        for (Consumer<UUID> l : sessionEndListeners) {
            try {
                l.accept(sessionId);
            } catch (RuntimeException ex) {
                LOG.warn("session-end listener failed", ex);
            }
        }
        LOG.debugf("session %s ended: %d tokens revoked, %d trend entries evicted", sessionId, t, e);
    }

    /** Number of live delegates (diagnostics, tests). */
    public int liveDelegateCount() {
        return liveDelegates.size();
    }

    // =========================================================================================================
    // Periodic work
    // =========================================================================================================

    private void pollSettings() {
        try {
            debugEnabled();
            settings.reloadIfRevChanged();
        } catch (RuntimeException e) {
            LOG.warn("Settings poll failed", e);
        }
    }

    private void applySettings(ModuleSettings.Settings s) {
        floorPolicy = FloorPolicy.from(s, LOG::warn);
        history.applySettings(s);
        if (s.sessionSweepMs() != sessionSweepMs) {
            scheduleSessionSweep(s.sessionSweepMs());      // a new interval applies at once, not after the old one
        }
    }

    // ---- session sweep ------------------------------------------------------------------------------------------

    private final Object sweepLock = new Object();
    private ScheduledFuture<?> sessionSweep;            // guarded by sweepLock
    private volatile long sessionSweepMs;

    /**
     * (Re)schedules the session sweep every {@code ms} ({@code ctg.session.sweepMs}, read live on settings reload).
     * Replacing the schedule cancels the pending run without interrupting one in progress.
     */
    private void scheduleSessionSweep(long ms) {
        synchronized (sweepLock) {
            if (sessionSweep != null) {
                sessionSweep.cancel(false);
            }
            sessionSweepMs = ms;
            try {
                sessionSweep = scheduler.scheduleWithFixedDelay(this::sweepSessions, ms, ms, TimeUnit.MILLISECONDS);
            } catch (RuntimeException e) {
                sessionSweep = null;                    // scheduler stopped (module shutdown)
            }
        }
        LOG.debugf("session sweep every %d ms", ms);
    }

    private void sweepTokens() {
        try {
            int n = tokens.sweep();
            if (n > 0) {
                LOG.debugf("token sweep removed %d", n);
            }
        } catch (RuntimeException e) {
            LOG.warn("Token sweep failed", e);
        }
    }

    /**
     * Safety net for a missed SessionShutdownEvent: sessions whose delegates are gone (past the grace) and lists of
     * unknown sessions.
     */
    private void sweepSessions() {
        try {
            // Every id is re-checked and ended in one step (LiveSessions.endIfDead), not from the snapshot taken
            // at the start: the listener work of earlier ids can take long enough for a session to come back to
            // life meanwhile, and ending it then would strand its running chart without a session entry.
            for (UUID id : liveSessions.deadIds()) {
                sweepEnd(id);
            }
            for (UUID id : trendStore.sessions()) {
                if (!liveSessions.isAlive(id)) {
                    sweepEnd(id);
                }
            }
        } catch (RuntimeException e) {
            LOG.warn("Session sweep failed", e);
        }
    }

    // =========================================================================================================
    // Shutdown
    // =========================================================================================================

    /**
     * Stops everything. Idempotent. Delegates still alive see {@link #isClosed()} and answer MODULE_STOPPING; each is
     * force-stopped on its session queue (falling back to the calling thread after {@value #FORCE_STOP_WAIT_MS} ms):
     * tags unsubscribed, listeners unregistered, tokens revoked.
     */
    @Override
    public void close() {
        if (!closed.compareAndSet(false, true)) {
            return;
        }
        forceStopDelegates();
        if (busRegistered) {
            try {
                perspectiveContext.getEventBus().unregister(evictionSubscriber);
            } catch (RuntimeException e) {
                LOG.debug("event bus unregister failed", e);
            }
        }
        history.close();
        scheduler.shutdownNow();
        try {
            if (!scheduler.awaitTermination(5, TimeUnit.SECONDS)) {
                LOG.warn("ctg-sched did not stop within 5 s");
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        tokens.clear();
        trendStore.clearAll();
        liveSessions.clear();
        for (Object o : shared.values()) {
            if (o instanceof AutoCloseable) {
                try {
                    ((AutoCloseable) o).close();
                } catch (Exception e) {
                    LOG.warn("Could not close " + o.getClass().getSimpleName(), e);
                }
            }
        }
        shared.clear();
    }

    private void forceStopDelegates() {
        List<CtgDelegateBase> list;
        synchronized (liveDelegates) {
            list = new ArrayList<>(liveDelegates);
        }
        if (list.isEmpty()) {
            return;
        }
        List<CompletableFuture<Void>> done = new ArrayList<>();
        for (CtgDelegateBase d : list) {
            CompletableFuture<Void> f = new CompletableFuture<>();
            done.add(f);
            if (!d.submitForceStop(f)) {
                d.forceStop();
                f.complete(null);
            }
        }
        try {
            CompletableFuture.allOf(done.toArray(new CompletableFuture[0])).get(FORCE_STOP_WAIT_MS, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (Exception e) {
            // timeout or failure: finish the stragglers on this thread below
        }
        int direct = 0;
        for (int i = 0; i < list.size(); i++) {
            if (!done.get(i).isDone()) {
                list.get(i).forceStop();   // idempotent and thread-safe by contract
                direct++;
            }
        }
        LOG.infof("Force-stopped %d delegate(s) on module shutdown%s", list.size(),
            direct > 0 ? " (" + direct + " off their session queue after the 5 s wait)" : "");
    }
}
