package com.example.simpletagdisplay.gateway.util;

import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Daemon threads named {@code <prefix>-<n>} so the module's threads are easy to find in a thread dump
 * ({@code ctg-sched-1}, {@code ctg-history-3}, ...). Daemon: a stuck task can never keep the gateway JVM alive.
 */
public final class NamedThreadFactory implements ThreadFactory {

    private final String prefix;
    private final AtomicInteger counter = new AtomicInteger();

    public NamedThreadFactory(String prefix) {
        this.prefix = prefix;
    }

    @Override
    public Thread newThread(Runnable r) {
        Thread t = new Thread(r, prefix + "-" + counter.incrementAndGet());
        t.setDaemon(true);
        return t;
    }
}
