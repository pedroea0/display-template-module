package com.example.simpletagdisplay.gateway.trend;

import java.util.Objects;
import java.util.UUID;

/**
 * Identity of one session trend list: Perspective session id + normalised trend group. A Perspective
 * session is shared by every tab of one browser and project, so all those tabs see the same list; different
 * groups are independent lists.
 */
public final class TrendKey {

    private final UUID sessionId;
    private final String group;

    public TrendKey(UUID sessionId, String group) {
        this.sessionId = Objects.requireNonNull(sessionId);
        this.group = Objects.requireNonNull(group);
    }

    public UUID sessionId() {
        return sessionId;
    }

    /** Normalised group ({@code TagPaths.normTrendGroup}). */
    public String group() {
        return group;
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) {
            return true;
        }
        if (!(o instanceof TrendKey)) {
            return false;
        }
        TrendKey k = (TrendKey) o;
        return sessionId.equals(k.sessionId) && group.equals(k.group);
    }

    @Override
    public int hashCode() {
        return sessionId.hashCode() * 31 + group.hashCode();
    }

    @Override
    public String toString() {
        return sessionId + "/" + group;
    }
}
