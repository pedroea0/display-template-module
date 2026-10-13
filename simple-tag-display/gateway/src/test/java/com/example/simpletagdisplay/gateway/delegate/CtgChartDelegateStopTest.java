package com.example.simpletagdisplay.gateway.delegate;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

import com.example.simpletagdisplay.gateway.GatewayServices;
import com.example.simpletagdisplay.gateway.ModuleSettings;
import com.example.simpletagdisplay.gateway.browse.TagBrowseService;
import com.example.simpletagdisplay.gateway.browse.TagSearchAdmission;
import com.example.simpletagdisplay.gateway.tags.TagSubscriber;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/**
 * The chart delegate's teardown returns a running tag search's gateway-wide admission slot even when an earlier
 * teardown step throws. The REAL {@code CtgChartDelegate.stop()} runs on an instance made without its constructor (a
 * Perspective component is not available in a unit test): its tag subscriber is an uninitialised
 * {@link TagSubscriber} whose {@code release()} throws, its tag browser holds an admission ticket.
 */
class CtgChartDelegateStopTest {

    private final Map<String, String> settings = new ConcurrentHashMap<>();
    private final GatewayServices services = new GatewayServices(null, null, new ModuleSettings(settings::get));

    @AfterEach
    void close() {
        services.close();
    }

    private static Object unsafeInstance(Class<?> c) throws Exception {
        Field f = Class.forName("sun.misc.Unsafe").getDeclaredField("theUnsafe");
        f.setAccessible(true);
        Object unsafe = f.get(null);
        return unsafe.getClass().getMethod("allocateInstance", Class.class).invoke(unsafe, c);
    }

    private static void set(Object target, String name, Object value) throws Exception {
        Field f = CtgChartDelegate.class.getDeclaredField(name);
        f.setAccessible(true);
        f.set(target, value);
    }

    @Test
    void aThrowingTeardownStepDoesNotLeakTheSearchSlot() throws Exception {
        TagSearchAdmission admission = TagSearchAdmission.of(services);
        TagSearchAdmission.Ticket ticket = admission.tryAcquire(UUID.randomUUID()).ticket();
        TagBrowseService browser = new TagBrowseService();
        Field t = TagBrowseService.class.getDeclaredField("ticket");
        t.setAccessible(true);
        t.set(browser, ticket);
        assertEquals(1, admission.running());

        CtgChartDelegate d = (CtgChartDelegate) unsafeInstance(CtgChartDelegate.class);
        set(d, "subscriber", unsafeInstance(TagSubscriber.class));   // release() -> NullPointerException
        set(d, "browser", browser);
        assertThrows(NullPointerException.class, d::stop, "the first failure still reaches the base teardown's log");
        assertEquals(0, admission.running(), "the slot was returned anyway (old code: leaked until a module restart)");
    }

    @Test
    void teardownStepsRunEveryStepAndRethrowTheFirstFailure() {
        List<String> ran = new ArrayList<>();
        IllegalStateException e = assertThrows(IllegalStateException.class, () -> CtgChartDelegate.teardownSteps(
            () -> ran.add("a"),
            () -> {
                ran.add("b");
                throw new IllegalStateException("b");
            },
            () -> {
                ran.add("c");
                throw new IllegalArgumentException("c");
            },
            () -> ran.add("d")));
        assertEquals(List.of("a", "b", "c", "d"), ran);
        assertEquals("b", e.getMessage());
        assertEquals(1, e.getSuppressed().length);
    }
}
