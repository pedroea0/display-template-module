package com.example.simpletagdisplay.gateway.history;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/** Bucket ladder and epoch alignment. */
class BucketLadderTest {

    private static final long S = 1_000L;
    private static final long M = 60 * S;
    private static final long H = 60 * M;
    private static final long D = 24 * H;

    @Test
    void ladderMembership() {
        for (long step : new long[] {100, 200, 250, 500, S, 2 * S, 5 * S, 10 * S, 15 * S, 30 * S, M, 2 * M, 5 * M, 10 * M,
            15 * M, 30 * M, H, 2 * H, 3 * H, 6 * H, 12 * H, D, 2 * D, 7 * D, 400 * D}) {
            assertTrue(BucketLadder.isStep(step), "step " + step);
        }
        for (long no : new long[] {0, 1, 99, 101, 300, 750, 3 * S, 45 * S, 4 * H, 18 * H, D + 1, D + H}) {
            assertFalse(BucketLadder.isStep(no), "not a step " + no);
        }
        assertEquals(22, BucketLadder.steps().size());
        assertEquals(D, BucketLadder.steps().get(BucketLadder.steps().size() - 1).longValue());
    }

    @Test
    void niceRoundsUpAndHonoursTheMinimum() {
        assertEquals(100, BucketLadder.niceAtLeast(1, 100));
        assertEquals(100, BucketLadder.niceAtLeast(100, 100));
        assertEquals(200, BucketLadder.niceAtLeast(101, 100));
        assertEquals(200, BucketLadder.niceAtLeast(1, 150), "minBucketMs 150 -> next step 200");
        assertEquals(2 * M, BucketLadder.niceAtLeast(96 * S, 100), "8 h / 300 points = 96 s -> 2 min");
        assertEquals(12 * H, BucketLadder.niceAtLeast(7 * H, 100));
        assertEquals(D, BucketLadder.niceAtLeast(13 * H, 100));
        assertEquals(2 * D, BucketLadder.niceAtLeast(D + 1, 100), "above 1 d: whole days");
        assertEquals(30 * S, BucketLadder.niceAtLeast(0, 30 * S));
    }

    @Test
    void nextStep() {
        assertEquals(200, BucketLadder.next(100));
        assertEquals(S, BucketLadder.next(500));
        assertEquals(D, BucketLadder.next(12 * H));
        assertEquals(2 * D, BucketLadder.next(D));
        assertEquals(5 * D, BucketLadder.next(4 * D));
    }

    @Test
    void alignmentIsEpochAnchored() {
        long t = 1_791_398_437_123L;
        assertEquals(1_791_398_400_000L, BucketLadder.alignDown(t, M));
        assertEquals(0, BucketLadder.alignDown(t, 2 * M) % (2 * M));
        // Two windows 3 s apart share every bucket boundary.
        long b = 2 * M;
        long a1 = BucketLadder.alignDown(t - 8 * H, b);
        long a2 = BucketLadder.alignDown(t + 3 * S - 8 * H, b);
        assertEquals(0, (a2 - a1) % b);
        assertEquals(3, BucketLadder.ceilDiv(7, 3));
        assertEquals(0, BucketLadder.ceilDiv(0, 3));
        assertEquals(2, BucketLadder.ceilDiv(6, 3));
    }
}
