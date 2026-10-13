package com.example.simpletagdisplay.gateway.trend;

import java.util.List;

/**
 * Receives changes of one session trend list. Display and chart delegates register for their
 * {@code (session, trendGroup)} in {@code start()} and unregister in {@code stop()}.
 *
 * Called on whatever thread changed the list, outside the store's locks; implementations only schedule work
 * onto their session queue ({@code queue().submit(...)}) and return.
 */
@FunctionalInterface
public interface TrendListListener {

    /**
     * @param key     the list that changed
     * @param paths   its paths after the change, in insertion order, original casing of the first add
     * @param version store-wide monotonic change counter (later changes have larger versions)
     */
    void onTrendListChanged(TrendKey key, List<String> paths, long version);
}
