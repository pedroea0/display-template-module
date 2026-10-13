package com.example.simpletagdisplay.gateway.security;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.Set;
import java.util.function.Predicate;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import com.example.simpletagdisplay.gateway.delegate.PropsSnapshot;
import com.example.simpletagdisplay.gateway.history.HistoryTokenStore;
import com.example.simpletagdisplay.gateway.tags.TagPaths;
import com.inductiveautomation.ignition.common.gson.JsonElement;
import com.inductiveautomation.ignition.common.tags.model.TagPath;
import com.inductiveautomation.ignition.common.tags.paths.BasicTagPath;

/**
 * The chart's <b>read scope</b>: which tags one Click To Graph
 * Chart may read — subscribe, read metadata of, and query history for.
 *
 * <h2>Rule</h2>
 * <pre>
 *   allows(key, runtime):
 *     runtime == false (a pen the Designer configured)              → true
 *     key is a Designer pen key ({@code designKeys})                 → true
 *     key is in the session trend list of the chart's group         → true   (the list only receives scope-checked
 *                                                                              chart adds and trusted display paths)
 *     otherwise (a runtime pen: written by the browser, or a chart trend add)
 *       runtimeAllowed && provider not in ctg.read.deniedProviders && (roots == ALL || key under a root)
 * </pre>
 * Display reads are not scope-limited (a display's {@code tagPath} is configured or param-bound exactly like a
 * Perspective tag binding); tag Read Permissions always apply on top through the user's security context.
 *
 * <h2>Roots</h2>
 * <pre>
 *   readScope.allowedRoots non-empty         → those folders ([provider] alone = the whole provider)
 *   else tagBrowser.enabled (default true)   → [tagBrowser.rootPath], or ALL providers when rootPath is ""
 *   else                                     → NONE (only Designer pens and the session trend list)
 * </pre>
 * <b>Fail closed</b>: a present {@code allowedRoots} that is not an array of strings
 * (JSON null, a string, a shadowed leaf whose ancestor is not an object) allows nothing; a non-empty list without a
 * single valid entry allows nothing; a {@code rootPath} that is present but not a string, or not a valid folder path,
 * allows nothing; {@code allowRuntimePens} / {@code tagBrowser.enabled} that are present but not Booleans read as
 * {@code false}; a security key of {@code readScope} / {@code tagBrowser} whose binding fails its gate closed
 * (bidirectional, or user-controlled with {@code ctg.security.rejectBoundGates}) turns runtime pens off.
 *
 * <h2>History tokens</h2>
 * The instance is a {@link HistoryTokenStore.PenGate}: {@link #allows(String)} is {@code allows(key, true)} (the route
 * cannot tell a Designer pen from a runtime one, but a Designer pen key is in {@code designKeys}). The chart delegate
 * hands every token a gate that reads its <em>current</em> scope, so a props, auth or trend-list change applies to
 * tokens already issued (issued tokens reference the scope atomically).
 *
 * Keys are {@link TagPaths#normalizedKey normalized keys} ({@code "[default]ctg/temp"}). Immutable apart from the
 * live trend-list predicate supplied by the delegate.
 */
public final class ReadScope implements HistoryTokenStore.PenGate {

    /**
     * Schema default of {@code tagBrowser.enabled} (ctgchart.props.json), used when the key is absent: TRUE, for
     * parity with the Power Chart. Consequence for the rule above: a chart without
     * {@code readScope.allowedRoots} and without a {@code tagBrowser.rootPath} lets runtime pens read every provider
     * except {@code ctg.read.deniedProviders} (default {@code System}), always with the user's own tag Read Permissions.
     * Set {@code tagBrowser.enabled:false} or {@code readScope.allowedRoots} to narrow it.
     */
    public static final boolean TAG_BROWSER_ENABLED_DEFAULT = true;

    /** A provider root as written in a prop: {@code [default]} or {@code [default]/}. */
    private static final Pattern PROVIDER_ROOT = Pattern.compile("^\\[([^\\[\\]/\\\\:]+)\\]/?$");

    /** Allows nothing at runtime (no Designer keys, no trend list, no roots). */
    public static final ReadScope NONE = new ReadScope(Set.of(), key -> false, false, false, List.of(), Set.of(), List.of(),
        "none");

    private final Set<String> designKeys;
    private final Predicate<String> trendMember;
    private final boolean runtimeAllowed;
    private final boolean allRoots;
    private final List<String> rootKeys;
    private final Set<String> deniedProviders;
    private final List<String> rootLabels;
    private final String source;

    private ReadScope(Set<String> designKeys, Predicate<String> trendMember, boolean runtimeAllowed, boolean allRoots,
                      List<String> rootKeys, Set<String> deniedProviders, List<String> rootLabels, String source) {
        this.designKeys = designKeys;
        this.trendMember = trendMember;
        this.runtimeAllowed = runtimeAllowed;
        this.allRoots = allRoots;
        this.rootKeys = rootKeys;
        this.deniedProviders = deniedProviders;
        this.rootLabels = rootLabels;
        this.source = source;
    }

    // =========================================================================================================
    // Building
    // =========================================================================================================

    /**
     * Builds the scope from the chart's <b>trusted</b> props.
     *
     * @param p               trusted snapshot (security keys + lint verdicts)
     * @param designKeys      normalized keys of the {@code pens} the Designer configured (start value and every
     *                        non-browser change)
     * @param trendMember     live membership test of the session trend list of the chart's group (normalized key)
     * @param deniedProviders {@code ctg.read.deniedProviders}, any casing
     * @param defaultProvider project default provider (a root without provider resolves to it)
     * @param providerNames   the gateway's tag providers, used only to list the effective roots when every provider
     *                        is allowed ({@link #rootLabels()})
     */
    public static ReadScope build(PropsSnapshot p, Collection<String> designKeys, Predicate<String> trendMember,
                                  Collection<String> deniedProviders, String defaultProvider,
                                  Collection<String> providerNames) {
        Set<String> denied = new LinkedHashSet<>();
        for (String d : deniedProviders) {
            if (d != null && !d.isBlank()) {
                denied.add(d.trim().toLowerCase(Locale.ROOT));
            }
        }
        Set<String> design = Collections.unmodifiableSet(new LinkedHashSet<>(designKeys));
        Predicate<String> trend = trendMember == null ? key -> false : trendMember;
        boolean allowRuntime = p.gateFlag("readScope.allowRuntimePens", true)
            && p.lintGate("readScope.allowRuntimePens", "readScope.allowedRoots").isEmpty();

        // ---- explicit roots ----------------------------------------------------------------------------------
        if (p.isPresent("readScope.allowedRoots")) {
            Optional<JsonElement> raw = p.json("readScope.allowedRoots");
            if (p.shadowed("readScope.allowedRoots") || raw.isEmpty() || !raw.get().isJsonArray()) {
                return closed(design, trend, denied, "allowedRoots malformed");
            }
            List<String> entries = new ArrayList<>();
            for (JsonElement e : raw.get().getAsJsonArray()) {
                if (e == null || !e.isJsonPrimitive() || !e.getAsJsonPrimitive().isString()) {
                    return closed(design, trend, denied, "allowedRoots malformed");
                }
                entries.add(e.getAsString());
            }
            if (!entries.isEmpty()) {
                List<String> keys = new ArrayList<>();
                List<String> labels = new ArrayList<>();
                for (String entry : entries) {
                    Optional<TagPath> root = parseFolder(entry, defaultProvider);
                    if (root.isPresent()) {
                        String k = folderKey(root.get());
                        if (!keys.contains(k)) {
                            keys.add(k);
                            labels.add(folderLabel(root.get()));
                        }
                    }
                }
                if (keys.isEmpty()) {
                    return closed(design, trend, denied, "allowedRoots has no valid entry");
                }
                return new ReadScope(design, trend, allowRuntime, false, List.copyOf(keys), Set.copyOf(denied),
                    List.copyOf(labels), "allowedRoots");
            }
        }

        // ---- fallback: the tag browser's root ------------------------------------------------------------------
        boolean browser = p.gateFlag("tagBrowser.enabled", TAG_BROWSER_ENABLED_DEFAULT) && p.lintGate("tagBrowser.enabled", "tagBrowser.rootPath").isEmpty();
        if (!browser) {
            return new ReadScope(design, trend, allowRuntime, false, List.of(), Set.copyOf(denied), List.of(), "none");
        }
        Optional<String> rootPath = rootPath(p);
        if (rootPath.isEmpty()) {
            return closed(design, trend, denied, "tagBrowser.rootPath malformed");
        }
        if (rootPath.get().isBlank()) {
            List<String> labels = new ArrayList<>();
            for (String n : providerNames) {
                if (n != null && !n.isBlank() && !denied.contains(n.toLowerCase(Locale.ROOT))) {
                    labels.add("[" + n + "]");
                }
            }
            labels.sort(String.CASE_INSENSITIVE_ORDER);
            return new ReadScope(design, trend, allowRuntime, true, List.of(), Set.copyOf(denied), List.copyOf(labels),
                "tagBrowser (all providers)");
        }
        Optional<TagPath> root = parseFolder(rootPath.get(), defaultProvider);
        if (root.isEmpty()) {
            return closed(design, trend, denied, "tagBrowser.rootPath invalid");
        }
        return new ReadScope(design, trend, allowRuntime, false, List.of(folderKey(root.get())), Set.copyOf(denied),
            List.of(folderLabel(root.get())), "tagBrowser.rootPath");
    }

    /** Runtime pens off (fail closed); Designer pens and the trend list keep working. */
    private static ReadScope closed(Set<String> design, Predicate<String> trend, Set<String> denied, String why) {
        return new ReadScope(design, trend, false, false, List.of(), Set.copyOf(denied), List.of(), "closed: " + why);
    }

    /**
     * The trusted {@code tagBrowser.rootPath}: "" when absent, the string when it is one, empty (= malformed, fail
     * closed) when present but not a string or shadowed.
     */
    public static Optional<String> rootPath(PropsSnapshot p) {
        if (!p.isPresent("tagBrowser.rootPath")) {
            return Optional.of("");
        }
        if (p.shadowed("tagBrowser.rootPath")) {
            return Optional.empty();
        }
        Optional<JsonElement> e = p.json("tagBrowser.rootPath");
        if (e.isEmpty()) {
            return Optional.empty();   // present JSON null
        }
        if (!e.get().isJsonPrimitive() || !e.get().getAsJsonPrimitive().isString()) {
            return Optional.empty();
        }
        return Optional.of(e.get().getAsString().trim());
    }

    // =========================================================================================================
    // Folder paths (shared with the tag browser)
    // =========================================================================================================

    /**
     * Parses a folder path for a scope root or a browse request: {@code [provider]} (or {@code [provider]/}) is the
     * provider root; anything else follows the read path rules of {@link TagPaths#parse(String, String)} (no
     * {@code .}/{@code ..} segments, no {@code :/}, no control characters, no property). Empty when invalid.
     *
     * <p>A provider name with leading or trailing white space ({@code [ System]}) is invalid here exactly as in
     * {@link TagPaths#parse(String, String)} ({@link TagPaths#isValidProviderName}): trimming it here to
     * {@code System} while the tag-path parser keeps {@code " System"} would make the two disagree about the same text.
     */
    public static Optional<TagPath> parseFolder(String raw, String defaultProvider) {
        String s = raw == null ? "" : raw.trim();
        if (s.isEmpty() || s.length() > TagPaths.MAX_LENGTH) {
            return Optional.empty();
        }
        Matcher m = PROVIDER_ROOT.matcher(s);
        if (m.matches()) {
            String provider = m.group(1);
            if (!TagPaths.isValidProviderName(provider)) {
                return Optional.empty();
            }
            if (provider.startsWith(".") || "~".equals(provider)) {
                if (!"~".equals(provider) || defaultProvider == null || defaultProvider.isEmpty()) {
                    return Optional.empty();
                }
                provider = defaultProvider;
            }
            return Optional.of(new BasicTagPath(provider, List.of()));
        }
        TagPaths.Parsed parsed = TagPaths.parse(s, defaultProvider);
        if (!parsed.ok() || parsed.path().getSource() == null || parsed.path().getSource().isEmpty()) {
            return Optional.empty();
        }
        return Optional.of(parsed.path());
    }

    /** Normalized key of a folder ({@code "[default]"} for a provider root, else {@link TagPaths#normalizedKey}). */
    public static String folderKey(TagPath folder) {
        return folderLabel(folder).toLowerCase(Locale.ROOT);
    }

    /** Display form of a folder ({@code "[default]"}, {@code "[default]CTG"}). */
    public static String folderLabel(TagPath folder) {
        StringBuilder b = new StringBuilder();
        b.append('[').append(folder.getSource() == null ? "" : folder.getSource()).append(']');
        for (int i = 0; i < folder.getPathLength(); i++) {
            if (i > 0) {
                b.append('/');
            }
            b.append(folder.getPathComponent(i));
        }
        return b.toString();
    }

    /**
     * True when {@code key} (a normalized tag or folder key) is {@code rootKey} or lies below it. A provider root
     * ({@code "[default]"}) contains every key of that provider.
     */
    public static boolean isUnder(String key, String rootKey) {
        if (rootKey.endsWith("]")) {
            return key.startsWith(rootKey);
        }
        return TagPaths.isUnder(key, rootKey);
    }

    /** Lower-cased provider of a normalized key ({@code "[default]ctg/temp"} → {@code "default"}); "" when none. */
    public static String providerOf(String key) {
        if (key == null || !key.startsWith("[")) {
            return "";
        }
        int end = key.indexOf(']');
        return end < 0 ? "" : key.substring(1, end);
    }

    // =========================================================================================================
    // Decisions
    // =========================================================================================================

    /** See the class comment. {@code runtime} is false only for a pen the Designer configured. */
    public boolean allows(String key, boolean runtime) {
        if (key == null) {
            return false;
        }
        if (!runtime || designKeys.contains(key) || trendMember.test(key)) {
            return true;
        }
        return runtimeRule(key);
    }

    /** History token gate: {@code allows(key, true)}. */
    @Override
    public boolean allows(String normalizedKey) {
        return allows(normalizedKey, true);
    }

    /** The runtime rule alone (scope roots + denied providers), without the Designer / trend-list exemptions. */
    public boolean runtimeRule(String key) {
        if (!runtimeAllowed || key == null) {
            return false;
        }
        if (deniedProviders.contains(providerOf(key))) {
            return false;
        }
        if (allRoots) {
            return true;
        }
        for (String root : rootKeys) {
            if (isUnder(key, root)) {
                return true;
            }
        }
        return false;
    }

    /** True when the provider of {@code key} is in {@code ctg.read.deniedProviders}. */
    public boolean providerDenied(String key) {
        return deniedProviders.contains(providerOf(key));
    }

    /** True when at least one runtime pen could be allowed (snapshot {@code readScope.runtimePensAllowed}). */
    public boolean runtimePensAllowed() {
        return runtimeAllowed && (allRoots || !rootKeys.isEmpty());
    }

    /** Effective roots for display (snapshot {@code readScope.roots}; with ALL: every non-denied provider). */
    public List<String> rootLabels() {
        return rootLabels;
    }

    /** Normalized root keys (empty for ALL and NONE). */
    public List<String> rootKeys() {
        return rootKeys;
    }

    public boolean allRoots() {
        return allRoots;
    }

    public Set<String> designKeys() {
        return designKeys;
    }

    /** Where the roots came from (diagnostics: "allowedRoots", "tagBrowser.rootPath", "closed: ..."). */
    public String source() {
        return source;
    }

    @Override
    public String toString() {
        return "ReadScope{runtimeAllowed=" + runtimeAllowed + ", all=" + allRoots + ", roots=" + rootKeys + ", denied="
            + deniedProviders + ", designKeys=" + designKeys.size() + ", source=" + source + "}";
    }
}
