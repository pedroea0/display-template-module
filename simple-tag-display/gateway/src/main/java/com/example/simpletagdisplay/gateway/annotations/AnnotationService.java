package com.example.simpletagdisplay.gateway.annotations;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;
import java.util.regex.Pattern;

import com.example.simpletagdisplay.gateway.GatewayServices;
import com.example.simpletagdisplay.gateway.security.UserContext;
import com.example.simpletagdisplay.gateway.util.Json;
import com.example.simpletagdisplay.gateway.util.NamedThreadFactory;
import com.example.simpletagdisplay.gateway.util.RateLimitedLog;
import com.inductiveautomation.ignition.common.QualifiedPath;
import com.inductiveautomation.ignition.common.gson.JsonElement;
import com.inductiveautomation.ignition.common.gson.JsonObject;
import com.inductiveautomation.ignition.common.gson.JsonParser;
import com.inductiveautomation.ignition.common.model.values.QualifiedValue;
import com.inductiveautomation.ignition.common.model.values.QualityCode;
import com.inductiveautomation.ignition.common.sqltags.history.annotations.Annotation;
import com.inductiveautomation.ignition.common.sqltags.history.annotations.TypeFilter;
import com.inductiveautomation.ignition.common.tags.model.TagPath;
import com.inductiveautomation.ignition.common.util.LoggerEx;
import com.inductiveautomation.ignition.gateway.historian.TagHistoryManager;

/**
 * Historian annotations (notes and ranges) of the Click To Graph Chart. One module-wide instance
 * ({@code GatewayServices.shared}), used by the history route (queries) and the chart delegate
 * ({@code ops/AnnotationOps}: saves, deletes).
 *
 * <h2>What the platform does (as observed on Ignition 8.3.10 with the Core Historian)</h2>
 * <ul>
 *   <li>{@code TagHistoryManager.storeAnnotations} stores asynchronously: an entry becomes visible to
 *       {@code queryAnnotations} about 0.3 s later (up to about 1 s), a delete about 0.3 s later.</li>
 *   <li>Storing an existing entry again (same {@code storageId}) does not replace it: both <em>versions</em> are
 *       returned by later queries, oldest first. {@link Annotation#getLastUpdated()} stays null on Core Historian. So
 *       an edit is "delete every version, store the new text under a new id", and the query collapses versions
 *       ({@link #collapse}) in case another tool appended one.</li>
 *   <li>The query matches entries whose <b>start</b> lies in {@code [from, to]}: a range that began before the window
 *       is not returned. Queries therefore look back {@link #queryFrom one window length} (1 h … 31 d) and the result
 *       is filtered per pen to what overlaps the pen's window ({@link #forWindow}).</li>
 *   <li>The query accepts the plain tag path ({@code [default]CTG/Temp}) and echoes each queried path (case included)
 *       in the results, so a multi-path query is attributed back to its pens ({@link #keyOf}).</li>
 *   <li>The store answers one {@link QualifiedValue} per entry; a tag without history gives
 *       {@code Error_Configuration("History provider '…' not found")}. Unknown providers make queries return nothing,
 *       not throw. The historian records no author: the author is stored by us inside {@code data} (JSON, built on the
 *       gateway from the session user, never from the client).</li>
 * </ul>
 *
 * <h2>Capability per historian ({@link #status})</h2>
 * A historian that throws {@link UnsupportedOperationException} (or an exception that says annotations are "not supported"; {@link #looksUnsupported}) from
 * {@code queryAnnotations}/{@code storeAnnotations} is remembered as {@code unsupported} for {@value #UNSUPPORTED_TTL_MS}
 * ms: its pens answer {@code annotationsStatus:"unsupported"}, saves {@code ANNOTATIONS_UNSUPPORTED}, and the chart's
 * capability says so (annotate button hidden). Any other failure is {@code error} for {@value #ERROR_TTL_MS} ms (one
 * rate-limited WARN; a broken historian is not hammered by every refresh of every chart).
 *
 * <h2>Data JSON</h2>
 * {@code {"v":1,"text":"…","author":"engineer","authorSource":"default","color":null|"#RRGGBB","created":<ms>}}, plus
 * {@code editedBy}/{@code edited} after an edit (the author stays the original author, so moderation keeps the
 * attribution). {@code authorSource} is the author's identity provider ({@code session.props.auth.idp}); it is left
 * out when Perspective reports none (Designer). Ownership compares the source <em>and</em> the name: the same
 * user name from two identity providers is two people. An entry without {@code authorSource} belongs only to a user
 * without one. Data written by other tools that is not this JSON is shown as text with the author unknown and is never
 * "own".
 *
 * <h2>Threads</h2>
 * Queries run on the caller's thread (the history route runs them as tasks of the fair history executor). Stores and
 * the id lookups of edits/deletes run on the single {@code ctg-annotations} thread (bounded queue; a full queue
 * refuses with {@link RejectedExecutionException}, which the delegate answers {@code BUSY}). The per-session quota
 * ({@code ctg.annotations.maxPerSessionPerHour}) is a sliding hour of save timestamps, dropped when the session ends
 * (not on a user change: logging out and in again does not give a session a fresh hour).
 *
 * <h2>One change per entry at a time ({@link #claim})</h2>
 * An edit or delete looks the entry's versions up, then stores their deletion (+ the new entry). Storage is
 * asynchronous (~0.3 s), so two edits of the same id that both look up before either store is visible would both
 * "replace" it and leave two copies (two tabs, a double submit). The delegate therefore claims the
 * id before its store: a second change of an id whose store is still in flight is refused {@code BUSY}, and for
 * {@value #REPLACED_TTL_MS} ms after a successful store (well past the moment the historian shows the deletion) an id
 * that was replaced or deleted answers {@code ANNOTATION_NOT_FOUND}. Module-wide, so it holds across sessions. Each
 * claim carries a token and is settled by compare-and-remove ({@link #settle}), so the late answer of a store that
 * outlived the claim's safety bound never touches a newer claim of the same id.
 */
public final class AnnotationService implements AutoCloseable {

    private static final LoggerEx LOG = LoggerEx.newBuilder().build("SimpleTagDisplay.Annotations");

    public static final String TYPE_NOTE = "note";
    public static final String TYPE_RANGE = "range";
    /** Types this module stores and queries (request allow-list and {@code TypeFilter.custom}). */
    public static final List<String> TYPES = List.of(TYPE_NOTE, TYPE_RANGE);

    public static final String STATUS_OK = "ok";
    public static final String STATUS_UNSUPPORTED = "unsupported";
    public static final String STATUS_ERROR = "error";

    /** Longest note text after cleaning. */
    public static final int MAX_TEXT_CHARS = 1000;
    /** Text characters in the audit value. */
    public static final int AUDIT_TEXT_CHARS = 200;
    /** {@code color}: empty or {@code #RRGGBB}. */
    public static final Pattern COLOR = Pattern.compile("^(#[0-9A-Fa-f]{6})?$");

    static final long UNSUPPORTED_TTL_MS = 600_000L;
    static final long ERROR_TTL_MS = 30_000L;
    static final long HOUR_MS = 3_600_000L;
    static final long DAY_MS = 24 * HOUR_MS;
    static final long LOOKBACK_MIN_MS = HOUR_MS;
    static final long LOOKBACK_MAX_MS = 31 * DAY_MS;
    /** Search window around an entry's start when an edit/delete looks its versions up by id. */
    public static final long ID_SEARCH_MS = DAY_MS;
    static final long QUOTA_WINDOW_MS = HOUR_MS;
    static final int STORE_QUEUE = 64;
    /**
     * How long a replaced or deleted id is remembered after its store succeeded. Storage is asynchronous (~0.3 s); a
     * replaced id never comes back, so the TTL only bounds memory and must outlast a lookup that ran before the store.
     */
    static final long REPLACED_TTL_MS = 60_000L;
    /** Safety bound of an in-flight claim (a store whose future never completes cannot lock an id for ever). */
    static final long CLAIM_MAX_MS = 120_000L;
    /** Claims kept before expired ones are pruned. */
    static final int CLAIMS_PRUNE_AT = 1_024;
    /** Most distinct providers remembered in the capability cache (bounded whatever providers are named). */
    static final int MAX_PROVIDERS = 256;
    private static final char LINE_SEP = (char) 0x2028;
    private static final char PARA_SEP = (char) 0x2029;

    private final RateLimitedLog warnings = new RateLimitedLog(LOG, 60_000L);
    private final ConcurrentHashMap<String, Support> support = new ConcurrentHashMap<>();
    private final Map<UUID, ArrayDeque<Long>> quota = new HashMap<>();
    private final Map<UUID, Claim> claims = new HashMap<>();
    /** Last token handed out by {@link #claim} (guarded by {@code this}). */
    private long claimTokens;
    private final ThreadPoolExecutor storeExec = new ThreadPoolExecutor(1, 1, 60, TimeUnit.SECONDS,
        new ArrayBlockingQueue<>(STORE_QUEUE), new NamedThreadFactory("ctg-annotations"));

    public AnnotationService() {
        storeExec.allowCoreThreadTimeOut(true);
    }

    /**
     * The module-wide instance; its quota entries die with the session ({@code GatewayServices.onSessionEnd}) — not
     * on a user change, so a log-out/log-in does not reset the session's hour. Closed with the module.
     */
    public static AnnotationService of(GatewayServices services) {
        return services.shared(AnnotationService.class, () -> {
            AnnotationService a = new AnnotationService();
            services.onSessionEnd(a::evict);
            return a;
        });
    }

    // =========================================================================================================
    // Capability per historian
    // =========================================================================================================

    /** A remembered capability of one historian provider. */
    private static final class Support {
        final String status;
        final long until;

        Support(String status, long until) {
            this.status = status;
            this.until = until;
        }
    }

    /**
     * The remembered status of {@code provider} ({@link #STATUS_UNSUPPORTED}, {@link #STATUS_ERROR}) or null when
     * nothing (current) is known, i.e. annotations are expected to work.
     */
    public String status(String provider, long now) {
        if (provider == null) {
            return null;
        }
        Support s = support.get(provider.toLowerCase(Locale.ROOT));
        return s == null || s.until <= now ? null : s.status;
    }

    /** True while {@code provider} is known not to support annotations. */
    public boolean unsupported(String provider) {
        return STATUS_UNSUPPORTED.equals(status(provider, System.currentTimeMillis()));
    }

    /** Remembers a failure of {@code provider} ({@code unsupported}: 10 min, {@code error}: 30 s). */
    void remember(String provider, String status, long now) {
        if (provider == null) {
            return;
        }
        if (support.size() >= MAX_PROVIDERS) {
            support.entrySet().removeIf(e -> e.getValue().until <= now);
            if (support.size() >= MAX_PROVIDERS) {
                support.clear();
            }
        }
        long ttl = STATUS_UNSUPPORTED.equals(status) ? UNSUPPORTED_TTL_MS : ERROR_TTL_MS;
        support.put(provider.toLowerCase(Locale.ROOT), new Support(status, now + ttl));
    }

    /**
     * True when a historian failure means "annotations are not supported here" rather than a transient error: an
     * {@link UnsupportedOperationException} or {@link AbstractMethodError} in the cause chain, or a message that says
     * "not supported" / "unsupported" / "not implemented" <b>and</b> mentions annotations. A message match alone (a SQL
     * "Unsupported data type", say) is an ordinary error, which expires after 30 s instead of hiding annotations for
     * 10 minutes.
     */
    static boolean looksUnsupported(Throwable t) {
        int depth = 0;
        for (Throwable c = t; c != null && depth < 16; c = c.getCause() == c ? null : c.getCause(), depth++) {
            if (c instanceof UnsupportedOperationException || c instanceof AbstractMethodError) {
                return true;
            }
            String m = c.getMessage();
            if (m != null) {
                String l = m.toLowerCase(Locale.ROOT);
                if ((l.contains("not supported") || l.contains("unsupported") || l.contains("not implemented"))
                        && l.contains("annotation")) {
                    return true;
                }
            }
        }
        return false;
    }

    /** Records {@code t} for {@code provider} and returns the resulting status. */
    String failure(String provider, Throwable t, String where) {
        long now = System.currentTimeMillis();
        if (looksUnsupported(t)) {
            remember(provider, STATUS_UNSUPPORTED, now);
            LOG.debugf("annotations not supported by historian %s (%s)", Json.sanitizeForLog(provider), t.getClass().getSimpleName());
            return STATUS_UNSUPPORTED;
        }
        remember(provider, STATUS_ERROR, now);
        warnings.warn("annotations." + where, "Annotation " + where + " failed on historian "
            + Json.sanitizeForLog(provider) + " (annotations of its pens are skipped for " + ERROR_TTL_MS / 1000 + " s)", t);
        return STATUS_ERROR;
    }

    // =========================================================================================================
    // Entries and version collapse
    // =========================================================================================================

    /** One stored entry, as the module needs it (immutable). */
    public static final class Item {
        final String id;
        final String type;
        final long start;
        final Long end;
        final String data;
        final Long lastUpdated;
        final boolean deleted;

        public Item(String id, String type, long start, Long end, String data, Long lastUpdated, boolean deleted) {
            this.id = id;
            this.type = type;
            this.start = start;
            this.end = end;
            this.data = data;
            this.lastUpdated = lastUpdated;
            this.deleted = deleted;
        }

        /** The entry of a historian annotation; null when it has no start time. */
        static Item of(Annotation a) {
            Date s = a.getRangeStart();
            if (s == null) {
                return null;
            }
            Date e = a.getRangeEnd();
            Date lu = a.getLastUpdated();
            String type = a.getType() == null ? TYPE_NOTE : a.getType().toLowerCase(Locale.ROOT);
            return new Item(a.hasStorageId() ? a.getStorageId().toString() : null, type, s.getTime(),
                e == null ? null : e.getTime(), a.getData(), lu == null ? null : lu.getTime(), a.isDeleted());
        }

        public String id() {
            return id;
        }

        public String type() {
            return type;
        }

        public long start() {
            return start;
        }

        public Long end() {
            return end;
        }

        public String data() {
            return data;
        }

        /** Where the entry ends on the time axis (its start for a note). */
        long last() {
            return end != null && end > start ? end : start;
        }
    }

    /**
     * Collapses versions: entries with the same id are one annotation — the latest version wins (by
     * {@code lastUpdated} when every version has one, else the last one returned; Core Historian returns versions
     * oldest first and leaves {@code lastUpdated} empty). An annotation whose winning version is a deletion is
     * dropped, as is every deleted entry without an id. Entries without an id that are not deleted are kept as they
     * are. Order: first appearance of each id.
     */
    public static List<Item> collapse(List<Item> in) {
        LinkedHashMap<String, Item> byId = new LinkedHashMap<>();
        List<Object> order = new ArrayList<>();
        for (Item it : in) {
            if (it == null) {
                continue;
            }
            if (it.id == null) {
                if (!it.deleted) {
                    order.add(it);
                }
                continue;
            }
            Item prev = byId.get(it.id);
            if (prev == null) {
                order.add(it.id);
                byId.put(it.id, it);
            } else if (newer(it, prev)) {
                byId.put(it.id, it);
            }
        }
        List<Item> out = new ArrayList<>(order.size());
        for (Object o : order) {
            Item it = o instanceof Item ? (Item) o : byId.get((String) o);
            if (it != null && !it.deleted) {
                out.add(it);
            }
        }
        return out;
    }

    /** {@code candidate} returned after {@code current}: it wins unless both carry a timestamp and it is older. */
    private static boolean newer(Item candidate, Item current) {
        if (candidate.lastUpdated != null && current.lastUpdated != null) {
            return candidate.lastUpdated >= current.lastUpdated;
        }
        return true;
    }

    /** Display order of a pen's annotations: by start, then id (id-less entries first among equal starts). */
    static final Comparator<Item> BY_START =
        Comparator.comparingLong((Item i) -> i.start).thenComparing(i -> i.id == null ? "" : i.id);

    /**
     * The entries overlapping {@code [from, to]}, sorted by start, at most {@code max}.
     *
     * @return the list and whether entries were left out
     */
    public static Window forWindow(List<Item> items, long from, long to, int max) {
        List<Item> in = new ArrayList<>();
        for (Item it : items) {
            if (it.start <= to && it.last() >= from) {
                in.add(it);
            }
        }
        in.sort(BY_START);
        boolean truncated = in.size() > max;
        return new Window(truncated ? new ArrayList<>(in.subList(0, Math.max(0, max))) : in, truncated);
    }

    /** One pen's annotations of one response. */
    public static final class Window {
        final List<Item> items;
        final boolean truncated;

        Window(List<Item> items, boolean truncated) {
            this.items = items;
            this.truncated = truncated;
        }

        public List<Item> items() {
            return items;
        }

        public boolean truncated() {
            return truncated;
        }
    }

    // =========================================================================================================
    // Queries (history route)
    // =========================================================================================================

    /**
     * Outcome of one historian's query: a status, the collapsed entries per normalized key and the keys whose entries
     * were cut at the per-pen bound ({@link #attribute}).
     */
    public static final class QueryResult {
        final String status;
        final Map<String, List<Item>> byKey;
        final Set<String> truncated;

        QueryResult(String status, Map<String, List<Item>> byKey) {
            this(status, byKey, Set.of());
        }

        QueryResult(String status, Map<String, List<Item>> byKey, Set<String> truncated) {
            this.status = status;
            this.byKey = byKey;
            this.truncated = truncated;
        }

        /** True when this pen had more live annotations in the window than the per-pen bound (the rest were cut). */
        public boolean truncated(String normalizedKey) {
            return normalizedKey != null && truncated.contains(normalizedKey);
        }

        public String status() {
            return status;
        }

        /** Entries of one pen (empty list when none or when the status is not ok). */
        public List<Item> of(String normalizedKey) {
            List<Item> l = byKey.get(normalizedKey);
            return l == null ? List.of() : l;
        }
    }

    /**
     * The query start for a window: one window length earlier (at least an hour, at most 31 days), because the
     * historian matches on the entry's start only and a range that began before the window must still be drawn.
     */
    public static long queryFrom(long from, long to) {
        long span = Math.max(0, to - from);
        long back = Math.max(LOOKBACK_MIN_MS, Math.min(LOOKBACK_MAX_MS, span));
        return Math.max(0, from - back);
    }

    /**
     * One query for every pen of one historian ({@code paths}: normalized key → canonical path, all with history on
     * {@code provider}), entries of {@code types} whose start is in {@code [from, to]}. Never throws: a failure is the
     * result's status ({@link #STATUS_UNSUPPORTED} or {@link #STATUS_ERROR}). Blocking; runs on a history worker.
     * Unbounded variant (tests); the route uses the bounded one below.
     */
    public QueryResult query(TagHistoryManager mgr, String provider, Map<String, TagPath> paths, long from, long to,
                             Collection<String> types) {
        return query(mgr, provider, paths, from, to, types, Long.MIN_VALUE, Long.MAX_VALUE, Integer.MAX_VALUE);
    }

    /**
     * As above, keeping per pen only the annotations that overlap the response window {@code [winFrom, winTo]}, and at
     * most {@code maxPerPen} of them: the earliest by start, as {@link #forWindow} would keep them. A pen cut there is
     * {@link QueryResult#truncated}. See {@link #attribute} for how versions and deletions are counted.
     */
    public QueryResult query(TagHistoryManager mgr, String provider, Map<String, TagPath> paths, long from, long to,
                             Collection<String> types, long winFrom, long winTo, int maxPerPen) {
        String known = status(provider, System.currentTimeMillis());
        if (known != null) {
            return new QueryResult(known, Map.of());
        }
        if (paths.isEmpty() || types.isEmpty()) {
            return new QueryResult(STATUS_OK, Map.of());
        }
        List<Annotation> found;
        try {
            found = mgr.queryAnnotations(new ArrayList<>(paths.values()), new Date(from), new Date(to),
                TypeFilter.custom(types.toArray(new String[0])));
        } catch (RuntimeException | LinkageError e) {
            return new QueryResult(failure(provider, e, "query"), Map.of());
        }
        Set<String> cut = new HashSet<>();
        return new QueryResult(STATUS_OK, attribute(found, paths, winFrom, winTo, Math.max(0, maxPerPen), cut), cut);
    }

    /**
     * Groups query results by pen: each entry's path is mapped to a normalized key ({@link #keyOf}); with a single
     * queried path everything belongs to it (whatever spelling the historian echoes). Versions are collapsed per key.
     */
    static Map<String, List<Item>> attribute(List<Annotation> found, Map<String, TagPath> paths) {
        return attribute(found, paths, Long.MIN_VALUE, Long.MAX_VALUE, Integer.MAX_VALUE, new HashSet<>());
    }

    /**
     * As above, per key: versions are collapsed first (the {@link #collapse} rule, one winning version per id kept as
     * the entries stream by), then the surviving annotations that overlap {@code [winFrom, winTo]} are sorted by start
     * (then id) and cut to the first {@code cap}; the keys that had more are added to {@code truncated}.
     *
     * <p>Why in this order: a cap that counted <em>raw</em> entries in historian order before the collapse would, on a
     * historian that returns deleted entries or version chains oldest first, let the newest version or the deletion of
     * an admitted id fall behind the cap — stale text, or a deleted note brought back — and the kept subset would not
     * be the "earliest by start" subset {@link #forWindow} keeps. The cap therefore counts distinct, live annotations;
     * deletions and older versions never take a place, and the result is exactly what
     * {@code forWindow(collapse(all), winFrom, winTo, cap)} would give. Memory: one winning entry per distinct id of
     * the answer (the SDK already holds the whole answer), and at most {@code cap} entries per pen leave this method.
     */
    static Map<String, List<Item>> attribute(List<Annotation> found, Map<String, TagPath> paths, long winFrom, long winTo,
                                             int cap, Set<String> truncated) {
        Map<String, LinkedHashMap<String, Item>> winners = new HashMap<>();
        Map<String, List<Item>> anonymous = new HashMap<>();
        String only = paths.size() == 1 ? paths.keySet().iterator().next() : null;
        if (found != null) {
            for (Annotation a : found) {
                if (a == null) {
                    continue;
                }
                String key = only != null ? only : keyOf(a.getPath());
                if (key == null || !paths.containsKey(key)) {
                    continue;
                }
                Item it = Item.of(a);
                if (it == null) {
                    continue;
                }
                if (it.id == null) {
                    // id-less entries (other tools) are separate annotations; a deleted one is dropped (collapse rule)
                    if (!it.deleted) {
                        anonymous.computeIfAbsent(key, k -> new ArrayList<>()).add(it);
                    }
                    continue;
                }
                LinkedHashMap<String, Item> byId = winners.computeIfAbsent(key, k -> new LinkedHashMap<>());
                Item prev = byId.get(it.id);
                if (prev == null || newer(it, prev)) {
                    byId.put(it.id, it);
                }
            }
        }
        Set<String> keys = new HashSet<>(winners.keySet());
        keys.addAll(anonymous.keySet());
        Map<String, List<Item>> out = new HashMap<>();
        for (String key : keys) {
            List<Item> live = new ArrayList<>();
            LinkedHashMap<String, Item> byId = winners.get(key);
            if (byId != null) {
                live.addAll(byId.values());
            }
            live.addAll(anonymous.getOrDefault(key, List.of()));
            live.removeIf(it -> it.deleted || it.start > winTo || it.last() < winFrom);
            live.sort(BY_START);
            if (live.size() > cap) {
                truncated.add(key);
                live = new ArrayList<>(live.subList(0, cap));
            }
            out.put(key, live);
        }
        return out;
    }

    /**
     * Normalized key ({@code TagPaths.normalizedKey} form: {@code "[provider]folder/tag"}, lower case) of an
     * annotation's path. The tag provider is the {@code prov} part; the 8.3 bridge answers {@code histprov:<tag
     * provider>:/tag:…} without one, so {@code histprov} stands in. Null when the path has no tag part.
     */
    static String keyOf(QualifiedPath p) {
        if (p == null) {
            return null;
        }
        String tag = p.getPathComponent("tag");
        String prov = p.getPathComponent("prov");
        if (prov == null) {
            prov = p.getPathComponent("histprov");
        }
        if (tag == null || prov == null) {
            return null;
        }
        return ("[" + prov + "]" + tag).toLowerCase(Locale.ROOT);
    }

    // =========================================================================================================
    // Stores and id lookups (delegate; ctg-annotations thread)
    // =========================================================================================================

    /**
     * Runs {@code work} on the {@code ctg-annotations} thread.
     *
     * @throws RejectedExecutionException when the queue is full or the module is stopping (the caller answers BUSY)
     */
    public <T> CompletableFuture<T> submit(Supplier<T> work) {
        return CompletableFuture.supplyAsync(work, storeExec);
    }

    /**
     * Stores {@code entries} (one call, so a delete + add edit is one historian request) and maps the per-entry
     * results to quality codes (the {@code CtgAudit} attempt's input). A historian that throws is remembered
     * ({@link #failure}); the future then completes exceptionally with the cause.
     */
    public CompletableFuture<List<QualityCode>> store(TagHistoryManager mgr, String provider, List<Annotation> entries) {
        return submit(() -> {
            List<QualifiedValue> res;
            try {
                res = mgr.storeAnnotations(entries);
            } catch (RuntimeException | LinkageError e) {
                String status = failure(provider, e, "store");
                throw new StoreFailed(status, e);
            }
            List<QualityCode> out = new ArrayList<>(entries.size());
            for (int i = 0; i < entries.size(); i++) {
                QualifiedValue qv = res != null && i < res.size() ? res.get(i) : null;
                out.add(qv == null || qv.getQuality() == null ? QualityCode.Bad : qv.getQuality());
            }
            return out;
        });
    }

    /** A store the historian refused by throwing; {@link #status} is {@code unsupported} or {@code error}. */
    public static final class StoreFailed extends RuntimeException {
        private final String status;

        StoreFailed(String status, Throwable cause) {
            super(status, cause, false, false);
            this.status = status;
        }

        public String status() {
            return status;
        }
    }

    /**
     * Every stored version of the entry {@code id} of {@code path} whose start is in {@code [from, to]} (raw, not
     * collapsed: an edit or delete must delete each version). Runs on the annotation thread.
     */
    public CompletableFuture<List<Annotation>> versions(TagHistoryManager mgr, String provider, TagPath path, UUID id,
                                                        long from, long to) {
        return submit(() -> {
            List<Annotation> found;
            try {
                found = mgr.queryAnnotations(List.of(path), new Date(Math.max(0, from)), new Date(Math.max(0, to)),
                    TypeFilter.ALL);
            } catch (RuntimeException | LinkageError e) {
                String status = failure(provider, e, "query");
                throw new StoreFailed(status, e);
            }
            List<Annotation> out = new ArrayList<>();
            if (found != null) {
                for (Annotation a : found) {
                    if (a != null && a.hasStorageId() && id.equals(a.getStorageId())) {
                        out.add(a);
                    }
                }
            }
            return out;
        });
    }

    /** The winning (current) version of {@code versions} (see {@link #collapse}); null when deleted or none. */
    public static Annotation current(List<Annotation> versions) {
        Annotation best = null;
        for (Annotation a : versions) {
            if (best == null) {
                best = a;
                continue;
            }
            Date la = a.getLastUpdated();
            Date lb = best.getLastUpdated();
            if (la == null || lb == null || !la.before(lb)) {
                best = a;
            }
        }
        return best == null || best.isDeleted() ? null : best;
    }

    // =========================================================================================================
    // One change per entry at a time
    // =========================================================================================================

    /** Outcome of {@link #claim}. */
    public enum ClaimResult {
        /** The caller owns the id until it calls {@link #settle} with the ticket's token. */
        OK,
        /** Another change of this id is still being stored → {@code BUSY}. */
        BUSY,
        /** The id was replaced or deleted moments ago (the historian may not show it yet) → {@code ANNOTATION_NOT_FOUND}. */
        GONE
    }

    /**
     * What {@link #claim} hands out: the result and, for {@link ClaimResult#OK}, the token that identifies this very
     * claim. {@link #settle} only acts on the claim that still carries the token (compare-and-remove).
     */
    public static final class Ticket {
        private final ClaimResult result;
        private final long token;

        Ticket(ClaimResult result, long token) {
            this.result = result;
            this.token = token;
        }

        public ClaimResult result() {
            return result;
        }

        /** The claim's token (0 unless {@link #result} is {@link ClaimResult#OK}). */
        public long token() {
            return token;
        }
    }

    /** An id being changed ({@code replaced} false, until the store settles) or just replaced / deleted. */
    private static final class Claim {
        final boolean replaced;
        final long until;
        final long token;

        Claim(boolean replaced, long until, long token) {
            this.replaced = replaced;
            this.until = until;
            this.token = token;
        }
    }

    /** Claims {@code id} for one edit or delete (see the class comment). Any thread. */
    public synchronized Ticket claim(UUID id, long now) {
        if (claims.size() >= CLAIMS_PRUNE_AT) {
            claims.values().removeIf(c -> c.until <= now);
        }
        Claim c = claims.get(id);
        if (c != null && c.until > now) {
            return new Ticket(c.replaced ? ClaimResult.GONE : ClaimResult.BUSY, 0L);
        }
        long token = ++claimTokens;
        claims.put(id, new Claim(false, now + CLAIM_MAX_MS, token));
        return new Ticket(ClaimResult.OK, token);
    }

    /**
     * Ends the claim {@code token} of {@code id}: {@code replaced} (the store succeeded) keeps the id answering
     * {@link ClaimResult#GONE} for {@value #REPLACED_TTL_MS} ms; otherwise (refused, failed) the id is free again at once.
     *
     * <p>Compare-and-remove: a store slower than {@value #CLAIM_MAX_MS} ms has lost its claim
     * to the safety bound, and another change may have claimed the id since. Its late settle then finds a different
     * token and does nothing, so it can neither free nor overwrite the newer change's claim (which settles itself).
     *
     * @return true when the claim was still this token's and was settled
     */
    public synchronized boolean settle(UUID id, long token, boolean replaced, long now) {
        Claim c = claims.get(id);
        if (c == null || c.replaced || c.token != token) {
            return false;
        }
        if (replaced) {
            claims.put(id, new Claim(true, now + REPLACED_TTL_MS, token));
        } else {
            claims.remove(id);
        }
        return true;
    }

    /** Claims held, expired ones included (tests, diagnostics). */
    synchronized int claimCount() {
        return claims.size();
    }

    // =========================================================================================================
    // Quota (ctg.annotations.maxPerSessionPerHour)
    // =========================================================================================================

    /**
     * Takes one save from {@code session}'s hourly quota; false when {@code max} saves were taken in the last hour.
     * Returns the timestamp to give back with {@link #refund} when the save then fails before the historian.
     */
    public synchronized boolean takeQuota(UUID session, int max, long now) {
        ArrayDeque<Long> q = quota.computeIfAbsent(session, k -> new ArrayDeque<>());
        while (!q.isEmpty() && q.peekFirst() <= now - QUOTA_WINDOW_MS) {
            q.pollFirst();
        }
        if (q.size() >= max) {
            return false;
        }
        q.addLast(now);
        return true;
    }

    /** Gives back a save taken at {@code at} (it never reached the historian). */
    public synchronized void refund(UUID session, long at) {
        ArrayDeque<Long> q = quota.get(session);
        if (q != null) {
            q.removeLastOccurrence(at);
            if (q.isEmpty()) {
                quota.remove(session);
            }
        }
    }

    /** Drops a session's quota (session end, via {@code GatewayServices}). */
    public synchronized void evict(UUID session) {
        quota.remove(session);
    }

    /** Sessions with quota state (tests, diagnostics). */
    synchronized int quotaSessions() {
        return quota.size();
    }

    // =========================================================================================================
    // Data JSON
    // =========================================================================================================

    /**
     * Note text as stored: control characters removed (line feeds and tabs kept), CR LF → LF, trimmed, at most
     * {@value #MAX_TEXT_CHARS} characters (never cutting a surrogate pair).
     */
    public static String cleanText(String s) {
        if (s == null) {
            return "";
        }
        String in = s.replace("\r\n", "\n");
        StringBuilder b = new StringBuilder(Math.min(in.length(), MAX_TEXT_CHARS + 1));
        for (int i = 0; i < in.length(); i++) {
            char c = in.charAt(i);
            if (c == '\n' || c == '\t' || !(Character.isISOControl(c) || c == LINE_SEP || c == PARA_SEP)) {
                b.append(c);
            }
        }
        String t = b.toString().strip();
        if (t.length() > MAX_TEXT_CHARS) {
            int cut = MAX_TEXT_CHARS;
            if (Character.isHighSurrogate(t.charAt(cut - 1))) {
                cut--;
            }
            t = t.substring(0, cut);
        }
        return t;
    }

    /** {@link #dataJson(String, String, String, String, long, String, Long)} for an author without a user source. */
    public static String dataJson(String text, String author, String color, long created, String editedBy, Long edited) {
        return dataJson(text, author, null, color, created, editedBy, edited);
    }

    /** The {@code data} JSON of a new or edited entry (see the class comment). */
    public static String dataJson(String text, String author, String authorSource, String color, long created,
                                  String editedBy, Long edited) {
        JsonObject o = new JsonObject();
        o.addProperty("v", 1);
        o.addProperty("text", text);
        if (author == null) {
            o.add("author", com.inductiveautomation.ignition.common.gson.JsonNull.INSTANCE);
        } else {
            o.addProperty("author", author);
            if (authorSource != null && !authorSource.isEmpty()) {
                o.addProperty("authorSource", authorSource);
            }
        }
        if (color == null || color.isEmpty()) {
            o.add("color", com.inductiveautomation.ignition.common.gson.JsonNull.INSTANCE);
        } else {
            o.addProperty("color", color);
        }
        o.addProperty("created", created);
        if (editedBy != null) {
            o.addProperty("editedBy", editedBy);
        }
        if (edited != null) {
            o.addProperty("edited", edited);
        }
        return o.toString();
    }

    /** A stored entry's {@code data}, read back. */
    public static final class Note {
        final String text;
        final String author;
        final String authorSource;
        final String color;
        final Long created;
        final boolean ours;

        Note(String text, String author, String authorSource, String color, Long created, boolean ours) {
            this.text = text;
            this.author = author;
            this.authorSource = authorSource;
            this.color = color;
            this.created = created;
            this.ours = ours;
        }

        public String text() {
            return text;
        }

        /** The author recorded in our JSON; null when unknown (foreign data, or no author). */
        public String author() {
            return author;
        }

        /** The author's identity provider recorded in our JSON; null when none was recorded. */
        public String authorSource() {
            return authorSource;
        }

        public String color() {
            return color;
        }

        public Long created() {
            return created;
        }

        /** True when the data is this module's JSON ({@code "v":1}). */
        public boolean ours() {
            return ours;
        }
    }

    /** Parses {@code data}; anything that is not our v1 JSON is plain text with an unknown author. */
    public static Note parseData(String data) {
        if (data == null) {
            return new Note("", null, null, null, null, false);
        }
        String t = data.strip();
        if (t.startsWith("{") && t.length() <= 16 * MAX_TEXT_CHARS) {
            try {
                JsonElement e = JsonParser.parseString(t);
                if (e.isJsonObject()) {
                    JsonObject o = e.getAsJsonObject();
                    JsonElement v = o.get("v");
                    if (v != null && v.isJsonPrimitive() && v.getAsJsonPrimitive().isNumber() && v.getAsInt() == 1) {
                        String text = Json.string(o, "text", "");
                        String author = Json.string(o, "author", null);
                        String source = Json.string(o, "authorSource", null);
                        String color = Json.string(o, "color", null);
                        JsonElement c = o.get("created");
                        Long created = c != null && c.isJsonPrimitive() && c.getAsJsonPrimitive().isNumber() ? c.getAsLong() : null;
                        boolean named = author != null && !author.isEmpty();
                        return new Note(text, named ? author : null,
                            named && source != null && !source.isEmpty() ? source : null,
                            color != null && COLOR.matcher(color).matches() && !color.isEmpty() ? color : null, created, true);
                    }
                }
            } catch (RuntimeException e) {
                // not JSON: plain text below
            }
        }
        return new Note(data, null, null, null, null, false);
    }

    /** {@link #isOwn(Note, String, String)} for a user without a user source. */
    public static boolean isOwn(Note note, String user) {
        return isOwn(note, user, null);
    }

    /**
     * True when {@code user} of {@code userSource} wrote the entry: exact, case-sensitive user name AND the same
     * identity provider (the same name from two user sources is two people; an entry without a recorded source
     * matches only a user without one). Unknown authors are never own.
     */
    public static boolean isOwn(Note note, String user, String userSource) {
        return note.author != null && user != null && !user.isEmpty() && note.author.equals(user)
            && !UserContext.ANONYMOUS.equals(user) && java.util.Objects.equals(note.authorSource, emptyToNull(userSource));
    }

    private static String emptyToNull(String s) {
        return s == null || s.isEmpty() ? null : s;
    }

    /**
     * Ownership for the {@code ownOnly} rule: an unauthenticated caller owns nothing — every anonymous session
     * shares the name {@link UserContext#ANONYMOUS}, so a name match would let any anonymous visitor change every
     * other anonymous visitor's notes. Notes written anonymously (author null; {@code "Unauthenticated"} in entries
     * written by earlier versions) can be changed only by moderators.
     */
    public static boolean isOwn(Note note, UserContext user) {
        return user != null && user.authenticated() && isOwn(note, user.userName(), user.userSource());
    }

    /** The user source recorded with a save by {@code user} (null when it records no author, or has no source). */
    public static String authorSourceOf(UserContext user) {
        return authorOf(user) == null ? null : user.userSource();
    }

    /** The author recorded for a save by {@code user}: the user name, or null for an unauthenticated session. */
    public static String authorOf(UserContext user) {
        if (user == null || !user.authenticated()) {
            return null;
        }
        String name = user.userName();
        return name == null || name.isEmpty() ? null : name;
    }

    // =========================================================================================================
    // Lifecycle
    // =========================================================================================================

    /** Stops the annotation thread; queued stores still run for a short bounded time (module shutdown). */
    @Override
    public void close() {
        storeExec.shutdown();
        try {
            if (!storeExec.awaitTermination(2, TimeUnit.SECONDS)) {
                storeExec.shutdownNow();
            }
        } catch (InterruptedException e) {
            storeExec.shutdownNow();
            Thread.currentThread().interrupt();
        }
        synchronized (this) {
            quota.clear();
            claims.clear();
        }
        support.clear();
    }
}
