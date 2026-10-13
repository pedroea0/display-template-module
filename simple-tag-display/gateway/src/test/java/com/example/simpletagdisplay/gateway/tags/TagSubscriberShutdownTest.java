package com.example.simpletagdisplay.gateway.tags;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicReference;

import com.inductiveautomation.ignition.common.model.values.QualityCode;
import com.inductiveautomation.ignition.common.tags.model.TagManager;
import com.inductiveautomation.ignition.common.tags.model.TagPath;
import com.inductiveautomation.ignition.common.tags.paths.parser.TagPathParser;
import org.junit.jupiter.api.Test;

/**
 * Seen on a live gateway: while Perspective destroys a session whose project was deleted, the session's tag manager
 * is gone ({@code session().getTagManager()} returns null) and the display's stop failed with an NPE in
 * {@code TagSubscriber.unsubscribe} ("Delegate stop failed", 7 WARN lines with stack traces).
 * The subscriber now reads the tag manager at release time, tolerates null, and {@code DisplayTemplateDelegate}
 * supplies the gateway's tag manager as the fallback so the listeners are still released.
 */
class TagSubscriberShutdownTest {

    /** Records subscribe/unsubscribe calls; answers subscribes with Good. */
    private static final class Recorder {
        final List<String> calls = new ArrayList<>();
        final List<Object> unsubscribedListeners = new ArrayList<>();
        final List<Object> subscribedListeners = new ArrayList<>();

        TagManager manager(String name) {
            return (TagManager) Proxy.newProxyInstance(TagManager.class.getClassLoader(), new Class<?>[] {TagManager.class},
                (proxy, m, args) -> {
                    switch (m.getName()) {
                        case "subscribeAsync": {
                            List<?> paths = (List<?>) args[0];
                            calls.add(name + ".subscribe " + paths.size());
                            subscribedListeners.addAll((List<?>) args[1]);
                            List<QualityCode> out = new ArrayList<>();
                            paths.forEach(p -> out.add(QualityCode.Good));
                            return CompletableFuture.completedFuture(out);
                        }
                        case "unsubscribeAsync": {
                            calls.add(name + ".unsubscribe " + ((List<?>) args[0]).size());
                            unsubscribedListeners.addAll((List<?>) args[1]);
                            return CompletableFuture.completedFuture(null);
                        }
                        case "toString":
                            return name;
                        default:
                            throw new UnsupportedOperationException(m.getName());
                    }
                });
        }
    }

    private static Map<String, TagPath> wanted() throws Exception {
        Map<String, TagPath> m = new LinkedHashMap<>();
        m.put("value", TagPathParser.parse("[default]CTG/Temp"));
        m.put("engLow", TagPathParser.parse("[default]CTG/Temp.EngLow"));
        return m;
    }

    @Test
    void releaseAfterTheSessionTagManagerVanishedGoesToTheFallback() throws Exception {
        Recorder r = new Recorder();
        TagManager session = r.manager("session");
        TagManager gateway = r.manager("gateway");
        AtomicReference<TagManager> sessionTm = new AtomicReference<>(session);
        // Same shape as DisplayTemplateDelegate.subscriptionTagManager(): the session's, else the gateway's.
        TagSubscriber sub = new TagSubscriber(() -> sessionTm.get() != null ? sessionTm.get() : gateway, () -> { }, e -> { });
        long before = TagSubscriber.totalSubscribed();

        assertTrue(sub.apply(wanted(), null, false));
        assertEquals(List.of("session.subscribe 2"), r.calls);
        assertEquals(before + 2, TagSubscriber.totalSubscribed());

        sessionTm.set(null);                                    // the project was deleted, the session is being destroyed
        assertDoesNotThrow(sub::release);
        assertEquals(List.of("session.subscribe 2", "gateway.unsubscribe 2"), r.calls);
        assertEquals(r.subscribedListeners.size(), r.unsubscribedListeners.size());
        for (int i = 0; i < r.subscribedListeners.size(); i++) {
            assertSame(r.subscribedListeners.get(i), r.unsubscribedListeners.get(i), "the very listeners are released");
        }
        assertEquals(before, TagSubscriber.totalSubscribed(), "the module-wide counter is balanced");
    }

    @Test
    void aNullTagManagerNeverThrows() throws Exception {
        TagSubscriber sub = new TagSubscriber(() -> null, () -> { }, e -> { });
        long before = TagSubscriber.totalSubscribed();
        assertDoesNotThrow(() -> sub.apply(wanted(), null, false));
        assertEquals(before, TagSubscriber.totalSubscribed(), "nothing subscribed, nothing counted");
        assertFalse(sub.killForTest("value"));
        assertDoesNotThrow(sub::release);
        assertEquals(before, TagSubscriber.totalSubscribed());
    }

    @Test
    void releaseWithAVanishedManagerAndNoFallbackStillBalancesTheCounter() throws Exception {
        Recorder r = new Recorder();
        AtomicReference<TagManager> tm = new AtomicReference<>(r.manager("session"));
        TagSubscriber sub = new TagSubscriber(tm::get, () -> { }, e -> { });
        long before = TagSubscriber.totalSubscribed();
        sub.apply(wanted(), null, false);
        tm.set(null);
        assertDoesNotThrow(sub::release);
        assertEquals(List.of("session.subscribe 2"), r.calls);
        assertEquals(before, TagSubscriber.totalSubscribed());
    }
}
