package com.example.simpletagdisplay.gateway.history;

import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collection;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Consumer;
import java.util.function.Function;
import java.util.function.LongSupplier;
import java.util.function.Predicate;

import com.inductiveautomation.ignition.common.util.LoggerEx;
import com.inductiveautomation.perspective.gateway.api.SessionScope;

/**
 * History tokens: issue, validate, revoke.
 *
 * <h2>Why our own tokens</h2>
 * The history route is plain HTTP; the chart needs a credential that binds each request to one live Perspective
 * session and one chart delegate. Perspective's {@code InternalSession.createToken} is one-shot with a 30 s expiry,
 * which would cost a websocket round trip per request. These tokens are multi-use, 256-bit
 * random, short-lived, and die with their session.
 *
 * <h2>Rules</h2>
 * <ul>
 *   <li>Token = 32 {@link SecureRandom} bytes, base64url without padding (43 characters).</li>
 *   <li>TTL {@code ctg.token.ttlMs} (15 min); Designer-scope tokens {@code ctg.token.designerTtlMs} (5 min) and bound
 *       to the Designer's remote address. A Designer token is never issued without that address ({@link IssueRefused}):
 *       a Designer request carries no Perspective session cookie, so the address is its only binding, and a failed
 *       lookup must make the module stricter, not looser.</li>
 *   <li>At most {@value #PER_OWNER} tokens per issuing delegate ("owner"): issuing a new one shortens the
 *       previous one to a {@value #ROTATION_GRACE_MS} ms grace (requests in flight finish) and drops older ones.</li>
 *   <li>At most {@value #PER_SESSION} per session: over the cap, expired tokens go first, then the
 *       rotated tokens still in their grace, then the caller's own previous ones; the CURRENT token of another chart
 *       is never evicted (otherwise that chart's next request gets 401, its renewal evicts the next chart's token,
 *       and so on).
 *       When every slot holds another chart's current token, a NEW chart is refused ({@link IssueRefused#sessionFull});
 *       a chart that already holds a token can always renew. At the global cap ({@value #GLOBAL_MAX}) the globally
 *       oldest token is evicted instead of refusing, so the store stays bounded without locking out new charts.</li>
 *   <li>{@link #validate}: exists, not expired, and the session is alive ({@code LiveSessions.isAlive}).</li>
 *   <li>Revoked per token, per owner (delegate stop), per session (session end, auth change).</li>
 *   <li>Every removal — revoke, rotation drop, eviction, expiry sweep — is reported to the {@link #onRemoved}
 *       listeners after the store changed (the history route uses this to drop the rate bucket of an owner that has
 *       no token left). {@link #issue} reports after the new token is in, so a rotating owner never looks
 *       token-less.</li>
 * </ul>
 * The route evaluates read permissions with the session's <em>current</em> user, so a logout is effective even
 * before the token is rotated.
 */
public final class HistoryTokenStore {

    private static final LoggerEx LOG = LoggerEx.newBuilder().build("SimpleTagDisplay.Tokens");

    public static final int PER_OWNER = 2;
    public static final int PER_SESSION = 64;
    public static final int GLOBAL_MAX = 20_000;
    public static final long ROTATION_GRACE_MS = 30_000L;

    private static final SecureRandom RNG = new SecureRandom();

    /**
     * Pen filter attached to a token: which normalized tag keys this token may read. {@link #ALL} allows every
     * key; the chart's {@code ReadScope} implements it, and the route checks it per pen before anything else.
     */
    @FunctionalInterface
    public interface PenGate {
        PenGate ALL = key -> true;

        boolean allows(String normalizedKey);
    }

    /** Everything known about one token. Immutable except for the expiry (shortened on rotation). */
    public static final class TokenInfo {
        private final String token;
        private final UUID sessionId;
        private final String project;
        private final SessionScope scope;
        private final String ownerId;
        private final String componentPath;
        private final String userNameAtIssue;
        private final long issuedAt;
        private volatile long expiresAt;
        private final String boundRemoteAddr;
        private final PenGate penGate;
        private final boolean annotationsEnabled;

        TokenInfo(String token, UUID sessionId, String project, SessionScope scope, String ownerId, String componentPath,
                  String userNameAtIssue, long issuedAt, long expiresAt, String boundRemoteAddr, PenGate penGate,
                  boolean annotationsEnabled) {
            this.token = token;
            this.sessionId = sessionId;
            this.project = project;
            this.scope = scope;
            this.ownerId = ownerId;
            this.componentPath = componentPath;
            this.userNameAtIssue = userNameAtIssue;
            this.issuedAt = issuedAt;
            this.expiresAt = expiresAt;
            this.boundRemoteAddr = boundRemoteAddr;
            this.penGate = penGate;
            this.annotationsEnabled = annotationsEnabled;
        }

        public String token() {
            return token;
        }

        public UUID sessionId() {
            return sessionId;
        }

        public String project() {
            return project;
        }

        public SessionScope scope() {
            return scope;
        }

        /** Id of the issuing delegate instance. */
        public String ownerId() {
            return ownerId;
        }

        public String componentPath() {
            return componentPath;
        }

        public String userNameAtIssue() {
            return userNameAtIssue;
        }

        public long issuedAt() {
            return issuedAt;
        }

        public long expiresAt() {
            return expiresAt;
        }

        /** Designer tokens: remote address the token is bound to (null = not bound). */
        public String boundRemoteAddr() {
            return boundRemoteAddr;
        }

        public PenGate penGate() {
            return penGate;
        }

        /** Trusted {@code annotations.enabled} at issue time. */
        public boolean annotationsEnabled() {
            return annotationsEnabled;
        }
    }

    /** Parameters of {@link #issue}. */
    public static final class IssueRequest {
        final UUID sessionId;
        final String project;
        final SessionScope scope;
        final String ownerId;
        final String componentPath;
        final String userName;
        final String remoteAddr;
        final PenGate penGate;
        final boolean annotationsEnabled;

        public IssueRequest(UUID sessionId, String project, SessionScope scope, String ownerId, String componentPath,
                            String userName, String remoteAddr, PenGate penGate, boolean annotationsEnabled) {
            this.sessionId = sessionId;
            this.project = project;
            this.scope = scope;
            this.ownerId = ownerId;
            this.componentPath = componentPath;
            this.userName = userName;
            this.remoteAddr = remoteAddr;
            this.penGate = penGate == null ? PenGate.ALL : penGate;
            this.annotationsEnabled = annotationsEnabled;
        }
    }

    /** Outcome of {@link #validate}. */
    public enum Status { OK, INVALID, EXPIRED }

    /** {@link #validate} result. */
    public static final class Validation {
        private final Status status;
        private final TokenInfo info;

        Validation(Status status, TokenInfo info) {
            this.status = status;
            this.info = info;
        }

        public Status status() {
            return status;
        }

        public Optional<TokenInfo> info() {
            return Optional.ofNullable(info);
        }
    }

    private final LongSupplier clock;
    private final LongSupplier ttlMs;
    private final LongSupplier designerTtlMs;
    private final Predicate<UUID> sessionAlive;
    private final ConcurrentHashMap<String, TokenInfo> tokens = new ConcurrentHashMap<>();
    private final Object issueLock = new Object();
    private final List<Consumer<Collection<TokenInfo>>> removalListeners = new CopyOnWriteArrayList<>();

    /**
     * @param ttlMs         live {@code ctg.token.ttlMs}
     * @param designerTtlMs live {@code ctg.token.designerTtlMs}
     * @param sessionAlive  {@code LiveSessions::isAlive}
     */
    public HistoryTokenStore(LongSupplier clockMs, LongSupplier ttlMs, LongSupplier designerTtlMs, Predicate<UUID> sessionAlive) {
        this.clock = clockMs;
        this.ttlMs = ttlMs;
        this.designerTtlMs = designerTtlMs;
        this.sessionAlive = sessionAlive;
    }

    /**
     * {@link #issue} refused: a Designer-scope token without a known remote address ({@code SESSION_MISMATCH}), or
     * ({@link #sessionFull}) a new chart in a session whose {@value #PER_SESSION} slots all hold other charts' current
     * tokens. Nothing is issued or rotated.
     */
    public static final class IssueRefused extends RuntimeException {
        private static final long serialVersionUID = 1L;
        private final boolean sessionFull;

        IssueRefused(String message) {
            this(message, false);
        }

        IssueRefused(String message, boolean sessionFull) {
            super(message, null, false, false);
            this.sessionFull = sessionFull;
        }

        /** True: the per-session cap, not the Designer address. */
        public boolean sessionFull() {
            return sessionFull;
        }
    }

    /**
     * Issues a new token for one chart delegate (rotating its previous one).
     *
     * @throws IssueRefused for a Designer-scope request without a remote address (nothing is issued or rotated)
     */
    public TokenInfo issue(IssueRequest r) {
        long now = clock.getAsLong();
        boolean designer = r.scope == SessionScope.Designer;
        if (designer && (r.remoteAddr == null || r.remoteAddr.isBlank())) {
            throw new IssueRefused("Designer remote address unknown");
        }
        long ttl = designer ? designerTtlMs.getAsLong() : ttlMs.getAsLong();
        TokenInfo info = new TokenInfo(newToken(), r.sessionId, r.project, r.scope, r.ownerId, r.componentPath, r.userName,
            now, now + ttl, designer ? r.remoteAddr : null, r.penGate, r.annotationsEnabled);
        List<TokenInfo> removed = new ArrayList<>();
        synchronized (issueLock) {
            // Per session first, decided before anything changes: what may go to make room.
            List<TokenInfo> evict = sessionEvictions(r, now);
            // Per owner: keep the newest previous token for a short grace, drop anything older.
            List<TokenInfo> owned = byNewest(t -> t.ownerId.equals(r.ownerId));
            for (int i = 0; i < owned.size(); i++) {
                TokenInfo t = owned.get(i);
                if (i < PER_OWNER - 1) {
                    t.expiresAt = Math.min(t.expiresAt, now + ROTATION_GRACE_MS);
                } else if (tokens.remove(t.token, t)) {
                    removed.add(t);
                }
            }
            for (TokenInfo t : evict) {
                if (tokens.remove(t.token, t)) {
                    removed.add(t);
                }
            }
            // Global: evict the oldest instead of refusing.
            if (tokens.size() >= GLOBAL_MAX) {
                long cut = clock.getAsLong();
                removed.addAll(removeAll(t -> cut >= t.expiresAt || !sessionAlive.test(t.sessionId)));
                while (tokens.size() >= GLOBAL_MAX) {
                    tokens.values().stream().min(Comparator.comparingLong(TokenInfo::issuedAt))
                        .filter(t -> tokens.remove(t.token, t)).ifPresent(removed::add);
                }
            }
            tokens.put(info.token, info);
        }
        notifyRemoved(removed);
        return info;
    }

    /**
     * The tokens of {@code r}'s session to remove so the new one fits under {@link #PER_SESSION}: expired ones first,
     * then other charts' rotated tokens in their grace, then the caller's own; oldest first within each. Another
     * chart's current (newest, unexpired) token is never chosen.
     *
     * @throws IssueRefused (sessionFull) when that is not enough room: only for a chart without a token of its own
     */
    private List<TokenInfo> sessionEvictions(IssueRequest r, long now) {
        List<TokenInfo> session = byNewest(t -> t.sessionId.equals(r.sessionId));
        int over = session.size() - (PER_SESSION - 1);
        if (over <= 0) {
            return List.of();
        }
        java.util.Set<String> currentOwners = new java.util.HashSet<>();
        List<TokenInfo> candidates = new ArrayList<>();
        java.util.Map<TokenInfo, Integer> rank = new java.util.IdentityHashMap<>();
        for (TokenInfo t : session) {                               // newest first
            boolean expired = now >= t.expiresAt;
            boolean own = t.ownerId.equals(r.ownerId);
            if (!own && !expired && currentOwners.add(t.ownerId)) {
                continue;                                           // another chart's current token: kept
            }
            rank.put(t, expired ? 0 : own ? 2 : 1);
            candidates.add(t);
        }
        candidates.sort(Comparator.<TokenInfo>comparingInt(rank::get).thenComparingLong(TokenInfo::issuedAt));
        boolean hasOwn = session.stream().anyMatch(t -> t.ownerId.equals(r.ownerId));
        if (candidates.size() < over && !hasOwn) {
            throw new IssueRefused("session token limit (" + PER_SESSION + " charts)", true);
        }
        return candidates.subList(0, Math.min(over, candidates.size()));
    }

    /** Validates a token from a request header. */
    public Validation validate(String token) {
        if (token == null || token.length() != 43) {
            return new Validation(Status.INVALID, null);
        }
        TokenInfo t = tokens.get(token);
        if (t == null) {
            return new Validation(Status.INVALID, null);
        }
        if (clock.getAsLong() >= t.expiresAt) {
            return new Validation(Status.EXPIRED, null);
        }
        if (!sessionAlive.test(t.sessionId)) {
            return new Validation(Status.INVALID, null);
        }
        return new Validation(Status.OK, t);
    }

    public void revoke(String token) {
        if (token != null) {
            TokenInfo t = tokens.remove(token);
            if (t != null) {
                notifyRemoved(List.of(t));
            }
        }
    }

    /** Every token of one delegate (delegate stop, auth change). */
    public int revokeOwner(String ownerId) {
        return removeIf(t -> t.ownerId.equals(ownerId));
    }

    /** Every token of one session (session end, auth change). */
    public int revokeSession(UUID sessionId) {
        return removeIf(t -> t.sessionId.equals(sessionId));
    }

    /** Removes expired tokens and tokens of dead sessions; returns how many. */
    public int sweep() {
        long now = clock.getAsLong();
        return removeIf(t -> now >= t.expiresAt || !sessionAlive.test(t.sessionId));
    }

    /** Removes every token (module shutdown). Not reported: the listeners' state is cleared with the module. */
    public void clear() {
        tokens.clear();
    }

    public int size() {
        return tokens.size();
    }

    /**
     * Registers a listener for removed tokens. It runs on the removing thread after the store changed, never
     * under the store's issue lock, and must be cheap; an exception is logged and does not stop the other listeners.
     */
    public void onRemoved(Consumer<Collection<TokenInfo>> listener) {
        removalListeners.add(listener);
    }

    /** {@code key(token)} of every token in the store right now (one scan; the history route's owner keys). */
    public Set<String> ownerKeys(Function<TokenInfo, String> key) {
        Set<String> out = new HashSet<>();
        for (TokenInfo t : tokens.values()) {
            out.add(key.apply(t));
        }
        return out;
    }

    private int removeIf(Predicate<TokenInfo> p) {
        List<TokenInfo> removed = removeAll(p);
        notifyRemoved(removed);
        return removed.size();
    }

    /** Removes the matching tokens without notifying (the caller notifies). */
    private List<TokenInfo> removeAll(Predicate<TokenInfo> p) {
        List<TokenInfo> removed = new ArrayList<>();
        for (Map.Entry<String, TokenInfo> e : tokens.entrySet()) {
            if (p.test(e.getValue()) && tokens.remove(e.getKey(), e.getValue())) {
                removed.add(e.getValue());
            }
        }
        return removed;
    }

    private void notifyRemoved(List<TokenInfo> removed) {
        if (removed.isEmpty()) {
            return;
        }
        Collection<TokenInfo> view = Collections.unmodifiableList(removed);
        for (Consumer<Collection<TokenInfo>> l : removalListeners) {
            try {
                l.accept(view);
            } catch (RuntimeException e) {
                LOG.warn("token removal listener failed", e);
            }
        }
    }

    private List<TokenInfo> byNewest(Predicate<TokenInfo> p) {
        List<TokenInfo> out = new ArrayList<>();
        for (TokenInfo t : tokens.values()) {
            if (p.test(t)) {
                out.add(t);
            }
        }
        out.sort(Comparator.comparingLong(TokenInfo::issuedAt).reversed());
        return out;
    }

    private static String newToken() {
        byte[] b = new byte[32];
        RNG.nextBytes(b);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(b);
    }
}
