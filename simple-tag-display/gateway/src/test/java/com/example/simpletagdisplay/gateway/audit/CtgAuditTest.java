package com.example.simpletagdisplay.gateway.audit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Date;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

import com.inductiveautomation.ignition.common.QualifiedPath;
import com.inductiveautomation.ignition.common.audit.AuditRecord;
import com.inductiveautomation.ignition.common.audit.DefaultAuditRecord;
import com.inductiveautomation.ignition.common.gson.JsonArray;
import com.inductiveautomation.ignition.common.model.values.QualityCode;
import com.inductiveautomation.ignition.common.util.AuditStatus;
import com.inductiveautomation.ignition.gateway.audit.AuditContext;
import com.inductiveautomation.ignition.gateway.audit.AuditProfile;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/** Audit value formatting (255 cap keeps the auditId) and the raw-future attempt state machine. */
class CtgAuditTest {

    private static final String ID = "0b6d1c64-6a59-4c0e-9d36-6f0b0a8c2f11";
    private final ScheduledThreadPoolExecutor sched = new ScheduledThreadPoolExecutor(1);

    private final List<CtgAudit> audits = new ArrayList<>();

    @AfterEach
    void stop() {
        sched.shutdownNow();
        audits.forEach(CtgAudit::close);
    }

    @Test
    void writeValueFormat() {
        assertEquals("72.5 (was 75.0) [ui=popup] [auditId=" + ID + "]", CtgAudit.writeValue("72.5", "75.0", "popup", ID, false));
        assertEquals("72.5 (was 75.0) [ui=direct] [auditId=" + ID + ", late=true]",
            CtgAudit.writeValue("72.5", "75.0", "direct", ID, true));
        assertEquals("a?b (was null) [ui=unknown] [auditId=" + ID + "]", CtgAudit.writeValue("a\nb", null, "unknown", ID, false));
    }

    @Test
    void capKeepsTheAuditIdSuffix() {
        String v = CtgAudit.writeValue("x".repeat(400), "y".repeat(400), "popup", ID, true);
        assertEquals(CtgAudit.MAX_VALUE_CHARS, v.length());
        assertTrue(v.endsWith("[ui=popup] [auditId=" + ID + ", late=true]"), v);
        assertTrue(v.contains("..."));
        String e = CtgAudit.editValue("EngUnit: '" + "u".repeat(300) + "' -> 'degC'", ID, false);
        assertTrue(e.length() <= CtgAudit.MAX_VALUE_CHARS);
        assertTrue(e.endsWith("[auditId=" + ID + "]"));
        assertEquals("EngUnit: 'degF' -> 'degC'; EngHigh: 100.0 -> 150.0 [auditId=" + ID + "]",
            CtgAudit.editValue("EngUnit: 'degF' -> 'degC'; EngHigh: 100.0 -> 150.0", ID, false));
    }

    /** Captures records. */
    private static class Profile implements AuditProfile {
        final List<AuditRecord> records = Collections.synchronizedList(new ArrayList<>());

        @Override
        public void audit(AuditRecord r) {
            records.add(r);
        }

        @Override
        public List<AuditRecord> query(String a, String b, String c, String d, Date e, Date f, String g, Integer h) {
            return List.copyOf(records);
        }
    }

    private CtgAudit.Attempt attempt(Profile p) {
        CtgAudit audit = new CtgAudit(null, sched, x -> "");
        audits.add(audit);
        AuditContext ctx = new AuditContext.Builder().setActor("engineer").setHost("10.0.0.5")
            .setPath(QualifiedPath.of("prj", "CTG_Test")).setTimestamp(new Date()).build();
        CtgAudit.Origin origin = new CtgAudit.Origin("engineer", "10.0.0.5", "CTG_Test", "s", "Client", "Area1/Faceplate", "0:1", ctx);
        return audit.begin(CtgAudit.ACTION_WRITE, "[default]CTG/TempSP", origin, ID, "old=75.0 new=72.5 ui=popup",
            late -> CtgAudit.writeValue("72.5", "75.0", "popup", ID, late), Optional.of(p));
    }

    private static void await(Profile p, int n) throws InterruptedException {
        for (int i = 0; i < 200 && p.records.size() < n; i++) {
            Thread.sleep(10);
        }
    }

    @Test
    void completionBeforeTheTimeoutGivesExactlyOneRecord() throws Exception {
        Profile p = new Profile();
        CompletableFuture<List<QualityCode>> raw = new CompletableFuture<>();
        attempt(p).attach(raw, 5_000);
        raw.complete(List.of(QualityCode.Good));
        await(p, 1);
        Thread.sleep(50);
        assertEquals(1, p.records.size());
        AuditRecord r = p.records.get(0);
        assertEquals("tag write", r.getAction());
        assertEquals("[default]CTG/TempSP", r.getActionTarget());
        assertEquals("engineer", r.getActor());
        assertEquals(AuditStatus.GOOD.getRawValue(), r.getStatusCode());
        assertFalse(r.getActionValue().contains("late=true"));
    }

    @Test
    void failedWriteIsBad() throws Exception {
        Profile p = new Profile();
        CompletableFuture<List<QualityCode>> raw = new CompletableFuture<>();
        attempt(p).attach(raw, 5_000);
        raw.complete(List.of(QualityCode.Bad_AccessDenied));
        await(p, 1);
        assertEquals(AuditStatus.BAD.getRawValue(), p.records.get(0).getStatusCode());
    }

    @Test
    void stalledProviderGivesUncertainThenALateFinalRecord() throws Exception {
        Profile p = new Profile();
        CompletableFuture<List<QualityCode>> raw = new CompletableFuture<>();
        attempt(p).attach(raw, 100);
        await(p, 1);
        assertEquals(1, p.records.size());
        assertEquals(AuditStatus.UNCERTAIN.getRawValue(), p.records.get(0).getStatusCode());
        raw.complete(List.of(QualityCode.Good));
        await(p, 2);
        assertEquals(2, p.records.size());
        assertEquals(AuditStatus.GOOD.getRawValue(), p.records.get(1).getStatusCode());
        assertTrue(p.records.get(1).getActionValue().endsWith(", late=true]"));
        raw.complete(List.of(QualityCode.Bad));   // already complete: nothing more
        sched.awaitTermination(100, TimeUnit.MILLISECONDS);
        assertEquals(2, p.records.size());
    }

    /**
     * A blocked audit profile (slow database / remote profile) must not hold the module scheduler,
     * which also carries the coalesced pushes and heartbeats; records still arrive in order once it unblocks.
     */
    @Test
    void slowProfileDoesNotBlockTheScheduler() throws Exception {
        java.util.concurrent.CountDownLatch release = new java.util.concurrent.CountDownLatch(1);
        Profile p = new Profile() {
            @Override
            public void audit(AuditRecord r) {
                try {
                    release.await(5, TimeUnit.SECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
                super.audit(r);
            }
        };
        CompletableFuture<List<QualityCode>> raw = new CompletableFuture<>();
        attempt(p).attach(raw, 50);                  // UNCERTAIN after 50 ms -> blocks in audit()
        Thread.sleep(150);
        CompletableFuture<Long> probe = new CompletableFuture<>();
        long t0 = System.nanoTime();
        sched.execute(() -> probe.complete(System.nanoTime() - t0));
        long waitedMs = TimeUnit.NANOSECONDS.toMillis(probe.get(2, TimeUnit.SECONDS));
        assertTrue(waitedMs < 500, "scheduler blocked for " + waitedMs + " ms");
        raw.complete(List.of(QualityCode.Good));     // late final record queued behind the blocked one
        release.countDown();
        await(p, 2);
        assertEquals(2, p.records.size());
        assertEquals(AuditStatus.UNCERTAIN.getRawValue(), p.records.get(0).getStatusCode());
        assertEquals(AuditStatus.GOOD.getRawValue(), p.records.get(1).getStatusCode());
        assertTrue(p.records.get(1).getActionValue().endsWith(", late=true]"));
    }

    /**
     * With the writer backlog full (profile stuck), the deciding thread (provider completion /
     * ctg-sched) must not run {@code profile.audit} itself — only the logger line — and must return at once.
     */
    @Test
    void overflowNeverRunsTheProfileOnTheDecidingThread() throws Exception {
        java.util.concurrent.CountDownLatch release = new java.util.concurrent.CountDownLatch(1);
        List<String> threads = Collections.synchronizedList(new ArrayList<>());
        Profile p = new Profile() {
            @Override
            public void audit(AuditRecord r) {
                threads.add(Thread.currentThread().getName());
                try {
                    release.await(10, TimeUnit.SECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
                super.audit(r);
            }
        };
        CtgAudit audit = new CtgAudit(null, sched, x -> "");
        audits.add(audit);
        AuditContext ctx = new AuditContext.Builder().setActor("engineer").setHost("h")
            .setPath(QualifiedPath.of("prj", "CTG_Test")).setTimestamp(new Date()).build();
        CtgAudit.Origin origin = new CtgAudit.Origin("engineer", "h", "CTG_Test", "s", "Client", "Area1/Faceplate", "0:1", ctx);
        int total = 1 + 1024 + 5;   // 1 running (blocked) + full queue + 5 overflowing
        long worstMs = 0;
        for (int i = 0; i < total; i++) {
            CtgAudit.Attempt a = audit.begin(CtgAudit.ACTION_WRITE, "[default]CTG/TempSP", origin, ID, "x",
                late -> "v", Optional.of(p));
            long t0 = System.nanoTime();
            a.failedBeforeProvider("Exception");
            worstMs = Math.max(worstMs, TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - t0));
            if (i == 0) {
                for (int k = 0; k < 200 && threads.isEmpty(); k++) {
                    Thread.sleep(5);   // let the writer pick up the first record and block in audit()
                }
            }
        }
        assertTrue(worstMs < 500, "deciding thread blocked for " + worstMs + " ms");
        release.countDown();
        await(p, total - 5);
        Thread.sleep(100);
        assertEquals(total - 5, p.records.size(), "overflowing attempts are logged only, not stored");
        assertTrue(threads.stream().allMatch(n -> n.startsWith("ctg-audit-write-")), "profile only on the writer");
    }

    @Test
    void auditQueryRowsFilterSortAndLimit() {
        long t = 1_000_000L;
        List<AuditRecord> in = new ArrayList<>();
        in.add(rec("tag write", "[default]CTG/TempSP", "72.5 (was 75.0) [ui=popup] [auditId=" + ID + "]", t + 10, AuditStatus.GOOD));
        in.add(rec("tag write", "[default]CTG/TempSPX", "x", t + 20, AuditStatus.GOOD));          // LIKE '_' false positive
        in.add(rec("tag edit", "[default]ctg/tempsp", "EngUnit: 'a' -> 'b' [auditId=x]", t + 30, AuditStatus.BAD));
        in.add(rec("login", "[default]CTG/TempSP", "", t + 40, AuditStatus.GOOD));                // other action
        in.add(rec("tag write", "[default]CTG/TempSP", "1 (was 2) [ui=direct] [auditId=" + ID + ", late=true]", t + 5,
            AuditStatus.UNCERTAIN));
        JsonArray rows = AuditQueryService.rows(in, "[default]CTG/TempSP", 20);
        assertEquals(3, rows.size());
        assertEquals(t + 30, rows.get(0).getAsJsonObject().get("t").getAsLong(), "newest first");
        assertEquals("bad", rows.get(0).getAsJsonObject().get("status").getAsString());
        assertEquals("good", rows.get(1).getAsJsonObject().get("status").getAsString());
        assertEquals(ID, rows.get(1).getAsJsonObject().get("auditId").getAsString());
        assertEquals("uncertain", rows.get(2).getAsJsonObject().get("status").getAsString());
        assertEquals(2, AuditQueryService.rows(in, "[default]CTG/TempSP", 2).size());
        assertEquals(0, AuditQueryService.rows(null, "x", 5).size());
    }

    /** Change History takes only the module's trailing suffix, never an id inside a written String. */
    @Test
    void auditIdComesOnlyFromTheTrailingSuffix() {
        String fakeA = "aaaaaaaa-1111-4222-8333-444444444444";
        String fakeB = "bbbbbbbb-1111-4222-8333-444444444444";
        // genuine records of every kind
        assertEquals(ID, AuditQueryService.auditIdOf(CtgAudit.writeValue("72.5", "75.0", "popup", ID, false)));
        assertEquals(ID, AuditQueryService.auditIdOf(CtgAudit.writeValue("72.5", "75.0", "direct", ID, true)));
        assertEquals(ID, AuditQueryService.auditIdOf(CtgAudit.editValue("EngUnit: 'a' -> 'b'", ID, false)));
        assertEquals(ID, AuditQueryService.auditIdOf(CtgAudit.annotationValue("note", ID, true)));
        assertEquals(ID.toUpperCase(), AuditQueryService.auditIdOf("1 (was 2) [ui=popup] [auditId=" + ID.toUpperCase() + "]"));
        // ids injected into the written String value (new and previous value), short and truncated records
        String injected = CtgAudit.writeValue("INJ [auditId=" + fakeA + "] (was y) [ui=popup] [auditId=" + fakeB + "]",
            "[auditId=" + fakeB + ", late=true]", "popup", ID, false);
        assertEquals(ID, AuditQueryService.auditIdOf(injected), injected);
        String cut = CtgAudit.writeValue(("[auditId=" + fakeA + "] ").repeat(10), "x", "popup", ID, true);
        assertEquals(CtgAudit.MAX_VALUE_CHARS, cut.length());
        assertEquals(ID, AuditQueryService.auditIdOf(cut), cut);
        // anything that does not END with the suffix has no id
        assertEquals(null, AuditQueryService.auditIdOf("[auditId=" + fakeA + "] tail"));
        assertEquals(null, AuditQueryService.auditIdOf("x [auditId=" + fakeA + "]\n"));
        assertEquals(null, AuditQueryService.auditIdOf("x [auditId=" + fakeA + "] "));
        assertEquals(null, AuditQueryService.auditIdOf("x [auditId=0b6d1c64]"), "not a UUID");
        assertEquals(null, AuditQueryService.auditIdOf("x [auditId=" + fakeA + ", late=yes]"));
        assertEquals(null, AuditQueryService.auditIdOf("x [auditId=" + fakeA + "]]"));
        assertEquals(null, AuditQueryService.auditIdOf(""));
        assertEquals(null, AuditQueryService.auditIdOf(null));
        // through the rows: the injected record reports the real id
        List<AuditRecord> in = new ArrayList<>();
        in.add(rec("tag write", "[default]CTG/Label", injected, 1_000L, AuditStatus.GOOD));
        in.add(rec("tag write", "[default]CTG/Label", "typed [auditId=" + fakeA + "] then text", 2_000L, AuditStatus.GOOD));
        JsonArray rows = AuditQueryService.rows(in, "[default]CTG/Label", 20);
        assertEquals(2, rows.size());
        assertFalse(rows.get(0).getAsJsonObject().has("auditId"), "an id inside the value is not taken");
        assertEquals(ID, rows.get(1).getAsJsonObject().get("auditId").getAsString());
    }

    private static AuditRecord rec(String action, String target, String value, long t, AuditStatus s) {
        return DefaultAuditRecord.newBuilder().action(action).actionTarget(target).actionValue(value).actor("engineer")
            .actorHost("h").statusCode(s.getRawValue()).timestamp(new Date(t)).originatingSystem("g").build();
    }
}
