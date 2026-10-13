package com.example.simpletagdisplay.gateway.browse;

import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.LongSupplier;

import com.example.simpletagdisplay.common.protocol.ErrorCode;
import com.example.simpletagdisplay.gateway.GatewayServices;
import com.example.simpletagdisplay.gateway.util.TokenBucket;

/**
 * Module-wide admission of recursive tag searches (bounded so search cannot be used for denial of service).
 * One instance per module ({@link #of}: {@code GatewayServices.shared}); thread-safe.
 *
 * <pre>
 *   per session  rate         {@value #RATE_PER_SECOND}/s, burst {@value #RATE_BURST} new searches  → RATE_LIMITED
 *   per session  concurrency  {@value #MAX_PER_SESSION} running search (all charts of the session)     → BUSY
 *   gateway      concurrency  {@value #MAX_GLOBAL} running searches                                       → BUSY
 * </pre>
 * Both codes are retryable; the tag browser retries once after a short pause.
 *
 * <p><b>Fairness of the gateway-wide cap.</b> Each session holds at most one slot; on top of that,
 * a session refused because the gateway cap was full <i>waits</i> (for {@value #WAIT_MS} ms after its last refusal).
 * Freed slots go to the waiting sessions first, oldest first: a session may take a slot only while more slots are
 * free than other sessions have waited longer than it (a session that is not waiting counts as the newest). And while
 * another session waits, a chart that replaces its running search does not keep its slot ({@link #charge} answers
 * {@code BUSY}; the old walk winds down and returns it). So a few sessions that keep re-searching a slow provider
 * cannot hold all {@value #MAX_GLOBAL} slots against everybody else: a refused session gets the next free slot on
 * its retry. A waiting entry that is not retried expires, so a gone session holds a free slot back for at most
 * {@value #WAIT_MS} ms. Sessions are still the unit: many sessions of one client are many waiters (the per-session
 * rate and the gateway's Perspective session limits bound that).
 *
 * <p>A chart that starts a new search
 * while its previous one still runs does not ask again: it keeps its {@link Ticket} and the new search waits for the
 * old one's calls in flight to return ({@link TagBrowseService}), so cancelling and re-typing never multiplies the
 * work in flight. Paging through a finished search's stored results and cancelling are not searches and are not
 * counted (they only pass the delegate's READ rate class).
 *
 * <p>Rate-limit keys are session ids, never client text. The per-session state is dropped when the
 * session ends ({@code GatewayServices.onSessionEnd}) and swept when idle, so the map stays bounded by the live
 * sessions. The limits are constants in 2.0.0, not module settings.
 */
public final class TagSearchAdmission {

    static final double RATE_PER_SECOND = 1.0;
    static final int RATE_BURST = 4;
    static final int MAX_PER_SESSION = 1;
    static final int MAX_GLOBAL = 4;
    /** Idle per-session entries (no running search, bucket full again) are swept after this long. */
    static final long IDLE_MS = 60_000L;
    /** Hard cap of tracked sessions; the oldest idle entries go first. */
    static final int MAX_SESSIONS = 10_000;
    /** A session refused by the gateway cap waits this long after its last refusal (fairness, see above). */
    static final long WAIT_MS = 5_000L;

    /** A held search slot. Release exactly once (further calls are no-ops). */
    public final class Ticket {
        private final UUID session;
        private final AtomicBoolean released = new AtomicBoolean(false);

        private Ticket(UUID session) {
            this.session = session;
        }

        public void release() {
            if (released.compareAndSet(false, true)) {
                TagSearchAdmission.this.release(session);
            }
        }

        public boolean released() {
            return released.get();
        }
    }

    /** Outcome of {@link #tryAcquire}: a ticket, or the refusal code. */
    public static final class Admit {
        private final Ticket ticket;
        private final ErrorCode refusal;

        private Admit(Ticket ticket, ErrorCode refusal) {
            this.ticket = ticket;
            this.refusal = refusal;
        }

        public Ticket ticket() {
            return ticket;
        }

        /** Null when admitted. */
        public ErrorCode refusal() {
            return refusal;
        }
    }

    private static final class SessionState {
        final TokenBucket bucket;
        int running;
        long lastUseMs;
        /** Queue position: order of the first refusal by the full gateway cap (no slot since), or -1 (not waiting). */
        long waitingSince = -1L;
        long lastRefusedMs;

        SessionState(TokenBucket bucket, long now) {
            this.bucket = bucket;
            this.lastUseMs = now;
        }
    }

    private final LongSupplier clock;
    private final Map<UUID, SessionState> sessions = new HashMap<>();
    /** Sessions waiting for a gateway slot (a subset of {@link #sessions}; small: bounded by the refused sessions). */
    private final Map<UUID, SessionState> waiting = new HashMap<>();
    private int running;
    private long lastSweepMs;
    /** Queue numbers of waiting sessions (refusal order; a clock could tie within one millisecond). */
    private long waitSeq;

    TagSearchAdmission(LongSupplier clock) {
        this.clock = clock;
    }

    /** The module's instance (created on first use; its per-session entries die with the session). */
    public static TagSearchAdmission of(GatewayServices services) {
        return services.shared(TagSearchAdmission.class, () -> {
            TagSearchAdmission a = new TagSearchAdmission(System::currentTimeMillis);
            services.onSessionEnd(a::evictSession);
            return a;
        });
    }

    /** Admits a new search of {@code session} (rate, then per-session and global concurrency). */
    public synchronized Admit tryAcquire(UUID session) {
        long now = clock.getAsLong();
        sweep(now);
        SessionState s = sessions.get(session);
        if (s == null) {
            if (sessions.size() >= MAX_SESSIONS) {
                return new Admit(null, ErrorCode.BUSY);
            }
            s = new SessionState(new TokenBucket(RATE_PER_SECOND, RATE_BURST, clock), now);
            sessions.put(session, s);
        }
        s.lastUseMs = now;
        if (!s.bucket.tryAcquire()) {
            return new Admit(null, ErrorCode.RATE_LIMITED);
        }
        if (s.running >= MAX_PER_SESSION) {
            return new Admit(null, ErrorCode.BUSY);   // its own search runs: not a wait for the gateway cap
        }
        if (MAX_GLOBAL - running <= waitersAhead(session, s, now)) {
            markWaiting(session, s, now);
            return new Admit(null, ErrorCode.BUSY);
        }
        s.waitingSince = -1L;
        waiting.remove(session);
        s.running++;
        running++;
        return new Admit(new Ticket(session), null);
    }

    /** Other sessions waiting longer than {@code s} (all live waiters when {@code s} is not waiting). Drops expired ones. */
    private int waitersAhead(UUID session, SessionState s, long now) {
        int ahead = 0;
        Iterator<Map.Entry<UUID, SessionState>> it = waiting.entrySet().iterator();
        while (it.hasNext()) {
            Map.Entry<UUID, SessionState> e = it.next();
            SessionState w = e.getValue();
            if (now - w.lastRefusedMs > WAIT_MS || w.waitingSince < 0) {
                w.waitingSince = -1L;
                it.remove();
                continue;
            }
            if (e.getKey().equals(session)) {
                continue;
            }
            if (s.waitingSince < 0 || w.waitingSince < s.waitingSince) {
                ahead++;
            }
        }
        return ahead;
    }

    private void markWaiting(UUID session, SessionState s, long now) {
        if (s.waitingSince < 0) {
            s.waitingSince = ++waitSeq;
        }
        s.lastRefusedMs = now;
        waiting.put(session, s);
    }

    /**
     * Charges one new search to {@code session}'s rate without taking a slot: a chart that already holds a ticket
     * and replaces its running search. Null when allowed, else {@code RATE_LIMITED}.
     */
    public synchronized ErrorCode charge(UUID session) {
        long now = clock.getAsLong();
        SessionState s = sessions.get(session);
        if (s == null) {
            return null;   // cannot happen while a ticket is held; nothing to charge
        }
        s.lastUseMs = now;
        if (!s.bucket.tryAcquire()) {
            return ErrorCode.RATE_LIMITED;
        }
        // Fairness: while another session waits for a slot, replacing a search does not keep this one; the
        // caller cancels the running search (which returns the slot) and answers BUSY, and this session queues
        if (waitersAhead(session, s, now) > 0) {
            markWaiting(session, s, now);
            return ErrorCode.BUSY;
        }
        return null;
    }

    private synchronized void release(UUID session) {
        running = Math.max(0, running - 1);
        SessionState s = sessions.get(session);
        if (s != null) {
            s.running = Math.max(0, s.running - 1);
            s.lastUseMs = clock.getAsLong();
        }
    }

    /** Forgets a session's rate state (its running searches end with their delegates, which release the tickets). */
    public synchronized void evictSession(UUID session) {
        SessionState s = sessions.get(session);
        waiting.remove(session);
        if (s != null && s.running == 0) {
            sessions.remove(session);
        }
    }

    /** Drops idle entries (nothing running, unused for {@value #IDLE_MS} ms: the bucket is full again anyway). */
    private void sweep(long now) {
        if (now - lastSweepMs < 10_000L && sessions.size() < MAX_SESSIONS) {
            return;   // at most every 10 s (or when full)
        }
        lastSweepMs = now;
        Iterator<SessionState> it = sessions.values().iterator();
        while (it.hasNext()) {
            SessionState s = it.next();
            if (s.running == 0 && now - s.lastUseMs > IDLE_MS) {
                it.remove();
                waiting.values().remove(s);
            }
        }
    }

    /** Running searches gateway-wide (diagnostics, tests). */
    public synchronized int running() {
        return running;
    }

    /** Sessions waiting for a gateway slot, expired ones included until the next acquire (diagnostics, tests). */
    synchronized int waitingSessions() {
        return waiting.size();
    }

    /** Tracked sessions (diagnostics, tests). */
    synchronized int trackedSessions() {
        return sessions.size();
    }
}
