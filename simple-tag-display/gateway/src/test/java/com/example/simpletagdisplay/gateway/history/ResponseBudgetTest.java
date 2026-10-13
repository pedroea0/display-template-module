package com.example.simpletagdisplay.gateway.history;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import com.inductiveautomation.ignition.common.model.values.QualityCode;
import org.junit.jupiter.api.RepeatedTest;
import org.junit.jupiter.api.Test;

/**
 * {@code maxPointsPerResponse} in request order with pens storing in parallel (a race between pen budgets once
 * made six 100 k pens against 500 k return only 400 k because two pens crossing the last remainder both refused
 * themselves).
 */
class ResponseBudgetTest {

    private static final QualityCode[] GOOD = {QualityCode.Good, QualityCode.Good};

    @Test
    void sequentialPrefixFits() {
        ResponseBudget r = new ResponseBudget(500);
        List<PenSeriesWriter.PenBudget> pens = new ArrayList<>();
        for (int i = 0; i < 6; i++) {
            pens.add(r.pen(1_000, i));
        }
        for (int i = 0; i < 6; i++) {
            for (int k = 0; k < 100; k++) {
                pens.get(i).take(1);
            }
        }
        for (int i = 0; i < 5; i++) {
            assertFalse(pens.get(i).isOver(), "pen " + i + " fits");
        }
        assertEquals(PenSeriesWriter.PenBudget.Overflow.RESPONSE_CAP, pens.get(5).overflow());
        assertEquals(0, r.remaining());
    }

    @Test
    void anEarlierPenEvictsALaterOneThatFilledFirst() {
        ResponseBudget r = new ResponseBudget(150);
        PenSeriesWriter.PenBudget early = r.pen(1_000, 0);
        PenSeriesWriter.PenBudget late = r.pen(1_000, 1);
        assertTrue(late.take(100));                     // the later pen's query finished first
        for (int k = 0; k < 100; k++) {
            assertTrue(early.take(1), "the earlier pen is served at " + k);
        }
        assertEquals(PenSeriesWriter.PenBudget.Overflow.RESPONSE_CAP, late.overflow());
        assertFalse(early.isOver());
        assertEquals(50, r.remaining(), "the evicted pen's points came back");
        assertFalse(late.take(1), "an evicted pen stays refused");
    }

    @Test
    void aPenOverItsOwnCapGivesItsShareBack() {
        ResponseBudget r = new ResponseBudget(100);
        PenSeriesWriter.PenBudget a = r.pen(50, 0);
        PenSeriesWriter.PenBudget b = r.pen(1_000, 1);
        assertTrue(a.take(50));
        assertFalse(a.take(1));
        assertEquals(PenSeriesWriter.PenBudget.Overflow.PEN_CAP, a.overflow());
        assertTrue(b.take(100), "the pen-capped pen's share is free again");
    }

    @Test
    void aRetiredPenGivesItsPointsBackWithoutRefusingLaterPens() {
        ResponseBudget r = new ResponseBudget(100);
        PenSeriesWriter.PenBudget timedOut = r.pen(1_000, 0);
        PenSeriesWriter.PenBudget later = r.pen(1_000, 1);
        assertTrue(timedOut.take(60));
        assertTrue(later.take(40));
        r.retire(timedOut);
        assertEquals(PenSeriesWriter.PenBudget.Overflow.RETIRED, timedOut.overflow());
        assertEquals(60, r.remaining());
        assertFalse(timedOut.take(1), "a zombie of a retired pen takes nothing more");
        assertTrue(later.take(60), "a later pen is not refused by the retirement");
        assertFalse(later.isOver());
    }

    @Test
    void aZombieOfARetiredEarlierPenCannotEvictASettledLaterPen() {
        ResponseBudget r = new ResponseBudget(100);
        PenSeriesWriter.PenBudget zombie = r.pen(1_000, 0);
        PenSeriesWriter.PenBudget settled = r.pen(1_000, 1);
        assertTrue(settled.take(100));
        r.retire(zombie);                               // deadline: the pen timed out, its query keeps running
        assertFalse(zombie.take(50));
        assertFalse(settled.isOver(), "the settled later pen keeps its points");
    }

    @Test
    void aFrozenBudgetRefusesWithoutEvicting() {
        ResponseBudget r = new ResponseBudget(100);
        PenSeriesWriter.PenBudget early = r.pen(1_000, 0);
        PenSeriesWriter.PenBudget late = r.pen(1_000, 1);
        assertTrue(late.take(100));
        r.freeze();
        assertFalse(early.take(1), "nothing can be taken once the response is being assembled");
        assertEquals(PenSeriesWriter.PenBudget.Overflow.RETIRED, early.overflow());
        assertFalse(late.isOver(), "and nobody is evicted");
        assertEquals(0, r.remaining());
    }

    @Test
    void anEarlierPensFallbackEvictsALaterPenThatAlreadyFinished() {
        // The budget side of HistoryAssembleTest: k0 over its own cap, k1/k2 finished, k0's fallback in k0's order.
        ResponseBudget r = new ResponseBudget(10_000);
        PenSeriesWriter.PenBudget k0 = r.pen(4_999, 0);
        PenSeriesWriter.PenBudget k1 = r.pen(4_999, 1);
        PenSeriesWriter.PenBudget k2 = r.pen(4_999, 2);
        assertTrue(k1.take(4_500));
        assertTrue(k2.take(4_500));
        assertTrue(k0.take(4_999));
        assertFalse(k0.take(1));
        assertEquals(PenSeriesWriter.PenBudget.Overflow.PEN_CAP, k0.overflow());
        PenSeriesWriter.PenBudget fb = r.pen(3_002, 0);
        assertTrue(fb.take(3_000));
        assertEquals(PenSeriesWriter.PenBudget.Overflow.RESPONSE_CAP, k2.overflow());
        assertFalse(k1.isOver());
        assertEquals(10_000 - 3_000 - 4_500, r.remaining());
    }

    /**
     * Two concurrent writers draining the last remainder (the original race, scaled down): whatever the
     * interleaving, exactly the request-order prefix that fits is served and no point leaks.
     */
    @RepeatedTest(20)
    void concurrentWritersAtTheBoundaryServeTheRequestOrderPrefix() throws Exception {
        int pensN = 6;
        int perPen = 10_000;
        ResponseBudget r = new ResponseBudget(5L * perPen);
        List<PenSeriesWriter.PenBudget> budgets = new ArrayList<>();
        List<PenSeriesWriter> writers = new ArrayList<>();
        for (int i = 0; i < pensN; i++) {
            PenSeriesWriter.PenBudget b = r.pen(1_000_000, i);
            budgets.add(b);
            // Two writers per pen (cache chunks of one pen run as separate queries sharing the pen budget).
            writers.add(new PenSeriesWriter(0, Long.MAX_VALUE, PenSeriesWriter.ValueFilter.NONE, false, b));
            writers.add(new PenSeriesWriter(0, Long.MAX_VALUE, PenSeriesWriter.ValueFilter.NONE, false, b));
        }
        List<Integer> order = new ArrayList<>();
        for (int i = 0; i < writers.size(); i++) {
            order.add(i);
        }
        Collections.shuffle(order);
        ExecutorService pool = Executors.newFixedThreadPool(writers.size());
        CountDownLatch go = new CountDownLatch(1);
        List<Future<?>> fs = new ArrayList<>();
        try {
            for (int idx : order) {
                PenSeriesWriter w = writers.get(idx);
                fs.add(pool.submit(() -> {
                    go.await();
                    for (int k = 0; k < perPen / 2; k++) {
                        w.write(new Object[] {(long) k, 1.0}, GOOD);
                    }
                    return null;
                }));
            }
            go.countDown();
            for (Future<?> f : fs) {
                f.get(30, TimeUnit.SECONDS);
            }
        } finally {
            pool.shutdownNow();
        }
        long served = 0;
        for (int i = 0; i < pensN; i++) {
            PenSeriesWriter.PenBudget b = budgets.get(i);
            if (i < 5) {
                assertFalse(b.isOver(), "pen " + i + " is inside the prefix that fits");
                served += writers.get(2 * i).count() + writers.get(2 * i + 1).count();
            } else {
                assertEquals(PenSeriesWriter.PenBudget.Overflow.RESPONSE_CAP, b.overflow(), "pen 5 does not fit");
            }
        }
        assertEquals(5L * perPen, served);
        assertEquals(0, r.remaining(), "no point leaked from the request budget");
    }
}
