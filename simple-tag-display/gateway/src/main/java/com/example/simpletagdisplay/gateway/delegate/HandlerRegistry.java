package com.example.simpletagdisplay.gateway.delegate;

import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;

/**
 * Message name → (rate class, handler) map of one delegate.
 *
 * Registration happens once in {@code onStartup}; lookups happen on the session queue. Every handler declares its
 * rate class, and {@link CtgDelegateBase} enforces it centrally with one token bucket per class and delegate:
 * exceeding it answers {@code RATE_LIMITED} without running the handler. MUTATE messages are also
 * de-duplicated by request id ({@link IdempotencyMap}).
 */
public final class HandlerRegistry {

    /** Rate class of a message with its token-bucket parameters. */
    public enum RateClass {
        /** hello, ping, debug hooks. */
        CONTROL(5, 10),
        /** browse, meta, audit query. */
        READ(10, 20),
        /** write, config edit, trend add/remove/clear, annotations (also de-duplicated by id). */
        MUTATE(2, 5),
        /** {@code chart.token} requests. */
        TOKEN(1, 3);

        private final double perSecond;
        private final int burst;

        RateClass(double perSecond, int burst) {
            this.perSecond = perSecond;
            this.burst = burst;
        }

        public double perSecond() {
            return perSecond;
        }

        public int burst() {
            return burst;
        }
    }

    /** A request handler. Runs on the session queue; must not block. */
    @FunctionalInterface
    public interface Handler {
        void handle(CallContext cc);
    }

    /** Registered handler with its rate class. */
    public static final class Entry {
        private final RateClass rateClass;
        private final Handler handler;
        private final boolean requiresId;

        Entry(RateClass rateClass, Handler handler, boolean requiresId) {
            this.rateClass = rateClass;
            this.handler = handler;
            this.requiresId = requiresId;
        }

        public RateClass rateClass() {
            return rateClass;
        }

        public Handler handler() {
            return handler;
        }

        /** False only for {@code ctg.hello}, the one message without a correlation id. */
        public boolean requiresId() {
            return requiresId;
        }
    }

    private final Map<String, Entry> entries = new HashMap<>();

    /** Registers a request handler (the message must carry an {@code id}). */
    public HandlerRegistry on(String name, RateClass rateClass, Handler handler) {
        return put(name, new Entry(rateClass, handler, true));
    }

    /** Registers a handler for a message that carries no {@code id} (the handshake). */
    public HandlerRegistry onUncorrelated(String name, RateClass rateClass, Handler handler) {
        return put(name, new Entry(rateClass, handler, false));
    }

    private HandlerRegistry put(String name, Entry e) {
        if (entries.putIfAbsent(name, e) != null) {
            throw new IllegalStateException("duplicate handler for " + name);
        }
        return this;
    }

    public Entry find(String name) {
        return entries.get(name);
    }

    public Set<String> names() {
        return Collections.unmodifiableSet(entries.keySet());
    }
}
