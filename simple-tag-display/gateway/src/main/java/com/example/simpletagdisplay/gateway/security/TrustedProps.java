package com.example.simpletagdisplay.gateway.security;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Consumer;
import java.util.function.Function;
import java.util.function.IntSupplier;
import java.util.function.LongSupplier;

import com.inductiveautomation.ignition.common.gson.JsonElement;
import com.inductiveautomation.ignition.common.gson.JsonNull;
import com.inductiveautomation.ignition.common.gson.JsonObject;
import com.inductiveautomation.ignition.common.util.LoggerEx;
import com.inductiveautomation.perspective.common.property.Origin;

/**
 * Trusted values of a component's security keys.
 *
 * <h2>The problem</h2>
 * A Perspective client can write any PUBLIC component prop, and the write reaches the gateway's property tree
 * (observed: {@code setpoint.enabled}, {@code setpoint.access.roles}, {@code enabled}, {@code tagPath} all
 * arrive with {@code Origin.Browser}, also when replayed after a reconnect). If a gate read the tree, a
 * user could switch on writing for himself from the browser console.
 *
 * <h2>The rule</h2>
 * <ul>
 *   <li>At start the current value of every security leaf is the trusted value (view-start values, including
 *       popup/page params, are covered by the floor policy and the binding lint, not by this class).</li>
 *   <li><b>Client scope:</b> a change whose origin is {@link Origin#Browser} and which leaves a security leaf
 *       different from its trusted value is <em>not adopted</em>: the trusted value is written back with
 *       {@code Origin.Delegate} (scheduled on the session queue by the caller), a rate-limited WARN
 *       {@code action=prop-tamper} goes to {@code SimpleTagDisplay.Audit}, and gates keep using the trusted
 *       value. The same holds for {@link Origin#BindingWriteback} (see {@link #clientControlled}):
 *       a bidirectional binding on another prop that targets a security key relays a client value. Changes
 *       with any other origin (Binding, Script, Session, Project) are adopted — a script that copies client
 *       input into a security key is the integrator's decision and is trusted.</li>
 *   <li><b>Designer scope:</b> every origin is adopted — no revert, no WARN (a Designer user edits
 *       and saves the view anyway).</li>
 * </ul>
 * Gates read only {@link #values()}; nothing reads security keys from the live tree.
 *
 * <h2>Threading</h2>
 * {@link #initialize} and {@link #onChange} run on the session queue only (property-tree callbacks run there).
 * The trusted values are copy-on-write: every change publishes a new immutable map through a volatile field, so
 * {@link #values()} and {@link #current()} are safe from any thread (a handler completing on another thread sees
 * either the old or the new map, never a half-updated one). The decision logic is a pure static function
 * ({@link #decide}).
 */
public final class TrustedProps {

    /** Access to the component's property tree (props). Session queue only. */
    public interface Tree {
        /** Current value of a leaf path, empty when the key is absent. */
        Optional<JsonElement> read(String path);
    }

    private final List<String> paths;
    private final boolean designerScope;
    private final Tree tree;
    /**
     * Trusted values; a path missing from the map = the key was absent (gates use the schema default). Immutable
     * and never mutated after publication (values are private deep copies); replaced as a whole on every change.
     */
    private volatile Map<String, JsonElement> trusted = Map.of();

    public TrustedProps(List<String> paths, boolean designerScope, Tree tree) {
        this.paths = List.copyOf(paths);
        this.designerScope = designerScope;
        this.tree = tree;
    }

    /** Reads the start values (session queue). */
    public void initialize() {
        trusted = freeze(read(paths));
    }

    /** Immutable map of private deep copies, in insertion order. */
    private static Map<String, JsonElement> freeze(Map<String, JsonElement> m) {
        Map<String, JsonElement> copy = new LinkedHashMap<>();
        for (Map.Entry<String, JsonElement> e : m.entrySet()) {
            copy.put(e.getKey(), e.getValue() == null ? null : e.getValue().deepCopy());
        }
        return Collections.unmodifiableMap(copy);
    }

    /**
     * A watched root key changed. Only the security leaves affected by {@code changedPath} (the leaf itself, its
     * descendants, or an ancestor container that was replaced) are re-read and decided; a {@code null} path means
     * "anything under {@code rootKey}". Returns the leaves whose value must be restored (Browser-origin tampering in
     * a Client session); every other difference has been adopted.
     *
     * @param changedPath dotted path of the change as Perspective reports it ({@code setpoint.access.roles},
     *                    {@code setpoint}, {@code setpoint.access.roles[0]} ...), or null
     */
    public List<Revert> onChange(String rootKey, Origin origin, String changedPath) {
        List<String> affected = new ArrayList<>();
        for (String p : subPaths(rootKey)) {
            if (affects(changedPath, p)) {
                affected.add(p);
            }
        }
        Map<String, JsonElement> fresh = read(affected);
        Map<String, JsonElement> before = trusted;
        Map<String, JsonElement> current = new LinkedHashMap<>();
        for (String p : affected) {
            JsonElement t = before.get(p);
            if (t != null) {
                current.put(p, t);
            }
        }
        Outcome o = decide(affected, current, fresh, origin, designerScope);
        if (!o.adopted.isEmpty()) {
            Map<String, JsonElement> next = new LinkedHashMap<>(before);
            for (String adopted : o.adopted) {
                JsonElement v = fresh.get(adopted);
                if (v == null) {
                    next.remove(adopted);
                } else {
                    next.put(adopted, v.deepCopy());
                }
            }
            trusted = Collections.unmodifiableMap(next);
        }
        Map<String, JsonElement> after = trusted;
        List<Revert> reverts = new ArrayList<>();
        for (String r : o.reverted) {
            JsonElement v = after.get(r);
            reverts.add(new Revert(r, v == null ? null : v.deepCopy()));
        }
        return reverts;
    }

    /**
     * True when a change at {@code changedPath} can alter {@code leaf}: same path, a descendant of the leaf (an
     * array element of {@code roles}), or an ancestor (a whole object replaced). Null → always.
     */
    static boolean affects(String changedPath, String leaf) {
        if (changedPath == null || changedPath.isEmpty()) {
            return true;
        }
        String c = changedPath.startsWith("props.") ? changedPath.substring("props.".length()) : changedPath;
        return c.equals(leaf) || c.startsWith(leaf + ".") || c.startsWith(leaf + "[")
            || leaf.startsWith(c + ".");
    }

    /**
     * True when a change at {@code changedPath} can alter any of {@code leaves} (same rule as {@link #affects}).
     * Used to limit binding re-inspection to changes at, above or below a security key.
     */
    public static boolean affectsAny(String changedPath, List<String> leaves) {
        for (String leaf : leaves) {
            if (affects(changedPath, leaf)) {
                return true;
            }
        }
        return false;
    }

    /** Immutable copy of the trusted values (deep copies; safe from any thread and to hand to other threads). */
    public Map<String, JsonElement> values() {
        return freeze(trusted);
    }

    /**
     * The current published map itself (immutable; identity changes on every adopted change). Callers must not
     * mutate the values; used to detect changes cheaply ({@code CtgDelegateBase.props()} caching).
     */
    public Map<String, JsonElement> current() {
        return trusted;
    }

    public boolean designerScope() {
        return designerScope;
    }

    private List<String> subPaths(String rootKey) {
        List<String> out = new ArrayList<>();
        for (String p : paths) {
            if (rootKey == null || underRoot(p, rootKey)) {
                out.add(p);
            }
        }
        return out;
    }

    private Map<String, JsonElement> read(List<String> leaves) {
        Map<String, JsonElement> out = new LinkedHashMap<>();
        for (String p : leaves) {
            readTrustForm(p, tree::read).ifPresent(j -> out.put(p, j));
        }
        return out;
    }

    // =========================================================================================================
    // Shadowed leaves (a container that is present but not an object)
    // =========================================================================================================

    /** Marker key; a NUL-prefixed name no schema key and no Perspective prop can carry by accident. */
    private static final String SHADOW_KEY = "\u0000ctg-shadowed-by";

    /**
     * The trusted form of one leaf: its value when present (JSON null included); a <b>shadow marker</b>
     * {@code {"\0ctg-shadowed-by": "<ancestor>", "value": <ancestor value>}} when the leaf is absent because an
     * ancestor is present but not an object ({@code setpoint.access: "Engineer"} or {@code null} hides
     * {@code roles}/{@code securityLevels}/{@code requireLogin}); empty when the leaf is simply absent (schema
     * default). Without the marker such a leaf looked absent and its gate fell back to the schema default — an
     * access rule with no roles, i.e. open. The marker is a value like any other for {@link #decide} (a Browser
     * change of the container is reverted, another origin adopted) and {@link #restorePlan} restores it by writing
     * the ancestor's value back; gates read it through {@code PropsSnapshot} (gate flag false, access rule nobody).
     */
    public static Optional<JsonElement> readTrustForm(String leaf, Function<String, Optional<JsonElement>> read) {
        Optional<JsonElement> v = safeRead(read, leaf);
        if (v.isPresent()) {
            return v;
        }
        int dot = leaf.indexOf('.');
        while (dot > 0) {
            String a = leaf.substring(0, dot);
            Optional<JsonElement> av = safeRead(read, a);
            if (av.isEmpty()) {
                return Optional.empty();   // ancestor absent: the leaf is absent, schema default
            }
            if (!av.get().isJsonObject()) {
                return Optional.of(shadow(a, av.get()));
            }
            dot = leaf.indexOf('.', dot + 1);
        }
        return Optional.empty();
    }

    private static Optional<JsonElement> safeRead(Function<String, Optional<JsonElement>> read, String path) {
        try {
            Optional<JsonElement> v = read.apply(path);
            return v == null ? Optional.empty() : v;
        } catch (RuntimeException e) {
            return Optional.empty();
        }
    }

    static JsonObject shadow(String ancestor, JsonElement ancestorValue) {
        JsonObject o = new JsonObject();
        o.addProperty(SHADOW_KEY, ancestor);
        o.add("value", ancestorValue == null ? JsonNull.INSTANCE
            : ancestorValue.deepCopy());
        return o;
    }

    /** True for a shadow marker ({@link #readTrustForm}). */
    public static boolean isShadow(JsonElement e) {
        return e != null && e.isJsonObject() && e.getAsJsonObject().has(SHADOW_KEY);
    }

    /** The shadowing ancestor's path of a marker. */
    static String shadowPath(JsonElement marker) {
        return marker.getAsJsonObject().get(SHADOW_KEY).getAsString();
    }

    /** The shadowing ancestor's (non-object) value of a marker. */
    static JsonElement shadowValue(JsonElement marker) {
        JsonElement v = marker.getAsJsonObject().get("value");
        return v == null ? JsonNull.INSTANCE : v.deepCopy();
    }

    /**
     * After a restore write: is {@code leaf} back to its trusted value {@code trustedValue}? Absent trusted value →
     * the leaf must be absent; a shadow marker → the leaf must be shadowed by the same ancestor again; any other
     * value → the leaf must be present (the write itself put the trusted value there).
     */
    public static boolean isRestored(String leaf, JsonElement trustedValue,
                                     Function<String, Optional<JsonElement>> read) {
        Optional<JsonElement> now = readTrustForm(leaf, read);
        if (trustedValue == null) {
            return now.isEmpty();
        }
        if (isShadow(trustedValue)) {
            return now.isPresent() && isShadow(now.get()) && shadowPath(now.get()).equals(shadowPath(trustedValue));
        }
        return now.isPresent() && !isShadow(now.get());
    }

    private static boolean underRoot(String path, String rootKey) {
        return path.equals(rootKey) || path.startsWith(rootKey + ".");
    }

    // =========================================================================================================
    // Pure decision logic
    // =========================================================================================================

    /** What to do with one change event. */
    public static final class Outcome {
        private final List<String> adopted;
        private final List<String> reverted;

        Outcome(List<String> adopted, List<String> reverted) {
            this.adopted = Collections.unmodifiableList(adopted);
            this.reverted = Collections.unmodifiableList(reverted);
        }

        /** Leaves whose new value becomes the trusted value. */
        public List<String> adopted() {
            return adopted;
        }

        /** Leaves to restore to the trusted value (Client scope, Browser origin). */
        public List<String> reverted() {
            return reverted;
        }
    }

    /**
     * @param paths   the security leaves under the changed root key
     * @param trusted trusted values (absent = key was absent)
     * @param fresh   values now in the tree (absent = key absent)
     */
    public static Outcome decide(List<String> paths, Map<String, JsonElement> trusted, Map<String, JsonElement> fresh,
                                 Origin origin, boolean designerScope) {
        List<String> adopted = new ArrayList<>();
        List<String> reverted = new ArrayList<>();
        for (String p : paths) {
            JsonElement t = trusted.get(p);
            JsonElement f = fresh.get(p);
            boolean same = t == null ? f == null : t.equals(f);
            if (same) {
                continue;
            }
            if (!designerScope && clientControlled(origin)) {
                reverted.add(p);
            } else {
                adopted.add(p);
            }
        }
        return new Outcome(adopted, reverted);
    }

    /**
     * Origins a Client-scope security leaf never adopts: {@link Origin#Browser} (a direct client
     * write) and {@link Origin#BindingWriteback}. A writeback lands on a security key only when a bidirectional
     * binding configured on ANOTHER prop (a sibling checkbox's {@code props.selected}, the component's own
     * {@code custom.unlock}) targets the key; the value then comes from that other prop, i.e. from the client. A
     * gate key that is itself bidirectionally bound is never a writeback target of its own binding (its writebacks
     * go to the binding's source), and the binding lint fails that case closed anyway.
     */
    public static boolean clientControlled(Origin origin) {
        return origin == Origin.Browser || origin == Origin.BindingWriteback;
    }

    /** One leaf to restore: write {@code value} back, or remove the key when {@code value} is null (was absent). */
    public static final class Revert {
        private final String path;
        private final JsonElement value;

        Revert(String path, JsonElement value) {
            this.path = path;
            this.value = value;
        }

        public String path() {
            return path;
        }

        /** Trusted value to write back; null = the key was absent at start → remove it. */
        public JsonElement value() {
            return value;
        }
    }

    // =========================================================================================================
    // Restore plan (pure; recreates parents the client removed)
    // =========================================================================================================

    /**
     * One property-tree write of a restore: {@code value} at {@code path}, or a removal when {@code value} is null.
     * {@link #covers} lists the reverted security leaves this write restores (several when a whole parent object
     * is rebuilt).
     */
    public static final class Write {
        private final String path;
        private final JsonElement value;
        private final List<String> covers;

        Write(String path, JsonElement value, List<String> covers) {
            this.path = path;
            this.value = value;
            this.covers = Collections.unmodifiableList(covers);
        }

        public String path() {
            return path;
        }

        /** Value to write (a private copy), or null = remove the key. */
        public JsonElement value() {
            return value;
        }

        /** Reverted leaves restored by this write. */
        public List<String> covers() {
            return covers;
        }
    }

    /**
     * Turns reverts into property-tree writes. A leaf whose parent object still exists is written directly. When
     * the client removed (or replaced with a non-object) an ancestor of the leaf, writing the leaf alone would
     * fail, so the <em>highest</em> such ancestor is rebuilt as one object from the trusted values of every
     * security leaf below it; every revert below that ancestor is then covered by that single write. Leaves that
     * were absent at start ({@code value == null}) are removed (nothing to rebuild for them). A leaf whose trusted
     * value is a shadow marker ({@link #readTrustForm}) is restored by writing the marker's non-object value back at
     * its ancestor (one write for all leaves it shadows; inside a rebuilt parent the value is placed there).
     *
     * @param reverts the leaves to restore ({@link #onChange} output)
     * @param read    current tree value of a path (empty when absent)
     * @param trusted trusted values of all security leaves ({@link #values()})
     */
    public static List<Write> restorePlan(List<Revert> reverts, Function<String, Optional<JsonElement>> read,
                                          Map<String, JsonElement> trusted) {
        Map<String, Write> byPath = new LinkedHashMap<>();
        Map<String, List<String>> rebuilt = new LinkedHashMap<>();   // ancestor -> covered leaves
        for (Revert r : reverts) {
            String covering = null;
            for (String a : rebuilt.keySet()) {
                if (r.path().startsWith(a + ".")) {
                    covering = a;
                    break;
                }
            }
            if (covering != null) {
                rebuilt.get(covering).add(r.path());
                continue;
            }
            // A shadow marker (trusted = "an ancestor held this non-object value") is restored by writing that value
            // back at the ancestor: one write for every leaf it shadows.
            boolean shadow = isShadow(r.value());
            String writePath = shadow ? shadowPath(r.value()) : r.path();
            String missing = r.value() == null ? null : highestMissingAncestor(writePath, read);
            if (missing == null && shadow) {
                Write prev = byPath.get(writePath);
                List<String> covers = new ArrayList<>(prev == null ? List.of() : prev.covers());
                covers.add(r.path());
                byPath.put(writePath, new Write(writePath, shadowValue(r.value()), covers));
            } else if (missing == null) {
                byPath.put(r.path(), new Write(r.path(), r.value() == null ? null : r.value().deepCopy(),
                    new ArrayList<>(List.of(r.path()))));
            } else {
                List<String> covered = new ArrayList<>();
                covered.add(r.path());
                // Leaves already planned as direct writes below this ancestor are covered by the rebuild too.
                for (Iterator<Map.Entry<String, Write>> it = byPath.entrySet().iterator(); it.hasNext(); ) {
                    Map.Entry<String, Write> e = it.next();
                    if (e.getKey().startsWith(missing + ".")) {
                        covered.addAll(e.getValue().covers());
                        it.remove();
                    }
                }
                rebuilt.put(missing, covered);
            }
        }
        List<Write> out = new ArrayList<>();
        for (Map.Entry<String, List<String>> e : rebuilt.entrySet()) {
            out.add(new Write(e.getKey(), objectOf(e.getKey(), trusted), e.getValue()));
        }
        out.addAll(byPath.values());
        return out;
    }

    /** Highest proper ancestor of {@code leaf} that is absent or not an object; null when all exist. */
    private static String highestMissingAncestor(String leaf, Function<String, Optional<JsonElement>> read) {
        int dot = leaf.indexOf('.');
        while (dot > 0) {
            String a = leaf.substring(0, dot);
            Optional<JsonElement> v;
            try {
                v = read.apply(a);
            } catch (RuntimeException e) {
                v = Optional.empty();
            }
            if (v == null || v.isEmpty() || !v.get().isJsonObject()) {
                return a;
            }
            dot = leaf.indexOf('.', dot + 1);
        }
        return null;
    }

    /** Nested object at {@code prefix} holding the trusted value of every leaf below it. */
    private static JsonObject objectOf(String prefix, Map<String, JsonElement> trusted) {
        JsonObject root = new JsonObject();
        for (Map.Entry<String, JsonElement> e : trusted.entrySet()) {
            if (e.getValue() == null || !e.getKey().startsWith(prefix + ".")) {
                continue;
            }
            String key = e.getKey();
            JsonElement value = e.getValue();
            if (isShadow(value)) {
                // Rebuild the shadowing ancestor with its non-object value (only meaningful strictly below prefix).
                String a = shadowPath(value);
                if (!a.startsWith(prefix + ".")) {
                    continue;
                }
                key = a;
                value = shadowValue(value);
            }
            String[] parts = key.substring(prefix.length() + 1).split("\\.");
            JsonObject o = root;
            for (int i = 0; i < parts.length - 1; i++) {
                JsonElement child = o.get(parts[i]);
                if (child == null || !child.isJsonObject()) {
                    child = new JsonObject();
                    o.add(parts[i], child);
                }
                o = child.getAsJsonObject();
            }
            o.add(parts[parts.length - 1], value.deepCopy());
        }
        return root;
    }

    // =========================================================================================================
    // Tamper log (module-wide, rate-limited per key name)
    // =========================================================================================================

    /**
     * {@code action=prop-tamper} WARN lines on {@code SimpleTagDisplay.Audit}, at most
     * {@code ctg.security.tamperLogPerMin} per security key name per minute. Keys are our fixed path
     * names, never client text; suppressed lines are counted into the next one.
     */
    public static final class TamperLog {
        private static final LoggerEx AUDIT = LoggerEx.newBuilder().build("SimpleTagDisplay.Audit");
        private static final int MAX_KEYS = 1024;
        private final IntSupplier perMinute;
        private final Consumer<String> sink;
        private final LongSupplier clock;
        private final ConcurrentHashMap<String, long[]> windows = new ConcurrentHashMap<>();   // key -> {windowStart, count, suppressed}

        /** Production: WARN lines on {@code SimpleTagDisplay.Audit}. */
        public TamperLog(IntSupplier perMinute) {
            this(perMinute, AUDIT::warn, System::currentTimeMillis);
        }

        /** Tests: any sink and clock. */
        public TamperLog(IntSupplier perMinute, Consumer<String> sink, LongSupplier clock) {
            this.perMinute = perMinute;
            this.sink = sink;
            this.clock = clock;
        }

        /**
         * @param key  fixed security-key path (never client text)
         * @param line already sanitised log text (user, component, key)
         */
        public void report(String key, String line) {
            long now = clock.getAsLong();
            if (windows.size() > MAX_KEYS) {
                windows.clear();
            }
            long[] w = windows.computeIfAbsent(key, k -> new long[] {now, 0, 0});
            long suppressed;
            synchronized (w) {
                if (now - w[0] >= 60_000L) {
                    w[0] = now;
                    w[1] = 0;
                }
                if (w[1] >= perMinute.getAsInt()) {
                    w[2]++;
                    return;
                }
                w[1]++;
                suppressed = w[2];
                w[2] = 0;
            }
            sink.accept(suppressed > 0 ? line + " (" + suppressed + " similar suppressed)" : line);
        }
    }
}
