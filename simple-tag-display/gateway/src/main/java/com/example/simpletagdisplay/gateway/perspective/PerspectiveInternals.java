package com.example.simpletagdisplay.gateway.perspective;

import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

import com.inductiveautomation.ignition.common.util.LoggerEx;
import com.inductiveautomation.ignition.gateway.clientcomm.ClientReqSession;
import com.inductiveautomation.ignition.gateway.clientcomm.MutabilityMode;
import com.inductiveautomation.ignition.gateway.model.GatewayContext;
import com.inductiveautomation.perspective.gateway.api.PerspectiveContext;
import com.inductiveautomation.perspective.gateway.api.Session;
import com.inductiveautomation.perspective.gateway.api.SessionScope;
import com.inductiveautomation.perspective.gateway.session.InternalSession;
import com.inductiveautomation.perspective.gateway.session.PerspectiveSessionCollection;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpSession;

/**
 * The ONLY class that touches non-{@code api} Perspective / gateway internals.
 *
 * {@code InternalSession}, {@code PerspectiveSessionCollection} and {@code ClientReqSession} are public classes
 * but not part of the documented SDK surface; a future Perspective version may move or change them. Keeping every
 * use here means one file to fix, and every method is total: it never throws, it returns a fail-safe default
 * and logs ONE warning per method the first time a lookup breaks ({@link ClassCastException},
 * {@link NoSuchMethodError}, ...).
 *
 * Fail-safe defaults are chosen so a broken lookup can only make the module stricter: unknown Designer
 * mutability is read-only, an unresolvable request session matches no token.
 */
public final class PerspectiveInternals {

    private static final LoggerEx LOG = LoggerEx.newBuilder().build("SimpleTagDisplay.Gateway");
    private static final Set<String> WARNED = ConcurrentHashMap.newKeySet();

    private PerspectiveInternals() {
    }

    /** The session as {@link InternalSession}, when it is one (it is for every Client and Designer session today). */
    public static Optional<InternalSession> internal(Session s) {
        try {
            return s instanceof InternalSession ? Optional.of((InternalSession) s) : Optional.empty();
        } catch (Throwable t) {
            warnOnce("internal", t);
            return Optional.empty();
        }
    }

    /** Remote host name of the browser (or Designer) behind the session, {@code "unknown"} when unavailable. */
    public static String remoteHost(Session s) {
        try {
            return internal(s).map(i -> i.getSessionCollection().getRemoteHost()).filter(h -> !h.isEmpty()).orElse("unknown");
        } catch (Throwable t) {
            warnOnce("remoteHost", t);
            return "unknown";
        }
    }

    /** Remote IP address behind the session, or null when unavailable. Used to bind Designer history tokens. */
    public static String remoteAddr(Session s) {
        try {
            return internal(s).map(i -> i.getSessionCollection().getRemoteAddr()).filter(h -> !h.isEmpty()).orElse(null);
        } catch (Throwable t) {
            warnOnce("remoteAddr", t);
            return null;
        }
    }

    /**
     * Communication mode of the Designer behind a Designer-scope session ({@code OFF / READ_ONLY / READ_WRITE}).
     * Client sessions are always {@code READ_WRITE}. Mirrors Perspective's own {@code BindingContext}: the Designer's
     * HTTP session is a {@link ClientReqSession} that carries the mode. Unknown → {@code READ_ONLY} (fail safe).
     */
    public static MutabilityMode designerMutability(Session s) {
        try {
            if (s.scope() != SessionScope.Designer) {
                return MutabilityMode.READ_WRITE;
            }
            Optional<HttpSession> hs = internal(s).flatMap(i -> i.getSessionCollection().getHttpSession());
            if (hs.isPresent() && hs.get() instanceof ClientReqSession) {
                MutabilityMode m = ((ClientReqSession) hs.get()).getMutabilityMode();
                return m == null ? MutabilityMode.READ_ONLY : m;
            }
            return MutabilityMode.READ_ONLY;
        } catch (Throwable t) {
            warnOnce("designerMutability", t);
            return MutabilityMode.READ_ONLY;
        }
    }

    /** True when writes are allowed by the session's comm mode (always for Client sessions). */
    public static boolean designerWritable(Session s) {
        return designerMutability(s).canWrite();
    }

    /** Live session by id from Perspective's session monitor (Client sessions; Designer coverage not verified). */
    public static Optional<InternalSession> findSession(PerspectiveContext p, UUID id) {
        try {
            return p.getSessionMonitor().findSession(id);
        } catch (Throwable t) {
            warnOnce("findSession", t);
            return Optional.empty();
        }
    }

    /**
     * Whether Perspective's session monitor still has session {@code id} (used by the session sweep): {@code
     * Optional.of(true/false)}, or empty when the lookup itself failed (no context, internal API changed) — the
     * caller then falls back to its own liveness rule.
     */
    public static Optional<Boolean> sessionOpen(PerspectiveContext p, UUID id) {
        if (p == null || id == null) {
            return Optional.empty();
        }
        try {
            return Optional.of(p.getSessionMonitor().findSession(id).isPresent());
        } catch (Throwable t) {
            warnOnce("sessionOpen", t);
            return Optional.empty();
        }
    }

    /**
     * The Perspective session id of {@code project} bound to the request's HTTP session (cookie), the same lookup
     * Perspective's own routes use ({@code HttpSession} attribute {@code "perspective-session"} →
     * {@link PerspectiveSessionCollection#findProjectSession}). Empty when the request has no HTTP session or no
     * Perspective session for that project. Designer requests identify themselves with a header we do not resolve;
     * they come back empty here.
     */
    public static Optional<UUID> sessionIdFromRequest(HttpServletRequest r, String project) {
        try {
            HttpSession hs = r.getSession(false);
            if (hs == null) {
                return Optional.empty();
            }
            Object attr = hs.getAttribute(PerspectiveSessionCollection.SESSION_KEY);
            if (!(attr instanceof PerspectiveSessionCollection)) {
                return Optional.empty();
            }
            return ((PerspectiveSessionCollection) attr).findProjectSession(project).map(Session::getSessionId);
        } catch (IllegalStateException e) {
            return Optional.empty();   // invalidated HTTP session
        } catch (Throwable t) {
            warnOnce("sessionIdFromRequest", t);
            return Optional.empty();
        }
    }

    /** The project's default tag provider name (Project Properties), {@code "default"} when it cannot be read. */
    public static String projectDefaultTagProvider(GatewayContext g, String project) {
        try {
            String name = g.getProjectManager().getProjectProps(project).getDefaultSQLTagsProviderName();
            return name == null || name.isEmpty() ? "default" : name;
        } catch (Throwable t) {
            warnOnce("projectDefaultTagProvider", t);
            return "default";
        }
    }

    private static void warnOnce(String method, Throwable t) {
        if (WARNED.add(method)) {
            LOG.warn("PerspectiveInternals." + method + " failed (Perspective internals changed?); using a fail-safe default", t);
        }
    }
}
