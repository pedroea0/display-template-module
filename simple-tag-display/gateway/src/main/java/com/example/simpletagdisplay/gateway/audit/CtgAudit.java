package com.example.simpletagdisplay.gateway.audit;

import java.util.Date;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Function;

import com.example.simpletagdisplay.gateway.util.Json;
import com.example.simpletagdisplay.gateway.util.NamedThreadFactory;
import com.inductiveautomation.ignition.common.audit.AuditRecord;
import com.inductiveautomation.ignition.common.model.ApplicationScope;
import com.inductiveautomation.ignition.common.model.values.QualityCode;
import com.inductiveautomation.ignition.common.util.AuditStatus;
import com.inductiveautomation.ignition.common.util.LoggerEx;
import com.inductiveautomation.ignition.gateway.audit.AuditContext;
import com.inductiveautomation.ignition.gateway.audit.AuditProfile;
import com.inductiveautomation.ignition.gateway.model.GatewayContext;
import com.inductiveautomation.perspective.gateway.api.Component;

/**
 * Audit trail of setpoint writes, tag configuration edits and chart annotation changes.
 *
 * <h2>Two sinks</h2>
 * <ul>
 *   <li>The project's <b>audit profile</b> ({@code component.getAuditProfile()}; when the project has none and
 *       {@code ctg.audit.fallbackProfile} names one, that gateway profile). Record = the component's audit snapshot
 *       (actor = session user, host, path project/page/view/component) taken <em>at receipt</em>, action
 *       {@code "tag write"} / {@code "tag edit"}, target = the full tag path, value
 *       {@code "<new> (was <old>) [ui=<mode>] [auditId=<uuid>]"} (≤ 255 chars, the auditId suffix always survives),
 *       status GOOD / BAD / UNCERTAIN — the DirectTagBinding pattern.</li>
 *   <li>The {@code SimpleTagDisplay.Audit} logger, one INFO line per attempt, key=value, sanitised.</li>
 * </ul>
 * Without a profile there is one WARN per project ("writes are only in the gateway log"); the capabilities then say
 * {@code audit:"none"} and, with {@code ctg.audit.required}, writes are refused {@code AUDIT_UNAVAILABLE}. With
 * {@code ctg.audit.required} a write or tag edit is also refused {@code AUDIT_UNAVAILABLE} while the audit writer
 * cannot take its records (backlog full or module stopping; {@link #refuses}): "required" means the record
 * reaches the profile, not only the gateway log.
 *
 * <h2>Atomic refusal under {@code ctg.audit.required}</h2>
 * {@link #refuses} only looks at the writer (advisory: the capability snapshot and the early gate). Two attempts that
 * both saw the last free slots could each pass it and one record would then be dropped. So the final decision, right
 * before the provider is called, is
 * {@link #reserve}: one compare-and-set on the slot counter that books the attempt's record <em>and</em> its possible
 * late record ({@value #REQUIRED_HEADROOM} slots), or refuses. The counter covers every record queued or booked and not
 * yet started on the writer, so a booked record always finds room, whatever other attempts do meanwhile. An attempt
 * gives back what it did not use when it ends; a late record's slot is held at most {@value #LATE_CREDIT_HOLD_MS} ms
 * after the timeout (a provider that never completes cannot pin the queue).
 *
 * <h2>Independent of the UI</h2>
 * An {@link Attempt} is attached to the <b>raw</b> provider future, not to the delegate: it records (on the audit
 * writer, below) even when the page navigated away or the delegate stopped. Its own timer (the write timeout) records
 * {@code result=Pending} + an UNCERTAIN audit record when the provider has not answered; the final outcome is then
 * recorded a second time with {@code late=true} when (if ever) the provider completes. Every attempt therefore has
 * exactly one record, or UNCERTAIN followed by one late final record.
 *
 * <h2>Threads and order</h2>
 * The module scheduler only runs the timeout timer. The <b>logger line</b> is written on the deciding thread at the
 * moment of the decision (inside the attempt's lock, so an attempt's {@code Pending} line always precedes its
 * {@code late=true} line, also when the writer overflows).
 * The <b>profile record</b> ({@code profile.audit(...)}, which may block on a database or a remote profile) runs on the
 * dedicated single-thread {@code ctg-audit-write} executor, so a slow audit sink never delays the coalesced pushes and
 * heartbeats on {@code ctg-sched}; one thread keeps the profile records in decision order. If the executor is full
 * (1 024 records behind a stuck profile) or closed, the profile record is dropped (the logger line says
 * {@code profile=notStored}) and a rate-limited {@code action=audit-overflow} WARN counts the drops: at most one WARN
 * per minute, and drops after the last WARN are reported by a one-shot flush a minute later or at {@link #close()},
 * so no drop goes unreported. {@link #close()} (module shutdown, via {@code GatewayServices.shared}) drains
 * queued records for up to {@value #CLOSE_DRAIN_MS} ms.
 */
public final class CtgAudit implements AutoCloseable {

    private static final LoggerEx AUDIT = LoggerEx.newBuilder().build("SimpleTagDisplay.Audit");
    /** Audit value column width. */
    public static final int MAX_VALUE_CHARS = 255;
    /** Cap of the remembered "no profile" projects (one WARN each). */
    private static final int MAX_WARNED = 1024;
    /** Queued profile records before new ones are dropped (logger line only). */
    private static final int WRITE_QUEUE = 1024;
    /** Free queue slots a new attempt needs under {@code ctg.audit.required}: its record and a possible late one. */
    static final int REQUIRED_HEADROOM = 2;
    /** Minimum time between two {@code audit-overflow} WARNs. */
    static final long OVERFLOW_WARN_MS = 60_000L;
    static final long CLOSE_DRAIN_MS = 3_000;
    /** How long a timed-out attempt keeps the slot booked for its late record. */
    static final long LATE_CREDIT_HOLD_MS = 600_000L;

    public static final String ACTION_WRITE = "tag write";
    public static final String ACTION_EDIT = "tag edit";
    /** Chart annotations: target = the tag path, value = the first 200 text characters. */
    public static final String ACTION_ANNOTATION_ADD = "annotation add";
    public static final String ACTION_ANNOTATION_EDIT = "annotation edit";
    public static final String ACTION_ANNOTATION_DELETE = "annotation delete";

    private final GatewayContext gateway;
    private final ScheduledExecutorService scheduler;
    private final Function<String, String> fallbackName;
    private final Set<String> warnedNoProfile = ConcurrentHashMap.newKeySet();
    private final ThreadPoolExecutor writer = new ThreadPoolExecutor(1, 1, 60, TimeUnit.SECONDS,
        new ArrayBlockingQueue<>(WRITE_QUEUE), new NamedThreadFactory("ctg-audit-write"));
    /**
     * Profile records queued, plus slots booked by {@link #reserve}, that the writer has not started yet; never above
     * {@value #WRITE_QUEUE}, so the writer's queue (same capacity) never rejects a counted record.
     */
    private final AtomicInteger slots = new AtomicInteger();

    /**
     * @param fallbackName returns the live {@code ctg.audit.fallbackProfile} (the argument is ignored; a function so
     *                     tests can stub it)
     */
    public CtgAudit(GatewayContext gateway, ScheduledExecutorService scheduler, Function<String, String> fallbackName) {
        this.gateway = gateway;
        this.scheduler = scheduler;
        this.fallbackName = fallbackName;
        writer.allowCoreThreadTimeOut(true);
    }

    /**
     * Queues a profile record on the audit writer. When the writer is full (a stuck profile with
     * {@value #WRITE_QUEUE} records waiting) or closed, the profile write is NOT run on the deciding thread (a tag
     * provider's completion thread or {@code ctg-sched}; a blocking {@code profile.audit} there would stall it, and it
     * could overtake the attempt's still-queued UNCERTAIN record): the record is dropped and counted for the
     * {@code action=audit-overflow} WARN.
     *
     * @return true when queued; false when dropped (the caller's logger line says {@code profile=notStored})
     */
    boolean store(Runnable profileRecord) {
        return store(profileRecord, null);
    }

    /**
     * {@link #store(Runnable)} using one slot booked by {@code booked} when it has one left (it then cannot overflow),
     * else a free slot.
     */
    boolean store(Runnable profileRecord, Reservation booked) {
        if (booked == null || !booked.consume()) {
            for (;;) {
                int used = slots.get();
                if (used >= WRITE_QUEUE) {
                    overflow();
                    return false;
                }
                if (slots.compareAndSet(used, used + 1)) {
                    break;
                }
            }
        }
        try {
            writer.execute(() -> {
                slots.decrementAndGet();         // started: its slot is free again
                profileRecord.run();
            });
            return true;
        } catch (RejectedExecutionException e) {
            slots.decrementAndGet();             // writer stopped (module shutdown)
            overflow();
            return false;
        }
    }

    /**
     * Slots booked by one attempt: used by its records, the rest given back by {@link #release()} (idempotent).
     */
    public final class Reservation {
        private final AtomicInteger credits;

        Reservation(int credits) {
            this.credits = new AtomicInteger(credits);
        }

        /** Takes one booked slot; false when none is left. */
        boolean consume() {
            for (;;) {
                int c = credits.get();
                if (c <= 0) {
                    return false;
                }
                if (credits.compareAndSet(c, c - 1)) {
                    return true;
                }
            }
        }

        /** Gives back every slot not used yet. */
        void release() {
            int left = credits.getAndSet(0);
            if (left > 0) {
                slots.addAndGet(-left);
            }
        }

        /** Slots still booked (tests). */
        int credits() {
            return credits.get();
        }
    }

    /**
     * The atomic {@code AUDIT_UNAVAILABLE} decision of an attempt, made right before the provider is called
     * (see the class comment): not required → a reservation without slots (records take free slots, a full writer
     * drops them, logged); required → null (refuse) when there is no profile, the writer is stopped or fewer than
     * {@value #REQUIRED_HEADROOM} slots are free, else {@value #REQUIRED_HEADROOM} booked slots. Pass the result to
     * {@link #begin(String, String, Origin, String, String, Function, Optional, Reservation)}.
     */
    public Reservation reserve(boolean required, Optional<AuditProfile> profile) {
        if (!required) {
            return new Reservation(0);
        }
        if (profile == null || profile.isEmpty()) {
            return null;
        }
        for (;;) {
            int used = slots.get();
            if (writer.isShutdown() || WRITE_QUEUE - used < REQUIRED_HEADROOM) {
                return null;
            }
            if (slots.compareAndSet(used, used + REQUIRED_HEADROOM)) {
                return new Reservation(REQUIRED_HEADROOM);
            }
        }
    }

    /** Records queued or booked and not started (tests, diagnostics). */
    int slotsInUse() {
        return slots.get();
    }

    /**
     * True while the writer can take an attempt's profile records: running, and at least {@value #REQUIRED_HEADROOM}
     * free queue slots (the record and a possible late final record). Advisory (another attempt can fill the last slot
     * right after); with {@code ctg.audit.required} it turns a known-full writer into a refusal instead of a write
     * whose record is silently dropped.
     */
    public boolean canStore() {
        return !writer.isShutdown() && WRITE_QUEUE - slots.get() >= REQUIRED_HEADROOM;
    }

    /**
     * The {@code AUDIT_UNAVAILABLE} decision for writes and tag edits: {@code ctg.audit.required} and either no audit
     * profile or a writer that cannot take the records now ({@link #canStore()}).
     */
    public boolean refuses(boolean required, Optional<AuditProfile> profile) {
        return required && (profile == null || profile.isEmpty() || !canStore());
    }

    private final AtomicLong overflowCount = new AtomicLong();
    private final AtomicLong overflowWarnedAt = new AtomicLong(Long.MIN_VALUE);
    private final AtomicInteger flushScheduled = new AtomicInteger();

    private void overflow() {
        overflowCount.incrementAndGet();
        if (!warnOverflow(false)) {
            scheduleFlush();
        }
    }

    /**
     * Writes the {@code audit-overflow} WARN with the drops counted since the last one, unless one was written less
     * than {@value #OVERFLOW_WARN_MS} ms ago ({@code force}: always, if anything is pending).
     *
     * @return true when the WARN was written (or nothing was pending)
     */
    private boolean warnOverflow(boolean force) {
        long now = System.currentTimeMillis();
        long last = overflowWarnedAt.get();
        boolean due = force || last == Long.MIN_VALUE || now - last >= OVERFLOW_WARN_MS;
        if (!due || !overflowWarnedAt.compareAndSet(last, now)) {
            return false;
        }
        long dropped = overflowCount.getAndSet(0);
        if (dropped > 0) {
            AUDIT.warnf("action=audit-overflow dropped=%d: the audit writer is %s; these attempts are only in the"
                    + " gateway log, their audit profile records were not stored", dropped,
                writer.isShutdown() ? "stopped (module shutdown)" : "backlogged (" + WRITE_QUEUE + " records waiting)");
        }
        return true;
    }

    /**
     * Drops counted while the WARN was rate-limited are reported by one flush when the minute is over, so the final
     * burst of an overflow is never left uncounted. At most one flush is pending.
     */
    private void scheduleFlush() {
        if (!flushScheduled.compareAndSet(0, 1)) {
            return;
        }
        long last = overflowWarnedAt.get();
        long delay = last == Long.MIN_VALUE ? 0L
            : Math.max(0L, OVERFLOW_WARN_MS - (System.currentTimeMillis() - last)) + 10L;
        try {
            scheduler.schedule(() -> {
                flushScheduled.set(0);
                if (overflowCount.get() > 0 && !warnOverflow(false)) {
                    scheduleFlush();            // a WARN raced in: try again after its minute
                }
            }, delay, TimeUnit.MILLISECONDS);
        } catch (RuntimeException e) {
            flushScheduled.set(0);              // scheduler stopped (module shutdown): close() flushes
        }
    }

    /** Profile records not stored since the last overflow WARN (tests). */
    long overflowCount() {
        return overflowCount.get();
    }

    /**
     * Attempts whose provider has neither completed nor timed out yet: {@link #close()} decides them. On a module
     * restart the scheduler is shut down first, which drops their UNCERTAIN timer; without this, a write to a device
     * that never answered would be recorded nowhere (no profile record, no log line).
     */
    private final Set<Attempt> pending = ConcurrentHashMap.newKeySet();

    /** Attempts still pending (JUnit). */
    int pendingAttempts() {
        return pending.size();
    }

    /**
     * Stops the writer after draining the queued records (bounded wait); reports pending overflow drops. Attempts
     * still pending are first recorded UNCERTAIN ({@code ModuleStopping}), while the writer still takes records; a
     * provider that completes later still writes its late log line.
     */
    @Override
    public void close() {
        for (Attempt a : List.copyOf(pending)) {
            a.decideAtClose();
        }
        warnOverflow(true);
        writer.shutdown();
        try {
            if (!writer.awaitTermination(CLOSE_DRAIN_MS, TimeUnit.MILLISECONDS)) {
                AUDIT.warnf("action=audit-close: %d audit records still queued at shutdown were dropped",
                    writer.shutdownNow().size());
            }
        } catch (InterruptedException e) {
            writer.shutdownNow();
            Thread.currentThread().interrupt();
        }
    }

    // =========================================================================================================
    // Profile
    // =========================================================================================================

    /**
     * The audit profile for writes of {@code component}: the project's, else {@code ctg.audit.fallbackProfile}.
     * Never throws. Call on the session queue (it reads the component).
     */
    public Optional<AuditProfile> profile(Component component) {
        try {
            Optional<AuditProfile> p = component.getAuditProfile();
            if (p != null && p.isPresent()) {
                return p;
            }
        } catch (RuntimeException e) {
            AUDIT.debugf("project audit profile lookup failed: %s", e.toString());
        }
        String name = fallbackName.apply("");
        if (name == null || name.isBlank() || gateway == null) {
            return Optional.empty();
        }
        try {
            return Optional.ofNullable(gateway.getAuditManager().getProfile(name.trim()));
        } catch (Exception e) {
            AUDIT.debugf("fallback audit profile '%s' unavailable: %s", Json.sanitizeForLog(name), e.toString());
            return Optional.empty();
        }
    }

    /** One WARN per project the first time a write finds no audit profile. */
    public void warnNoProfile(String project) {
        String key = project == null ? "?" : project;
        if (warnedNoProfile.size() >= MAX_WARNED) {
            warnedNoProfile.clear();
        }
        if (warnedNoProfile.add(key)) {
            AUDIT.warnf("action=audit-unavailable project=%s: no audit profile (project audit profile or"
                + " ctg.audit.fallbackProfile); setpoint writes and tag edits are only recorded in the gateway log",
                Json.sanitizeForLog(key));
        }
    }

    // =========================================================================================================
    // Value formatting (pure)
    // =========================================================================================================

    /**
     * {@code "<new> (was <old>) [ui=<mode>] [auditId=<id>]"}, late records {@code "... [auditId=<id>, late=true]"};
     * at most {@value #MAX_VALUE_CHARS} characters: the head ({@code new (was old)}) is shortened with "..." so the
     * {@code [ui] [auditId]} suffix always survives. Control characters become '?'.
     */
    public static String writeValue(String newValue, String oldValue, String ui, String auditId, boolean late) {
        String head = clean(newValue) + " (was " + clean(oldValue) + ")";
        String suffix = " [ui=" + clean(ui) + "] [auditId=" + clean(auditId) + (late ? ", late=true]" : "]");
        return fit(head, suffix);
    }

    /** {@code "EngUnit: 'degF' -> 'degC'; EngHigh: 100.0 -> 150.0 [auditId=<id>]"} (≤ 255 chars, suffix kept). */
    public static String editValue(String description, String auditId, boolean late) {
        return fit(clean(description), " [auditId=" + clean(auditId) + (late ? ", late=true]" : "]"));
    }

    /** {@code "<text> [auditId=<id>]"} of an annotation change (≤ 255 chars, suffix kept). */
    public static String annotationValue(String text, String auditId, boolean late) {
        return fit(clean(text), " [auditId=" + clean(auditId) + (late ? ", late=true]" : "]"));
    }

    /** The logger's {@code action=} word: {@code tag-write}, {@code tag-edit}, {@code annotation-add}, … */
    static String logAction(String action) {
        if (ACTION_WRITE.equals(action)) {
            return "tag-write";
        }
        if (ACTION_EDIT.equals(action)) {
            return "tag-edit";
        }
        return action == null ? "unknown" : action.replace(' ', '-');
    }

    private static String fit(String head, String suffix) {
        if (head.length() + suffix.length() <= MAX_VALUE_CHARS) {
            return head + suffix;
        }
        int room = Math.max(0, MAX_VALUE_CHARS - suffix.length() - 3);
        String s = head.substring(0, Math.min(head.length(), room)) + "..." + suffix;
        return s.length() > MAX_VALUE_CHARS ? s.substring(s.length() - MAX_VALUE_CHARS) : s;
    }

    private static String clean(String s) {
        if (s == null) {
            return "null";
        }
        StringBuilder b = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            b.append(Character.isISOControl(c) ? '?' : c);
        }
        return b.toString();
    }

    // =========================================================================================================
    // Attempts
    // =========================================================================================================

    /** Who/where of an attempt, captured on the session queue at receipt. Immutable. */
    public static final class Origin {
        final String user;
        final String host;
        final String project;
        final String session;
        final String scope;
        final String view;
        final String component;
        final AuditContext context;

        /**
         * @param context the component's audit snapshot built at receipt ({@code getAuditSnapshot()...build()});
         *                null when unavailable (then the logger line is the only record)
         */
        public Origin(String user, String host, String project, String session, String scope, String view,
                      String component, AuditContext context) {
            this.user = user;
            this.host = host;
            this.project = project;
            this.session = session;
            this.scope = scope;
            this.view = view;
            this.component = component;
            this.context = context;
        }

        /** Project name ("?" when unknown). */
        public String project() {
            return project;
        }

        /** Builds the origin of {@code component}'s current session user. Session queue only; never throws. */
        public static Origin of(Component component, String user, String host, String scope) {
            AuditContext ctx = null;
            try {
                ctx = component.getAuditSnapshot().setScope(ApplicationScope.GATEWAY).setTimestamp(new Date()).build();
            } catch (RuntimeException e) {
                AUDIT.debugf("audit snapshot unavailable: %s", e.toString());
            }
            String project = "?";
            String session = "?";
            String view = "?";
            try {
                project = component.getSession().getProjectName();
                session = String.valueOf(component.getSession().getSessionId());
                view = String.valueOf(component.getView().getId().resourcePath);
            } catch (RuntimeException e) {
                // keep the placeholders
            }
            return new Origin(user, host, project, session, scope, view, component.getComponentAddressPath(), ctx);
        }
    }

    /**
     * Starts an attempt. {@code describe} renders the audit value for a given (late) flag; {@code good} decides the
     * status from the provider's quality.
     *
     * @param action      {@link #ACTION_WRITE} or {@link #ACTION_EDIT}
     * @param target      full tag path (the audit target; {@code dt.auditQuery} filters on it)
     * @param logFields   extra key=value text for the logger line (already sanitised), e.g. {@code old=75.0 new=72.5 ui=popup}
     * @param valueOf     audit value for (late) — see {@link #writeValue} / {@link #editValue}
     * @param profile     the audit profile, or empty (logger only)
     */
    public Attempt begin(String action, String target, Origin origin, String auditId, String logFields,
                         Function<Boolean, String> valueOf, Optional<AuditProfile> profile) {
        return begin(action, target, origin, auditId, logFields, valueOf, profile, null);
    }

    /**
     * {@link #begin(String, String, Origin, String, String, Function, Optional)} with the slots {@link #reserve}
     * booked for this attempt (null: none, records take free slots).
     */
    public Attempt begin(String action, String target, Origin origin, String auditId, String logFields,
                         Function<Boolean, String> valueOf, Optional<AuditProfile> profile, Reservation booked) {
        return new Attempt(action, target, origin, auditId, logFields, valueOf, profile,
            booked == null ? new Reservation(0) : booked);
    }

    /** One audited write / edit. See the class comment for the state machine. */
    public final class Attempt {
        private static final int PENDING = 0;
        private static final int TIMED_OUT = 1;
        private static final int DONE = 2;

        private final String action;
        private final String target;
        private final Origin origin;
        private final String auditId;
        private final String logFields;
        private final Function<Boolean, String> valueOf;
        private final Optional<AuditProfile> profile;
        private final Reservation booked;
        private final AtomicInteger state = new AtomicInteger(PENDING);
        private volatile ScheduledFuture<?> timer;

        Attempt(String action, String target, Origin origin, String auditId, String logFields,
                Function<Boolean, String> valueOf, Optional<AuditProfile> profile, Reservation booked) {
            this.action = action;
            this.target = target;
            this.origin = origin;
            this.auditId = auditId;
            this.logFields = logFields;
            this.valueOf = valueOf;
            this.profile = profile;
            this.booked = booked;
        }

        public String auditId() {
            return auditId;
        }

        /**
         * Watches the raw provider future: final record when it completes, UNCERTAIN after {@code timeoutMs} if it
         * has not. The decision (a CAS) is cheap and made on the completing / timer thread; the record itself is
         * queued on the audit writer (see the class comment), in decision order.
         */
        public void attach(CompletableFuture<List<QualityCode>> raw, long timeoutMs) {
            pending.add(this);
            try {
                timer = scheduler.schedule(this::onTimeout, timeoutMs, TimeUnit.MILLISECONDS);
            } catch (RejectedExecutionException e) {
                timer = null;   // module stopping: the completion below still records
            }
            raw.whenComplete(this::onComplete);
        }

        /** Module stopping with the provider still pending: UNCERTAIN now (see {@link CtgAudit#close()}). */
        synchronized void decideAtClose() {
            pending.remove(this);
            if (state.compareAndSet(PENDING, TIMED_OUT)) {
                submit(AuditStatus.UNCERTAIN, "ModuleStopping", false);
            }
        }

        private synchronized void onTimeout() {
            pending.remove(this);
            if (state.compareAndSet(PENDING, TIMED_OUT)) {
                submit(AuditStatus.UNCERTAIN, "Pending", false);
                // The late record keeps its booked slot for a while; a provider that never completes gives it back.
                try {
                    scheduler.schedule(booked::release, LATE_CREDIT_HOLD_MS, TimeUnit.MILLISECONDS);
                } catch (RejectedExecutionException e) {
                    booked.release();
                }
            }
        }

        /**
         * Queues the profile record (see {@link CtgAudit#store}), then writes the logger line on this (deciding)
         * thread: callers hold the attempt's lock, so the lines of one attempt are in decision order whatever the
         * writer does.
         */
        private void submit(AuditStatus status, String result, boolean late) {
            boolean stored = profile.isEmpty() || origin.context == null
                || store(() -> storeRecord(status, late), booked);
            logLine(result, late, stored);
        }

        private synchronized void onComplete(List<QualityCode> codes, Throwable err) {
            pending.remove(this);
            ScheduledFuture<?> t = timer;
            if (t != null) {
                t.cancel(false);
            }
            QualityCode q = err == null && codes != null && !codes.isEmpty() ? codes.get(0) : null;
            boolean good = q != null && q.isGood();
            String result = q != null ? q.getName() : (err != null ? "Exception" : "Unknown");
            AuditStatus status = good ? AuditStatus.GOOD : AuditStatus.BAD;
            if (state.compareAndSet(PENDING, DONE)) {
                submit(status, result, false);
            } else if (state.compareAndSet(TIMED_OUT, DONE)) {
                submit(status, result, true);
            }
            booked.release();                    // the slots this attempt did not use
        }

        /**
         * Records a failure that happened before the provider was called (e.g. an exception from
         * {@code writeAsync} itself). Only valid instead of {@link #attach}.
         */
        public synchronized void failedBeforeProvider(String result) {
            if (state.compareAndSet(PENDING, DONE)) {
                submit(AuditStatus.BAD, result, false);
            }
            booked.release();
        }

        /** The logger line ({@code stored=false}: the profile record was dropped by the overflow). */
        private void logLine(String result, boolean late, boolean stored) {
            AUDIT.infof("action=%s result=%s user=%s host=%s project=%s session=%s scope=%s view=%s component=%s"
                    + " tag=%s %s auditId=%s%s%s",
                logAction(action), Json.sanitizeForLog(result),
                Json.sanitizeForLog(origin.user), Json.sanitizeForLog(origin.host), Json.sanitizeForLog(origin.project),
                origin.session, origin.scope, Json.sanitizeForLog(origin.view), Json.sanitizeForLog(origin.component),
                Json.sanitizeForLog(target), logFields, auditId, late ? " late=true" : "",
                profile.isPresent() ? (stored ? "" : " profile=notStored") : " profile=none");
        }

        /** The profile record (audit writer thread only). */
        private void storeRecord(AuditStatus status, boolean late) {
            try {
                String value = valueOf.apply(late);
                AuditRecord r = origin.context.toRecordBuilder()
                    .setAction(action)
                    .setActionTarget(target)
                    .setActionValue(value)
                    .setStatusCode(status.getRawValue())
                    .setTimestamp(new Date())
                    .build();
                profile.get().audit(r);
            } catch (Exception e) {
                AUDIT.warnf("action=audit-failed auditId=%s: the audit profile rejected the record (%s)", auditId,
                    e.getClass().getSimpleName());
            }
        }
    }
}
