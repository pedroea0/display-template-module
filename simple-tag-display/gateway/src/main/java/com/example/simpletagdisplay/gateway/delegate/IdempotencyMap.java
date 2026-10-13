package com.example.simpletagdisplay.gateway.delegate;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.CompletableFuture;

import com.inductiveautomation.ignition.common.gson.JsonArray;
import com.inductiveautomation.ignition.common.gson.JsonElement;
import com.inductiveautomation.ignition.common.gson.JsonObject;

/**
 * Request-id → reply future for MUTATE messages, recorded <b>at receipt</b> (before any permission check or tag
 * access), so a duplicate that arrives while the first is still running never executes.
 *
 * A client may resend a write with the same {@code id} (its own retry after a reconnect, or a replay). The first
 * receipt creates the future and executes the handler; every later receipt of the same id — while the first is
 * still pending or after it completed — attaches to the same future and gets the same reply. Nothing executes
 * twice, so one write produces one tag write and one audit record.
 *
 * <h2>Fingerprints</h2>
 * A retry is the SAME request: same message name and same body (envelope fields {@code id}/{@code v}/{@code build}
 * and the cosmetic {@code display} text excluded, see {@link #fingerprint}). Each claim records that fingerprint. An
 * id that comes back with a different fingerprint is not a retry — it is a reused id (a page reloaded while this
 * delegate survived restarts its id counter): against a <em>completed</em> entry it executes as a new request (the
 * entry is replaced); against a <em>pending</em> one it is refused ({@link Claim#conflict()}, the caller answers
 * {@code BAD_REQUEST}), because two different replies would go out under one id. Without the fingerprint, a reused
 * id would be answered with the old request's reply — "Written" for a setpoint that never reached the tag.
 *
 * Bounded: all pending entries plus the last {@value #KEEP_COMPLETED} completed ones; at most
 * {@value #MAX_PENDING} pending (the MUTATE rate limit keeps the real number far lower). Thread-safe.
 */
public final class IdempotencyMap {

    public static final int KEEP_COMPLETED = 32;
    public static final int MAX_PENDING = 256;

    /** Body fields that are not part of a request's identity. */
    private static final Set<String> NOT_IDENTITY = Set.of("id", "v", "build", "display");

    private static final class Slot {
        final CompletableFuture<JsonObject> future;
        final String fingerprint;

        Slot(CompletableFuture<JsonObject> future, String fingerprint) {
            this.future = future;
            this.fingerprint = fingerprint;
        }
    }

    private final LinkedHashMap<String, Slot> entries = new LinkedHashMap<>();

    /** Result of {@link #claim}. */
    public static final class Claim {
        private final boolean fresh;
        private final boolean conflict;
        private final CompletableFuture<JsonObject> future;

        Claim(boolean fresh, boolean conflict, CompletableFuture<JsonObject> future) {
            this.fresh = fresh;
            this.conflict = conflict;
            this.future = future;
        }

        /** True for the first receipt of the id: the caller executes the request and completes {@link #future()}. */
        public boolean fresh() {
            return fresh;
        }

        /**
         * True when the id is pending for a DIFFERENT request (fingerprint mismatch): nothing executes, the caller
         * answers {@code BAD_REQUEST}; {@link #future()} is null.
         */
        public boolean conflict() {
            return conflict;
        }

        /** The reply (the {@code ctg.reply} body without envelope fields) once the request finished. */
        public CompletableFuture<JsonObject> future() {
            return future;
        }
    }

    /** {@link #claim(String, String)} without a fingerprint (every receipt of the id is a retry). */
    public Claim claim(String id) {
        return claim(id, null);
    }

    /**
     * Claims {@code id} for the request with {@code fingerprint} ({@link #fingerprint}; null = unknown, matches
     * anything). Returns null when {@value #MAX_PENDING} requests are already pending (the caller answers
     * {@code RATE_LIMITED}).
     */
    public synchronized Claim claim(String id, String fingerprint) {
        Slot existing = entries.get(id);
        if (existing != null) {
            boolean same = existing.fingerprint == null || fingerprint == null
                || existing.fingerprint.equals(fingerprint);
            if (same) {
                return new Claim(false, false, existing.future);
            }
            if (!existing.future.isDone()) {
                return new Claim(false, true, null);
            }
            entries.remove(id);   // a completed entry of another request: this one is new
        }
        if (pendingCount() >= MAX_PENDING) {
            return null;
        }
        CompletableFuture<JsonObject> f = new CompletableFuture<>();
        entries.put(id, new Slot(f, fingerprint));
        evictCompleted();
        return new Claim(true, false, f);
    }

    /**
     * Forgets every completed entry (a fresh client delegate said hello: none of its requests can be a retry of an
     * earlier page's). Pending entries stay.
     */
    public synchronized void clearCompleted() {
        entries.values().removeIf(s -> s.future.isDone());
    }

    /** Number of entries (pending + retained completed). */
    public synchronized int size() {
        return entries.size();
    }

    public synchronized int pendingCount() {
        int n = 0;
        for (Slot s : entries.values()) {
            if (!s.future.isDone()) {
                n++;
            }
        }
        return n;
    }

    /** Drops the oldest completed entries beyond {@value #KEEP_COMPLETED}. */
    private void evictCompleted() {
        int completed = entries.size() - pendingCount();
        Iterator<Map.Entry<String, Slot>> it = entries.entrySet().iterator();
        while (completed > KEEP_COMPLETED && it.hasNext()) {
            if (it.next().getValue().future.isDone()) {
                it.remove();
                completed--;
            }
        }
    }

    /** Fails every pending future (delegate stop): attached senders see the failure and send nothing. */
    public synchronized void cancelPending() {
        for (Slot s : entries.values()) {
            if (!s.future.isDone()) {
                s.future.cancel(false);
            }
        }
    }

    /**
     * Identity of a request: the message name plus the body in canonical form (object keys sorted at every level),
     * without {@code id}, {@code v}, {@code build} and the cosmetic {@code display} text at the top level.
     */
    public static String fingerprint(String name, JsonObject body) {
        StringBuilder b = new StringBuilder(Objects.toString(name, "")).append('\u0000');
        if (body != null) {
            List<String> keys = new ArrayList<>(body.keySet());
            Collections.sort(keys);
            b.append('{');
            for (String k : keys) {
                if (NOT_IDENTITY.contains(k)) {
                    continue;
                }
                b.append(new com.inductiveautomation.ignition.common.gson.JsonPrimitive(k)).append(':');
                canonical(body.get(k), b);
                b.append(',');
            }
            b.append('}');
        }
        return b.toString();
    }

    private static void canonical(JsonElement e, StringBuilder b) {
        if (e == null || e.isJsonNull()) {
            b.append("null");
        } else if (e.isJsonObject()) {
            JsonObject o = e.getAsJsonObject();
            List<String> keys = new ArrayList<>(o.keySet());
            Collections.sort(keys);
            b.append('{');
            for (String k : keys) {
                b.append(new com.inductiveautomation.ignition.common.gson.JsonPrimitive(k)).append(':');
                canonical(o.get(k), b);
                b.append(',');
            }
            b.append('}');
        } else if (e.isJsonArray()) {
            JsonArray a = e.getAsJsonArray();
            b.append('[');
            for (JsonElement item : a) {
                canonical(item, b);
                b.append(',');
            }
            b.append(']');
        } else {
            b.append(e.toString());
        }
    }
}
