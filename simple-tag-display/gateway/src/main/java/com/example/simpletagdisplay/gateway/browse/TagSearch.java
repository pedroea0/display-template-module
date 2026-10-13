package com.example.simpletagdisplay.gateway.browse;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.Deque;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeoutException;
import java.util.function.BiConsumer;
import java.util.function.Consumer;
import java.util.function.LongSupplier;

import com.example.simpletagdisplay.gateway.ops.ChartOps;
import com.example.simpletagdisplay.gateway.security.ReadScope;
import com.example.simpletagdisplay.gateway.tags.TagPaths;
import com.inductiveautomation.ignition.common.browsing.BrowseFilter;
import com.inductiveautomation.ignition.common.browsing.Results;
import com.inductiveautomation.ignition.common.model.values.QualityCode;
import com.inductiveautomation.ignition.common.sqltags.model.types.DataType;
import com.inductiveautomation.ignition.common.tags.browsing.NodeDescription;
import com.inductiveautomation.ignition.common.tags.config.types.TagObjectType;
import com.inductiveautomation.ignition.common.tags.model.TagPath;
import com.inductiveautomation.ignition.common.tags.paths.BasicTagPath;

/**
 * Recursive tag search for the chart's tag browser ("Search all folders"): the traversal engine,
 * independent of the delegate so JUnit can drive it with a fake tag tree. {@link TagBrowseService} owns the request,
 * the admission and the reply.
 *
 * <h2>Why a traversal of ordinary browses</h2>
 * The search walks the tree breadth-first with the SAME call the tree browse uses —
 * {@code browseAsync(folder, filter, user.securityContext())}, one folder page at a time — instead of a provider-side
 * recursive browse or a tag query. Every bound is then ours to enforce (a recursive provider browse can only be
 * capped by result count, not by time or depth), and the search can never see a node the user could not reach by
 * expanding folders one by one: a folder the provider refuses for this user (bad result quality) is skipped, not
 * reported. {@link TagBrowseService} additionally reads every match with the user's context at the end and drops
 * the tags the user may not read.
 *
 * <h2>What matches</h2>
 * Only tags ({@code AtomicTag}) are results. A tag matches when the query matches its <b>name</b> or its <b>path
 * below the folder the search starts in</b> ({@code Area1/Pump101/Speed} when the search starts in
 * {@code [default]}), so a UDT instance or folder name finds the tags inside it. Case-insensitive
 * ({@link Locale#ROOT}). Two modes ({@link Query}):
 * <ul>
 *   <li><b>contains</b> (default): substring of the name or the path;</li>
 *   <li><b>wildcard</b> (the text holds {@code *} or {@code ?}): the pattern must match the WHOLE name or the WHOLE
 *       path; {@code *} = any run of characters (including {@code /}), {@code ?} = one character. Matched by a
 *       linear backtracking matcher ({@link #glob}), never a regular expression, so a crafted pattern cannot cost
 *       more than O(pattern × text).</li>
 * </ul>
 *
 * <h2>Bounds ({@link Limits}; the defaults are constants in 2.0.0, not module settings)</h2>
 * <pre>
 *   maxDepth     16       folder levels below the start (deeper folders are not opened → stopped "depth")
 *   maxNodes     50 000   browse rows inspected                                         → stopped "nodes"
 *   maxFolders   5 000    browse calls (folder pages)                                   → stopped "folders"
 *   maxResults   1 000    matches kept                                                  → stopped "results"
 *   timeBudget   5 000 ms wall clock; every browse call times out at the budget's end  → stopped "time"
 *   parallel     4        browse calls in flight per search
 *   pageSize     500      maxResults of each browse call (provider continuation followed)
 * </pre>
 * A search that hit no bound and had no failed folder is {@code complete}. After a time or folder-call stop the pages
 * already in flight are still read (they are paid for); after a results, rows or cancel stop they are dropped.
 * Folders the provider denies are counted
 * ({@code denied}) but do not make it incomplete (the user may not see them anyway).
 *
 * <h2>Region</h2>
 * {@link Region} prunes the walk: a folder is opened only when it can contain a tag inside the read scope (it lies
 * below a scope root, or is an ancestor of one), and a tag is a result only when the scope's runtime rule allows it
 * ({@link ReadScope#runtimeRule}: roots + {@code ctg.read.deniedProviders}). The {@code _types_} folder of a
 * provider (UDT definitions — not real tags) is never opened.
 *
 * <h2>Threading</h2>
 * A {@link Run} is confined to one thread at a time: every browse completion continues through
 * {@link Port#hop} (the delegate's session queue), so the counters and the work queue need no lock.
 * {@link Run#cancel} must be called on that same queue (the delegate's stop also runs there or after the queue
 * stopped running callbacks).
 */
public final class TagSearch {

    /** Folder name of a provider's UDT definitions (never searched). */
    static final String TYPES_FOLDER = "_types_";

    /** Stop reasons ({@code search.stopped} in the reply). */
    public static final String STOP_RESULTS = "results";
    public static final String STOP_NODES = "nodes";
    public static final String STOP_FOLDERS = "folders";
    public static final String STOP_DEPTH = "depth";
    public static final String STOP_TIME = "time";
    public static final String STOP_ERRORS = "errors";
    public static final String STOP_CANCELLED = "cancelled";
    public static final String STOP_SUPERSEDED = "superseded";

    private TagSearch() {
    }

    // =========================================================================================================
    // Limits
    // =========================================================================================================

    /** The bounds of one search. Immutable. */
    public static final class Limits {
        final int maxDepth;
        final int maxNodes;
        final int maxFolders;
        final int maxResults;
        final long timeBudgetMs;
        final int parallel;
        final int pageSize;

        public Limits(int maxDepth, int maxNodes, int maxFolders, int maxResults, long timeBudgetMs, int parallel, int pageSize) {
            if (maxDepth < 0 || maxNodes < 1 || maxFolders < 1 || maxResults < 1 || timeBudgetMs < 1 || parallel < 1 || pageSize < 1) {
                throw new IllegalArgumentException("search limits must be positive");
            }
            this.maxDepth = maxDepth;
            this.maxNodes = maxNodes;
            this.maxFolders = maxFolders;
            this.maxResults = maxResults;
            this.timeBudgetMs = timeBudgetMs;
            this.parallel = parallel;
            this.pageSize = pageSize;
        }

        public int maxResults() {
            return maxResults;
        }

        public long timeBudgetMs() {
            return timeBudgetMs;
        }

        @Override
        public String toString() {
            return "depth " + maxDepth + ", nodes " + maxNodes + ", folders " + maxFolders + ", results " + maxResults + ", "
                + timeBudgetMs + " ms, parallel " + parallel + ", page " + pageSize;
        }
    }

    /** Shipped bounds (see the class comment). */
    public static final Limits DEFAULT_LIMITS = new Limits(16, 50_000, 5_000, 1_000, 5_000L, 4, 500);

    // =========================================================================================================
    // Query
    // =========================================================================================================

    /** A parsed search text. Immutable. */
    public static final class Query {
        /** Longest accepted text (characters). */
        public static final int MAX_LENGTH = 64;

        final String text;        // lower-cased, trimmed
        final boolean wildcard;

        private Query(String text, boolean wildcard) {
            this.text = text;
            this.wildcard = wildcard;
        }

        /**
         * Parses the client's text: trimmed, 1..{@value #MAX_LENGTH} characters, no control characters, at least one
         * character that is not {@code *}, {@code ?} or white space (a bare {@code *} would list everything). Empty
         * when invalid.
         */
        public static Optional<Query> parse(String raw) {
            if (raw == null) {
                return Optional.empty();
            }
            String s = raw.trim();
            if (s.isEmpty() || s.length() > MAX_LENGTH) {
                return Optional.empty();
            }
            boolean wild = false;
            boolean literal = false;
            for (int i = 0; i < s.length(); i++) {
                char c = s.charAt(i);
                if (Character.isISOControl(c) || c == 0x2028 || c == 0x2029) {   // + the Unicode line/paragraph separators
                    return Optional.empty();
                }
                if (c == '*' || c == '?') {
                    wild = true;
                } else if (!Character.isWhitespace(c)) {
                    literal = true;
                }
            }
            if (!literal) {
                return Optional.empty();
            }
            return Optional.of(new Query(s.toLowerCase(Locale.ROOT), wild));
        }

        /** Normalized text (lower case) — part of a paging key, never logged. */
        public String text() {
            return text;
        }

        public boolean wildcard() {
            return wildcard;
        }

        /** True when the query matches a lower-cased name or lower-cased relative path. */
        public boolean matches(String nameLc, String relPathLc) {
            if (wildcard) {
                return glob(text, nameLc) || glob(text, relPathLc);
            }
            return nameLc.contains(text) || relPathLc.contains(text);
        }
    }

    /**
     * Wildcard match of the whole {@code text}: {@code *} any run (also empty), {@code ?} exactly one character,
     * everything else literal. Iterative with a single backtrack point (the last star), O(pattern × text) in the worst
     * case — no regular expression, so no catastrophic backtracking.
     */
    static boolean glob(String pattern, String text) {
        int p = 0;
        int t = 0;
        int star = -1;
        int mark = 0;
        while (t < text.length()) {
            if (p < pattern.length() && (pattern.charAt(p) == '?' || pattern.charAt(p) == text.charAt(t))) {
                p++;
                t++;
            } else if (p < pattern.length() && pattern.charAt(p) == '*') {
                star = p++;
                mark = t;
            } else if (star >= 0) {
                p = star + 1;
                t = ++mark;
            } else {
                return false;
            }
        }
        while (p < pattern.length() && pattern.charAt(p) == '*') {
            p++;
        }
        return p == pattern.length();
    }

    // =========================================================================================================
    // Ports
    // =========================================================================================================

    /** What a run needs from its delegate. */
    public interface Port {
        /** One browse page with the user's security context. May throw; may complete exceptionally. */
        CompletableFuture<Results<NodeDescription>> browse(TagPath folder, BrowseFilter filter);

        /**
         * Continues with {@code cb} on the run's thread (the session queue) when {@code f} completes or after
         * {@code timeoutMs} (then with a {@link TimeoutException}); at most once, and not at all once the delegate
         * stopped.
         */
        <T> void hop(CompletableFuture<T> f, long timeoutMs, BiConsumer<T, Throwable> cb);

        /** Upper bound of a single browse call (ctg.read.timeoutMs). */
        long readTimeoutMs();

        /** Millisecond clock. */
        LongSupplier clock();
    }

    /** Which folders are opened and which tags may be results (normalized keys). */
    public interface Region {
        boolean descend(String folderKey);

        boolean include(String tagKey);

        /** The read-scope region below a start: see the class comment. */
        static Region of(ReadScope scope) {
            return new Region() {
                @Override
                public boolean descend(String folderKey) {
                    if (scope.providerDenied(folderKey)) {
                        return false;
                    }
                    if (scope.allRoots()) {
                        return true;
                    }
                    for (String root : scope.rootKeys()) {
                        // inside a root, or on the way down to one
                        if (ReadScope.isUnder(folderKey, root) || isAncestor(folderKey, root)) {
                            return true;
                        }
                    }
                    return false;
                }

                @Override
                public boolean include(String tagKey) {
                    return scope.runtimeRule(tagKey);
                }
            };
        }
    }

    /** True when folder {@code folderKey} contains {@code rootKey} (strictly or equal). */
    static boolean isAncestor(String folderKey, String rootKey) {
        if (folderKey.endsWith("]")) {
            return rootKey.startsWith(folderKey);
        }
        return TagPaths.isUnder(rootKey, folderKey);
    }

    // =========================================================================================================
    // Results
    // =========================================================================================================

    /** One matching tag. Immutable. */
    public static final class Match {
        final TagPath path;
        final String key;
        final String label;
        final String name;
        final String folderLabel;
        final DataType dataType;
        final boolean trendable;

        Match(TagPath path, String name, String folderLabel, DataType dataType) {
            this.path = path;
            this.key = TagPaths.normalizedKey(path);
            this.label = path.toStringFull();
            this.name = name;
            this.folderLabel = folderLabel;
            this.dataType = dataType;
            this.trendable = ChartOps.trendableType(dataType);
        }

        public TagPath path() {
            return path;
        }

        public String key() {
            return key;
        }

        public String label() {
            return label;
        }

        public String name() {
            return name;
        }

        public String folderLabel() {
            return folderLabel;
        }

        public DataType dataType() {
            return dataType;
        }

        public boolean trendable() {
            return trendable;
        }
    }

    /** How a run ended. Immutable. */
    public static final class Outcome {
        final List<Match> matches;
        final String stopped;
        final int folders;
        final int nodes;
        final int denied;
        final int failed;
        final long elapsedMs;

        Outcome(List<Match> matches, String stopped, int folders, int nodes, int denied, int failed, long elapsedMs) {
            this.matches = matches;
            this.stopped = stopped;
            this.folders = folders;
            this.nodes = nodes;
            this.denied = denied;
            this.failed = failed;
            this.elapsedMs = elapsedMs;
        }

        /** Matches sorted by path (case-insensitive). */
        public List<Match> matches() {
            return matches;
        }

        /** Why the search ended early ({@code STOP_*}), or null when it searched everything it could. */
        public String stopped() {
            return stopped;
        }

        public boolean complete() {
            return stopped == null;
        }

        public int folders() {
            return folders;
        }

        public int nodes() {
            return nodes;
        }

        public int denied() {
            return denied;
        }

        public int failed() {
            return failed;
        }

        public long elapsedMs() {
            return elapsedMs;
        }

        /** The same outcome with some matches removed (the permission pass). */
        Outcome withMatches(List<Match> kept) {
            return new Outcome(List.copyOf(kept), stopped, folders, nodes, denied, failed, elapsedMs);
        }
    }

    // =========================================================================================================
    // Run
    // =========================================================================================================

    /** One folder page to browse (a provider root has no path components). */
    private static final class Task {
        final TagPath folder;
        final String key;
        final String rel;          // lower-cased path below the start ("" for the start itself)
        final int depth;
        final String point;        // provider continuation point of a later page, or null

        Task(TagPath folder, String rel, int depth, String point) {
            this.folder = folder;
            this.key = ReadScope.folderKey(folder);
            this.rel = rel;
            this.depth = depth;
            this.point = point;
        }
    }

    /** One search. Create with {@link #start}; confined to the port's thread (see the class comment). */
    public static final class Run {
        private final Port port;
        private final Query query;
        private final Region region;
        private final Limits limits;
        private final Consumer<Outcome> done;
        private final long startedMs;
        private final long deadlineMs;

        private final Deque<Task> work = new ArrayDeque<>();
        private final List<Match> matches = new ArrayList<>();
        private int outstanding;
        private int folders;
        private int nodes;
        private int denied;
        private int failed;
        private boolean depthHit;
        private String stopped;
        private boolean finished;

        private Run(Port port, Query query, Region region, Limits limits, Consumer<Outcome> done) {
            this.port = port;
            this.query = query;
            this.region = region;
            this.limits = limits;
            this.done = done;
            this.startedMs = port.clock().getAsLong();
            this.deadlineMs = startedMs + limits.timeBudgetMs;
        }

        /**
         * Starts a search below {@code starts} (one folder, or every provider root of the provider list) and calls
         * {@code done} exactly once — unless the delegate stops first (then {@link Port#hop} drops the remaining
         * continuations and nothing is called).
         */
        public static Run start(Port port, Query query, Region region, Limits limits, Collection<TagPath> starts,
                                Consumer<Outcome> done) {
            Run r = new Run(port, query, region, limits, done);
            for (TagPath s : starts) {
                if (region.descend(ReadScope.folderKey(s))) {
                    r.work.add(new Task(s, "", 0, null));
                }
            }
            r.pump();
            return r;
        }

        /** Stops launching browses; the outcome follows once the calls in flight returned (or timed out). */
        public void cancel(String why) {
            if (finished) {
                return;
            }
            stop(why);
            pump();
        }

        public boolean finished() {
            return finished;
        }

        /** Launches browse calls while there is work, room and budget; finishes when nothing is left in flight. */
        private void pump() {
            while (stopped == null && outstanding < limits.parallel && !work.isEmpty()) {
                long now = port.clock().getAsLong();
                if (now >= deadlineMs) {
                    stop(STOP_TIME);
                    break;
                }
                if (folders >= limits.maxFolders) {
                    stop(STOP_FOLDERS);
                    break;
                }
                Task task = work.poll();
                folders++;
                outstanding++;
                BrowseFilter f = new BrowseFilter().setRecursive(false).setMaxResults(limits.pageSize);
                if (task.point != null) {
                    f.setContinuationPoint(task.point);
                }
                CompletableFuture<Results<NodeDescription>> future;
                try {
                    future = port.browse(task.folder, f);
                } catch (RuntimeException e) {
                    future = CompletableFuture.failedFuture(e);
                }
                if (future == null) {
                    future = CompletableFuture.failedFuture(new IllegalStateException("no browse result"));
                }
                long timeout = Math.max(1L, Math.min(port.readTimeoutMs(), deadlineMs - now));
                port.hop(future, timeout, (res, err) -> onPage(task, res, err));
            }
            if (outstanding == 0 && (stopped != null || work.isEmpty())) {
                finish();
            }
        }

        private void onPage(Task task, Results<NodeDescription> res, Throwable err) {
            outstanding--;
            if (finished) {
                return;
            }
            // after a "soft" stop (time, folder calls) the pages already paid for are still read; after a hard one
            // (results, rows, cancel) nothing more is
            if (stopped == null || STOP_TIME.equals(stopped) || STOP_FOLDERS.equals(stopped)) {
                if (err != null || res == null) {
                    failed++;
                    if (err instanceof TimeoutException && port.clock().getAsLong() >= deadlineMs) {
                        stop(STOP_TIME);
                    }
                } else {
                    QualityCode q = res.getResultQuality();
                    if (q != null && !q.isGood()) {
                        if (TagPaths.isAccessDenied(q) || TagPaths.isNotFound(q)) {
                            denied++;
                        } else {
                            failed++;
                        }
                    } else {
                        page(task, res);
                    }
                }
            }
            pump();
        }

        /** Inspects one page: matches, sub-folders to open, the provider's next page. */
        private void page(Task task, Results<NodeDescription> res) {
            Collection<NodeDescription> rows = res.getResults() == null ? List.of() : res.getResults();
            for (NodeDescription n : rows) {
                if (nodes >= limits.maxNodes) {
                    stop(STOP_NODES);
                    return;
                }
                if (matches.size() >= limits.maxResults) {
                    stop(STOP_RESULTS);   // (a page read after a soft stop must not grow the list past the cap either)
                    return;
                }
                nodes++;
                String name = n.getName();
                if (name == null || name.isEmpty()) {
                    continue;
                }
                TagObjectType type = n.getObjectType();
                TagPath child = canonicalChild(task.folder, n, name);
                String rel = (task.rel.isEmpty() ? "" : task.rel + "/") + name.toLowerCase(Locale.ROOT);
                if (type == TagObjectType.AtomicTag) {
                    if (query.matches(name.toLowerCase(Locale.ROOT), rel) && region.include(TagPaths.normalizedKey(child))) {
                        matches.add(new Match(child, name, ReadScope.folderLabel(parentOf(child, task.folder)), n.getDataType()));
                        if (matches.size() >= limits.maxResults) {
                            stop(STOP_RESULTS);
                            return;
                        }
                    }
                    continue;
                }
                if (!n.hasChildren() || !opens(type) || (task.folder.getPathLength() == 0 && TYPES_FOLDER.equalsIgnoreCase(name))) {
                    continue;
                }
                // the read scope first: a folder the scope prunes is never opened, so being too deep
                // is not a reason to report the search as incomplete ('depth')
                if (!region.descend(ReadScope.folderKey(child))) {
                    continue;
                }
                if (task.depth + 1 > limits.maxDepth) {
                    depthHit = true;
                    continue;
                }
                work.add(new Task(child, rel, task.depth + 1, null));
            }
            // Observed on 8.3.10: a provider returns a continuation point on its LAST (short) page too, so
            // only a full page is continued.
            String point = res.getContinuationPoint();
            if (point != null && !point.isEmpty() && rows.size() >= limits.pageSize) {
                work.addFirst(new Task(task.folder, task.rel, task.depth, point));
            }
        }

        private void stop(String why) {
            if (stopped == null) {
                stopped = why;
            }
        }

        private void finish() {
            if (finished) {
                return;
            }
            finished = true;
            String why = stopped;
            if (why == null && depthHit) {
                why = STOP_DEPTH;
            }
            if (why == null && failed > 0) {
                why = STOP_ERRORS;
            }
            List<Match> sorted = new ArrayList<>(matches);
            sorted.sort(Comparator.comparing((Match m) -> m.label, String.CASE_INSENSITIVE_ORDER).thenComparing(m -> m.label));
            done.accept(new Outcome(List.copyOf(sorted), why, folders, nodes, denied, failed,
                Math.max(0L, port.clock().getAsLong() - startedMs)));
        }
    }

    /** Object types whose children are searched: folders, UDT instances, providers. */
    static boolean opens(TagObjectType type) {
        return type == TagObjectType.Folder || type == TagObjectType.UdtInstance || type == TagObjectType.Provider;
    }

    /**
     * The child's path as the provider spells it: the casing of a start folder typed differently
     * ({@code [DEFAULT]ctg_search}) must not reach every hit and every pen added from the results. The provider's
     * {@link NodeDescription#getFullPath()} is used when it names the same tag (same normalized key as
     * {@code folder/name}, so it can only change the spelling, never the place); otherwise {@link #childOf}.
     * {@link TagBrowseService#node} does the same for a plain browse.
     */
    static TagPath canonicalChild(TagPath folder, NodeDescription n, String name) {
        TagPath built = childOf(folder, name);
        TagPath full = n.getFullPath();
        if (full == null || full.getSource() == null || full.getSource().isEmpty()) {
            return built;
        }
        try {
            return TagPaths.normalizedKey(full).equals(TagPaths.normalizedKey(built)) ? full : built;
        } catch (RuntimeException e) {
            return built;
        }
    }

    /** The folder of a (canonical) child path; {@code fallback} when it has no usable parent. */
    static TagPath parentOf(TagPath child, TagPath fallback) {
        if (child.getPathLength() < 1) {
            return fallback;
        }
        List<String> parts = new ArrayList<>(child.getPathLength() - 1);
        for (int i = 0; i < child.getPathLength() - 1; i++) {
            parts.add(child.getPathComponent(i));
        }
        return new BasicTagPath(child.getSource(), parts);
    }

    /** {@code folder/name} as a full tag path (provider kept). */
    static TagPath childOf(TagPath folder, String name) {
        List<String> parts = new ArrayList<>(folder.getPathLength() + 1);
        for (int i = 0; i < folder.getPathLength(); i++) {
            parts.add(folder.getPathComponent(i));
        }
        parts.add(name);
        return new BasicTagPath(folder.getSource(), parts);
    }
}
