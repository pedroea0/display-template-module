package com.example.simpletagdisplay.gateway.security;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.Set;
import java.util.function.Consumer;

import com.example.simpletagdisplay.common.protocol.ErrorCode;
import com.example.simpletagdisplay.gateway.ModuleSettings;
import com.example.simpletagdisplay.gateway.tags.TagPaths;
import com.inductiveautomation.ignition.common.tags.model.TagPath;

/**
 * Gateway-wide floor policy for writes and config edits.
 *
 * Component props say who may write ({@code setpoint.access}); this policy is evaluated <b>in addition</b> and
 * can only make a gate stricter. It comes from module settings, which a client cannot touch, so a page whose
 * gate props were tampered with or laundered through a binding still cannot go below the floor:
 * <pre>
 *   checkWrite(user, path)
 *     ctg.write.requireAuthenticated (default false) and anonymous     → AUTH_REQUIRED
 *     ctg.write.requiredRoles set: anonymous → AUTH_REQUIRED, holds none → FORBIDDEN_ROLE   (exact names)
 *     provider in ctg.write.deniedProviders (default "System")         → INVALID_PATH     (case-insensitive)
 *     ctg.write.allowedRoots set and the path is under none of them    → OUT_OF_SCOPE
 *   checkConfigEdit(user, path) = checkWrite(...) and then ctg.configEdit.requiredRoles like the write roles
 * </pre>
 * {@link #readProviderDenied(String)} applies {@code ctg.read.deniedProviders} to chart runtime pens, chart trend
 * adds and tag browsing, and to the history route for every pen, Designer pens included (history of a denied
 * provider is never served).
 *
 * <h2>allowedRoots</h2>
 * Entries ({@code [provider]Folder}) are normalised with {@link TagPaths#parse(String, String)} and compared on
 * normalized keys. Invalid entries are dropped with a WARN. If the setting is non-empty but <em>no</em> entry is
 * valid, the policy fails closed: every write is {@code OUT_OF_SCOPE} until the setting is fixed (a typo must not
 * silently remove the restriction).
 *
 * <h2>Default</h2>
 * {@code ctg.write.requireAuthenticated} defaults to {@code false}: native Perspective lets an anonymous session write
 * unless tag write permissions or project security forbid it, and the module does the same. The setting is an
 * opt-in floor. Tag write permissions always apply (writes run with the session user's security context).
 *
 * <h2>Which setting refused</h2>
 * {@link #writeBlock} / {@link #configEditBlock} return the refusal together with the gateway setting that produced it
 * ({@link Block#setting()}), so the UI can say "Writes need a login on this gateway (gateway setting
 * ctg.write.requireAuthenticated)" rather than a bare "Log in" when the component itself allows the action.
 * {@link #overrides} lists the settings that make a component's own access rule stricter for a tag, whoever the user
 * is (the Designer hint).
 *
 * Immutable; rebuilt from the settings on every reload ({@code GatewayServices}).
 */
public final class FloorPolicy {

    private final boolean requireAuthenticated;
    private final List<String> writeRoles;
    private final List<String> configEditRoles;
    private final Set<String> writeDeniedProviders;
    private final Set<String> readDeniedProviders;
    private final List<String> allowedRoots;
    private final boolean allowedRootsConfigured;

    private FloorPolicy(boolean requireAuthenticated, List<String> writeRoles, List<String> configEditRoles,
                        Set<String> writeDeniedProviders, Set<String> readDeniedProviders, List<String> allowedRoots,
                        boolean allowedRootsConfigured) {
        this.requireAuthenticated = requireAuthenticated;
        this.writeRoles = writeRoles;
        this.configEditRoles = configEditRoles;
        this.writeDeniedProviders = writeDeniedProviders;
        this.readDeniedProviders = readDeniedProviders;
        this.allowedRoots = allowedRoots;
        this.allowedRootsConfigured = allowedRootsConfigured;
    }

    /** Builds the policy from a settings snapshot; invalid {@code allowedRoots} entries are reported via {@code warn}. */
    public static FloorPolicy from(ModuleSettings.Settings s, Consumer<String> warn) {
        List<String> roots = new ArrayList<>();
        for (String raw : s.writeAllowedRoots()) {
            TagPaths.Parsed p = TagPaths.parse(raw, null);
            if (p.ok() && p.path().getSource() != null && !p.path().getSource().isEmpty()) {
                roots.add(TagPaths.normalizedKey(p.path()));
            } else {
                warn.accept("ctg.write.allowedRoots entry '" + clip(raw) + "' is not a [provider]Folder path; ignored");
            }
        }
        boolean configured = !s.writeAllowedRoots().isEmpty();
        if (configured && roots.isEmpty()) {
            warn.accept("ctg.write.allowedRoots has no valid entry: every write and config edit is refused (OUT_OF_SCOPE)"
                + " until it is fixed");
        }
        return new FloorPolicy(s.writeRequireAuthenticated(), List.copyOf(s.writeRequiredRoles()),
            List.copyOf(s.configEditRequiredRoles()), lower(s.writeDeniedProviders()), lower(s.readDeniedProviders()),
            Collections.unmodifiableList(roots), configured);
    }

    /** Gateway setting names, as shown to users and integrators. */
    public static final String SETTING_REQUIRE_AUTHENTICATED = "ctg.write.requireAuthenticated";
    public static final String SETTING_WRITE_ROLES = "ctg.write.requiredRoles";
    public static final String SETTING_CONFIG_EDIT_ROLES = "ctg.configEdit.requiredRoles";
    public static final String SETTING_DENIED_PROVIDERS = "ctg.write.deniedProviders";
    public static final String SETTING_ALLOWED_ROOTS = "ctg.write.allowedRoots";

    /** A floor refusal: the error code and the gateway setting that produced it. Immutable. */
    public static final class Block {
        private final ErrorCode code;
        private final String setting;

        Block(ErrorCode code, String setting) {
            this.code = code;
            this.setting = setting;
        }

        public ErrorCode code() {
            return code;
        }

        /** The gateway setting that refused ({@code ctg.write.requireAuthenticated}, ...). Never null. */
        public String setting() {
            return setting;
        }

        @Override
        public String toString() {
            return code + "(" + setting + ")";
        }
    }

    /** Floor for {@code dt.write}. Empty = allowed by the floor (the component rule and tag permissions still apply). */
    public Optional<ErrorCode> checkWrite(UserContext user, TagPath path) {
        return writeBlock(user, path).map(Block::code);
    }

    /** Floor for {@code dt.configEdit}: the write floor plus {@code ctg.configEdit.requiredRoles}. */
    public Optional<ErrorCode> checkConfigEdit(UserContext user, TagPath path) {
        return configEditBlock(user, path).map(Block::code);
    }

    /** {@link #checkWrite} together with the setting that refused. */
    public Optional<Block> writeBlock(UserContext user, TagPath path) {
        if (requireAuthenticated && !user.authenticated()) {
            return block(ErrorCode.AUTH_REQUIRED, SETTING_REQUIRE_AUTHENTICATED);
        }
        Optional<Block> roles = roleBlock(writeRoles, user, SETTING_WRITE_ROLES);
        if (roles.isPresent()) {
            return roles;
        }
        if (writeDeniedProviders.contains(TagPaths.providerKey(path))) {
            return block(ErrorCode.INVALID_PATH, SETTING_DENIED_PROVIDERS);
        }
        if (outsideAllowedRoots(path)) {
            return block(ErrorCode.OUT_OF_SCOPE, SETTING_ALLOWED_ROOTS);
        }
        return Optional.empty();
    }

    /** {@link #checkConfigEdit} together with the setting that refused. */
    public Optional<Block> configEditBlock(UserContext user, TagPath path) {
        Optional<Block> w = writeBlock(user, path);
        if (w.isPresent()) {
            return w;
        }
        return roleBlock(configEditRoles, user, SETTING_CONFIG_EDIT_ROLES);
    }

    /**
     * The gateway settings that make {@code component} (the component's own access rule for the action) stricter for
     * {@code path}, whoever the user is. The Designer shows them as a hint, so a conflict is visible while the view is
     * built. A role floor counts unless every role the component accepts is also a floor role (the floor then
     * adds nothing). Order = evaluation order. {@code path} may be null (no valid tag path: the path rules are skipped).
     */
    public List<String> overrides(AccessRule component, TagPath path, boolean configEdit) {
        List<String> out = new ArrayList<>();
        boolean componentNeedsLogin = component.requireLogin() || !component.roles().isEmpty()
            || !component.securityLevels().isEmpty();
        if (requireAuthenticated && !componentNeedsLogin) {
            out.add(SETTING_REQUIRE_AUTHENTICATED);
        }
        if (rolesNarrow(writeRoles, component)) {
            out.add(SETTING_WRITE_ROLES);
        }
        if (configEdit && rolesNarrow(configEditRoles, component)) {
            out.add(SETTING_CONFIG_EDIT_ROLES);
        }
        if (path != null && writeDeniedProviders.contains(TagPaths.providerKey(path))) {
            out.add(SETTING_DENIED_PROVIDERS);
        }
        if (path != null && outsideAllowedRoots(path)) {
            out.add(SETTING_ALLOWED_ROOTS);
        }
        return out;
    }

    private static boolean rolesNarrow(List<String> floorRoles, AccessRule component) {
        return !floorRoles.isEmpty() && (component.roles().isEmpty() || !floorRoles.containsAll(component.roles()));
    }

    /** A role floor: anonymous → AUTH_REQUIRED (log in first), logged in without a listed role → FORBIDDEN_ROLE. */
    private static Optional<Block> roleBlock(List<String> roles, UserContext user, String setting) {
        if (roles.isEmpty() || roles.stream().anyMatch(user.roles()::contains)) {
            return Optional.empty();
        }
        return block(user.authenticated() ? ErrorCode.FORBIDDEN_ROLE : ErrorCode.AUTH_REQUIRED, setting);
    }

    private boolean outsideAllowedRoots(TagPath path) {
        if (!allowedRootsConfigured) {
            return false;
        }
        String key = TagPaths.normalizedKey(path);
        return allowedRoots.stream().noneMatch(root -> TagPaths.isUnder(key, root));
    }

    private static Optional<Block> block(ErrorCode code, String setting) {
        return Optional.of(new Block(code, setting));
    }

    /** {@code ctg.read.deniedProviders}: chart runtime pens, chart trend adds and browsing (case-insensitive). */
    public boolean readProviderDenied(String provider) {
        return provider != null && readDeniedProviders.contains(provider.toLowerCase(Locale.ROOT));
    }

    public boolean requireAuthenticated() {
        return requireAuthenticated;
    }

    private static Set<String> lower(List<String> names) {
        Set<String> out = new LinkedHashSet<>();
        for (String n : names) {
            out.add(n.toLowerCase(Locale.ROOT));
        }
        return Collections.unmodifiableSet(out);
    }

    private static String clip(String s) {
        String c = s.replaceAll("[\\p{Cntrl}]", "?");
        return c.length() > 64 ? c.substring(0, 64) + "..." : c;
    }
}
