package com.example.simpletagdisplay.gateway.tags;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

import com.example.simpletagdisplay.common.protocol.ErrorCode;
import com.inductiveautomation.ignition.common.model.values.QualityCode;
import com.inductiveautomation.ignition.common.tags.model.TagPath;
import com.inductiveautomation.ignition.common.tags.paths.BasicTagPath;
import com.inductiveautomation.ignition.common.tags.paths.parser.TagPathParser;

/**
 * Parsing, validation and normalisation of tag paths that come from component props or requests
 * ("path rules v2").
 *
 * <h2>Read rules ({@link #parse(String, String)})</h2>
 * Before parsing, the raw string (trimmed) is rejected when it is empty ({@code NO_TAG_PATH}), longer than
 * {@value #MAX_LENGTH} characters, contains a control character, contains {@code ":/"} (qualified
 * {@code histprov:/prov:/tag:} paths), has a {@code .} or {@code ..} path segment, or addresses an alarm
 * ({@code …/Alarms.<prop>} or {@code …/Alarms/<name>.<prop>}). After parsing, the property must be absent or
 * {@code Value}; a relative provider ({@code [.]}) is rejected; a provider name with leading or trailing white space
 * ({@code [ System]}, {@code [default ]}; {@link #isValidProviderName}) is rejected; an empty or {@code [~]} provider is
 * replaced by the project's default provider. The result is canonical: provider resolved, {@code .Value} dropped, so
 * {@link #normalizedKey} is the same for every spelling of one tag.
 *
 * <h2>Provider names</h2>
 * {@code TagPathParser} keeps the white space inside the brackets, so {@code [ System]Gateway/X} parses with the
 * provider {@code " System"}: unchecked, it would slip past {@code ctg.read.deniedProviders} and the read-scope roots
 * (it simply does not exist, {@code notFound}), while a folder parser that trims would read the same text as
 * {@code System} ({@code OUT_OF_SCOPE}). Both parsers therefore apply {@link #isValidProviderName} and answer
 * {@code INVALID_PATH} for such a spelling, so every entry point (pens, trend adds, history, browse, scope roots, write
 * floor) reaches the same verdict.
 *
 * A plain folder that happens to be named {@code Alarms} is allowed here; operations that need a real tag
 * (write, config edit, trend) decide by reading {@code .TagType} ({@code AtomicTag} required).
 *
 * <h2>Write rules ({@link #parseForWrite})</h2>
 * The read rules plus: no {@code _types_} first segment (UDT definitions) and no array element ({@code [} after
 * the provider bracket).
 *
 * <h2>Keys</h2>
 * {@link #normalizedKey} = full path, fully lower-cased: used for equality, {@code expectedTagPath},
 * trend-list dedupe and chart pen keys. Ignition tag paths are case-insensitive; the casing of the first
 * appearance is kept for display.
 */
public final class TagPaths {

    public static final int MAX_LENGTH = 1024;

    /** {@code …/Alarms.HasActive} (tag alarm summary) or {@code …/Alarms/High.SetpointA} (one alarm's property). */
    private static final Pattern ALARM_PATH = Pattern.compile("(?i)(^|[/\\]])Alarms(\\.|/[^/]*\\.)");

    private TagPaths() {
    }

    /** Outcome of a parse: either a canonical path or an error code ({@code NO_TAG_PATH} / {@code INVALID_PATH}). */
    public static final class Parsed {
        private final TagPath path;
        private final ErrorCode error;

        private Parsed(TagPath path, ErrorCode error) {
            this.path = path;
            this.error = error;
        }

        static Parsed ok(TagPath p) {
            return new Parsed(p, null);
        }

        static Parsed fail(ErrorCode c) {
            return new Parsed(null, c);
        }

        public boolean ok() {
            return path != null;
        }

        public TagPath path() {
            return path;
        }

        public ErrorCode error() {
            return error;
        }
    }

    /**
     * Read rules without provider resolution: an empty or {@code [~]} provider stays as written. Kept for code
     * that only displays a path; anything that compares keys or talks to a tag provider uses
     * {@link #parse(String, String)}.
     */
    public static Parsed parse(String raw) {
        return parse(raw, null);
    }

    /**
     * Read rules (class comment). Never throws.
     *
     * @param defaultProvider the project's default tag provider ({@code PerspectiveInternals.projectDefaultTagProvider});
     *                        null keeps an empty / {@code ~} provider unresolved
     */
    public static Parsed parse(String raw, String defaultProvider) {
        String s = raw == null ? "" : raw.trim();
        if (s.isEmpty()) {
            return Parsed.fail(ErrorCode.NO_TAG_PATH);
        }
        if (s.length() > MAX_LENGTH || hasControlChars(s) || s.contains(":/") || hasDotSegment(s)
                || ALARM_PATH.matcher(s).find()) {
            return Parsed.fail(ErrorCode.INVALID_PATH);
        }
        TagPath p;
        try {
            p = TagPathParser.parse(s);
        } catch (IOException | RuntimeException e) {
            return Parsed.fail(ErrorCode.INVALID_PATH);
        }
        if (p == null || p.getPathLength() == 0) {
            return Parsed.fail(ErrorCode.INVALID_PATH);
        }
        String prop = p.getProperty() == null ? null : p.getProperty().getName();
        if (prop != null && !prop.isEmpty() && !"Value".equalsIgnoreCase(prop)) {
            return Parsed.fail(ErrorCode.INVALID_PATH);
        }
        String source = p.getSource();
        if (source != null && !source.isEmpty() && !isValidProviderName(source)) {
            return Parsed.fail(ErrorCode.INVALID_PATH);
        }
        boolean defaultSource = source == null || source.isEmpty() || "~".equals(source);
        // TagPathParser.isRelativePath() is also true for "[~]" and provider-less paths (observed on 8.3.10); those
        // are resolved to the project default below. Only "[.]"-style relative providers are rejected.
        if ((source != null && source.startsWith(".")) || (!defaultSource && TagPathParser.isRelativePath(p))) {
            return Parsed.fail(ErrorCode.INVALID_PATH);
        }
        String resolved = defaultSource && defaultProvider != null && !defaultProvider.isEmpty() ? defaultProvider : source;
        List<String> parts = new ArrayList<>(p.getPathLength());
        for (int i = 0; i < p.getPathLength(); i++) {
            String part = p.getPathComponent(i);
            if (part == null || part.isEmpty()) {
                return Parsed.fail(ErrorCode.INVALID_PATH);
            }
            parts.add(part);
        }
        // Canonical form: resolved provider, no ".Value" property.
        return Parsed.ok(new BasicTagPath(resolved == null ? "" : resolved, parts));
    }

    /** Write / config-edit rules: the read rules plus no {@code _types_} first segment and no array element. */
    public static Parsed parseForWrite(String raw, String defaultProvider) {
        Parsed p = parse(raw, defaultProvider);
        if (!p.ok()) {
            return p;
        }
        TagPath path = p.path();
        if ("_types_".equalsIgnoreCase(path.getPathComponent(0))) {
            return Parsed.fail(ErrorCode.INVALID_PATH);
        }
        String s = raw.trim();
        int afterProvider = s.startsWith("[") ? s.indexOf(']') + 1 : 0;
        if (s.indexOf('[', Math.max(afterProvider, 0)) >= 0) {
            return Parsed.fail(ErrorCode.INVALID_PATH);
        }
        return p;
    }

    /**
     * Normalized key used for equality everywhere ({@code expectedTagPath}, trend dedupe, chart pen keys,
     * {@code allowedRoots}): the full path, fully lower-case.
     */
    public static String normalizedKey(TagPath p) {
        return p.toStringFull().toLowerCase(Locale.ROOT);
    }

    /** Provider (source) of a path, lower-cased; "" when none. */
    public static String providerKey(TagPath p) {
        String s = p.getSource();
        return s == null ? "" : s.toLowerCase(Locale.ROOT);
    }

    /** True when {@code key} equals {@code rootKey} or lies below it (both normalized keys). */
    public static boolean isUnder(String key, String rootKey) {
        return key.equals(rootKey) || key.startsWith(rootKey.endsWith("/") ? rootKey : rootKey + "/");
    }

    /** Last element of the path ("Temp" for {@code [default]CTG/Temp}). */
    public static String tagName(TagPath p) {
        String n = p.getItemName();
        return n == null ? "" : n;
    }

    /**
     * True for the qualities a read or subscription returns when the user lacks the tag's Read Permissions.
     * Observed on 8.3.10: {@code Bad_AccessDenied} (-2147483134) for reads AND
     * subscriptions. {@code Bad_Unauthorized} is accepted as an alias (never observed, documented by the SDK).
     */
    public static boolean isAccessDenied(QualityCode q) {
        return q != null && (q.is(QualityCode.Bad_AccessDenied) || q.is(QualityCode.Bad_Unauthorized));
    }

    /** True for "this tag does not exist". */
    public static boolean isNotFound(QualityCode q) {
        return q != null && q.is(QualityCode.Bad_NotFound);
    }

    /**
     * trendGroup normalisation shared with the browser ({@code NS.util.normTrendGroup}): trim with
     * {@link String#trim()} semantics (code units &lt;= U+0020 at both ends; the JS side implements exactly that, not
     * JS {@code trim()}; shared vectors in {@code tests/vectors/trend-group.json}); null or
     * empty → {@code "default"} for a display and {@code null} ("ignore the trend list") for a chart; characters
     * outside {@code [A-Za-z0-9_.-]} become {@code '_'}; at most 64 characters.
     */
    public static String normTrendGroup(String raw, boolean chart) {
        String s = raw == null ? "" : raw.trim();
        if (s.isEmpty()) {
            return chart ? null : "default";
        }
        StringBuilder b = new StringBuilder(Math.min(s.length(), 64));
        for (int i = 0; i < s.length() && b.length() < 64; i++) {
            char c = s.charAt(i);
            boolean okChar = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
                || c == '_' || c == '.' || c == '-';
            b.append(okChar ? c : '_');
        }
        return b.toString();
    }

    /**
     * True for a provider name a path may carry: not empty, no control character anywhere, and no white space (any
     * Unicode space or blank, {@code U+00A0} included) as its first or last character. Ignition provider names never
     * start or end with blanks, so such a spelling can only be a typo or an attempt to dodge a provider rule
     * ({@code ctg.read.deniedProviders}, scope roots). Shared by {@link #parse(String, String)} and the folder parser
     * of the read scope / tag browser ({@code ReadScope.parseFolder}), so both reject the same texts.
     */
    public static boolean isValidProviderName(String name) {
        if (name == null || name.isEmpty() || hasControlChars(name)) {
            return false;
        }
        return !isBlankChar(name.charAt(0)) && !isBlankChar(name.charAt(name.length() - 1));
    }

    private static boolean isBlankChar(char c) {
        return c <= ' ' || Character.isWhitespace(c) || Character.isSpaceChar(c);
    }

    private static boolean hasControlChars(String s) {
        for (int i = 0; i < s.length(); i++) {
            if (Character.isISOControl(s.charAt(i))) {
                return true;
            }
        }
        return false;
    }

    /** A {@code .} or {@code ..} path segment after the provider bracket (relative navigation). */
    private static boolean hasDotSegment(String s) {
        int start = s.startsWith("[") ? s.indexOf(']') + 1 : 0;
        if (start <= 0 && s.startsWith("[")) {
            return false;   // unterminated bracket: the parser rejects it
        }
        for (String seg : s.substring(start).split("/", -1)) {
            String t = seg.trim();
            if (t.equals(".") || t.equals("..")) {
                return true;
            }
        }
        return false;
    }
}
