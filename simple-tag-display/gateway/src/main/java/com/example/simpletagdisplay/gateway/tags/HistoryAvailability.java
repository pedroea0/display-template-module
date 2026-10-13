package com.example.simpletagdisplay.gateway.tags;

import java.util.Collection;
import java.util.Locale;
import java.util.Set;
import java.util.function.LongSupplier;
import java.util.function.Supplier;
import java.util.stream.Collectors;

import com.inductiveautomation.ignition.common.gson.JsonObject;
import com.inductiveautomation.ignition.common.sqltags.model.types.DataType;
import com.inductiveautomation.ignition.common.util.LoggerEx;

/**
 * "Can this tag be trended?" (the snapshot's {@code history} object): {@code HistoryEnabled} is true
 * and {@code HistoryProvider} names a history provider that exists on this gateway. The provider list
 * ({@code TagHistoryManager.getTagHistoryProviders()}) is cached for {@value #TTL_MS} ms; one module-wide instance
 * ({@code GatewayServices.shared}).
 *
 * <h2>Reasons</h2>
 * {@code ok} | {@code disabled} (HistoryEnabled false / unknown) | {@code noProvider} (empty provider) |
 * {@code providerMissing} (provider not installed / renamed) | {@code unsupportedType} (String, DateTime, arrays …:
 * the history route only serves numeric and Boolean pens, so trending them would show nothing).
 */
public final class HistoryAvailability {

    private static final LoggerEx LOG = LoggerEx.newBuilder().build("SimpleTagDisplay.Display");
    static final long TTL_MS = 30_000L;

    private final LongSupplier clock;
    private volatile Set<String> providers = Set.of();
    private volatile long loadedAt;
    private volatile boolean loaded;

    public HistoryAvailability() {
        this(System::currentTimeMillis);
    }

    HistoryAvailability(LongSupplier clock) {
        this.clock = clock;
    }

    /** Result of one check. Immutable. */
    public static final class Status {
        private final boolean available;
        private final boolean enabled;
        private final String provider;
        private final String reason;

        Status(boolean available, boolean enabled, String provider, String reason) {
            this.available = available;
            this.enabled = enabled;
            this.provider = provider;
            this.reason = reason;
        }

        public boolean available() {
            return available;
        }

        public String reason() {
            return reason;
        }

        /** The snapshot's {@code history} object: {@code {available, enabled, provider, reason}}. */
        public JsonObject toJson() {
            JsonObject o = new JsonObject();
            o.addProperty("available", available);
            o.addProperty("enabled", enabled);
            o.addProperty("provider", provider);
            o.addProperty("reason", reason);
            return o;
        }
    }

    /**
     * Classifies a tag from its metadata.
     *
     * @param providerSource supplies the gateway's history provider names when the cache is stale (called at most
     *                       once per {@value #TTL_MS} ms; failures keep the old list and are logged at DEBUG)
     */
    public Status check(TagMetaReader.Meta meta, Supplier<Collection<String>> providerSource) {
        Boolean enabled = meta.bool(TagMetaReader.HISTORY_ENABLED);
        String provider = meta.string(TagMetaReader.HISTORY_PROVIDER);
        String prov = provider == null ? "" : provider.trim();
        DataType dt = meta.dataType();
        if (!Boolean.TRUE.equals(enabled)) {
            return new Status(false, false, prov, "disabled");
        }
        if (prov.isEmpty()) {
            return new Status(false, true, prov, "noProvider");
        }
        if (!providers(providerSource).contains(prov.toLowerCase(Locale.ROOT))) {
            return new Status(false, true, prov, "providerMissing");
        }
        if (dt != null && (dt.isArray() || !(dt.isNumeric() || dt == DataType.Boolean))) {
            return new Status(false, true, prov, "unsupportedType");
        }
        return new Status(true, true, prov, "ok");
    }

    private Set<String> providers(Supplier<Collection<String>> source) {
        long now = clock.getAsLong();
        if (!loaded || now - loadedAt >= TTL_MS) {
            try {
                Collection<String> names = source.get();
                providers = names == null ? Set.of()
                    : names.stream().filter(n -> n != null).map(n -> n.trim().toLowerCase(Locale.ROOT))
                        .collect(Collectors.toUnmodifiableSet());
                loadedAt = now;
                loaded = true;
            } catch (RuntimeException e) {
                LOG.debugf("history provider list unavailable: %s", e.toString());
            }
        }
        return providers;
    }
}
