package com.example.simpletagdisplay.gateway.trend;

import java.util.UUID;

import com.example.simpletagdisplay.gateway.GatewayServices;
import com.google.common.eventbus.Subscribe;
import com.inductiveautomation.ignition.common.util.LoggerEx;
import com.inductiveautomation.perspective.gateway.event.SessionShutdownEvent;

/**
 * Evicts per-session module state when a Perspective session ends.
 *
 * Registered on {@code PerspectiveContext.getEventBus()} (a Guava {@code EventBus}) by {@link GatewayServices#start()}.
 * On {@link SessionShutdownEvent} the session's history tokens are revoked, its trend lists dropped and its
 * {@code LiveSessions} entry removed ({@link GatewayServices#sessionEnded}); other module parts hook their own
 * caches in through {@link GatewayServices#onSessionEnd}.
 *
 * Who posts {@code SessionShutdownEvent}, and for which kinds of session end (logout-close, timeout, Designer
 * close), is not documented; the 10-minute sweep in {@code GatewayServices} is the safety net that also covers
 * Designer sessions. The handler runs on the event bus's thread: it must stay quick and never throw.
 */
public final class SessionEvictionSubscriber {

    private static final LoggerEx LOG = LoggerEx.newBuilder().build("SimpleTagDisplay.Trend");

    private final GatewayServices services;

    public SessionEvictionSubscriber(GatewayServices services) {
        this.services = services;
    }

    @Subscribe
    public void onSessionShutdown(SessionShutdownEvent e) {
        try {
            UUID id = e == null || e.getSession() == null ? null : e.getSession().getSessionId();
            if (id == null) {
                return;
            }
            LOG.debugf("SessionShutdownEvent for session %s", id);
            services.sessionEnded(id);
        } catch (RuntimeException ex) {
            LOG.warn("Session eviction failed", ex);
        }
    }
}
