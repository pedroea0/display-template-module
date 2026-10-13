package com.example.simpletagdisplay.gateway.ops;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.function.Function;

import com.inductiveautomation.ignition.common.gson.JsonArray;
import com.inductiveautomation.ignition.common.gson.JsonElement;
import com.inductiveautomation.ignition.common.gson.JsonObject;

/**
 * Shadow of the chart's {@code pens} prop <em>as the Designer configured it</em>, so that a pen a browser wrote can
 * never be mistaken for a Designer pen and bypass the read scope.
 *
 * <h2>Why a shadow</h2>
 * A pen whose tag was not configured by the Designer is a <em>runtime</em> pen and is subject to the read scope. The
 * Designer's configuration is the start value of {@code pens} plus every later change whose origin is not
 * {@code Browser} (binding, script, project). Re-reading the whole live array on such a change would also adopt every
 * entry a browser wrote earlier — e.g. an expression binding on {@code pens[0].name} ticking every second would turn
 * every browser-written pen into a Designer pen within a second. This class therefore applies <em>only the delta</em>
 * that the non-Browser change wrote:
 * <pre>
 *   path "pens"                 the whole array was replaced → the shadow becomes the keys of the new value
 *   path "pens[i]"              entry i was replaced          → shadow[i] = key of the new entry
 *   path "pens[i].tagPath"      entry i's tag was replaced    → shadow[i] = key of the new path
 *   anything else under pens[i] (name, color, enabled, …)   → unchanged (no tag was chosen by that change)
 * </pre>
 * The shadow is index-based and bounded ({@value #MAX_ENTRIES} entries), so a binding that cycles {@code pens[1].tagPath}
 * through tags replaces the previous Designer key instead of accumulating them. Immutable; every update returns a new
 * instance.
 */
public final class DesignPens {

    /** Upper bound of shadowed entries (a Designer never configures this many pens; bounds memory and work). */
    public static final int MAX_ENTRIES = 4_096;

    public static final DesignPens EMPTY = new DesignPens(List.of());

    private final List<String> keys;   // per index: normalized key, or null (invalid path / not an object)
    private final Set<String> keySet;

    private DesignPens(List<String> keys) {
        this.keys = keys;
        Set<String> s = new LinkedHashSet<>();
        for (String k : keys) {
            if (k != null) {
                s.add(k);
            }
        }
        this.keySet = Collections.unmodifiableSet(s);
    }

    /**
     * The shadow of a whole {@code pens} value (start value, root replacement, or any change inside the Designer).
     *
     * @param keyOf raw {@code tagPath} → normalized key, or null when the path is invalid
     */
    public static DesignPens of(JsonElement pensValue, Function<String, String> keyOf) {
        if (pensValue == null || !pensValue.isJsonArray()) {
            return EMPTY;
        }
        JsonArray arr = pensValue.getAsJsonArray();
        int n = Math.min(arr.size(), MAX_ENTRIES);
        List<String> out = new ArrayList<>(n);
        for (int i = 0; i < n; i++) {
            out.add(entryKey(arr.get(i), keyOf));
        }
        return new DesignPens(Collections.unmodifiableList(out));
    }

    /**
     * Applies one non-Browser change.
     *
     * @param changedPath the change's path as Perspective reports it ({@code pens}, {@code pens[2]},
     *                    {@code pens[2].tagPath}, optionally prefixed with {@code props.}); null = unknown
     * @param valueAtPath the new value at {@code changedPath} (plain JSON)
     * @param keyOf       raw {@code tagPath} → normalized key, or null when the path is invalid
     * @return the updated shadow ({@code this} when the change chose no tag)
     */
    public DesignPens apply(String changedPath, JsonElement valueAtPath, Function<String, String> keyOf) {
        List<Object> parts = parsePath(changedPath);
        if (parts == null) {
            // Unknown / unparsable path: adopt nothing (fail closed — a missed Designer change shows a Designer pen
            // as a runtime pen, never the reverse).
            return this;
        }
        if (parts.isEmpty()) {
            return of(valueAtPath, keyOf);
        }
        if (!(parts.get(0) instanceof Integer)) {
            return this;
        }
        int index = (Integer) parts.get(0);
        if (index < 0 || index >= MAX_ENTRIES) {
            return this;
        }
        String key;
        if (parts.size() == 1) {
            key = entryKey(valueAtPath, keyOf);
        } else if (parts.size() == 2 && "tagPath".equals(parts.get(1))) {
            key = valueAtPath != null && valueAtPath.isJsonPrimitive() && valueAtPath.getAsJsonPrimitive().isString()
                ? keyOf.apply(valueAtPath.getAsString()) : null;
        } else {
            return this;   // name, color, enabled, axis … : no tag chosen
        }
        List<String> next = new ArrayList<>(keys);
        while (next.size() <= index) {
            next.add(null);
        }
        next.set(index, key);
        return new DesignPens(Collections.unmodifiableList(next));
    }

    /** Distinct normalized keys of the Designer-configured pens. */
    public Set<String> keys() {
        return keySet;
    }

    /** Shadowed entries (index-based, incl. invalid ones). */
    public int size() {
        return keys.size();
    }

    private static String entryKey(JsonElement e, Function<String, String> keyOf) {
        if (e == null || !e.isJsonObject()) {
            return null;
        }
        JsonObject o = e.getAsJsonObject();
        JsonElement tp = o.get("tagPath");
        if (tp == null || !tp.isJsonPrimitive() || !tp.getAsJsonPrimitive().isString()) {
            return null;
        }
        return keyOf.apply(tp.getAsString());
    }

    /**
     * Parts below the {@code pens} root: {@code "pens"} → [], {@code "pens[2].tagPath"} → [2, "tagPath"]; also accepts
     * the dotted index form {@code pens.2.tagPath} and a {@code props.} prefix. Null when the path is null, does not
     * start at {@code pens}, or is malformed.
     */
    static List<Object> parsePath(String path) {
        if (path == null) {
            return null;
        }
        String s = path.startsWith("props.") ? path.substring("props.".length()) : path;
        if (!s.startsWith("pens")) {
            return null;
        }
        s = s.substring("pens".length());
        List<Object> out = new ArrayList<>();
        int i = 0;
        while (i < s.length()) {
            char c = s.charAt(i);
            if (c == '[') {
                int end = s.indexOf(']', i);
                if (end < 0) {
                    return null;
                }
                Integer idx = parseIndex(s.substring(i + 1, end));
                if (idx == null) {
                    return null;
                }
                out.add(idx);
                i = end + 1;
            } else if (c == '.') {
                int end = i + 1;
                while (end < s.length() && s.charAt(end) != '.' && s.charAt(end) != '[') {
                    end++;
                }
                String name = s.substring(i + 1, end);
                if (name.isEmpty()) {
                    return null;
                }
                Integer idx = parseIndex(name);
                out.add(idx != null ? idx : name);
                i = end;
            } else {
                return null;   // "pensX…": another root key
            }
        }
        return out;
    }

    private static Integer parseIndex(String s) {
        if (s.isEmpty() || s.length() > 9) {
            return null;
        }
        for (int i = 0; i < s.length(); i++) {
            if (!Character.isDigit(s.charAt(i))) {
                return null;
            }
        }
        return Integer.parseInt(s);
    }
}
