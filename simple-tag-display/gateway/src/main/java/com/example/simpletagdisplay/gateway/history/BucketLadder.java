package com.example.simpletagdisplay.gateway.history;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/**
 * The aggregated-history bucket grid.
 *
 * <h2>Why a ladder</h2>
 * Dividing every window evenly into {@code pointCount} buckets makes each refresh tick (window shifted by a few
 * seconds) move every bucket boundary, so spikes appear and disappear between ticks. The ladder snaps the bucket
 * width to a short list of "nice" steps and anchors the grid at epoch 0: every client, every incremental tick and
 * every chunk of the cache share the same bucket boundaries, so the same bucket always has the same value.
 *
 * <h2>The ladder</h2>
 * {@code 100, 200, 250, 500 ms, 1, 2, 5, 10, 15, 30 s, 1, 2, 5, 10, 15, 30 min, 1, 2, 3, 6, 12 h, 1 d}, then every
 * whole number of days. The chart receives the finite part as {@code limits.bucketLadder} so its client copy
 * never diverges; whole days above 1 d follow the {@code n · 1 d} rule on both sides.
 *
 * <h2>Bucket timestamps (server side of the bucket alignment)</h2>
 * Core Historian returns one row per bucket {@code [s, s + bucketMs)} stamped with the bucket <b>start</b> {@code s}
 * (MinMax: two rows, both stamped {@code s}). The value of a LastValue bucket is the last sample inside it. The
 * response says so with {@code window.bucketTime: "start"}.
 */
public final class BucketLadder {

    public static final long SECOND = 1_000L;
    public static final long MINUTE = 60 * SECOND;
    public static final long HOUR = 60 * MINUTE;
    public static final long DAY = 24 * HOUR;

    /** The finite part of the ladder, ascending. Above {@link #DAY} every whole number of days is a step. */
    private static final long[] STEPS = {
        100, 200, 250, 500,
        SECOND, 2 * SECOND, 5 * SECOND, 10 * SECOND, 15 * SECOND, 30 * SECOND,
        MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE, 30 * MINUTE,
        HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR,
        DAY,
    };

    private static final List<Long> STEP_LIST;

    static {
        Long[] boxed = new Long[STEPS.length];
        for (int i = 0; i < STEPS.length; i++) {
            boxed[i] = STEPS[i];
        }
        STEP_LIST = Collections.unmodifiableList(Arrays.asList(boxed));
    }

    private BucketLadder() {
    }

    /** The finite ladder (ascending, ms) for {@code chart.snapshot.limits.bucketLadder}. */
    public static List<Long> steps() {
        return STEP_LIST;
    }

    /** True when {@code ms} is a ladder step (a finite step, or a whole number of days ≥ 1 d). */
    public static boolean isStep(long ms) {
        if (ms >= DAY) {
            return ms % DAY == 0;
        }
        return Arrays.binarySearch(STEPS, ms) >= 0;
    }

    /**
     * The smallest ladder step that is ≥ {@code ms} and ≥ {@code minBucketMs}.
     *
     * @param ms          desired bucket width (e.g. {@code ceil(span / pointCount)}); values below 1 are treated as 1
     * @param minBucketMs {@code ctg.history.minBucketMs}
     */
    public static long niceAtLeast(long ms, long minBucketMs) {
        long want = Math.max(Math.max(1L, ms), minBucketMs);
        if (want > DAY) {
            long days = (want + DAY - 1) / DAY;          // round up to whole days
            return days > Long.MAX_VALUE / DAY ? Long.MAX_VALUE / DAY * DAY : days * DAY;
        }
        for (long s : STEPS) {
            if (s >= want) {
                return s;
            }
        }
        return DAY;
    }

    /** The next ladder step strictly greater than {@code step} (a ladder step). */
    public static long next(long step) {
        if (step >= DAY) {
            return (step / DAY + 1) * DAY;
        }
        for (long s : STEPS) {
            if (s > step) {
                return s;
            }
        }
        return 2 * DAY;
    }

    /** {@code floor(t / bucketMs) * bucketMs} for any {@code t ≥ 0} (epoch-anchored grid). */
    public static long alignDown(long t, long bucketMs) {
        return Math.floorDiv(t, bucketMs) * bucketMs;
    }

    /** {@code ceil(a / b)} for positive {@code b} and non-negative {@code a}. */
    public static long ceilDiv(long a, long b) {
        return -Math.floorDiv(-a, b);
    }
}
