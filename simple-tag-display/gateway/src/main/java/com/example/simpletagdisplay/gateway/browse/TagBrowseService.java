package com.example.simpletagdisplay.gateway.browse;

import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collection;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeoutException;
import java.util.function.BiConsumer;
import java.util.function.LongSupplier;

import com.example.simpletagdisplay.common.protocol.ErrorCode;
import com.example.simpletagdisplay.gateway.delegate.CallContext;
import com.example.simpletagdisplay.gateway.delegate.PropsSnapshot;
import com.example.simpletagdisplay.gateway.ops.ChartOps;
import com.example.simpletagdisplay.gateway.security.ReadScope;
import com.example.simpletagdisplay.gateway.security.UserContext;
import com.example.simpletagdisplay.gateway.tags.TagPaths;
import com.example.simpletagdisplay.gateway.util.Json;
import com.inductiveautomation.ignition.common.browsing.BrowseFilter;
import com.inductiveautomation.ignition.common.browsing.Results;
import com.inductiveautomation.ignition.common.gson.JsonArray;
import com.inductiveautomation.ignition.common.gson.JsonElement;
import com.inductiveautomation.ignition.common.gson.JsonNull;
import com.inductiveautomation.ignition.common.gson.JsonObject;
import com.inductiveautomation.ignition.common.model.values.QualifiedValue;
import com.inductiveautomation.ignition.common.model.values.QualityCode;
import com.inductiveautomation.ignition.common.sqltags.model.types.DataType;
import com.inductiveautomation.ignition.common.tags.browsing.NodeDescription;
import com.inductiveautomation.ignition.common.tags.config.types.TagObjectType;
import com.inductiveautomation.ignition.common.tags.model.TagPath;
import com.inductiveautomation.ignition.common.tags.paths.BasicTagPath;

/**
 * Tag browsing for the chart's tag browser panel: {@code chart.browse} (the server side of a Power-Chart-style tag
 * browser). One instance per chart delegate: it owns that delegate's
 * continuation ids.
 *
 * <h2>Request → reply</h2>
 * <pre>
 *   {path:"" | "[default]Area1", continuation?, limit? (1..200, default 100), filterText? (≤ 64)}
 *   → {path, totalAvailable, continuation, results:[{name, path, type, dataType, hasChildren, trendable}]}
 * </pre>
 * <ol>
 *   <li>Gate ({@link ChartOps#browseGate}): {@code tagBrowser.enabled}, binding lint, {@code tagBrowser.access}. The
 *       root {@code enabled} does not apply: browsing changes nothing.</li>
 *   <li>{@code path == ""}: the trusted {@code tagBrowser.rootPath} when set; otherwise the gateway's tag providers
 *       minus {@code ctg.read.deniedProviders} (one folder node {@code [name]} each; a provider the user may not browse
 *       answers with an error on expansion, it is not pre-filtered).</li>
 *   <li>Root enforcement on normalized paths, with the same parser for {@code path} and {@code rootPath}
 *       ({@link ReadScope#parseFolder}: {@code .}/{@code ..} segments, {@code :/}, control characters rejected): a path
 *       outside the root — or one that does not even parse while a root is set (a traversal attempt) — is
 *       {@code BROWSE_ROOT_VIOLATION}. A malformed trusted {@code rootPath} fails closed (every browse refused).</li>
 *   <li>A provider in {@code ctg.read.deniedProviders} → {@code OUT_OF_SCOPE}.</li>
 *   <li>A provider the gateway does not have → {@code TAG_NOT_FOUND}, logged at DEBUG like every other refusal
 *       (the provider's {@code browseAsync} fails exceptionally, and a client-chosen path must not write a WARN with a
 *       stack trace). Checked before the call and again when a call fails
 *       (a provider removed meanwhile); any other failure is still a rate-limited WARN.</li>
 *   <li>{@code session.getTagManager().browseAsync(path, filter, userContext)} (project tag manager, user's
 *       security context) with {@code ctg.read.timeoutMs} → {@code TIMEOUT}. Bad result quality →
 *       {@code ACCESS_DENIED} / {@code TAG_NOT_FOUND} / {@code INTERNAL}.</li>
 *   <li>{@code continuation}: an <b>opaque</b> id kept per delegate (LRU {@value #MAX_CONTINUATIONS}: id →
 *       (normalized path, provider continuation point or page offset)), valid only for the same path — reused for
 *       another path, or unknown → {@code BAD_REQUEST}. Provider continuation points never reach the client.</li>
 *   <li>{@code filterText}: case-insensitive substring filter on the names of the returned page (not recursive;
 *       the recursive search below is the "search all folders" mode).</li>
 * </ol>
 * {@code trendable} = an AtomicTag whose data type is a numeric or Boolean scalar (history availability is checked
 * when the pen is added). Folders and UDT instances have {@code hasChildren:true}.
 *
 * <h2>Recursive search ("Search all folders")</h2>
 * The same message with a {@code search} member (no protocol or ChartApi change; {@code chart.browse} is already on
 * the panel allow-list):
 * <pre>
 *   {path, search:"pump*", limit?}            → a new search below path ("" = the root, as above)
 *   {path, search, continuation, limit?}      → the next page of that search's stored results (no new search)
 *   {cancelSearch:true}                       → {cancelled} — stops this chart's running search (only the Boolean
 *                                               true, alone; anything else is BAD_REQUEST)
 *   reply: {path, totalAvailable, continuation, results:[row + folder],
 *           search:{complete, stopped, folders, nodes, denied, failed, elapsedMs, maxResults, wildcard}}
 * </pre>
 * Order for a new search: text ({@link TagSearch.Query#parse}, else {@code BAD_REQUEST}) → the browse gate and root
 * ({@link #target}: same codes as a browse) → read scope ({@code OUT_OF_SCOPE} when no runtime pen could be added at
 * all) → admission ({@link TagSearchAdmission}: {@code RATE_LIMITED} / {@code BUSY}) → the walk
 * ({@link TagSearch}: bounded depth, rows, folder calls, results and time; user's security context; read-scope
 * region) → a <b>permission pass</b>: one batched {@code readAsync} of every match with the user's context drops
 * the tags the user may not read (an Ignition browse lists a tag whose Read Permissions deny the user; the search
 * must not) — when that read fails or times out the search fails closed ({@code TIMEOUT}) → the user, the gate,
 * the root and the scope are checked again ({@code AUTH_CHANGED} / gate code) and the result is filtered by the
 * scope of that moment → the first page.
 *
 * <p>One search per chart: a new search while the previous one runs cancels it (its request is answered with no
 * rows, {@code stopped:"superseded"}) and starts when the old walk's calls in flight have returned, keeping the
 * old search's admission ticket — retyping never multiplies the work in flight. A cancelled search answers with no
 * rows too (unchecked matches are never sent). The stored results of the latest finished search are the only
 * ones kept (at most {@code maxResults} rows, for {@value #SEARCH_RESULTS_TTL_MS} ms); a continuation of an older or
 * expired search, of another path or text, or of a previous user is refused ({@code BAD_REQUEST} / {@code AUTH_CHANGED}). {@link #stop} (delegate teardown) drops
 * everything and returns the ticket.
 */
public final class TagBrowseService {

    static final int MAX_CONTINUATIONS = 32;
    static final int DEFAULT_LIMIT = 100;
    static final int MAX_LIMIT = 200;
    static final int MAX_FILTER = 64;
    /** Stored search results expire after this long (a permission change must not stay hidden behind "Load more"). */
    static final long SEARCH_RESULTS_TTL_MS = 300_000L;

    private static final SecureRandom RNG = new SecureRandom();

    /** What a continuation id stands for. Immutable. */
    static final class Continuation {
        final String pathKey;
        final String providerPoint;   // provider continuation point, or null
        final int offset;             // page offset when the provider returned everything at once

        Continuation(String pathKey, String providerPoint, int offset) {
            this.pathKey = pathKey;
            this.providerPoint = providerPoint;
            this.offset = offset;
        }
    }

    /** Session-queue only (one delegate). */
    private final LinkedHashMap<String, Continuation> continuations = new LinkedHashMap<>(16, 0.75f, true);

    // ---- recursive search state (session queue only) ----
    private final TagSearch.Limits searchLimits;
    private final LongSupplier clock;
    /** The running search (walk or permission pass), or null. */
    private ActiveSearch active;
    /** A search waiting for {@link #active} to wind down (it superseded it), or null. */
    private SearchRequest pending;
    /** The admission slot held while a search is active or pending. */
    private TagSearchAdmission.Ticket ticket;
    /** The latest finished search (its rows are what continuations page through), or null. */
    private SearchResults last;
    private long searchSeq;

    public TagBrowseService() {
        this(TagSearch.DEFAULT_LIMITS, System::currentTimeMillis);
    }

    TagBrowseService(TagSearch.Limits searchLimits, LongSupplier clock) {
        this.searchLimits = searchLimits;
        this.clock = clock;
    }

    // =========================================================================================================
    // Request
    // =========================================================================================================

    /** {@code chart.browse}: see the class comment. Completes {@code cc} exactly once. */
    public void browse(CallContext cc, ChartOps.Host h, Collection<String> providerNames) {
        JsonObject b = cc.body();
        if (b.has("cancelSearch")) {
            // Only {cancelSearch:true} cancels; false / non-Boolean / mixed with a search is ambiguous
            JsonElement cs = b.get("cancelSearch");
            boolean cancel = cs != null && cs.isJsonPrimitive() && cs.getAsJsonPrimitive().isBoolean() && cs.getAsBoolean();
            if (!cancel || b.has("search")) {
                fail(cc, h, ErrorCode.BAD_REQUEST, "cancelSearch must be true and alone");
                return;
            }
            cancelSearch(cc, h);
            return;
        }
        if (b.has("search")) {
            search(cc, h, providerNames);
            return;
        }
        String rawPath = Json.string(b, "path", "");
        String contId = b.has("continuation") && !b.get("continuation").isJsonNull() ? Json.string(b, "continuation", null) : "";
        if (rawPath == null || contId == null) {
            fail(cc, h, ErrorCode.BAD_REQUEST, "path/continuation not a string");
            return;
        }
        int limit = (int) Math.max(1, Math.min(MAX_LIMIT, Json.integer(b, "limit", DEFAULT_LIMIT)));
        String filter = Json.string(b, "filterText", "");
        if (filter == null || filter.length() > MAX_FILTER) {
            fail(cc, h, ErrorCode.BAD_REQUEST, "filterText");
            return;
        }
        filter = filter.trim().toLowerCase(Locale.ROOT);

        Target t = target(cc.props(), cc.user(), rawPath, h.defaultProvider(), h.scope());
        if (t.error != null) {
            fail(cc, h, t.error, "target");
            return;
        }
        Continuation cont = null;
        if (!contId.isEmpty()) {
            cont = continuations.get(contId);
            String key = t.path == null ? "" : ReadScope.folderKey(t.path);
            if (cont == null || !cont.pathKey.equals(key)) {
                fail(cc, h, ErrorCode.BAD_REQUEST, "continuation");
                return;
            }
        }
        if (t.path == null) {
            cc.reply(providers(providerNames, h.scope(), filter, limit, cont == null ? 0 : cont.offset));
            return;
        }
        if (!providerKnown(providerNames, t.path.getSource())) {
            fail(cc, h, ErrorCode.TAG_NOT_FOUND, "unknown provider");
            return;
        }
        browseFolder(cc, h, t.path, cont, limit, filter, providerNames);
    }

    /**
     * True when {@code source} names one of the gateway's tag providers, compared the way Ignition resolves provider
     * names: both sides lower-cased with {@link Locale#ROOT} (the gateway's provider map is keyed by
     * {@code StringUtils.lowerCase}). Not {@link String#equalsIgnoreCase}: that folds Unicode case twins such as the
     * long s (U+017F + "ystem" equals "System" ignoring case) which the gateway then cannot find. An empty
     * provider list (the lookup failed) answers true: the browse itself then decides.
     */
    static boolean providerKnown(Collection<String> providerNames, String source) {
        if (providerNames == null || providerNames.isEmpty()) {
            return true;
        }
        if (source == null || source.isEmpty()) {
            return false;
        }
        for (String n : providerNames) {
            if (n != null && n.toLowerCase(Locale.ROOT).equals(source.toLowerCase(Locale.ROOT))) {
                return true;
            }
        }
        return false;
    }

    /** Where a request points: the folder to browse, null for the provider list, or an error. */
    static final class Target {
        final TagPath path;
        final ErrorCode error;

        Target(TagPath path, ErrorCode error) {
            this.path = path;
            this.error = error;
        }
    }

    /**
     * Gate + path resolution (pure; JUnit). {@code rawPath} "" = the root (the trusted {@code rootPath}, or the
     * provider list when there is none).
     */
    static Target target(PropsSnapshot p, UserContext u, String rawPath, String defaultProvider, ReadScope scope) {
        Optional<ErrorCode> gate = ChartOps.browseGate(p, u);
        if (gate.isPresent()) {
            return new Target(null, gate.get());
        }
        Optional<String> rootText = ReadScope.rootPath(p);
        if (rootText.isEmpty()) {
            return new Target(null, ErrorCode.BROWSE_ROOT_VIOLATION);   // malformed trusted rootPath: fail closed
        }
        TagPath root = null;
        if (!rootText.get().isEmpty()) {
            Optional<TagPath> r = ReadScope.parseFolder(rootText.get(), defaultProvider);
            if (r.isEmpty()) {
                return new Target(null, ErrorCode.BROWSE_ROOT_VIOLATION);
            }
            root = r.get();
        }
        String raw = rawPath == null ? "" : rawPath.trim();
        TagPath path;
        if (raw.isEmpty()) {
            path = root;   // null = provider list
        } else {
            Optional<TagPath> parsed = ReadScope.parseFolder(raw, defaultProvider);
            if (parsed.isEmpty()) {
                return new Target(null, root != null ? ErrorCode.BROWSE_ROOT_VIOLATION : ErrorCode.INVALID_PATH);
            }
            path = parsed.get();
            if (root != null && !ReadScope.isUnder(ReadScope.folderKey(path), ReadScope.folderKey(root))) {
                return new Target(null, ErrorCode.BROWSE_ROOT_VIOLATION);
            }
        }
        if (path != null && scope.providerDenied(ReadScope.folderKey(path))) {
            return new Target(null, ErrorCode.OUT_OF_SCOPE);
        }
        return new Target(path, null);
    }

    // =========================================================================================================
    // Provider list
    // =========================================================================================================

    /** The provider list (no root): non-denied providers, sorted, filtered, paged by offset. */
    JsonObject providers(Collection<String> names, ReadScope scope, String filter, int limit, int offset) {
        List<String> all = new ArrayList<>();
        for (String n : names) {
            if (n == null || n.isBlank() || scope.providerDenied("[" + n.toLowerCase(Locale.ROOT) + "]")) {
                continue;
            }
            if (!filter.isEmpty() && !n.toLowerCase(Locale.ROOT).contains(filter)) {
                continue;
            }
            all.add(n);
        }
        all.sort(String.CASE_INSENSITIVE_ORDER);
        JsonArray results = new JsonArray();
        int end = Math.min(all.size(), offset + limit);
        for (int i = Math.max(0, offset); i < end; i++) {
            String n = all.get(i);
            JsonObject r = new JsonObject();
            r.addProperty("name", n);
            r.addProperty("path", "[" + n + "]");
            r.addProperty("type", TagObjectType.Provider.name());
            r.add("dataType", JsonNull.INSTANCE);
            r.addProperty("hasChildren", true);
            r.addProperty("trendable", false);
            results.add(r);
        }
        JsonObject o = new JsonObject();
        o.addProperty("path", "");
        o.addProperty("totalAvailable", all.size());
        if (end < all.size()) {
            o.addProperty("continuation", remember(new Continuation("", null, end)));
        } else {
            o.add("continuation", JsonNull.INSTANCE);
        }
        o.add("results", results);
        return o;
    }

    // =========================================================================================================
    // Folder browse
    // =========================================================================================================

    private void browseFolder(CallContext cc, ChartOps.Host h, TagPath path, Continuation cont, int limit, String filter,
                              Collection<String> providerNames) {
        BrowseFilter f = new BrowseFilter().setRecursive(false).setMaxResults(limit);
        if (cont != null && cont.providerPoint != null) {
            f.setContinuationPoint(cont.providerPoint);
        }
        CompletableFuture<Results<NodeDescription>> future;
        try {
            future = h.tagManager().browseAsync(path, f, cc.user().securityContext());
        } catch (RuntimeException e) {
            browseFailed(cc, h, path, providerNames, e, "browse.exception");
            return;
        }
        String pathKey = ReadScope.folderKey(path);
        h.onQueue(future, h.services().settings().get().readTimeoutMs(), (res, err) -> {
            if (err instanceof TimeoutException) {
                cc.fail(ErrorCode.TIMEOUT);
                return;
            }
            if (err != null || res == null) {
                browseFailed(cc, h, path, providerNames, err, "browse.failed");
                return;
            }
            // The user, the gate and the root must still be the ones the request was checked against.
            UserContext user = h.user();
            if (user.generation() != cc.user().generation()) {
                fail(cc, h, ErrorCode.AUTH_CHANGED, "auth changed");
                return;
            }
            Target again = target(h.props(), user, ReadScope.folderLabel(path), h.defaultProvider(), h.scope());
            if (again.error != null) {
                fail(cc, h, again.error, "target after browse");
                return;
            }
            QualityCode q = res.getResultQuality();
            if (q != null && !q.isGood()) {
                fail(cc, h, mapQuality(q), "result quality " + q.getName());
                return;
            }
            cc.reply(page(path, pathKey, res, cont, limit, filter));
        });
    }

    /**
     * A browse call failed (threw, or completed exceptionally). When the provider is not (or no longer) one of the
     * gateway's, that is the client's path, not a module fault: {@code TAG_NOT_FOUND} at DEBUG. Anything else is a
     * rate-limited WARN with the cause and {@code INTERNAL}. The provider list is read again here, so a provider that
     * was removed while the browse ran is recognised too.
     */
    private static void browseFailed(CallContext cc, ChartOps.Host h, TagPath path, Collection<String> namesAtRequest,
                                     Throwable err, String warnKey) {
        Collection<String> now = h.providerNames();
        if (!providerKnown(now == null || now.isEmpty() ? namesAtRequest : now, path.getSource())) {
            h.logger().debugf("chart.browse unknown provider on %s: %s", h.describe(),
                err == null ? "no result" : err.toString());
            cc.fail(ErrorCode.TAG_NOT_FOUND);
            return;
        }
        h.warnings().warn(warnKey, "Tag browse failed on " + h.describe(), err);
        cc.fail(ErrorCode.INTERNAL);
    }

    /** Builds the reply page; provider continuation points (or offsets) are replaced by opaque ids. */
    JsonObject page(TagPath path, String pathKey, Results<NodeDescription> res, Continuation cont, int limit, String filter) {
        List<NodeDescription> nodes = new ArrayList<>(res.getResults() == null ? List.of() : res.getResults());
        String providerPoint = res.getContinuationPoint();
        // Observed on 8.3.10: the tag provider honours maxResults and returns a continuation point, but
        // it returns one on the LAST (short) page too. A short page therefore ends the listing.
        boolean providerPaged = providerPoint != null && !providerPoint.isEmpty() && nodes.size() >= limit;
        int offset = !providerPaged && cont != null && cont.providerPoint == null ? cont.offset : 0;
        int total = res.getTotalAvailableSize() > 0 ? res.getTotalAvailableSize() : nodes.size();
        List<NodeDescription> pageNodes;
        String nextId = null;
        if (providerPaged) {
            pageNodes = nodes;
            nextId = remember(new Continuation(pathKey, providerPoint, 0));
        } else {
            // The provider ignored maxResults (or this is a later page of a local paging): page here.
            int from = Math.min(offset, nodes.size());
            int to = Math.min(nodes.size(), from + limit);
            pageNodes = nodes.subList(from, to);
            if (to < nodes.size()) {
                nextId = remember(new Continuation(pathKey, null, to));
            }
            total = Math.max(total, nodes.size());
        }
        JsonArray results = new JsonArray();
        for (NodeDescription n : pageNodes) {
            String name = n.getName() == null ? "" : n.getName();
            if (!filter.isEmpty() && !name.toLowerCase(Locale.ROOT).contains(filter)) {
                continue;
            }
            results.add(node(path, n));
        }
        JsonObject o = new JsonObject();
        o.addProperty("path", ReadScope.folderLabel(path));
        o.addProperty("totalAvailable", total);
        if (nextId == null) {
            o.add("continuation", JsonNull.INSTANCE);
        } else {
            o.addProperty("continuation", nextId);
        }
        o.add("results", results);
        return o;
    }

    /** One result row. */
    static JsonObject node(TagPath parent, NodeDescription n) {
        String name = n.getName() == null ? "" : n.getName();
        TagPath full = n.getFullPath();
        String fullText;
        if (full != null && full.getSource() != null && !full.getSource().isEmpty()) {
            fullText = full.toStringFull();
        } else {
            List<String> parts = new ArrayList<>();
            for (int i = 0; i < parent.getPathLength(); i++) {
                parts.add(parent.getPathComponent(i));
            }
            parts.add(name);
            fullText = new BasicTagPath(parent.getSource(), parts).toStringFull();
        }
        TagObjectType type = n.getObjectType();
        DataType dt = n.getDataType();
        JsonObject r = new JsonObject();
        r.addProperty("name", name);
        r.addProperty("path", fullText);
        r.addProperty("type", type == null ? TagObjectType.Unknown.name() : type.name());
        if (dt == null) {
            r.add("dataType", JsonNull.INSTANCE);
        } else {
            r.addProperty("dataType", dt.name());
        }
        r.addProperty("hasChildren", n.hasChildren());
        r.addProperty("trendable", type == TagObjectType.AtomicTag && ChartOps.trendableType(dt));
        return r;
    }

    /** Bad browse quality → reply code. */
    static ErrorCode mapQuality(QualityCode q) {
        if (TagPaths.isAccessDenied(q)) {
            return ErrorCode.ACCESS_DENIED;
        }
        if (TagPaths.isNotFound(q)) {
            return ErrorCode.TAG_NOT_FOUND;
        }
        String n = q.getName() == null ? "" : q.getName().toLowerCase(Locale.ROOT);
        if (n.contains("denied") || n.contains("unauthorized")) {
            return ErrorCode.ACCESS_DENIED;
        }
        if (n.contains("notfound")) {
            return ErrorCode.TAG_NOT_FOUND;
        }
        return ErrorCode.INTERNAL;
    }

    /** Stores a continuation and returns its opaque id (LRU {@value #MAX_CONTINUATIONS}). */
    String remember(Continuation c) {
        byte[] b = new byte[12];
        RNG.nextBytes(b);
        String id = Base64.getUrlEncoder().withoutPadding().encodeToString(b);
        continuations.put(id, c);
        while (continuations.size() > MAX_CONTINUATIONS) {
            Iterator<String> it = continuations.keySet().iterator();
            it.next();
            it.remove();
        }
        return id;
    }

    /** Number of stored continuations (tests, diagnostics). */
    int continuationCount() {
        return continuations.size();
    }

    /** Diagnostics: id → path key. */
    Map<String, String> continuationPaths() {
        Map<String, String> out = new LinkedHashMap<>();
        continuations.forEach((k, v) -> out.put(k, v.pathKey));
        return out;
    }

    // =========================================================================================================
    // Recursive search (see the class comment)
    // =========================================================================================================

    /** A validated search request. Immutable. */
    static final class SearchRequest {
        final CallContext cc;
        final TagSearch.Query query;
        final TagPath start;          // null = every (non-denied) provider
        final String rawPath;         // as sent (re-checked against the root when a waiting search starts)
        final int limit;
        final Collection<String> providerNames;

        SearchRequest(CallContext cc, TagSearch.Query query, TagPath start, String rawPath, int limit,
                      Collection<String> providerNames) {
            this.cc = cc;
            this.query = query;
            this.start = start;
            this.rawPath = rawPath;
            this.limit = limit;
            this.providerNames = providerNames;
        }
    }

    /** The running search. Session queue only. */
    private static final class ActiveSearch {
        final SearchRequest req;
        final long generation;
        TagSearch.Run run;            // null while the permission pass runs (and before start() returned)
        String cancelled;             // STOP_CANCELLED / STOP_SUPERSEDED once cancelled

        ActiveSearch(SearchRequest req) {
            this.req = req;
            this.generation = req.cc.user().generation();
        }
    }

    /** The rows of the latest finished search. Immutable. */
    static final class SearchResults {
        final String pagingKey;
        final long generation;
        final TagPath start;
        final List<TagSearch.Match> matches;
        final TagSearch.Outcome outcome;
        final boolean wildcard;
        final long createdMs;

        SearchResults(String pagingKey, long generation, TagPath start, List<TagSearch.Match> matches, TagSearch.Outcome outcome,
                      boolean wildcard, long createdMs) {
            this.createdMs = createdMs;
            this.pagingKey = pagingKey;
            this.generation = generation;
            this.start = start;
            this.matches = matches;
            this.outcome = outcome;
            this.wildcard = wildcard;
        }
    }

    /** Paging key prefix of a search: path + normalized text (a continuation must come back with both). */
    static String searchKeyPrefix(TagPath start, TagSearch.Query q) {
        return "search\u0000" + (start == null ? "" : ReadScope.folderKey(start)) + "\u0000" + q.text() + "\u0000";
    }

    /** {@code chart.browse {path, search, continuation?, limit?}}. Completes {@code cc} exactly once. */
    private void search(CallContext cc, ChartOps.Host h, Collection<String> providerNames) {
        JsonObject b = cc.body();
        Optional<TagSearch.Query> q = TagSearch.Query.parse(Json.string(b, "search", null));
        String rawPath = Json.string(b, "path", "");
        String contId = b.has("continuation") && !b.get("continuation").isJsonNull() ? Json.string(b, "continuation", null) : "";
        if (q.isEmpty() || rawPath == null || contId == null) {
            fail(cc, h, ErrorCode.BAD_REQUEST, "search text/path/continuation");
            return;
        }
        int limit = (int) Math.max(1, Math.min(MAX_LIMIT, Json.integer(b, "limit", DEFAULT_LIMIT)));
        Target t = target(cc.props(), cc.user(), rawPath, h.defaultProvider(), h.scope());
        if (t.error != null) {
            fail(cc, h, t.error, "search target");
            return;
        }
        if (!h.scope().runtimePensAllowed()) {
            fail(cc, h, ErrorCode.OUT_OF_SCOPE, "search: no runtime pen can be added");
            return;
        }
        if (!contId.isEmpty()) {
            searchPage(cc, h, t, q.get(), contId, limit);
            return;
        }
        if (t.path != null && !providerKnown(providerNames, t.path.getSource())) {
            fail(cc, h, ErrorCode.TAG_NOT_FOUND, "search: unknown provider");
            return;
        }
        if (t.path == null && (providerNames == null || providerNames.isEmpty())) {
            h.warnings().warn("search.providers", "Tag search could not list the tag providers on " + h.describe(), null);
            cc.fail(ErrorCode.INTERNAL);
            return;
        }
        SearchRequest req = new SearchRequest(cc, q.get(), t.path, rawPath, limit,
            providerNames == null ? List.of() : List.copyOf(providerNames));
        TagSearchAdmission admission = TagSearchAdmission.of(h.services());
        if (active != null) {
            // this chart's previous search is still running: it is superseded and this one waits for it to wind down
            // (same ticket); only the rate of new searches is charged
            ErrorCode rate = admission.charge(h.sessionId());
            if (rate == ErrorCode.BUSY) {
                // Fairness: another session waits for a slot, so this chart does not keep its slot across a new
                // search — the old one (and a waiting one) is cancelled now; when its walk winds down the slot goes
                // back to the gateway and the waiting session gets it on its retry
                if (pending != null) {
                    SearchRequest p = pending;
                    pending = null;
                    replyStopped(p, TagSearch.STOP_SUPERSEDED);
                }
                cancelActive(TagSearch.STOP_SUPERSEDED);
                fail(cc, h, rate, "search admission (another session waits)");
                return;
            }
            if (rate != null) {
                fail(cc, h, rate, "search rate");
                return;
            }
            if (pending != null) {
                replyStopped(pending, TagSearch.STOP_SUPERSEDED);
            }
            pending = req;
            cancelActive(TagSearch.STOP_SUPERSEDED);
            return;
        }
        TagSearchAdmission.Admit admit = admission.tryAcquire(h.sessionId());
        if (admit.refusal() != null) {
            fail(cc, h, admit.refusal(), "search admission");
            return;
        }
        ticket = admit.ticket();
        startSearch(h, req);
    }

    /** The next page of the latest finished search (no new walk). */
    private void searchPage(CallContext cc, ChartOps.Host h, Target t, TagSearch.Query q, String contId, int limit) {
        Continuation c = continuations.get(contId);
        SearchResults r = last;
        if (c == null || r == null || !c.pathKey.equals(r.pagingKey) || !r.pagingKey.startsWith(searchKeyPrefix(t.path, q))) {
            fail(cc, h, ErrorCode.BAD_REQUEST, "search continuation");
            return;
        }
        if (r.generation != cc.user().generation()) {
            last = null;
            fail(cc, h, ErrorCode.AUTH_CHANGED, "search continuation of another user");
            return;
        }
        if (clock.getAsLong() - r.createdMs > SEARCH_RESULTS_TTL_MS) {
            last = null;
            fail(cc, h, ErrorCode.BAD_REQUEST, "search results expired");
            return;
        }
        cc.reply(resultsPage(r, c.offset, limit, h.scope()));
    }

    /** {@code {cancelSearch:true}} → {@code {cancelled}}: stops this chart's running (and waiting) search. */
    private void cancelSearch(CallContext cc, ChartOps.Host h) {
        boolean any = active != null || pending != null;
        if (pending != null) {
            SearchRequest p = pending;
            pending = null;
            replyStopped(p, TagSearch.STOP_CANCELLED);
        }
        if (active != null) {
            cancelActive(TagSearch.STOP_CANCELLED);
        }
        h.logger().debugf("chart.browse search cancel on %s: %s", h.describe(), any ? "cancelled" : "nothing running");
        JsonObject o = new JsonObject();
        o.addProperty("cancelled", any);
        cc.reply(o);
    }

    /** Starts the walk of {@code req}; {@link #ticket} is held. Session queue. */
    private void startSearch(ChartOps.Host h, SearchRequest req) {
        List<TagPath> starts = new ArrayList<>();
        if (req.start != null) {
            starts.add(req.start);
        } else {
            List<String> names = new ArrayList<>(req.providerNames);
            names.sort(String.CASE_INSENSITIVE_ORDER);
            for (String n : names) {
                if (n != null && !n.isBlank() && !h.scope().providerDenied("[" + n.toLowerCase(Locale.ROOT) + "]")) {
                    starts.add(new BasicTagPath(n, List.of()));
                }
            }
        }
        ActiveSearch a = new ActiveSearch(req);
        active = a;
        UserContext user = req.cc.user();
        TagSearch.Port port = new TagSearch.Port() {
            @Override
            public CompletableFuture<Results<NodeDescription>> browse(TagPath folder, BrowseFilter filter) {
                return h.tagManager().browseAsync(folder, filter, user.securityContext());
            }

            @Override
            public <T> void hop(CompletableFuture<T> f, long timeoutMs, BiConsumer<T, Throwable> cb) {
                h.onQueue(f, timeoutMs, cb);
            }

            @Override
            public long readTimeoutMs() {
                return h.services().settings().get().readTimeoutMs();
            }

            @Override
            public LongSupplier clock() {
                return clock;
            }
        };
        TagSearch.Run run = TagSearch.Run.start(port, req.query, TagSearch.Region.of(h.scope()), searchLimits, starts,
            outcome -> walked(h, a, outcome));
        if (active == a && !run.finished()) {
            a.run = run;
            if (a.cancelled != null) {
                run.cancel(a.cancelled);
            }
        }
    }

    /** Cancels the running search (walk or permission pass); its request is answered with no rows. */
    private void cancelActive(String why) {
        ActiveSearch a = active;
        if (a == null || a.cancelled != null) {
            return;
        }
        a.cancelled = why;
        if (a.run != null) {
            a.run.cancel(why);   // may finish synchronously → walked()
        }
    }

    /** The walk ended: permission pass (unless cancelled). Session queue. */
    private void walked(ChartOps.Host h, ActiveSearch a, TagSearch.Outcome outcome) {
        if (active != a) {
            return;
        }
        a.run = null;
        if (a.cancelled != null) {
            ended(h, a, null, a.cancelled);
            return;
        }
        if (outcome.matches().isEmpty()) {
            ended(h, a, outcome, null);
            return;
        }
        List<TagPath> paths = new ArrayList<>(outcome.matches().size());
        for (TagSearch.Match m : outcome.matches()) {
            paths.add(m.path());
        }
        CompletableFuture<List<QualifiedValue>> read;
        try {
            read = h.tagManager().readAsync(paths, a.req.cc.user().securityContext());
        } catch (RuntimeException e) {
            read = CompletableFuture.failedFuture(e);
        }
        h.onQueue(read, h.services().settings().get().readTimeoutMs(), (values, err) -> {
            if (active != a) {
                return;
            }
            if (a.cancelled != null) {
                ended(h, a, null, a.cancelled);
                return;
            }
            if (err != null || values == null || values.size() != paths.size()) {
                // fail closed: unchecked matches are never sent
                h.logger().debugf("chart.browse search permission pass failed on %s: %s", h.describe(),
                    err == null ? "short result" : err.toString());
                a.req.cc.fail(err instanceof TimeoutException || err == null ? ErrorCode.TIMEOUT : ErrorCode.INTERNAL);
                ended(h, a, null, null);
                return;
            }
            ended(h, a, outcome.withMatches(readable(outcome.matches(), values)), null);
        });
    }

    /** The matches whose read did not come back access-denied or not-found (same order). */
    static List<TagSearch.Match> readable(List<TagSearch.Match> matches, List<QualifiedValue> values) {
        List<TagSearch.Match> kept = new ArrayList<>(matches.size());
        for (int i = 0; i < matches.size(); i++) {
            QualifiedValue v = values.get(i);
            QualityCode q = v == null ? null : v.getQuality();
            if (q == null || TagPaths.isAccessDenied(q) || TagPaths.isNotFound(q)) {
                continue;
            }
            kept.add(matches.get(i));
        }
        return kept;
    }

    /**
     * A search ended — finished ({@code outcome}), cancelled ({@code stoppedWhy}), or failed and already answered
     * (both null): answers it, then starts the waiting search or returns the ticket.
     */
    private void ended(ChartOps.Host h, ActiveSearch a, TagSearch.Outcome outcome, String stoppedWhy) {
        active = null;
        if (stoppedWhy != null) {
            replyStopped(a.req, stoppedWhy);
        } else if (outcome != null) {
            finishSearch(h, a, outcome);
        }
        SearchRequest next = pending;
        pending = null;
        if (next == null) {
            releaseTicket();
            return;
        }
        // the waiting search was checked at receipt; the user and the gate must still be the ones it was checked against
        Target again = target(h.props(), h.user(), next.rawPath, h.defaultProvider(), h.scope());
        if (h.user().generation() != next.cc.user().generation()) {
            fail(next.cc, h, ErrorCode.AUTH_CHANGED, "waiting search: auth changed");
            releaseTicket();
        } else if (again.error != null) {
            fail(next.cc, h, again.error, "waiting search target");
            releaseTicket();
        } else if (!sameStart(again.path, next.start)) {
            // the trusted rootPath changed while it waited: "" now means another folder; never walk the old one
            fail(next.cc, h, ErrorCode.BROWSE_ROOT_VIOLATION, "waiting search: root changed");
            releaseTicket();
        } else if (!h.scope().runtimePensAllowed()) {
            fail(next.cc, h, ErrorCode.OUT_OF_SCOPE, "waiting search: no runtime pen can be added");
            releaseTicket();
        } else {
            startSearch(h, next);
        }
    }

    /** True when two search starts are the same folder (null = every provider). */
    static boolean sameStart(TagPath a, TagPath b) {
        if (a == null || b == null) {
            return a == b;
        }
        return ReadScope.folderKey(a).equals(ReadScope.folderKey(b));
    }

    /** True when a match lies below the folder its search started in (always, unless the provider misbehaved). */
    static boolean below(TagSearch.Match m, TagPath start) {
        return start == null || ReadScope.isUnder(m.key(), ReadScope.folderKey(start));
    }

    /** Answers a finished search with its first page and keeps its rows for paging. */
    private void finishSearch(ChartOps.Host h, ActiveSearch a, TagSearch.Outcome outcome) {
        CallContext cc = a.req.cc;
        UserContext user = h.user();
        if (user.generation() != a.generation) {
            fail(cc, h, ErrorCode.AUTH_CHANGED, "search: auth changed");
            return;
        }
        Target again = target(h.props(), user, a.req.rawPath, h.defaultProvider(), h.scope());
        if (again.error != null) {
            fail(cc, h, again.error, "search target after walk");
            return;
        }
        if (!sameStart(again.path, a.req.start)) {
            // the trusted rootPath changed during the walk: what was found below the old root is not shown
            fail(cc, h, ErrorCode.BROWSE_ROOT_VIOLATION, "search: root changed during the walk");
            return;
        }
        ReadScope scope = h.scope();
        TagSearch.Region region = TagSearch.Region.of(scope);
        List<TagSearch.Match> kept = new ArrayList<>(outcome.matches().size());
        for (TagSearch.Match m : outcome.matches()) {
            // read scope of this moment + (defence in depth) below the start, i.e. inside tagBrowser.rootPath
            if (region.include(m.key()) && below(m, a.req.start)) {
                kept.add(m);
            }
        }
        searchSeq++;
        last = new SearchResults(searchKeyPrefix(a.req.start, a.req.query) + searchSeq, a.generation, a.req.start,
            List.copyOf(kept), outcome, a.req.query.wildcard(), clock.getAsLong());
        h.logger().debugf("chart.browse search on %s: %d matches (%d before the permission/scope pass), %d folder pages, %d rows, "
                + "%d denied, %d failed, %d ms, stopped=%s", h.describe(), kept.size(), outcome.matches().size(), outcome.folders(),
            outcome.nodes(), outcome.denied(), outcome.failed(), outcome.elapsedMs(), outcome.stopped());
        cc.reply(resultsPage(last, 0, a.req.limit, scope));
    }

    /** One page of stored results, re-filtered by the current scope; the next page gets an opaque id. */
    JsonObject resultsPage(SearchResults r, int offset, int limit, ReadScope scope) {
        TagSearch.Region region = TagSearch.Region.of(scope);
        int from = Math.max(0, Math.min(offset, r.matches.size()));
        int to = Math.min(r.matches.size(), from + limit);
        JsonArray results = new JsonArray();
        for (int i = from; i < to; i++) {
            TagSearch.Match m = r.matches.get(i);
            if (region.include(m.key())) {
                results.add(matchRow(m));
            }
        }
        JsonObject o = new JsonObject();
        o.addProperty("path", r.start == null ? "" : ReadScope.folderLabel(r.start));
        o.addProperty("totalAvailable", r.matches.size());
        if (to < r.matches.size()) {
            o.addProperty("continuation", remember(new Continuation(r.pagingKey, null, to)));
        } else {
            o.add("continuation", JsonNull.INSTANCE);
        }
        o.add("results", results);
        o.add("search", searchInfo(r.outcome, r.matches.size(), r.wildcard, searchLimits));
        return o;
    }

    /** {@code search} member of a reply ({@code outcome} null = a search answered without a walk result). */
    static JsonObject searchInfo(TagSearch.Outcome outcome, int matches, boolean wildcard, TagSearch.Limits limits) {
        JsonObject s = new JsonObject();
        s.addProperty("complete", outcome != null && outcome.complete());
        if (outcome == null || outcome.stopped() == null) {
            s.add("stopped", JsonNull.INSTANCE);
        } else {
            s.addProperty("stopped", outcome.stopped());
        }
        s.addProperty("matches", matches);
        s.addProperty("folders", outcome == null ? 0 : outcome.folders());
        s.addProperty("nodes", outcome == null ? 0 : outcome.nodes());
        s.addProperty("denied", outcome == null ? 0 : outcome.denied());
        s.addProperty("failed", outcome == null ? 0 : outcome.failed());
        s.addProperty("elapsedMs", outcome == null ? 0 : outcome.elapsedMs());
        s.addProperty("maxResults", limits.maxResults());
        s.addProperty("timeBudgetMs", limits.timeBudgetMs());
        s.addProperty("wildcard", wildcard);
        return s;
    }

    /** A result row: the browse row shape plus the tag's folder. */
    static JsonObject matchRow(TagSearch.Match m) {
        JsonObject r = new JsonObject();
        r.addProperty("name", m.name());
        r.addProperty("path", m.label());
        r.addProperty("type", TagObjectType.AtomicTag.name());
        if (m.dataType() == null) {
            r.add("dataType", JsonNull.INSTANCE);
        } else {
            r.addProperty("dataType", m.dataType().name());
        }
        r.addProperty("hasChildren", false);
        r.addProperty("trendable", m.trendable());
        r.addProperty("folder", m.folderLabel());
        return r;
    }

    /** Answers a cancelled / superseded search: no rows (its matches never passed the permission pass). */
    private void replyStopped(SearchRequest req, String why) {
        JsonObject o = new JsonObject();
        o.addProperty("path", req.start == null ? "" : ReadScope.folderLabel(req.start));
        o.addProperty("totalAvailable", 0);
        o.add("continuation", JsonNull.INSTANCE);
        o.add("results", new JsonArray());
        JsonObject s = searchInfo(null, 0, req.query.wildcard(), searchLimits);
        s.addProperty("stopped", why);
        o.add("search", s);
        if (!req.cc.isDone()) {
            req.cc.reply(o);
        }
    }

    private void releaseTicket() {
        TagSearchAdmission.Ticket t = ticket;
        ticket = null;
        if (t != null) {
            t.release();
        }
    }

    /**
     * Delegate teardown (session queue, or after the queue stopped running callbacks): drops the running and the
     * waiting search without answering (the page is gone) and returns the admission ticket.
     */
    public void stop() {
        ActiveSearch a = active;
        active = null;
        pending = null;
        last = null;
        if (a != null) {
            a.cancelled = TagSearch.STOP_CANCELLED;
            if (a.run != null) {
                a.run.cancel(TagSearch.STOP_CANCELLED);
            }
        }
        releaseTicket();
    }

    /**
     * The session user changed (session queue): nothing found with the previous user's context may reach the client.
     * The running and the waiting search are answered {@code AUTH_CHANGED} now (instead of when their walk ends), the
     * stored results are dropped and the ticket is returned.
     */
    public void authChanged() {
        ActiveSearch a = active;
        SearchRequest p = pending;
        active = null;
        pending = null;
        last = null;
        if (a != null) {
            a.cancelled = TagSearch.STOP_CANCELLED;
            if (a.run != null) {
                a.run.cancel(TagSearch.STOP_CANCELLED);
            }
            if (!a.req.cc.isDone()) {
                a.req.cc.fail(ErrorCode.AUTH_CHANGED);
            }
        }
        if (p != null && !p.cc.isDone()) {
            p.cc.fail(ErrorCode.AUTH_CHANGED);
        }
        releaseTicket();
    }

    /** True while a search runs or waits (tests, diagnostics). */
    boolean searchBusy() {
        return active != null || pending != null;
    }

    private static void fail(CallContext cc, ChartOps.Host h, ErrorCode code, String where) {
        h.logger().debugf("chart.browse %s refused: %s on %s", where, code, h.describe());
        cc.fail(code);
    }
}
