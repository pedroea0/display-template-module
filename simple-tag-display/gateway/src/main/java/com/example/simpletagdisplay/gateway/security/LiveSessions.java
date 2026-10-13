package com.example.simpletagdisplay.gateway.security;

import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.LongSupplier;

import com.inductiveautomation.perspective.gateway.api.Session;
import com.inductiveautomation.perspective.gateway.api.SessionScope;

/**
 * The module's own registry of live Perspective sessions.
 *
 * <h2>Why our own</h2>
 * History tokens and the trend-list sweep need "is this session still alive?" for Client <b>and</b> Designer
 * sessions. Perspective's session monitor may not cover Designer sessions, so liveness is derived
 * from our own delegates instead: every {@code CtgDelegateBase} registers on startup and unregisters on shutdown.
 * A session is alive while it has at least one live delegate, and for {@link #GRACE_MS} after the last one
 * stopped (page navigation and reloads briefly drop to zero delegates without ending the session).
 * {@code SessionShutdownEvent} removes the entry at once.
 *
 * <h2>Auth generation</h2>
 * {@link #bumpAuth} increments a per-session generation when the logged-in user changes; caches keyed by
 * {@code (sessionId, authGeneration, …)} (history read-permission cache, chart meta cache) thereby drop every
 * entry of the previous user without a sweep. All delegates of a session see the same
 * {@code WebAuthStatusChangeEvent}; only the first one to report a given event object bumps (and learns that
 * it is the one that must clear the session's trend lists and tokens).
 *
 * <h2>Ending a session once</h2>
 * A session can end twice from the module's point of view: the sweep ends a session that shows no module component
 * any more (no delegate past the grace) and that Perspective's session monitor no longer has, or whose lookup failed
 * (a session Perspective still has is never swept), and Perspective's {@code SessionShutdownEvent} for the
 * same id follows when the browser really closes (without a guard, every session-end listener and the DEBUG line
 * would run twice). {@link #end} records a bounded tombstone; a later end of the same id is "already ended" unless a
 * delegate of that session registered again in between (the session came back to life, so its next end is a real
 * one).
 *
 * <p><b>Ordering (register/end tombstone race).</b> The invariant is: <em>once both calls
 * returned, a session that has an entry has no tombstone</em> — else its next real end would be taken for a repeat
 * and the session-end listeners (per-session caches) would never run for it. Clearing the tombstone at the top of
 * {@link #register}, before the entry exists, would let an {@link #end} landing between the two leave a live session
 * with a tombstone. So both tombstone operations are serialised per id by the {@code ended} map's own per-key lock:
 * {@link #end} removes the entry <em>and</em> records the tombstone in one {@code ended.compute}, and
 * {@link #register} clears the tombstone only <em>after</em> its delegate is counted, and only while its entry is
 * still the one in the map ({@code computeIfPresent}). Whichever of the two runs last decides, and both outcomes are
 * consistent: "ended, tombstone" or "alive, no tombstone". As a second line, an end that removed a live entry always
 * counts as a first end. Lock order (no cycle): {@code ended} bin → {@code entries} bin / entry monitor; nothing takes
 * the {@code ended} bin while holding an entry monitor.
 *
 * Thread-safe; all methods are cheap. The clock is injectable for unit tests.
 */
public final class LiveSessions {

    /** Liveness grace after the last delegate of a session stopped. */
    public static final long GRACE_MS = 60_000L;

    /** How long an ended session is remembered ({@link #end}); a SessionShutdownEvent normally follows within it. */
    public static final long ENDED_TTL_MS = 24L * 60 * 60_000L;
    /** Most tombstones kept; beyond it the oldest go first (a forgotten id at worst ends twice, the old behaviour). */
    public static final int MAX_ENDED = 10_000;

    private final LongSupplier clock;
    private final ConcurrentHashMap<UUID, Entry> entries = new ConcurrentHashMap<>();
    /** Ended sessions (id → end time), see {@link #end}. */
    private final ConcurrentHashMap<UUID, Long> ended = new ConcurrentHashMap<>();

    public LiveSessions() {
        this(System::currentTimeMillis);
    }

    public LiveSessions(LongSupplier clockMs) {
        this.clock = clockMs;
    }

    /** Mutable per-session state; every access synchronises on the entry. */
    private static final class Entry {
        final SessionScope scope;
        WeakReference<Session> session;
        String userName;
        int delegates;
        long lastUnregisterAt;
        long authGeneration;
        WeakReference<Object> lastAuthEvent = new WeakReference<>(null);
        /** Set (under the entry lock) when the entry left the map; a racing register must start over. */
        boolean removed;

        Entry(SessionScope scope, Session session, String userName) {
            this.scope = scope;
            this.session = new WeakReference<>(session);
            this.userName = userName;
        }
    }

    /** Result of {@link #bumpAuth}. */
    public static final class AuthChange {
        private final long generation;
        private final boolean firstObserver;
        private final boolean userChanged;

        AuthChange(long generation, boolean firstObserver, boolean userChanged) {
            this.generation = generation;
            this.firstObserver = firstObserver;
            this.userChanged = userChanged;
        }

        /** The session's auth generation after this change. */
        public long generation() {
            return generation;
        }

        /** True for exactly one caller per auth event: that caller performs the session-wide reactions. */
        public boolean firstObserver() {
            return firstObserver;
        }

        /** True when the user name differs from the one before the event (login, logout, switch user). */
        public boolean userChanged() {
            return userChanged;
        }
    }

    /**
     * A delegate of {@code session} started.
     *
     * Also detects a user change that no delegate saw as an auth event: Perspective typically navigates on
     * login/logout, so the old delegates stop and new ones start under the new user. When the session is known
     * under another user name, the auth generation is bumped and the result says {@code userChanged} (exactly one
     * caller per change gets {@code firstObserver}), so the caller performs the session-wide reactions (trend
     * lists cleared, tokens revoked).
     */
    public AuthChange register(UUID id, SessionScope scope, Session session, String userName) {
        for (;;) {
            Entry e = entries.computeIfAbsent(id, k -> new Entry(scope, session, userName));
            AuthChange change;
            synchronized (e) {
                if (e.removed) {
                    continue;   // swept or ended between lookup and lock: register into a fresh entry
                }
                e.delegates++;
                if (e.session.get() == null && session != null) {
                    e.session = new WeakReference<>(session);
                }
                if (userName != null && !userName.equals(e.userName)) {
                    e.userName = userName;
                    e.authGeneration++;
                    change = new AuthChange(e.authGeneration, true, true);
                } else {
                    change = new AuthChange(e.authGeneration, false, false);
                }
            }
            // Alive again: its next end is a real one. Cleared only now that the delegate is counted, and only while
            // this entry is still the session's — an end() that won the race since then keeps its tombstone (the
            // session really ended after this register). Outside the entry monitor: see "Ordering" above.
            if (id != null) {
                ended.computeIfPresent(id, (k, endedAt) -> entries.get(k) == e ? null : endedAt);
            }
            return change;
        }
    }

    /** A delegate of the session stopped. The entry stays alive for {@link #GRACE_MS} once the count reaches 0. */
    public void unregister(UUID id) {
        Entry e = entries.get(id);
        if (e == null) {
            return;
        }
        synchronized (e) {
            if (e.delegates > 0) {
                e.delegates--;
            }
            if (e.delegates == 0) {
                e.lastUnregisterAt = clock.getAsLong();
            }
        }
    }

    /** The session ended ({@code SessionShutdownEvent}): forget it at once. */
    public void remove(UUID id) {
        removeEntry(id);
    }

    /** Removes the session's entry and marks it removed (a racing register starts over); returns it, or null. */
    private Entry removeEntry(UUID id) {
        Entry e = id == null ? null : entries.remove(id);
        if (e != null) {
            synchronized (e) {
                e.removed = true;
            }
        }
        return e;
    }

    /**
     * The session ended (sweep or {@code SessionShutdownEvent}): forgets it like {@link #remove} and records a
     * tombstone, both in one step per id (see "Ordering" in the class comment). Returns true for the first end since
     * the session last registered a delegate (or for an id never seen, or when a live entry was removed now), false
     * when it had already ended — the caller then skips the session-end reactions it already ran.
     */
    public boolean end(UUID id) {
        if (id == null) {
            return false;
        }
        long now = clock.getAsLong();
        boolean[] first = {false};
        ended.compute(id, (k, endedAt) -> {
            // Another map is modified inside this compute (allowed); this map is not touched here (pruning is below).
            Entry removed = removeEntry(k);
            first[0] = endedAt == null || removed != null;
            return now;
        });
        if (first[0] && ended.size() > MAX_ENDED) {
            pruneEnded(now);
        }
        return first[0];
    }

    /** Tombstones currently kept (tests, diagnostics). */
    public int endedCount() {
        return ended.size();
    }

    /**
     * Drops tombstones older than {@link #ENDED_TTL_MS}, then the oldest until 90 % of {@link #MAX_ENDED} remain (so a
     * steady churn prunes once per {@code MAX_ENDED / 10} ends, not on every end).
     */
    private void pruneEnded(long now) {
        ended.entrySet().removeIf(e -> now - e.getValue() > ENDED_TTL_MS);
        int excess = ended.size() - MAX_ENDED * 9 / 10;
        if (excess > 0) {
            ended.entrySet().stream().sorted(Map.Entry.comparingByValue()).limit(excess).map(Map.Entry::getKey)
                .toList().forEach(ended::remove);
        }
    }

    /**
     * Runs {@code action} while holding the id's tombstone lock (the {@code ended} bin {@link #register} takes before
     * it returns), and returns its result. The sweep evicts an ended session's tokens and trend
     * listeners inside it, after re-checking {@link #isAlive}: a delegate that registers meanwhile either is counted
     * before the check (alive: nothing is evicted) or returns from {@link #register} only after the eviction, so the
     * listener and token it creates next can no longer be removed by that sweep. The action must not take this
     * class's {@code ended} bins (lock order: {@code ended} bin, then entry monitors / other maps).
     */
    @SuppressWarnings("unchecked")
    public <T> T underEndLock(UUID id, java.util.function.Supplier<T> action) {
        Object[] out = {null};
        if (id == null) {
            return action.get();
        }
        ended.compute(id, (k, endedAt) -> {
            out[0] = action.get();
            return endedAt;
        });
        return (T) out[0];
    }

    /** True while the session has live delegates, or within the grace period after the last one stopped. */
    public boolean isAlive(UUID id) {
        Entry e = id == null ? null : entries.get(id);
        if (e == null) {
            return false;
        }
        synchronized (e) {
            return e.delegates > 0 || clock.getAsLong() - e.lastUnregisterAt <= GRACE_MS;
        }
    }

    /** The live {@link Session} object (held weakly), when the session is alive. */
    public Optional<Session> session(UUID id) {
        Entry e = id == null ? null : entries.get(id);
        if (e == null || !isAlive(id)) {
            return Optional.empty();
        }
        synchronized (e) {
            return Optional.ofNullable(e.session.get());
        }
    }

    /** Scope the session registered with, or null when unknown. */
    public SessionScope scope(UUID id) {
        Entry e = id == null ? null : entries.get(id);
        return e == null ? null : e.scope;
    }

    /** Current auth generation of the session (0 when unknown). */
    public long authGeneration(UUID id) {
        Entry e = id == null ? null : entries.get(id);
        if (e == null) {
            return 0L;
        }
        synchronized (e) {
            return e.authGeneration;
        }
    }

    /**
     * Records an auth change. Only the first call per {@code authEvent} object increments the generation.
     *
     * @param authEvent   the {@code WebAuthStatusChangeEvent} instance (all delegates of the session receive the
     *                    same object)
     * @param newUserName user name after the change
     */
    public AuthChange bumpAuth(UUID id, Object authEvent, String newUserName) {
        Entry e = entries.get(id);
        if (e == null) {
            return new AuthChange(0L, false, false);
        }
        synchronized (e) {
            if (authEvent != null && e.lastAuthEvent.get() == authEvent) {
                return new AuthChange(e.authGeneration, false, false);
            }
            e.lastAuthEvent = new WeakReference<>(authEvent);
            boolean changed = newUserName == null ? e.userName != null : !newUserName.equals(e.userName);
            e.userName = newUserName;
            e.authGeneration++;
            return new AuthChange(e.authGeneration, true, changed);
        }
    }

    /** Outcome of {@link #endIfDead}. */
    public enum SweepEnd {
        /** The session has a live entry (it came back to life since the sweep looked): nothing was ended. */
        ALIVE,
        /** Ended now, for the first time since it last registered: run the session-end reactions. */
        FIRST,
        /** Already ended before (tombstone): only the idempotent store checks are needed. */
        REPEAT
    }

    /**
     * Ids whose entry is past the grace period right now. A snapshot only: nothing is removed; the sweep then ends
     * each one with {@link #endIfDead}, which re-checks it.
     */
    public List<UUID> deadIds() {
        List<UUID> dead = new ArrayList<>();
        long now = clock.getAsLong();
        for (Map.Entry<UUID, Entry> me : entries.entrySet()) {
            Entry e = me.getValue();
            synchronized (e) {
                if (!e.removed && e.delegates == 0 && now - e.lastUnregisterAt > GRACE_MS) {
                    dead.add(me.getKey());
                }
            }
        }
        return dead;
    }

    /**
     * The sweep's end, safe against a session that comes back to life: ends the session only
     * if, at this moment, it has no entry or its entry is still past the grace period — checked and acted on inside
     * one {@code ended.compute} for the id, under the entry's monitor (lock order {@code ended} bin → entry monitor,
     * as in {@link #end}). Removing the dead entry in {@link #sweep} and ending the id later from that stale snapshot
     * is not safe: a {@code register} in between creates a fresh, live entry that {@link #end} then removes, which
     * leaves a running chart with no session entry (its tokens could never validate again).
     */
    public SweepEnd endIfDead(UUID id) {
        if (id == null) {
            return SweepEnd.ALIVE;
        }
        long now = clock.getAsLong();
        SweepEnd[] out = {SweepEnd.ALIVE};
        ended.compute(id, (k, endedAt) -> {
            Entry e = entries.get(k);
            if (e != null) {
                synchronized (e) {
                    boolean dead = e.delegates == 0 && now - e.lastUnregisterAt > GRACE_MS;
                    if (!dead && !e.removed) {
                        out[0] = SweepEnd.ALIVE;
                        return endedAt;                 // alive again: leave the tombstone state as it is
                    }
                    entries.remove(k, e);
                    e.removed = true;
                }
                out[0] = SweepEnd.FIRST;                // a live-map entry was removed now: a real end
                return now;
            }
            out[0] = endedAt == null ? SweepEnd.FIRST : SweepEnd.REPEAT;
            return now;
        });
        if (out[0] == SweepEnd.FIRST && ended.size() > MAX_ENDED) {
            pruneEnded(now);
        }
        return out[0];
    }

    /** Removes entries that are past the grace period; returns their ids (the caller evicts their state). */
    public List<UUID> sweep() {
        List<UUID> dead = new ArrayList<>();
        long now = clock.getAsLong();
        for (Map.Entry<UUID, Entry> me : entries.entrySet()) {
            Entry e = me.getValue();
            synchronized (e) {
                if (e.delegates == 0 && now - e.lastUnregisterAt > GRACE_MS && entries.remove(me.getKey(), e)) {
                    e.removed = true;
                    dead.add(me.getKey());
                }
            }
        }
        return dead;
    }

    /** Number of known sessions (alive or in grace). */
    public int size() {
        return entries.size();
    }

    /** Live delegate count of a session (diagnostics, tests). */
    public int delegates(UUID id) {
        Entry e = id == null ? null : entries.get(id);
        if (e == null) {
            return 0;
        }
        synchronized (e) {
            return e.delegates;
        }
    }

    public void clear() {
        for (UUID id : new ArrayList<>(entries.keySet())) {
            remove(id);
        }
        ended.clear();
    }
}
