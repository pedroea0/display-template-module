package com.example.simpletagdisplay.gateway.audit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Date;
import java.util.List;
import java.util.Optional;
import java.util.Random;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.inductiveautomation.ignition.common.QualifiedPath;
import com.inductiveautomation.ignition.common.audit.AuditRecord;
import com.inductiveautomation.ignition.common.audit.DefaultAuditRecord;
import com.inductiveautomation.ignition.common.gson.JsonArray;
import com.inductiveautomation.ignition.common.model.values.QualityCode;
import com.inductiveautomation.ignition.common.util.AuditStatus;
import com.inductiveautomation.ignition.gateway.audit.AuditContext;
import com.inductiveautomation.ignition.gateway.audit.AuditProfile;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;

/**
 * {@code ctg.audit.required} refuses while the audit writer cannot take the records; logger lines stay in decision
 * order on overflow; overflow drops are always reported; the change history keeps the newest rows of a result of any
 * size and order in O(limit) memory.
 */
class CtgAuditOverflowTest {

    private static final String ID = "0b6d1c64-6a59-4c0e-9d36-6f0b0a8c2f11";
    private final ScheduledThreadPoolExecutor sched = new ScheduledThreadPoolExecutor(1);
    private final List<CtgAudit> audits = new ArrayList<>();
    private final CountDownLatch release = new CountDownLatch(1);
    private final List<String> stored = Collections.synchronizedList(new ArrayList<>());
    private ListAppender<ILoggingEvent> appender;
    private Logger logger;

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

    @BeforeEach
    void capture() {
        logger = (Logger) LoggerFactory.getLogger("SimpleTagDisplay.Audit");
        appender = new ListAppender<>();
        appender.start();
        logger.addAppender(appender);
    }

    @AfterEach
    void stop() {
        release.countDown();
        logger.detachAppender(appender);
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

    private CtgAudit.Attempt attempt(CtgAudit audit, String id) {
        return audit.begin(CtgAudit.ACTION_WRITE, "[default]CTG/TempSP", origin(), id, "x", late -> id + (late ? "-late" : ""),
            Optional.of(stuck));
    }

    /** Blocks the writer thread in audit() and queues records until {@code free} queue slots are left. */
    private void fill(CtgAudit audit, int free) throws InterruptedException {
        attempt(audit, "blocker").failedBeforeProvider("Exception");
        Thread.sleep(100);                              // the writer took it and blocks in audit()
        int n = 1024 - free;
        for (int i = 0; i < n; i++) {
            attempt(audit, "q" + i).failedBeforeProvider("Exception");
        }
    }

    private List<String> lines(String contains) {
        synchronized (appender.list) {
            return appender.list.stream().map(ILoggingEvent::getFormattedMessage).filter(m -> m.contains(contains))
                .collect(Collectors.toList());
        }
    }

    // ---- ctg.audit.required ---------------------------------------------------------------------------------

    @Test
    void requiredRefusesWhileTheWriterIsFullAndOnlyThen() throws Exception {
        CtgAudit audit = audit();
        Optional<AuditProfile> p = Optional.of(stuck);
        assertTrue(audit.canStore());
        assertFalse(audit.refuses(true, p), "healthy writer: the write goes through");
        assertTrue(audit.refuses(true, Optional.empty()), "no profile: refused (unchanged)");
        fill(audit, 1);
        assertFalse(audit.canStore(), "one free slot is not enough for a record and its late record");
        assertTrue(audit.refuses(true, p), "required + backlogged writer → AUDIT_UNAVAILABLE");
        assertFalse(audit.refuses(false, p), "not required: the write goes through, logged only");
        release.countDown();
        for (int i = 0; i < 300 && !audit.canStore(); i++) {
            Thread.sleep(10);
        }
        assertTrue(audit.canStore(), "drained");
        assertFalse(audit.refuses(true, p));
    }

    @Test
    void requiredRefusesWhenTheWriterIsStopped() {
        CtgAudit audit = audit();
        audit.close();
        assertFalse(audit.canStore());
        assertTrue(audit.refuses(true, Optional.of(stuck)));
    }

    // ---- logger line order on overflow ----------------------------------------------------------------------

    @Test
    void anAttemptsLogLinesStayInDecisionOrderWhenItsLateRecordOverflows() throws Exception {
        CtgAudit audit = audit();
        fill(audit, 1);                                 // room for exactly one more record
        CtgAudit.Attempt a = attempt(audit, ID);
        CompletableFuture<List<QualityCode>> raw = new CompletableFuture<>();
        a.attach(raw, 30);
        Thread.sleep(200);                              // Pending: queued (the last slot), its line written now
        raw.complete(List.of(QualityCode.Good));        // late final: the queue is full → dropped, line inline
        List<String> mine = lines("auditId=" + ID);
        assertEquals(2, mine.size(), mine.toString());
        assertTrue(mine.get(0).contains("result=Pending"), "Pending first: " + mine);
        assertFalse(mine.get(0).contains("profile=notStored"), "the Pending record was queued");
        assertTrue(mine.get(1).contains("late=true"), "then the late final line: " + mine);
        assertTrue(mine.get(1).contains("profile=notStored"));
        release.countDown();
        for (int i = 0; i < 300 && !stored.contains(ID); i++) {
            Thread.sleep(10);
        }
        assertTrue(stored.contains(ID), "the Pending record reached the profile");
        assertFalse(stored.contains(ID + "-late"), "the dropped late record did not");
    }

    // ---- overflow counting ----------------------------------------------------------------------------------

    @Test
    void dropsAfterTheLastOverflowWarnAreReportedAtClose() throws Exception {
        CtgAudit audit = audit();
        fill(audit, 0);
        for (int i = 0; i < 3; i++) {
            attempt(audit, "over" + i).failedBeforeProvider("Exception");
        }
        List<String> warns = lines("action=audit-overflow");
        assertEquals(1, warns.size(), "one WARN per minute: " + warns);
        assertTrue(warns.get(0).contains("dropped=1"), warns.get(0));
        assertEquals(2, audit.overflowCount(), "the next two are pending");
        release.countDown();
        audit.close();
        warns = lines("action=audit-overflow");
        assertEquals(2, warns.size(), "close() reports the pending drops: " + warns);
        assertTrue(warns.get(1).contains("dropped=2"), warns.get(1));
        assertEquals(0, audit.overflowCount());
    }

    // ---- change history: newest rows, bounded memory -------------------------------------------------------

    private static AuditRecord rec(String target, long t) {
        return DefaultAuditRecord.newBuilder().action("tag write").actionTarget(target).actionValue("v " + t)
            .actor("engineer").actorHost("h").statusCode(AuditStatus.GOOD.getRawValue()).timestamp(new Date(t))
            .originatingSystem("g").build();
    }

    @Test
    void theNewestRowsSurviveAResultLargerThanTheOldScanCapInAnyOrder() {
        // 30 000 matching records (the old code stopped after 20 000, before sorting) in a shuffled order.
        List<AuditRecord> in = new ArrayList<>();
        for (int i = 0; i < 30_000; i++) {
            in.add(rec("[default]CTG/TempSP", 1_000_000L + i));
            if (i % 3 == 0) {
                in.add(rec("[default]CTG/TempSPX", 9_000_000L + i));   // other tag (LIKE '_' false positive)
            }
        }
        Collections.shuffle(in, new Random(7));
        in.sort((a, b) -> Long.compare(a.getTimestamp().getTime() % 7, b.getTimestamp().getTime() % 7)); // newest late
        AuditQueryService.TopRecords top = new AuditQueryService.TopRecords("[default]CTG/TempSP", 20);
        int maxHeld = 0;
        for (AuditRecord r : in) {
            top.offer(r);
            maxHeld = Math.max(maxHeld, top.held());
        }
        assertEquals(in.size(), top.seen(), "no early break");
        assertTrue(maxHeld <= 20, "O(limit) memory: " + maxHeld);
        JsonArray rows = top.rows();
        assertEquals(20, rows.size());
        for (int i = 0; i < 20; i++) {
            assertEquals(1_000_000L + 29_999 - i, rows.get(i).getAsJsonObject().get("t").getAsLong(), "row " + i);
        }
        assertEquals(rows, AuditQueryService.rows(in, "[default]CTG/TempSP", 20), "list form = streaming form");
    }

    @Test
    void theStreamingFormIsUsedWhenTheGatewayHasIt() {
        // The SDK the tests compile against (8.3.1) lacks QueryRequest: the service must fall back to the 8-arg form.
        boolean streaming;
        try {
            Class.forName("com.inductiveautomation.ignition.gateway.audit.AuditProfile$QueryRequest");
            streaming = true;
        } catch (ClassNotFoundException e) {
            streaming = false;
        }
        AuditQueryService.TopRecords top = new AuditQueryService.TopRecords("[default]CTG/TempSP", 5);
        AuditProfile p = new AuditProfile() {
            @Override
            public void audit(AuditRecord r) {
            }

            @Override
            public List<AuditRecord> query(String a, String b, String c, String d, Date e, Date f, String g, Integer h) {
                return List.of(rec("[default]CTG/TempSP", 1L));
            }
        };
        try {
            boolean used = AuditQueryService.Streaming.query(p, "[default]CTG/TempSP", new Date(0), new Date(), top);
            assertEquals(streaming, used);
            if (used) {
                assertEquals(1, top.rows().size(), "the default streaming method delegates to the 8-arg query");
            }
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }
}
