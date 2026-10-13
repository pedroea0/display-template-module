package com.example.simpletagdisplay.gateway.ops;

import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

import com.example.simpletagdisplay.gateway.GatewayServices;
import com.inductiveautomation.ignition.common.util.LoggerEx;

/**
 * Module-wide fan-out of settings reloads to the running chart and display delegates.
 *
 * <h2>Why</h2>
 * Several things a delegate has already sent depend on {@code ctg.*} settings: a chart's read scope
 * ({@code ctg.read.deniedProviders}) and pen budget ({@code ctg.trend.maxPens}); a display's advisory
 * {@code capabilities} (the write / config-edit floor — {@code ctg.write.*}, {@code ctg.configEdit.requiredRoles} —
 * and {@code ctg.audit.required} / {@code ctg.audit.fallbackProfile}) and its {@code trend.max}. Without a push the
 * client would keep the old answer until something else changed: a display would show "write allowed" after
 * {@code ctg.audit.required=true} until the next value change, and a chart would keep a denied provider in scope until
 * its next reconcile.
 *
 * <h2>How</h2>
 * {@code ModuleSettings.onReload} listeners cannot be removed, so the module registers this one object once
 * ({@link #of}, through {@code GatewayServices.shared}) and every delegate adds its own callback while it runs and
 * removes it on stop (keeping the instance: {@code shared()} refuses once the module has closed). The reload listener is
 * registered after {@code GatewayServices}' own one, so the floor policy is already rebuilt when the callbacks run.
 * Each reload that changed a setting calls every callback, in isolation; a callback only queues work on its session
 * queue (a chart a debounced reconcile, a display a section push that sends only what really changed). Thread-safe.
 */
public final class SettingsFanOut {

    private static final LoggerEx LOG = LoggerEx.newBuilder().build("SimpleTagDisplay.Gateway");

    private final Set<Runnable> callbacks = ConcurrentHashMap.newKeySet();

    SettingsFanOut() {
    }

    /** The module's instance, registered once with {@code ModuleSettings.onReload}. */
    public static SettingsFanOut of(GatewayServices services) {
        return services.shared(SettingsFanOut.class, () -> {
            SettingsFanOut f = new SettingsFanOut();
            services.settings().onReload(s -> f.changed());
            return f;
        });
    }

    /** Registers a running delegate's callback (idempotent). */
    public void add(Runnable onSettingsChanged) {
        callbacks.add(onSettingsChanged);
    }

    /** Removes it (delegate stop). */
    public void remove(Runnable onSettingsChanged) {
        callbacks.remove(onSettingsChanged);
    }

    /** Number of registered delegates (diagnostics, tests). */
    public int size() {
        return callbacks.size();
    }

    /** The settings changed: tell every registered delegate (each in isolation). */
    public void changed() {
        for (Runnable r : callbacks) {
            try {
                r.run();
            } catch (RuntimeException e) {
                LOG.debugf("settings callback failed: %s", e.toString());
            }
        }
    }
}
