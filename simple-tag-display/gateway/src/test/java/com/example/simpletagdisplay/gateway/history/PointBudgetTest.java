package com.example.simpletagdisplay.gateway.history;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

import org.junit.jupiter.api.Test;

/** Global point reservation. */
class PointBudgetTest {

    @Test
    void reservesWithinTheLimitAndReleasesOnce() {
        AtomicLong max = new AtomicLong(1_000);
        PointBudget b = new PointBudget(max::get);
        PointBudget.Reservation r1 = b.fixtureReserve(600);
        assertNotNull(r1);
        assertNull(b.fixtureReserve(500), "600 + 500 > 1000");
        PointBudget.Reservation r2 = b.fixtureReserve(400);
        assertNotNull(r2);
        assertEquals(1_000, b.reserved());
        r1.close();
        r1.close();                                             // idempotent
        assertEquals(400, b.reserved());
        assertNull(b.fixtureReserve(2_000), "never admissible alone");
        r2.close();
        assertEquals(0, b.reserved());
    }

    @Test
    void liveLimitChangesApplyToNewReservations() {
        AtomicLong max = new AtomicLong(5_000_000);
        PointBudget b = new PointBudget(max::get);
        PointBudget.Reservation big = b.fixtureReserve(400_000);
        assertNotNull(big);
        max.set(300_000);                                       // lowered live
        assertNull(b.fixtureReserve(1), "already over the lowered limit");
        big.close();
        assertNull(b.fixtureReserve(300_001));
        assertNotNull(b.fixtureReserve(300_000));
    }

    @Test
    void concurrentReservationsNeverExceedTheLimit() throws Exception {
        PointBudget b = new PointBudget(() -> 10_000);
        AtomicInteger granted = new AtomicInteger();
        CountDownLatch go = new CountDownLatch(1);
        List<Thread> threads = new ArrayList<>();
        List<PointBudget.Reservation> held = java.util.Collections.synchronizedList(new ArrayList<>());
        for (int i = 0; i < 16; i++) {
            Thread t = new Thread(() -> {
                try {
                    go.await();
                } catch (InterruptedException e) {
                    return;
                }
                for (int k = 0; k < 100; k++) {
                    PointBudget.Reservation r = b.fixtureReserve(100);
                    if (r != null) {
                        granted.incrementAndGet();
                        held.add(r);
                    }
                }
            });
            threads.add(t);
            t.start();
        }
        go.countDown();
        for (Thread t : threads) {
            t.join();
        }
        assertEquals(100, granted.get(), "exactly 10 000 / 100 reservations fit");
        assertEquals(10_000, b.reserved());
        held.forEach(PointBudget.Reservation::close);
        assertEquals(0, b.reserved());
    }

    /**
     * The session-less reservation skipped every tier and was reached only from
     * tests; a later product caller could have bypassed the reserve and the small reserve by mistake. It is no longer
     * public, and no product source may call the fixture that replaced it.
     */
    @Test
    void noUnattributedReservationInProductCode() throws IOException {
        for (Method m : PointBudget.class.getDeclaredMethods()) {
            boolean sessionLess = m.getReturnType() == PointBudget.Reservation.class && m.getParameterCount() == 1
                && m.getParameterTypes()[0] == long.class;
            assertTrue(!sessionLess || !Modifier.isPublic(m.getModifiers()),
                "a public session-less reservation: " + m + " (old code: public tryReserve(long))");
        }
        Path main = Paths.get("src", "main", "java");
        if (!Files.isDirectory(main)) {
            main = Paths.get("gateway", "src", "main", "java");
        }
        assertTrue(Files.isDirectory(main), "product sources at " + main.toAbsolutePath());
        List<String> callers;
        try (Stream<Path> files = Files.walk(main)) {
            callers = files.filter(f -> f.toString().endsWith(".java") && !f.getFileName().toString().equals("PointBudget.java"))
                .filter(f -> {
                    try {
                        return Files.readString(f).contains("fixtureReserve(");
                    } catch (IOException e) {
                        throw new IllegalStateException(e);
                    }
                })
                .map(Path::toString).collect(Collectors.toList());
        }
        assertEquals(List.of(), callers, "product code calls the JUnit-only fixture");
    }
}
