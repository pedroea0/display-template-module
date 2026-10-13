package com.example.simpletagdisplay.gateway.security;

import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

import com.example.simpletagdisplay.gateway.perspective.PerspectiveInternals;
import com.google.common.collect.ImmutableSet;
import com.inductiveautomation.ignition.common.auth.security.level.SecurityLevelConfig;
import com.inductiveautomation.ignition.common.auth.web.WebAuthUser;
import com.inductiveautomation.ignition.common.tags.model.SecurityContext;
import com.inductiveautomation.perspective.gateway.api.Session;
import com.inductiveautomation.perspective.gateway.api.SessionScope;
import com.inductiveautomation.perspective.gateway.api.WebAuthStatus;

/**
 * Immutable snapshot of the Perspective session's user, rebuilt on every {@code WebAuthStatusChangeEvent}.
 *
 * <ul>
 *   <li>{@link #securityContext()} is exactly what Perspective's own tag bindings use
 *       ({@code SecurityContext.fromSecurityLevels(webAuthStatus.getSecurityLevels())}), so tag Read/Write
 *       Permissions apply to every read, subscription and write the module makes for this user. The module never
 *       uses the empty (anonymous) or the system security context for user work.</li>
 *   <li>{@link #roles()} and {@link #levelPaths()} feed {@link AccessRule} and {@link FloorPolicy}; both are
 *       compared exactly (case-sensitive).</li>
 *   <li>{@link #designerWritable()} is the Designer's communication mode (Read/Write) — always true in a
 *       Client session.</li>
 *   <li>{@link #generation()} increments on every auth change seen by the owning delegate: an async operation
 *       compares it before and after its hop to detect "the user changed meanwhile" ({@code AUTH_CHANGED}).</li>
 *   <li>{@link #userSource()} is the identity provider the session logged in with ({@code session.props.auth.idp};
 *       {@code WebAuthStatus.getIdp()}), null when Perspective reports none (Designer, anonymous). Two users of the
 *       same name from different identity providers are different people: annotation ownership compares the source
 *       and the name.</li>
 * </ul>
 */
public final class UserContext {

    /** Name the audit system uses for anonymous sessions. */
    public static final String ANONYMOUS = "Unauthenticated";

    private final boolean authenticated;
    private final String userName;
    private final List<String> roles;
    private final Set<String> levelPaths;
    private final SecurityContext securityContext;
    private final SessionScope scope;
    private final long generation;
    private final String remoteHost;
    private final boolean designerWritable;
    private final String userSource;

    private UserContext(boolean authenticated, String userName, List<String> roles, Set<String> levelPaths,
                        SecurityContext securityContext, SessionScope scope, long generation, String remoteHost,
                        boolean designerWritable, String userSource) {
        this.authenticated = authenticated;
        this.userName = userName;
        this.roles = roles;
        this.levelPaths = levelPaths;
        this.securityContext = securityContext;
        this.scope = scope;
        this.generation = generation;
        this.remoteHost = remoteHost;
        this.designerWritable = designerWritable;
        this.userSource = userSource == null || userSource.isEmpty() ? null : userSource;
    }

    /**
     * Reads the session's current {@link WebAuthStatus}. Call on the session queue (or at least after the session
     * started; the status object itself is immutable).
     *
     * @param generation increments on every auth change seen by the owning delegate
     */
    public static UserContext of(Session session, long generation) {
        WebAuthStatus status = session.getWebAuthStatus();
        boolean authenticated = status != null && status.isAuthenticated();
        String name = ANONYMOUS;
        List<String> roles = List.of();
        if (status != null && status.getUser().isPresent()) {
            WebAuthUser u = status.getUser().get();
            if (u.getUserName() != null && !u.getUserName().isEmpty()) {
                name = u.getUserName();
            }
            roles = List.copyOf(u.getRoles());
        }
        ImmutableSet<SecurityLevelConfig> levels = status == null ? ImmutableSet.of() : status.getSecurityLevels();
        String idp = status == null ? null : status.getIdp().orElse(null);
        return new UserContext(authenticated, name, roles, levelPaths(levels), SecurityContext.fromSecurityLevels(levels),
            session.scope(), generation, PerspectiveInternals.remoteHost(session),
            PerspectiveInternals.designerWritable(session), idp);
    }

    /** Pure factory (unit tests, and code that has no session). The security context is empty (anonymous). */
    public static UserContext of(boolean authenticated, String userName, List<String> roles, Set<String> levelPaths,
                                 SessionScope scope, boolean designerWritable) {
        return of(authenticated, userName, null, roles, levelPaths, scope, designerWritable);
    }

    /** {@link #of(boolean, String, List, Set, SessionScope, boolean)} with a user source (identity provider). */
    public static UserContext of(boolean authenticated, String userName, String userSource, List<String> roles,
                                 Set<String> levelPaths, SessionScope scope, boolean designerWritable) {
        return new UserContext(authenticated, userName == null ? ANONYMOUS : userName, List.copyOf(roles),
            Collections.unmodifiableSet(new LinkedHashSet<>(levelPaths)), SecurityContext.fromSecurityLevels(ImmutableSet.of()),
            scope, 0, "test", designerWritable, userSource);
    }

    /**
     * {@code "/"}-joined security-level paths ({@code SecurityLevelConfig.toPaths()}) plus every prefix, so holding
     * {@code Authenticated/Roles/Operator} also satisfies {@code Authenticated/Roles} and {@code Authenticated}.
     */
    static Set<String> levelPaths(ImmutableSet<SecurityLevelConfig> levels) {
        Set<String> out = new LinkedHashSet<>();
        if (levels != null) {
            for (SecurityLevelConfig level : levels) {
                String[][] paths;
                try {
                    paths = level.toPaths();
                } catch (RuntimeException e) {
                    continue;
                }
                for (String[] path : paths) {
                    StringBuilder b = new StringBuilder();
                    for (String part : path) {
                        if (b.length() > 0) {
                            b.append('/');
                        }
                        b.append(part);
                        out.add(b.toString());
                    }
                }
            }
        }
        return Collections.unmodifiableSet(out);
    }

    public boolean authenticated() {
        return authenticated;
    }

    /** User name, or {@link #ANONYMOUS}. */
    public String userName() {
        return userName;
    }

    /** The identity provider of the login ({@code session.props.auth.idp}), or null when Perspective reports none. */
    public String userSource() {
        return userSource;
    }

    /** Role names exactly as the user source reports them (compared case-sensitively). */
    public List<String> roles() {
        return roles;
    }

    /** Security-level paths with all their prefixes ({@code "Authenticated/Roles/Operator"}, ...). */
    public Set<String> levelPaths() {
        return levelPaths;
    }

    /** Tag security context of this user (Read/Write Permissions). */
    public SecurityContext securityContext() {
        return securityContext;
    }

    public SessionScope scope() {
        return scope;
    }

    public boolean isDesigner() {
        return scope == SessionScope.Designer;
    }

    public long generation() {
        return generation;
    }

    /** Remote host of the browser / Designer (audit actor host), {@code "unknown"} when unavailable. */
    public String remoteHost() {
        return remoteHost;
    }

    /** False only in a Designer whose communication mode is not Read/Write ({@code DESIGNER_READ_ONLY}). */
    public boolean designerWritable() {
        return designerWritable;
    }
}
