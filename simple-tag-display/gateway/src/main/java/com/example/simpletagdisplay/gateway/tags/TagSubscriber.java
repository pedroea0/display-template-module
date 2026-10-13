package com.example.simpletagdisplay.gateway.tags;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;
import java.util.function.Supplier;

import com.inductiveautomation.ignition.common.model.values.QualifiedValue;
import com.inductiveautomation.ignition.common.tags.model.SecurityContext;
import com.inductiveautomation.ignition.common.tags.model.TagManager;
import com.inductiveautomation.ignition.common.tags.model.TagPath;
import com.inductiveautomation.ignition.common.tags.model.event.TagChangeEvent;
import com.inductiveautomation.ignition.common.tags.model.event.TagChangeListener;

/**
 * The tag subscriptions of one Display Template delegate (conditional: only the keys the current props need).
 *
 * <h2>Model</h2>
 * A <em>set</em> is a map logical key → {@link TagPath} ({@link TagMetaReader} keys: {@code value}, {@code engLow},
 * {@code alarmActive} ...) subscribed with one listener per key, all carrying the session user's
 * {@link SecurityContext} ({@link TagChangeListener#getSecurityContext()}; DirectTagBinding does the same), so tag Read
 * Permissions apply. {@link #apply} replaces the set atomically: a new <em>generation</em> is published first, the
 * old listeners are released, the new ones subscribed. Values are stored per key together with the generation that
 * produced them; readers only see values of the current generation, so a late event of a previous tag can never be
 * shown under the new tag (no check-then-act race between the generation check and the store).
 *
 * <h2>Threads</h2>
 * {@link TagChangeListener#tagChanged} runs on tag-subsystem threads and does O(1) work: store the value, count the
 * event, call the {@code onChange} callback (which only schedules a coalesced flush). Everything else may be called
 * from the session queue or, for {@link #release}, any thread.
 *
 * <h2>Release (do not "simplify")</h2>
 * A set is released AT LEAST once: by {@link #apply}/{@link #release} (getAndSet), and again by the subscribe
 * completion handler when the generation changed while {@code subscribeAsync} was in flight (an unsubscribe can
 * overtake the subscribe on the tag system). Releasing twice is harmless; releasing never leaks the listener.
 *
 * <h2>Diagnostics</h2>
 * {@link #totalSubscribed()} is the module-wide number of subscribed paths (a DEBUG scale counter); {@link #size()}
 * the count of this delegate.
 */
public final class TagSubscriber {

    private static final AtomicLong TOTAL = new AtomicLong();

    private final Supplier<TagManager> tagManager;
    private final Runnable onChange;
    private final Consumer<Throwable> onSubscribeError;

    private final AtomicReference<Subscription> current = new AtomicReference<>();
    private final ConcurrentHashMap<String, GenValue> latest = new ConcurrentHashMap<>();
    private final AtomicLong events = new AtomicLong();
    private volatile long generation;
    private volatile boolean closed;

    /**
     * @param tagManager       the session's tag manager; may return null while the session is being destroyed (then
     *                         nothing is subscribed and nothing can be unsubscribed through it — see
     *                         {@code DisplayTemplateDelegate}, which falls back to the gateway's tag manager)
     * @param onChange         called (tag thread) after a value of the current generation was stored
     * @param onSubscribeError called (any thread) when {@code subscribeAsync} failed
     */
    public TagSubscriber(Supplier<TagManager> tagManager, Runnable onChange, Consumer<Throwable> onSubscribeError) {
        this.tagManager = tagManager;
        this.onChange = onChange;
        this.onSubscribeError = onSubscribeError;
    }

    /** Module-wide number of subscribed tag paths (all display delegates). */
    public static long totalSubscribed() {
        return TOTAL.get();
    }

    /**
     * Subscribes exactly {@code wanted} with {@code ctx}. When the set and the context are unchanged nothing happens
     * (returns false). Otherwise a new generation starts; values of keys whose path is unchanged are carried over
     * when {@code carryOver} is true (same tag, other conditional keys toggled: no "loading" flash), everything else
     * starts empty.
     */
    public boolean apply(Map<String, TagPath> wanted, SecurityContext ctx, boolean carryOver) {
        if (closed) {
            return false;
        }
        Subscription old = current.get();
        if (old != null && old.ctx == ctx && old.paths.equals(wanted)) {
            return false;
        }
        long gen = generation + 1;
        // Publish the new generation BEFORE replacing values: a listener of the old generation that passed its
        // generation check can no longer store (its compute sees the new generation and keeps the entry).
        generation = gen;
        Map<String, TagPath> paths = new LinkedHashMap<>(wanted);
        for (Map.Entry<String, GenValue> e : latest.entrySet()) {
            TagPath oldPath = old == null ? null : old.paths.get(e.getKey());
            boolean keep = carryOver && oldPath != null && oldPath.equals(paths.get(e.getKey()));
            if (keep) {
                latest.put(e.getKey(), new GenValue(gen, e.getValue().qv));
            } else {
                latest.remove(e.getKey());
            }
        }
        Subscription next = new Subscription(gen, paths, ctx);
        Subscription previous = current.getAndSet(next);
        unsubscribe(previous);
        subscribe(next);
        if (closed) {
            // release() ran concurrently (stop off the session queue): never leave this set behind
            unsubscribe(current.getAndSet(null));
        }
        return true;
    }

    private void subscribe(Subscription s) {
        if (s.paths.isEmpty()) {
            return;
        }
        TagManager tm = tagManager.get();
        if (tm == null) {
            return;     // the session is being destroyed (e.g. its project was deleted): nothing to subscribe to
        }
        synchronized (s) {
            if (s.released) {
                return;
            }
            TOTAL.addAndGet(s.paths.size());
            s.counted = true;
        }
        tm.subscribeAsync(s.pathList(), s.listenerList()).whenComplete((ok, err) -> {
            if (err != null) {
                onSubscribeError.accept(err);
            }
            if (closed || current.get() != s) {
                // re-pointed or released while subscribing: this set is no longer ours to keep
                tm.unsubscribeAsync(s.pathList(), s.listenerList());
            }
        });
    }

    private void unsubscribe(Subscription s) {
        if (s == null || s.paths.isEmpty()) {
            return;
        }
        synchronized (s) {
            s.released = true;
            if (s.counted) {
                TOTAL.addAndGet(-s.paths.size());
                s.counted = false;
            }
        }
        // A listener already dropped by the test hook is not registered any more: unregistering it again would make
        // the tag system WARN "Tried to unregister a path/listener combination that is not present".
        List<TagPath> paths = new ArrayList<>();
        List<TagChangeListener> listeners = new ArrayList<>();
        for (Map.Entry<String, Listener> e : s.listeners.entrySet()) {
            if (!e.getValue().dead) {
                paths.add(s.paths.get(e.getKey()));
                listeners.add(e.getValue());
            }
        }
        TagManager tm = tagManager.get();
        if (!paths.isEmpty() && tm != null) {
            tm.unsubscribeAsync(paths, listeners);
        }
    }

    /** Releases the current set (stop / module shutdown). Idempotent, any thread. */
    public void release() {
        closed = true;
        generation = generation + 1;
        unsubscribe(current.getAndSet(null));
        latest.clear();
    }

    /** Current generation (bumps on every {@link #apply}). */
    public long generation() {
        return generation;
    }

    /** Subscribed paths of the current set (key → path). */
    public Map<String, TagPath> paths() {
        Subscription s = current.get();
        return s == null ? Map.of() : s.paths;
    }

    /** Number of subscribed paths of this delegate. */
    public int size() {
        Subscription s = current.get();
        return s == null ? 0 : s.paths.size();
    }

    /** Count of change events received (all keys, all generations): the self-check's "did anything arrive". */
    public long eventCount() {
        return events.get();
    }

    /** Values of the current generation, by key. */
    public Map<String, QualifiedValue> values() {
        long gen = generation;
        Map<String, QualifiedValue> out = new LinkedHashMap<>();
        for (Map.Entry<String, GenValue> e : latest.entrySet()) {
            if (e.getValue().gen == gen && e.getValue().qv != null) {
                out.put(e.getKey(), e.getValue().qv);
            }
        }
        return out;
    }

    /** Value of one key in the current generation, or null. */
    public QualifiedValue value(String key) {
        GenValue g = latest.get(key);
        return g != null && g.gen == generation ? g.qv : null;
    }

    /**
     * Seeds a value read with {@code readAsync} (the source of truth after (re)subscribing). A value that a change
     * event of the current generation already delivered and that is newer is kept. Values for keys outside the
     * current set or for an old generation are ignored.
     */
    public void seed(long gen, String key, QualifiedValue qv) {
        if (qv == null || gen != generation) {
            return;
        }
        Subscription s = current.get();
        if (s == null || !s.paths.containsKey(key)) {
            return;
        }
        latest.compute(key, (k, cur) -> {
            if (gen != generation) {
                return cur;
            }
            if (cur != null && cur.gen == gen && cur.qv != null && !olderThan(cur.qv, qv)) {
                return cur;
            }
            return new GenValue(gen, qv);
        });
    }

    /**
     * Test hook (debug only): silently drops the listener of {@code key} on the tag system while
     * keeping it in the set, as if the subscription had died. The 60 s self-check must notice and repair it.
     */
    public boolean killForTest(String key) {
        Subscription s = current.get();
        if (s == null) {
            return false;
        }
        Listener l = s.listeners.get(key);
        TagPath p = s.paths.get(key);
        if (l == null || p == null) {
            return false;
        }
        TagManager tm = tagManager.get();
        if (tm == null) {
            return false;
        }
        l.dead = true;
        tm.unsubscribeAsync(List.of(p), List.of(l));
        return true;
    }

    private static boolean olderThan(QualifiedValue a, QualifiedValue b) {
        Date ta = a.getTimestamp();
        Date tb = b.getTimestamp();
        return ta != null && tb != null && ta.before(tb);
    }

    // =========================================================================================================
    // Internals
    // =========================================================================================================

    /** A value with the generation that produced it. Immutable. */
    private static final class GenValue {
        final long gen;
        final QualifiedValue qv;

        GenValue(long gen, QualifiedValue qv) {
            this.gen = gen;
            this.qv = qv;
        }
    }

    /** One subscribed set: paths, one listener per key, the security context. */
    private final class Subscription {
        final long gen;
        final Map<String, TagPath> paths;
        final Map<String, Listener> listeners = new LinkedHashMap<>();
        final SecurityContext ctx;
        boolean counted;   // guarded by this
        boolean released;  // guarded by this

        Subscription(long gen, Map<String, TagPath> paths, SecurityContext ctx) {
            this.gen = gen;
            this.paths = Collections.unmodifiableMap(paths);
            this.ctx = ctx;
            for (String key : paths.keySet()) {
                listeners.put(key, new Listener(gen, key, ctx));
            }
        }

        List<TagPath> pathList() {
            return new ArrayList<>(paths.values());
        }

        List<TagChangeListener> listenerList() {
            return new ArrayList<>(listeners.values());
        }
    }

    /** One listener per key; tag-subsystem threads; O(1). */
    private final class Listener implements TagChangeListener {
        private final long gen;
        private final String key;
        private final SecurityContext ctx;
        volatile boolean dead;

        Listener(long gen, String key, SecurityContext ctx) {
            this.gen = gen;
            this.key = Objects.requireNonNull(key);
            this.ctx = ctx;
        }

        @Override
        public void tagChanged(TagChangeEvent e) {
            if (e == null || e.getValue() == null || dead || gen != generation) {
                return;
            }
            events.incrementAndGet();
            GenValue next = new GenValue(gen, e.getValue());
            GenValue stored = latest.compute(key, (k, cur) -> gen != generation ? cur : next);
            if (stored == next) {
                onChange.run();
            }
        }

        @Override
        public SecurityContext getSecurityContext() {
            return ctx;
        }
    }
}
