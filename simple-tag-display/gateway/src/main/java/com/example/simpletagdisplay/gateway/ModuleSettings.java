package com.example.simpletagdisplay.gateway;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;
import java.util.function.Function;

import com.inductiveautomation.ignition.common.util.LoggerEx;

/**
 * Every module setting, live-reloadable.
 *
 * <h2>Where values come from</h2>
 * There is no settings UI in v2. Each setting is a JVM system property ({@code ctg.*}); production sets them in
 * {@code ignition.conf} ({@code wrapper.java.additional.N=-Dctg.history.threads=8}), tests set them live with
 * {@code java.lang.System.setProperty} (from a gateway script) and then change {@code ctg.settings.rev}.
 * Every value is clamped to a sane range; an unparsable or out-of-range value falls back to the
 * default (or the nearest bound) and logs one WARN per load.
 *
 * <h2>Reload</h2>
 * {@link #get()} returns an immutable {@link Settings} snapshot; code reads it at the moment it needs a value and
 * never caches individual numbers for long. {@link #reload()} re-reads every property, swaps the snapshot
 * atomically and notifies the listeners registered with {@link #onReload} (executors are resized, the floor
 * policy is rebuilt). {@code GatewayServices} polls {@code ctg.settings.rev} every 10 s and reloads when it
 * changed; with {@code ctg.debug} on, the {@code ctg.debug.reloadSettings} message reloads at once.
 *
 * <h2>Stable contract</h2>
 * The property names and defaults are part of the documented contract (docs/user-guide/gateway-settings.md):
 * renaming a property or changing its default breaks every gateway that sets it. A new setting is added here and
 * documented there.
 */
public final class ModuleSettings {

    private static final LoggerEx LOG = LoggerEx.newBuilder().build("SimpleTagDisplay.Gateway");

    /** The revision property whose change triggers a reload. */
    public static final String REV_PROPERTY = "ctg.settings.rev";

    private final Function<String, String> source;
    private final AtomicReference<Settings> current = new AtomicReference<>();
    private final List<Consumer<Settings>> listeners = new CopyOnWriteArrayList<>();
    private volatile String lastRev;

    /**
     * @param source property lookup ({@link System#getProperty(String)} in production, a map in tests)
     */
    public ModuleSettings(Function<String, String> source) {
        this.source = Objects.requireNonNull(source);
        this.current.set(Settings.read(source, LOG::warn));
        this.lastRev = Objects.toString(source.apply(REV_PROPERTY), "");
    }

    /** Settings from the JVM system properties (production). */
    public static ModuleSettings fromSystemProperties() {
        return new ModuleSettings(System::getProperty);
    }

    /** Current immutable snapshot. */
    public Settings get() {
        return current.get();
    }

    /** Called with the new snapshot after every {@link #reload()} that changed something. */
    public void onReload(Consumer<Settings> listener) {
        listeners.add(listener);
    }

    /**
     * Re-reads every property and swaps the snapshot. Listeners run on the calling thread, each in its own
     * try/catch.
     *
     * @return true when at least one value differs from the previous snapshot
     */
    public boolean reload() {
        Settings next = Settings.read(source, LOG::warn);
        Settings prev = current.getAndSet(next);
        lastRev = Objects.toString(source.apply(REV_PROPERTY), "");
        boolean changed = !next.equals(prev);
        LOG.infof("Module settings reloaded (rev '%s', %s)", sanitize(lastRev), changed ? "changed" : "unchanged");
        if (changed) {
            for (Consumer<Settings> l : listeners) {
                try {
                    l.accept(next);
                } catch (RuntimeException e) {
                    LOG.warn("Settings reload listener failed", e);
                }
            }
        }
        return changed;
    }

    /** Reloads when {@code ctg.settings.rev} changed since the last load. Called every 10 s by the scheduler. */
    public boolean reloadIfRevChanged() {
        String rev = Objects.toString(source.apply(REV_PROPERTY), "");
        if (rev.equals(lastRev)) {
            return false;
        }
        reload();
        return true;
    }

    private static String sanitize(String s) {
        return s.length() > 64 ? s.substring(0, 64) : s.replaceAll("[\\p{Cntrl}]", "?");
    }

    // =========================================================================================================
    // Settings snapshot
    // =========================================================================================================

    /**
     * Immutable values of one load. Names follow the property names ({@code ctg.history.threads} →
     * {@link #historyThreads()}). Equality compares every value (used to detect "nothing changed" on reload).
     */
    public static final class Settings {
        // ---- display / chart pushes ---------------------------------------------------------------------
        private final int displayCoalesceMs;
        private final int chartLiveCoalesceMs;
        private final int displayMetaRefreshMs;
        private final int displayHeartbeatMs;
        private final int chartMaxNewPathsPerMinute;
        private final int pushMaxValueBytes;
        private final int pushMaxBytes;
        // ---- tag operations ------------------------------------------------------------------------------
        private final int writeTimeoutMs;
        private final int readTimeoutMs;
        // ---- trend list -------------------------------------------------------------------------------------
        private final int trendMaxPens;
        private final int trendMaxGroupsPerSession;
        private final boolean trendClearOnUserChange;
        // ---- history ------------------------------------------------------------------------------------------
        private final int historyThreads;
        private final int historyQueue;
        private final int historyTimeoutMs;
        private final int historyMaxConcurrentPerSession;
        private final int historyMinIntervalMs;
        private final int historyMaxPens;
        private final int historyMaxRangeDays;
        private final int historyMaxRawRangeDays;
        private final int historyPointCountMin;
        private final int historyPointCountMax;
        private final int historyPointCountDefault;
        private final int historyMinBucketMs;
        private final int historyMaxRawPointsPerPen;
        private final int historyMaxPointsPerResponse;
        private final int historyCacheMb;
        private final long historySealMarginMs;
        private final int historyBodyMaxKb;
        private final int historyMaxTasksPerRequest;
        private final int historyMaxQueuedTasksPerSession;
        private final int historyMaxInFlightRequests;
        private final long historyMaxInFlightPoints;
        // ---- tokens --------------------------------------------------------------------------------------------
        private final long tokenTtlMs;
        private final long tokenDesignerTtlMs;
        // ---- sessions ------------------------------------------------------------------------------------------
        private final long sessionSweepMs;
        // ---- audit ---------------------------------------------------------------------------------------------
        private final String auditFallbackProfile;
        private final boolean auditRequired;
        // ---- annotations ------------------------------------------------------------------------------------------
        private final int annotationsMaxPerPen;
        private final int annotationsMaxPerSessionPerHour;
        // ---- security (floor policy, lint, frames) ------------------------------------------------------------
        private final int securityTamperLogPerMin;
        private final boolean securityRejectBoundGates;
        private final boolean securityAllowCrossOriginFrames;
        private final boolean writeRequireAuthenticated;
        private final List<String> writeRequiredRoles;
        private final List<String> configEditRequiredRoles;
        private final List<String> writeAllowedRoots;
        private final List<String> writeDeniedProviders;
        private final List<String> readDeniedProviders;
        // ---- misc ---------------------------------------------------------------------------------------------
        private final boolean debug;
        private final String settingsRev;

        private Settings(Reader r) {
            displayCoalesceMs = r.integer("ctg.display.coalesceMs", 150, 50, 2000);
            chartLiveCoalesceMs = r.integer("ctg.chart.liveCoalesceMs", 250, 100, 5000);
            displayMetaRefreshMs = r.integer("ctg.display.metaRefreshMs", 60_000, 10_000, 3_600_000);
            displayHeartbeatMs = r.integer("ctg.display.heartbeatMs", 30_000, 5_000, 300_000);
            chartMaxNewPathsPerMinute = r.integer("ctg.chart.maxNewPathsPerMinute", 200, 10, 10_000);
            pushMaxValueBytes = r.integer("ctg.push.maxValueBytes", 65_536, 4_096, 1_048_576);
            pushMaxBytes = r.integer("ctg.push.maxBytes", 262_144, 16_384, 4_194_304);

            writeTimeoutMs = r.integer("ctg.write.timeoutMs", 10_000, 1_000, 30_000);
            readTimeoutMs = r.integer("ctg.read.timeoutMs", 5_000, 1_000, 30_000);

            trendMaxPens = r.integer("ctg.trend.maxPens", 32, 1, 64);
            trendMaxGroupsPerSession = r.integer("ctg.trend.maxGroupsPerSession", 16, 1, 64);
            trendClearOnUserChange = r.bool("ctg.trend.clearOnUserChange", true);

            historyThreads = r.integer("ctg.history.threads", 4, 1, 32);
            historyQueue = r.integer("ctg.history.queue", 64, 8, 1024);
            historyTimeoutMs = r.integer("ctg.history.timeoutMs", 15_000, 2_000, 60_000);
            historyMaxConcurrentPerSession = r.integer("ctg.history.maxConcurrentPerSession", 4, 1, 8);
            historyMinIntervalMs = r.integer("ctg.history.minIntervalMs", 200, 0, 5_000);
            historyMaxPens = r.integer("ctg.history.maxPens", 32, 1, 64);
            historyMaxRangeDays = r.integer("ctg.history.maxRangeDays", 400, 1, 3_650);
            historyMaxRawRangeDays = r.integer("ctg.history.maxRawRangeDays", 31, 1, 3_650);
            historyPointCountMin = r.integer("ctg.history.pointCountMin", 10, 1, 1_000);
            historyPointCountMax = r.integer("ctg.history.pointCountMax", 5_000, Math.max(100, historyPointCountMin), 20_000);
            historyPointCountDefault = r.integer("ctg.history.pointCountDefault", 300, historyPointCountMin, historyPointCountMax);
            historyMinBucketMs = r.integer("ctg.history.minBucketMs", 100, 10, 60_000);
            historyMaxRawPointsPerPen = r.integer("ctg.history.maxRawPointsPerPen", 250_000, 1_000, 2_000_000);
            historyMaxPointsPerResponse = r.integer("ctg.history.maxPointsPerResponse", 500_000, 10_000, 5_000_000);
            historyCacheMb = r.integer("ctg.history.cacheMb", 64, 0, 1_024);
            historySealMarginMs = r.longValue("ctg.history.sealMarginMs", 300_000L, 0L, 86_400_000L);
            historyBodyMaxKb = r.integer("ctg.history.bodyMaxKb", 256, 16, 2_048);
            historyMaxTasksPerRequest = r.integer("ctg.history.maxTasksPerRequest", 64, 1, 1_024);
            historyMaxQueuedTasksPerSession = r.integer("ctg.history.maxQueuedTasksPerSession", 16, 1, 256);
            historyMaxInFlightRequests = r.integer("ctg.history.maxInFlightRequests", 32, 1, 512);
            historyMaxInFlightPoints = r.longValue("ctg.history.maxInFlightPoints", 5_000_000L, 100_000L, 50_000_000L);

            tokenTtlMs = r.longValue("ctg.token.ttlMs", 900_000L, 60_000L, 86_400_000L);
            tokenDesignerTtlMs = r.longValue("ctg.token.designerTtlMs", 300_000L, 60_000L, 900_000L);

            // The liveness sweep of GatewayServices (safety net when Perspective's SessionShutdownEvent is missed):
            // 10 minutes by default, live-settable so the sweep can be tested.
            sessionSweepMs = r.longValue("ctg.session.sweepMs", 600_000L, 10_000L, 3_600_000L);

            auditFallbackProfile = r.string("ctg.audit.fallbackProfile", "");
            auditRequired = r.bool("ctg.audit.required", false);

            annotationsMaxPerPen = r.integer("ctg.annotations.maxPerPen", 500, 1, 5_000);
            annotationsMaxPerSessionPerHour = r.integer("ctg.annotations.maxPerSessionPerHour", 60, 1, 10_000);

            securityTamperLogPerMin = r.integer("ctg.security.tamperLogPerMin", 6, 1, 600);
            // Default TRUE: a client can launder a value into a gate key through any binding (Origin.Binding),
            // which TrustedProps cannot see.
            securityRejectBoundGates = r.bool("ctg.security.rejectBoundGates", true);
            securityAllowCrossOriginFrames = r.bool("ctg.security.allowCrossOriginFrames", false);
            // Default FALSE, as in native Perspective, which lets an anonymous session write unless tag write
            // permissions / project security forbid it; this is an opt-in floor.
            writeRequireAuthenticated = r.bool("ctg.write.requireAuthenticated", false);
            writeRequiredRoles = r.csv("ctg.write.requiredRoles", "");
            configEditRequiredRoles = r.csv("ctg.configEdit.requiredRoles", "");
            writeAllowedRoots = r.csv("ctg.write.allowedRoots", "");
            writeDeniedProviders = r.csv("ctg.write.deniedProviders", "System");
            readDeniedProviders = r.csv("ctg.read.deniedProviders", "System");

            debug = r.bool("ctg.debug", false);
            settingsRev = r.string(REV_PROPERTY, "");
        }

        /** Reads and clamps every property; problems are reported through {@code warn} (one line each). */
        public static Settings read(Function<String, String> source, Consumer<String> warn) {
            return new Settings(new Reader(source, warn));
        }

        /** All defaults (no property set). */
        public static Settings defaults() {
            return read(k -> null, w -> { });
        }

        public int displayCoalesceMs() {
            return displayCoalesceMs;
        }

        public int chartLiveCoalesceMs() {
            return chartLiveCoalesceMs;
        }

        public int displayMetaRefreshMs() {
            return displayMetaRefreshMs;
        }

        public int displayHeartbeatMs() {
            return displayHeartbeatMs;
        }

        public int chartMaxNewPathsPerMinute() {
            return chartMaxNewPathsPerMinute;
        }

        public int pushMaxValueBytes() {
            return pushMaxValueBytes;
        }

        public int pushMaxBytes() {
            return pushMaxBytes;
        }

        public int writeTimeoutMs() {
            return writeTimeoutMs;
        }

        public int readTimeoutMs() {
            return readTimeoutMs;
        }

        public int trendMaxPens() {
            return trendMaxPens;
        }

        public int trendMaxGroupsPerSession() {
            return trendMaxGroupsPerSession;
        }

        public boolean trendClearOnUserChange() {
            return trendClearOnUserChange;
        }

        public int historyThreads() {
            return historyThreads;
        }

        public int historyQueue() {
            return historyQueue;
        }

        public int historyTimeoutMs() {
            return historyTimeoutMs;
        }

        public int historyMaxConcurrentPerSession() {
            return historyMaxConcurrentPerSession;
        }

        public int historyMinIntervalMs() {
            return historyMinIntervalMs;
        }

        public int historyMaxPens() {
            return historyMaxPens;
        }

        public int historyMaxRangeDays() {
            return historyMaxRangeDays;
        }

        public int historyMaxRawRangeDays() {
            return historyMaxRawRangeDays;
        }

        public int historyPointCountMin() {
            return historyPointCountMin;
        }

        public int historyPointCountMax() {
            return historyPointCountMax;
        }

        public int historyPointCountDefault() {
            return historyPointCountDefault;
        }

        public int historyMinBucketMs() {
            return historyMinBucketMs;
        }

        public int historyMaxRawPointsPerPen() {
            return historyMaxRawPointsPerPen;
        }

        public int historyMaxPointsPerResponse() {
            return historyMaxPointsPerResponse;
        }

        public int historyCacheMb() {
            return historyCacheMb;
        }

        public long historySealMarginMs() {
            return historySealMarginMs;
        }

        public int historyBodyMaxKb() {
            return historyBodyMaxKb;
        }

        public int historyMaxTasksPerRequest() {
            return historyMaxTasksPerRequest;
        }

        public int historyMaxQueuedTasksPerSession() {
            return historyMaxQueuedTasksPerSession;
        }

        public int historyMaxInFlightRequests() {
            return historyMaxInFlightRequests;
        }

        public long historyMaxInFlightPoints() {
            return historyMaxInFlightPoints;
        }

        public long tokenTtlMs() {
            return tokenTtlMs;
        }

        public long tokenDesignerTtlMs() {
            return tokenDesignerTtlMs;
        }

        /** Interval of the session liveness sweep ({@code ctg.session.sweepMs}, 10 s – 1 h, default 10 min). */
        public long sessionSweepMs() {
            return sessionSweepMs;
        }

        public String auditFallbackProfile() {
            return auditFallbackProfile;
        }

        public boolean auditRequired() {
            return auditRequired;
        }

        public int annotationsMaxPerPen() {
            return annotationsMaxPerPen;
        }

        public int annotationsMaxPerSessionPerHour() {
            return annotationsMaxPerSessionPerHour;
        }

        public int securityTamperLogPerMin() {
            return securityTamperLogPerMin;
        }

        public boolean securityRejectBoundGates() {
            return securityRejectBoundGates;
        }

        public boolean securityAllowCrossOriginFrames() {
            return securityAllowCrossOriginFrames;
        }

        public boolean writeRequireAuthenticated() {
            return writeRequireAuthenticated;
        }

        /** Role floor for every write (exact names; empty = none). */
        public List<String> writeRequiredRoles() {
            return writeRequiredRoles;
        }

        /** Extra role floor for config edits (exact names; empty = none). */
        public List<String> configEditRequiredRoles() {
            return configEditRequiredRoles;
        }

        /** Raw {@code [provider]Folder} entries; normalised by {@code FloorPolicy}. */
        public List<String> writeAllowedRoots() {
            return writeAllowedRoots;
        }

        public List<String> writeDeniedProviders() {
            return writeDeniedProviders;
        }

        public List<String> readDeniedProviders() {
            return readDeniedProviders;
        }

        /**
         * {@code ctg.debug} as of this load. Debug hooks must NOT use this value: they read the live property on
         * every call ({@code GatewayServices.debugEnabled()}). Kept for completeness / diagnostics.
         */
        public boolean debug() {
            return debug;
        }

        public String settingsRev() {
            return settingsRev;
        }

        private List<Object> values() {
            return Arrays.asList(displayCoalesceMs, chartLiveCoalesceMs, displayMetaRefreshMs, displayHeartbeatMs,
                chartMaxNewPathsPerMinute, pushMaxValueBytes, pushMaxBytes, writeTimeoutMs, readTimeoutMs,
                trendMaxPens, trendMaxGroupsPerSession, trendClearOnUserChange, historyThreads, historyQueue,
                historyTimeoutMs, historyMaxConcurrentPerSession, historyMinIntervalMs, historyMaxPens,
                historyMaxRangeDays, historyMaxRawRangeDays, historyPointCountMin, historyPointCountMax,
                historyPointCountDefault, historyMinBucketMs, historyMaxRawPointsPerPen, historyMaxPointsPerResponse,
                historyCacheMb, historySealMarginMs, historyBodyMaxKb, historyMaxTasksPerRequest,
                historyMaxQueuedTasksPerSession, historyMaxInFlightRequests, historyMaxInFlightPoints, tokenTtlMs,
                tokenDesignerTtlMs, sessionSweepMs, auditFallbackProfile, auditRequired, annotationsMaxPerPen,
                annotationsMaxPerSessionPerHour, securityTamperLogPerMin, securityRejectBoundGates,
                securityAllowCrossOriginFrames, writeRequireAuthenticated, writeRequiredRoles, configEditRequiredRoles,
                writeAllowedRoots, writeDeniedProviders, readDeniedProviders, debug, settingsRev);
        }

        @Override
        public boolean equals(Object o) {
            return o instanceof Settings && values().equals(((Settings) o).values());
        }

        @Override
        public int hashCode() {
            return values().hashCode();
        }
    }

    // =========================================================================================================
    // Property reader with clamping
    // =========================================================================================================

    private static final class Reader {
        private final Function<String, String> source;
        private final Consumer<String> warn;

        Reader(Function<String, String> source, Consumer<String> warn) {
            this.source = source;
            this.warn = warn;
        }

        private String raw(String key) {
            try {
                String v = source.apply(key);
                return v == null ? null : v.trim();
            } catch (RuntimeException e) {
                return null;
            }
        }

        int integer(String key, int def, int min, int max) {
            return (int) longValue(key, def, min, max);
        }

        long longValue(String key, long def, long min, long max) {
            String v = raw(key);
            if (v == null || v.isEmpty()) {
                return def;
            }
            long parsed;
            try {
                parsed = Long.parseLong(v);
            } catch (NumberFormatException e) {
                warn.accept("Setting " + key + "='" + clip(v) + "' is not a whole number; using the default " + def);
                return def;
            }
            if (parsed < min || parsed > max) {
                long clamped = Math.max(min, Math.min(max, parsed));
                warn.accept("Setting " + key + "=" + parsed + " is outside " + min + ".." + max + "; using " + clamped);
                return clamped;
            }
            return parsed;
        }

        boolean bool(String key, boolean def) {
            String v = raw(key);
            if (v == null || v.isEmpty()) {
                return def;
            }
            String l = v.toLowerCase(Locale.ROOT);
            if (l.equals("true")) {
                return true;
            }
            if (l.equals("false")) {
                return false;
            }
            warn.accept("Setting " + key + "='" + clip(v) + "' is not true/false; using the default " + def);
            return def;
        }

        String string(String key, String def) {
            String v = raw(key);
            return v == null ? def : v;
        }

        /** Comma-separated list; blanks dropped; entries trimmed (names in these settings never start/end with spaces). */
        List<String> csv(String key, String def) {
            String v = raw(key);
            if (v == null) {
                v = def;
            }
            List<String> out = new ArrayList<>();
            for (String part : v.split(",")) {
                String p = part.trim();
                if (!p.isEmpty()) {
                    out.add(p);
                }
            }
            return Collections.unmodifiableList(out);
        }

        private static String clip(String s) {
            String c = s.replaceAll("[\\p{Cntrl}]", "?");
            return c.length() > 64 ? c.substring(0, 64) + "..." : c;
        }
    }
}
