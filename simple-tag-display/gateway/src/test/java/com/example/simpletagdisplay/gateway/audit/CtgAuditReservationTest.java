package com.example.simpletagdisplay.gateway.audit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Date;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import com.inductiveautomation.ignition.common.QualifiedPath;
import com.inductiveautomation.ignition.common.audit.AuditRecord;
import com.inductiveautomation.ignition.common.model.values.QualityCode;
import com.inductiveautomation.ignition.gateway.audit.AuditContext;
import com.inductiveautomation.ignition.gateway.audit.AuditProfile;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/**
 * Under {@code ctg.audit.required} the {@code AUDIT_UNAVAILABLE} refusal is atomic. {@link CtgAudit#refuses} is only
 * advisory; {@link CtgAudit#reserve} books the attempt's record and its possible late record in one compare-and-set,
 * so concurrent attempts can never both pass on the last free slots and a booked record is never dropped.
 */
class CtgAuditReservationTest {

    private final ScheduledThreadPoolExecutor sched = new ScheduledThreadPoolExecutor(1);
    private final List<CtgAudit> audits = new ArrayList<>();
    private final CountDownLatch release = new CountDownLatch(1);
    private final List<String> stored = Collections.synchronizedList(new ArrayList<>());

    /** A profile that blocks in audit() until the test releases it. */
    private final AuditProfile stuck = new AuditProfile() {
        @Override
        public void audit(AuditRecord r) {
            try {
                release.await(10, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            stored.add(r.getActionValue());
        }

        @Override
        public List<AuditRecord> query(String a, String b, String c, String d, Date e, Date f, String g, Integer h) {
            return List.of();
        }
    };

    @AfterEach
    void stop() {
        release.countDown();
        sched.shutdownNow();
        audits.forEach(CtgAudit::close);
    }

    private CtgAudit audit() {
        CtgAudit a = new CtgAudit(null, sched, x -> "");
        audits.add(a);
        return a;
    }

    private static CtgAudit.Origin origin() {
        AuditContext ctx = new AuditContext.Builder().setActor("engineer").setHost("h")
            .setPath(QualifiedPath.of("prj", "CTG_Test")).setTimestamp(new Date()).build();
        return new CtgAudit.Origin("engineer", "h", "CTG_Test", "s", "Client", "Area1/Faceplate", "0:1", ctx);
    }

    private CtgAudit.Attempt attempt(CtgAudit audit, String id, CtgAudit.Reservation r) {
        return audit.begin(CtgAudit.ACTION_WRITE, "[default]CTG/TempSP", origin(), id, "x", late -> id + (late ? "-late" : ""),
            Optional.of(stuck), r);
    }

    /** Blocks the writer in audit() and queues unbooked records until {@code free} slots are left. */
    private void fill(CtgAudit audit, int free) throws InterruptedException {
        attempt(audit, "blocker", null).failedBeforeProvider("Exception");
        Thread.sleep(100);
        for (int i = 0; i < 1024 - free; i++) {
            attempt(audit, "q" + i, null).failedBeforeProvider("Exception");
        }
    }

    @Test
    void concurrentAttemptsCannotBothTakeTheLastSlots() throws Exception {
        CtgAudit audit = audit();
        fill(audit, 3);                                   // room for ONE attempt (2 slots), not two
        Optional<AuditProfile> p = Optional.of(stuck);
        assertFalse(audit.refuses(true, p), "the advisory check passes for everybody …");
        int threads = 16;
        CyclicBarrier go = new CyclicBarrier(threads);
        AtomicInteger granted = new AtomicInteger();
        List<Thread> ts = new ArrayList<>();
        for (int i = 0; i < threads; i++) {
            Thread t = new Thread(() -> {
                try {
                    go.await();
                    if (audit.reserve(true, p) != null) {
                        granted.incrementAndGet();
                    }
                } catch (Exception e) {
                    throw new AssertionError(e);
                }
            });
            ts.add(t);
            t.start();
        }
        for (Thread t : ts) {
            t.join(5_000);
        }
        assertEquals(1, granted.get(), "… but exactly one attempt books the slots");
        assertEquals(1023, audit.slotsInUse(), "1021 queued + 2 booked");
        assertNull(audit.reserve(true, p), "one free slot is not enough");
        assertTrue(audit.refuses(true, p));
    }

    @Test
    void aBookedAttemptKeepsItsRecordsWhenOthersFillTheQueue() throws Exception {
        CtgAudit audit = audit();
        fill(audit, 10);
        CtgAudit.Reservation r = audit.reserve(true, Optional.of(stuck));
        assertNotNull(r);
        assertEquals(2, r.credits());
        for (int i = 0; i < 8; i++) {
            attempt(audit, "other" + i, null).failedBeforeProvider("Exception");   // unbooked: take the free slots
        }
        assertEquals(1024, audit.slotsInUse(), "queue + booked = full");
        attempt(audit, "late-comer", null).failedBeforeProvider("Exception");      // dropped (overflow)
        CtgAudit.Attempt a = attempt(audit, "BOOKED", r);
        CompletableFuture<List<QualityCode>> raw = new CompletableFuture<>();
        a.attach(raw, 30);
        Thread.sleep(200);                                // Pending record: uses booked slot 1
        raw.complete(List.of(QualityCode.Good));          // late record: uses booked slot 2
        assertEquals(0, r.credits());
        release.countDown();
        for (int i = 0; i < 500 && !(stored.contains("BOOKED") && stored.contains("BOOKED-late")); i++) {
            Thread.sleep(10);
        }
        assertTrue(stored.contains("BOOKED"), "the booked Pending record reached the profile");
        assertTrue(stored.contains("BOOKED-late"), "and so did the booked late record");
        assertFalse(stored.contains("late-comer"), "the unbooked one over capacity was dropped");
        for (int i = 0; i < 300 && audit.slotsInUse() > 0; i++) {
            Thread.sleep(10);
        }
        assertEquals(0, audit.slotsInUse(), "every slot is free again once the writer drained");
    }

    @Test
    void unusedSlotsAreGivenBackWhenTheAttemptEnds() throws Exception {
        CtgAudit audit = audit();
        CtgAudit.Reservation r = audit.reserve(true, Optional.of(stuck));
        assertEquals(2, audit.slotsInUse());
        CtgAudit.Attempt a = attempt(audit, "quick", r);
        CompletableFuture<List<QualityCode>> raw = new CompletableFuture<>();
        a.attach(raw, 60_000);
        raw.complete(List.of(QualityCode.Good));          // one record, no late one
        assertEquals(0, r.credits(), "the second slot is released at once");
        CtgAudit.Reservation r2 = audit.reserve(true, Optional.of(stuck));
        attempt(audit, "early", r2).failedBeforeProvider("Exception");
        assertEquals(0, r2.credits());
        release.countDown();
        for (int i = 0; i < 300 && audit.slotsInUse() > 0; i++) {
            Thread.sleep(10);
        }
        assertEquals(0, audit.slotsInUse());
    }

    @Test
    void notRequiredNeverRefusesAndNoProfileOrAStoppedWriterRefuses() {
        CtgAudit audit = audit();
        CtgAudit.Reservation none = audit.reserve(false, Optional.empty());
        assertNotNull(none, "not required: never refused");
        assertEquals(0, none.credits());
        assertNull(audit.reserve(true, Optional.empty()), "required without a profile");
        audit.close();
        assertNull(audit.reserve(true, Optional.of(stuck)), "required with a stopped writer");
    }
}