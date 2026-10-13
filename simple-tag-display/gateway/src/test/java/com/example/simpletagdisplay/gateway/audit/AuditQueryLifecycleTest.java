package com.example.simpletagdisplay.gateway.audit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Date;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Collectors;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.inductiveautomation.ignition.common.QualifiedPath;
import com.inductiveautomation.ignition.common.audit.AuditRecord;
import com.inductiveautomation.ignition.common.gson.JsonArray;
import com.inductiveautomation.ignition.common.model.values.QualityCode;
import com.inductiveautomation.ignition.common.util.AuditStatus;
import com.inductiveautomation.ignition.gateway.audit.AuditContext;
import com.inductiveautomation.ignition.gateway.audit.AuditProfile;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;

/** Abandoned change-history queries; attempts pending when the module stops. */
class AuditQueryLifecycleTest {

    private final AuditQueryService svc = new AuditQueryService();
    private final CountDownLatch dbRelease = new CountDownLatch(1);
    private final ScheduledThreadPoolExecutor sched = new ScheduledThreadPoolExecutor(1);

    @AfterEach
    void stop() {
        dbRelease.countDown();
        svc.close();
        sched.shutdownNow();
    }

    /** A "slow audit database": blocks until released, counting the queries that really ran. */
    private java.util.concurrent.Callable<JsonArray> slow(AtomicInteger ran) {
        return () -> {
            ran.incrementAndGet();
            dbRelease.await(10, TimeUnit.SECONDS);
            return new JsonArray();
        };
    }

    // ---- abandoned queries leave the queue and never run ------------------------------------------------------

    @Test
    void aQueryWhoseCallerTimedOutIsRemovedFromTheQueueAndNeverRuns() throws Exception {
        AtomicInteger ran = new AtomicInteger();
        UUID[] sessions = new UUID[9];
        List<CompletableFuture<JsonArray>> fs = new ArrayList<>();
        for (int i = 0; i < sessions.length; i++) {
            sessions[i] = UUID.randomUUID();
            fs.add(svc.submit("q" + i, sessions[i], 200, slow(ran)));
        }
        Thread.sleep(100);
        assertEquals(2, ran.get(), "2 running");
        assertEquals(7, svc.queued(), "7 queued");
        for (CompletableFuture<JsonArray> f : fs) {
            ExecutionException e = assertThrows(ExecutionException.class, () -> f.get(5, TimeUnit.SECONDS));
            assertTrue(e.getCause() instanceof TimeoutException, String.valueOf(e.getCause()));
        }
        Thread.sleep(50);
        assertEquals(0, svc.queued(), "the abandoned tasks left the queue (was: still queued, then run)");
        dbRelease.countDown();
        Thread.sleep(200);
        assertEquals(2, ran.get(), "none of the 7 queued ones reached the database");
        for (UUID s : sessions) {
            assertEquals(0, svc.outstanding(s));
        }
        // the service takes new queries again at once
        CompletableFuture<JsonArray> again = svc.submit("again", UUID.randomUUID(), 2000, () -> new JsonArray());
        assertEquals(0, again.get(5, TimeUnit.SECONDS).size());
    }

    @Test
    void oneSessionCannotFillTheExecutorAndIdenticalQueriesShareOneTask() throws Exception {
        AtomicInteger ran = new AtomicInteger();
        UUID s = UUID.randomUUID();
        CompletableFuture<JsonArray> a = svc.submit("x", s, 5000, slow(ran));
        CompletableFuture<JsonArray> b = svc.submit("y", s, 5000, slow(ran));
        assertThrows(RejectedExecutionException.class, () -> svc.submit("z", s, 5000, slow(ran)),
            "a third outstanding query of the same session is refused (RATE_LIMITED for this session only)");
        // another session asking the same (target, limit) joins the running task
        CompletableFuture<JsonArray> c = svc.submit("x", UUID.randomUUID(), 5000, slow(ran));
        dbRelease.countDown();
        assertEquals(0, a.get(5, TimeUnit.SECONDS).size());
        assertEquals(0, b.get(5, TimeUnit.SECONDS).size());
        assertEquals(0, c.get(5, TimeUnit.SECONDS).size());
        assertEquals(2, ran.get(), "x ran once for both sessions");
        assertEquals(0, svc.outstanding(s));
    }

    @Test
    void aSharedTaskIsKeptWhileAnotherCallerStillWaits() throws Exception {
        AtomicInteger ran = new AtomicInteger();
        CompletableFuture<JsonArray> blocker1 = svc.submit("b1", UUID.randomUUID(), 5000, slow(ran));
        CompletableFuture<JsonArray> blocker2 = svc.submit("b2", UUID.randomUUID(), 5000, slow(ran));
        CompletableFuture<JsonArray> early = svc.submit("x", UUID.randomUUID(), 100, () -> new JsonArray());
        CompletableFuture<JsonArray> patient = svc.submit("x", UUID.randomUUID(), 5000, () -> new JsonArray());
        assertThrows(ExecutionException.class, () -> early.get(5, TimeUnit.SECONDS));
        assertEquals(1, svc.queued(), "still queued for the caller that waits");
        dbRelease.countDown();
        assertEquals(0, patient.get(5, TimeUnit.SECONDS).size());
        blocker1.get(5, TimeUnit.SECONDS);
        blocker2.get(5, TimeUnit.SECONDS);
    }

    // ---- write attempts pending at module stop --------------------------------------------------------------------

    @Test
    void anAttemptStillPendingAtCloseIsRecordedUncertainBeforeTheWriterStops() throws Exception {
        Logger logger = (Logger) LoggerFactory.getLogger("SimpleTagDisplay.Audit");
        ListAppender<ILoggingEvent> appender = new ListAppender<>();
        appender.start();
        logger.addAppender(appender);
        List<String> stored = Collections.synchronizedList(new ArrayList<>());
        AuditProfile profile = new AuditProfile() {
            @Override
            public void audit(AuditRecord r) {
                stored.add(r.getActionValue() + "|" + r.getStatusCode());
            }

            @Override
            public List<AuditRecord> query(String a, String b, String c, String d, Date e, Date f, String g, Integer h) {
                return List.of();
            }
        };
        try {
            CtgAudit audit = new CtgAudit(null, sched, x -> "");
            AuditContext ctx = new AuditContext.Builder().setActor("engineer").setHost("h")
                .setPath(QualifiedPath.of("prj", "CTG_Test")).setTimestamp(new Date()).build();
            CtgAudit.Origin origin = new CtgAudit.Origin("engineer", "h", "CTG_Test", "s", "Client", "V", "0:1", ctx);
            String id = "0b6d1c64-6a59-4c0e-9d36-6f0b0a8c2f12";
            CtgAudit.Attempt a = audit.begin(CtgAudit.ACTION_WRITE, "[default]Dev/SP", origin, id, "x",
                late -> id + (late ? "-late" : ""), Optional.of(profile));
            CompletableFuture<List<QualityCode>> raw = new CompletableFuture<>();   // the device never answers
            a.attach(raw, 60_000);
            assertEquals(1, audit.pendingAttempts());
            sched.shutdownNow();                       // module restart: the UNCERTAIN timer is dropped first
            audit.close();
            assertEquals(1, stored.size(), "recorded in the profile (was: nowhere)");
            assertTrue(stored.get(0).startsWith(id + "|"));
            assertEquals(AuditStatus.UNCERTAIN.getRawValue(), Integer.parseInt(stored.get(0).split("\\|")[1]));
            List<String> lines;
            synchronized (appender.list) {
                lines = appender.list.stream().map(ILoggingEvent::getFormattedMessage)
                    .filter(m -> m.contains("auditId=" + id)).collect(Collectors.toList());
            }
            assertEquals(1, lines.size(), lines.toString());
            assertTrue(lines.get(0).contains("result=ModuleStopping"), lines.get(0));
            assertFalse(lines.get(0).contains("profile=notStored"));
            assertEquals(0, audit.pendingAttempts());
            // the provider answering after the stop still leaves its late log line
            raw.complete(List.of(QualityCode.Good));
            synchronized (appender.list) {
                assertTrue(appender.list.stream().map(ILoggingEvent::getFormattedMessage)
                    .anyMatch(m -> m.contains("auditId=" + id) && m.contains("late=true")));
            }
        } finally {
            logger.detachAppender(appender);
        }
    }

    @Test
    void completedAttemptsLeaveNothingPending() {
        CtgAudit audit = new CtgAudit(null, sched, x -> "");
        AuditContext ctx = new AuditContext.Builder().setActor("e").setHost("h")
            .setPath(QualifiedPath.of("prj", "P")).setTimestamp(new Date()).build();
        CtgAudit.Origin origin = new CtgAudit.Origin("e", "h", "P", "s", "Client", "V", "0:1", ctx);
        CtgAudit.Attempt a = audit.begin(CtgAudit.ACTION_WRITE, "[default]X", origin, "id", "x", late -> "v", Optional.empty());
        CompletableFuture<List<QualityCode>> raw = new CompletableFuture<>();
        a.attach(raw, 60_000);
        raw.complete(List.of(QualityCode.Good));
        assertEquals(0, audit.pendingAttempts());
        audit.close();
        assertSame(0, audit.pendingAttempts());
    }
}
