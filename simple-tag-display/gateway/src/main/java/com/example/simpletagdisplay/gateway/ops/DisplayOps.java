package com.example.simpletagdisplay.gateway.ops;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.OptionalDouble;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeoutException;
import java.util.function.BiConsumer;

import com.example.simpletagdisplay.common.protocol.ErrorCode;
import com.example.simpletagdisplay.gateway.GatewayServices;
import com.example.simpletagdisplay.gateway.ModuleSettings;
import com.example.simpletagdisplay.gateway.audit.AuditQueryService;
import com.example.simpletagdisplay.gateway.audit.CtgAudit;
import com.example.simpletagdisplay.gateway.delegate.CallContext;
import com.example.simpletagdisplay.gateway.delegate.PropsSnapshot;
import com.example.simpletagdisplay.gateway.security.UserContext;
import com.example.simpletagdisplay.gateway.tags.HistoryAvailability;
import com.example.simpletagdisplay.gateway.tags.TagConfigEditor;
import com.example.simpletagdisplay.gateway.tags.TagMetaReader;
import com.example.simpletagdisplay.gateway.tags.TagPaths;
import com.example.simpletagdisplay.gateway.tags.ValueCodec;
import com.example.simpletagdisplay.gateway.tags.WriteCoercer;
import com.example.simpletagdisplay.gateway.trend.TrendListStore;
import com.example.simpletagdisplay.gateway.util.Json;
import com.example.simpletagdisplay.gateway.util.RateLimitedLog;
import com.inductiveautomation.ignition.common.gson.JsonArray;
import com.inductiveautomation.ignition.common.gson.JsonElement;
import com.inductiveautomation.ignition.common.gson.JsonNull;
import com.inductiveautomation.ignition.common.gson.JsonObject;
import com.inductiveautomation.ignition.common.model.values.QualifiedValue;
import com.inductiveautomation.ignition.common.model.values.QualityCode;
import com.inductiveautomation.ignition.common.sqltags.model.types.DataType;
import com.inductiveautomation.ignition.common.tags.model.TagManager;
import com.inductiveautomation.ignition.common.tags.model.TagPath;
import com.inductiveautomation.ignition.common.tags.model.TagProvider;
import com.inductiveautomation.ignition.common.util.LoggerEx;
import com.inductiveautomation.ignition.gateway.audit.AuditProfile;
import com.inductiveautomation.perspective.gateway.api.Component;

/**
 * The Display Template's gateway actions, independent of the transport: write, configEdit, trendAdd, trendRemove and
 * the change-history query. The delegate adapts a model event into a {@link CallContext} and a {@link Host}; every
 * action completes the call exactly once.
 *
 * <h2>Write flow</h2>
 * <pre>
 *  0 idempotency at receipt ............................ CtgDelegateBase (MUTATE)
 *  1 trusted snapshot + lint verdicts .................. cc.props()
 *  2-5 enabled, lint, path rules, stale target, floor, setpoint.access, Designer mutability, audit requirement
 *  6 fresh read (user ctx): base, DataType, CanWrite, EngLow, EngHigh, TagType → NotFound / denied / not an
 *    AtomicTag / read-only / unsupported type / bad quality
 *  7 back on the queue: the user is the same (AUTH_CHANGED) and steps 2-5 still pass on the CURRENT snapshot (TOCTOU)
 *  8 coerce   9 options   10 limits (fail closed)   11 step guard
 * 12 auditId + writeAsync with the user's context; the audit attempt watches the RAW future
 * 13 map the result (UI timeout → TIMEOUT; the audit records UNCERTAIN, then the late final outcome)
 * 14 onSetpointWrite fired BEFORE the reply        15 reply {tagPath, written, previous, quality, auditId}
 * </pre>
 * Validation failures (2–11) neither audit nor fire the event and log at DEBUG only (no client-triggerable WARN).
 * {@code dt.configEdit} follows the same pattern.
 */
public final class DisplayOps {

    /** How the component event fires: {@code component.fireEvent(EVENT_TYPE, name, payload)}. */
    public static final String EVENT_TYPE = "component";

    private static final LoggerEx TREND = LoggerEx.newBuilder().build("SimpleTagDisplay.Trend");

    private DisplayOps() {
    }

    /** What an action needs from its delegate. Called on the session queue unless noted. */
    public interface Host {
        /** The current trusted snapshot (re-read after every async hop). */
        PropsSnapshot props();

        /** The current user (compare {@code generation()} after a hop). */
        UserContext user();

        /** Project default tag provider ({@code [~]} / empty provider resolve to it). */
        String defaultProvider();

        /** The session's tag manager. */
        TagManager tagManager();

        GatewayServices services();

        Component component();

        CtgAudit audit();

        /** Audit profile for this component's writes (project, else fallback), or empty. */
        Optional<AuditProfile> auditProfile();

        /** Continue on the session queue when {@code f} completes or times out (only while the delegate runs). */
        <T> void onQueue(CompletableFuture<T> f, long timeoutMs, BiConsumer<T, Throwable> cb);

        /** Fires a component event gateway-side (only while running). */
        void fire(String event, JsonObject payload);

        UUID sessionId();

        /** Normalised trend group of the trusted {@code trendGroup}. */
        String trendGroup();

        /** History availability of a tag from its metadata (cached provider list). */
        HistoryAvailability.Status history(TagMetaReader.Meta meta);

        /** A config edit succeeded: re-read metadata now and push it. */
        void configEdited();

        /** Rate-limited WARN sink of the delegate (keys are fixed strings). */
        RateLimitedLog warnings();

        LoggerEx logger();

        /** Short identity for log lines. */
        String describe();

        /**
         * Debug-only artificial delay before an action continues after its fresh read (test hook for the re-check of
         * every gate after the read); 0 normally.
         */
        long debugReadDelayMs();

        /**
         * Debug-only artificial provider delay of a write (test hook for an audit outcome that arrives after the UI
         * timed out); 0 normally.
         */
        long debugWriteDelayMs();
    }

    // =========================================================================================================
    // dt.write
    // =========================================================================================================

    /** {@code dt.write {expectedTagPath, value, display?, ui?}}. */
    public static void write(CallContext cc, Host h) {
        JsonObject b = cc.body();
        String expected = Json.string(b, "expectedTagPath", null);
        JsonElement value = b.get("value");
        if (expected == null || value == null) {
            fail(cc, h, ErrorCode.BAD_REQUEST, null, "missing expectedTagPath/value");
            return;
        }
        String ui = editMode(Json.string(b, "ui", ""));
        String display = Json.string(b, "display", null);
        Optional<AuditProfile> profile = h.auditProfile();
        ModuleSettings.Settings s = h.services().settings().get();
        DisplayGates.Target t = DisplayGates.write(cc.props(), cc.user(), h.services().floorPolicy(), h.defaultProvider(),
            h.audit().refuses(s.auditRequired(), profile));
        if (!t.ok()) {
            fail(cc, h, t.error(), t.details(), "write gate");
            return;
        }
        TagPath path = t.path();
        if (!DisplayGates.sameTarget(expected, path, h.defaultProvider())) {
            fail(cc, h, ErrorCode.STALE_TARGET, null, "write target");
            return;
        }
        Map<String, TagPath> reads = new LinkedHashMap<>();
        for (String k : List.of(TagMetaReader.VALUE, TagMetaReader.DATA_TYPE, TagMetaReader.CAN_WRITE,
                TagMetaReader.READ_ONLY, TagMetaReader.ENG_LOW, TagMetaReader.ENG_HIGH, TagMetaReader.TAG_TYPE)) {
            reads.put(k, TagMetaReader.path(path, k, null));
        }
        CompletableFuture<Map<String, QualifiedValue>> read =
            delayed(TagMetaReader.read(h.tagManager(), reads, cc.user().securityContext()), h.debugReadDelayMs(), h);
        h.onQueue(read, s.readTimeoutMs() + h.debugReadDelayMs(), (m, err) -> {
            if (err != null) {
                readFailed(cc, h, err, "write");
                return;
            }
            writeAfterRead(cc, h, expected, path, value, ui, display, profile, m);
        });
    }

    private static void writeAfterRead(CallContext cc, Host h, String expected, TagPath path, JsonElement json, String ui,
                                       String display, Optional<AuditProfile> profile, Map<String, QualifiedValue> m) {
        TagMetaReader.Meta meta = new TagMetaReader.Meta(m);
        QualifiedValue current = m.get(TagMetaReader.VALUE);
        PropsSnapshot now = h.props();
        ErrorCode facts = DisplayGates.tagFacts(current, meta, now.bool("setpoint.allowOnBadQuality", false), true, true);
        if (facts != null) {
            fail(cc, h, facts, null, "write tag facts");
            return;
        }
        // 7. TOCTOU: the user and every gate again, on the snapshot as it is NOW.
        UserContext user = h.user();
        if (user.generation() != cc.user().generation()) {
            fail(cc, h, ErrorCode.AUTH_CHANGED, null, "write auth changed");
            return;
        }
        ModuleSettings.Settings s = h.services().settings().get();
        DisplayGates.Target again = DisplayGates.write(now, user, h.services().floorPolicy(), h.defaultProvider(),
            h.audit().refuses(s.auditRequired(), profile));
        if (!again.ok()) {
            fail(cc, h, again.error(), again.details(), "write gate after read");
            return;
        }
        if (!again.path().equals(path) || !DisplayGates.sameTarget(expected, again.path(), h.defaultProvider())) {
            fail(cc, h, ErrorCode.STALE_TARGET, null, "write target after read");
            return;
        }
        // 8-11. Value checks.
        DataType type = meta.dataType();
        int maxLen = maxStringLength(now);
        WriteCoercer.Result r = WriteCoercer.coerce(json, type, maxLen);
        if (!r.ok()) {
            fail(cc, h, r.error(), null, "coerce");
            return;
        }
        if (!DisplayGates.isAllowedOption(now, r.value(), type, maxLen)) {
            fail(cc, h, ErrorCode.NOT_AN_OPTION, null, "options");
            return;
        }
        DisplayGates.Limits lim = DisplayGates.limits(now, type, meta);
        if (lim.applies()) {
            if (lim.error() != null) {
                h.warnings().warn("limits." + lim.error().name(), "Setpoint write refused (" + lim.error().name()
                    + "): the write limits of " + h.describe() + " are misconfigured or unreadable");
                fail(cc, h, lim.error(), null, "limits");
                return;
            }
            double v = ValueCodec.toDouble(r.value());
            if (!lim.contains(v)) {
                fail(cc, h, ErrorCode.OUT_OF_RANGE, lim.details(), "range");
                return;
            }
        }
        ErrorCode stepCfg = DisplayGates.stepConfigError(now);
        if (stepCfg != null) {
            h.warnings().warn("step.config." + stepCfg.name(), "Setpoint write refused (" + stepCfg.name()
                + "): maxStep/maxStepPercent of " + h.describe() + (stepCfg == ErrorCode.LIMITS_UNAVAILABLE
                ? " is bound and its binding delivers no value or a bad quality" : " is not a number >= 0"));
            fail(cc, h, stepCfg, null, "step config");
            return;
        }
        if (WriteCoercer.isNumeric(type)) {
            JsonObject step = DisplayGates.stepViolation(now, ValueCodec.toDouble(current.getValue()),
                ValueCodec.toDouble(r.value()), lim);
            if (step != null) {
                fail(cc, h, ErrorCode.STEP_TOO_LARGE, step, "step");
                return;
            }
        }
        // 12. The write. The audit slots are booked first, atomically: with ctg.audit.required a full audit
        //     writer refuses here even when the advisory gate above passed in a race with another attempt.
        CtgAudit.Reservation slots = h.audit().reserve(s.auditRequired(), profile);
        if (slots == null) {
            fail(cc, h, ErrorCode.AUDIT_UNAVAILABLE, null, "write audit slots");
            return;
        }
        String auditId = UUID.randomUUID().toString();
        String target = path.toStringFull();
        String newText = String.valueOf(r.value());
        String oldText = current == null ? "null" : String.valueOf(current.getValue());
        CtgAudit.Origin origin = CtgAudit.Origin.of(h.component(), user.userName(), user.remoteHost(),
            user.isDesigner() ? "Designer" : "Client");
        if (profile.isEmpty()) {
            h.audit().warnNoProfile(origin.project());
        }
        String logFields = "old=" + Json.sanitizeForLog(oldText) + " new=" + Json.sanitizeForLog(newText) + " ui=" + ui
            + (display == null ? "" : " display=" + Json.sanitizeForLog(display.length() > 64 ? display.substring(0, 64) : display));
        CtgAudit.Attempt attempt = h.audit().begin(CtgAudit.ACTION_WRITE, target, origin, auditId, logFields,
            late -> CtgAudit.writeValue(newText, oldText, ui, auditId, late), profile, slots);
        CompletableFuture<List<QualityCode>> raw;
        try {
            raw = h.tagManager().writeAsync(List.of(path), List.of(r.value()), user.securityContext());
        } catch (RuntimeException e) {
            attempt.failedBeforeProvider("Exception");
            h.warnings().warn("write.exception", "writeAsync failed on " + h.describe(), e);
            cc.fail(ErrorCode.INTERNAL, auditDetails(auditId, null));
            return;
        }
        raw = delayed(raw, h.debugWriteDelayMs(), h);
        long timeoutMs = s.writeTimeoutMs();
        attempt.attach(raw, timeoutMs);
        JsonElement written = ValueCodec.plain(r.value());
        JsonElement previous = current == null ? JsonNull.INSTANCE : ValueCodec.plain(current.getValue());
        h.onQueue(raw, timeoutMs, (codes, err) -> {
            QualityCode q = err == null && codes != null && !codes.isEmpty() ? codes.get(0) : null;
            ErrorCode code;
            if (err instanceof TimeoutException) {
                code = ErrorCode.TIMEOUT;
            } else if (err != null) {
                h.warnings().warn("write.failed", "Tag write failed on " + h.describe(), err);
                code = ErrorCode.INTERNAL;
            } else {
                code = mapWrite(q);
            }
            JsonObject ev = new JsonObject();
            ev.addProperty("tagPath", target);
            ev.add("value", written.deepCopy());
            ev.add("previousValue", previous.deepCopy());
            ev.addProperty("success", code == null);
            ev.addProperty("quality", q != null ? q.getName() : (code == ErrorCode.TIMEOUT ? "Uncertain" : "Bad"));
            if (code == null) {
                ev.add("errorCode", JsonNull.INSTANCE);
            } else {
                ev.addProperty("errorCode", code.name());
            }
            ev.addProperty("user", user.userName());
            ev.addProperty("timestamp", System.currentTimeMillis());
            ev.addProperty("editMode", ui);
            ev.addProperty("auditId", auditId);
            h.fire("onSetpointWrite", ev);   // 14: before the reply
            if (code == null) {
                JsonObject data = new JsonObject();
                data.addProperty("tagPath", target);
                data.add("written", written.deepCopy());
                data.add("previous", previous.deepCopy());
                data.add("quality", qualityJson(q));
                data.addProperty("auditId", auditId);
                cc.reply(data);
            } else {
                cc.fail(code, auditDetails(auditId, q));
            }
        });
    }

    /** Write result quality → error code; null = success. */
    public static ErrorCode mapWrite(QualityCode q) {
        if (q == null) {
            return ErrorCode.WRITE_FAILED;
        }
        if (q.isGood()) {
            return null;
        }
        if (TagPaths.isNotFound(q)) {
            return ErrorCode.TAG_NOT_FOUND;
        }
        if (q.is(QualityCode.Bad_ReadOnly)) {
            return ErrorCode.READ_ONLY;
        }
        String n = (q.getName() + " " + q.getDiagnosticMessage()).toLowerCase(Locale.ROOT);
        if (TagPaths.isAccessDenied(q) || n.contains("write_denied") || n.contains("writedenied")
                || n.contains("denied") || n.contains("unauthorized")) {
            return ErrorCode.WRITE_DENIED;
        }
        return ErrorCode.WRITE_FAILED;
    }

    // =========================================================================================================
    // dt.configEdit
    // =========================================================================================================

    /** {@code dt.configEdit {expectedTagPath, changes:{engUnit?, engLow?, engHigh?}}}. */
    public static void configEdit(CallContext cc, Host h) {
        JsonObject b = cc.body();
        String expected = Json.string(b, "expectedTagPath", null);
        if (expected == null) {
            fail(cc, h, ErrorCode.BAD_REQUEST, null, "missing expectedTagPath");
            return;
        }
        TagConfigEditor.Parsed parsed = TagConfigEditor.parse(b.get("changes"));
        Optional<AuditProfile> profile = h.auditProfile();
        ModuleSettings.Settings s = h.services().settings().get();
        DisplayGates.Target t = DisplayGates.configEdit(cc.props(), cc.user(), h.services().floorPolicy(),
            h.defaultProvider(), h.audit().refuses(s.auditRequired(), profile));
        if (!t.ok()) {
            fail(cc, h, t.error(), t.details(), "configEdit gate");
            return;
        }
        if (!DisplayGates.sameTarget(expected, t.path(), h.defaultProvider())) {
            fail(cc, h, ErrorCode.STALE_TARGET, null, "configEdit target");
            return;
        }
        if (!parsed.ok()) {
            fail(cc, h, parsed.error(), null, "configEdit changes");
            return;
        }
        TagPath path = t.path();
        Map<String, TagPath> reads = new LinkedHashMap<>();
        for (String k : List.of(TagMetaReader.VALUE, TagMetaReader.TAG_TYPE, TagMetaReader.ENG_UNIT,
                TagMetaReader.ENG_LOW, TagMetaReader.ENG_HIGH)) {
            reads.put(k, TagMetaReader.path(path, k, null));
        }
        CompletableFuture<Map<String, QualifiedValue>> read =
            delayed(TagMetaReader.read(h.tagManager(), reads, cc.user().securityContext()), h.debugReadDelayMs(), h);
        h.onQueue(read, s.readTimeoutMs() + h.debugReadDelayMs(), (m, err) -> {
            if (err != null) {
                readFailed(cc, h, err, "configEdit");
                return;
            }
            configEditAfterRead(cc, h, expected, path, parsed.changes(), profile, m);
        });
    }

    private static void configEditAfterRead(CallContext cc, Host h, String expected, TagPath path,
                                            TagConfigEditor.Changes changes, Optional<AuditProfile> profile,
                                            Map<String, QualifiedValue> m) {
        TagMetaReader.Meta meta = new TagMetaReader.Meta(m);
        ErrorCode facts = DisplayGates.tagFacts(m.get(TagMetaReader.VALUE), meta, true, false, false);
        if (facts != null) {
            fail(cc, h, facts, null, "configEdit tag facts");
            return;
        }
        UserContext user = h.user();
        if (user.generation() != cc.user().generation()) {
            fail(cc, h, ErrorCode.AUTH_CHANGED, null, "configEdit auth changed");
            return;
        }
        ModuleSettings.Settings s = h.services().settings().get();
        DisplayGates.Target again = DisplayGates.configEdit(h.props(), user, h.services().floorPolicy(),
            h.defaultProvider(), h.audit().refuses(s.auditRequired(), profile));
        if (!again.ok()) {
            fail(cc, h, again.error(), again.details(), "configEdit gate after read");
            return;
        }
        if (!again.path().equals(path) || !DisplayGates.sameTarget(expected, again.path(), h.defaultProvider())) {
            fail(cc, h, ErrorCode.STALE_TARGET, null, "configEdit target after read");
            return;
        }
        String prevUnit = meta.string(TagMetaReader.ENG_UNIT);
        Double prevLow = finite(meta.engLow());
        Double prevHigh = finite(meta.engHigh());
        ErrorCode range = TagConfigEditor.checkRange(changes, meta.engLow(), meta.engHigh());
        if (range != null) {
            fail(cc, h, range, null, "configEdit range");
            return;
        }
        TagProvider provider = null;
        try {
            provider = h.services().gatewayContext().getTagManager().getTagProvider(path.getSource());
        } catch (RuntimeException e) {
            h.logger().debugf("provider lookup failed: %s", e.toString());
        }
        if (provider == null) {
            fail(cc, h, ErrorCode.PROVIDER_UNRESOLVED, null, "configEdit provider");
            return;
        }
        CtgAudit.Reservation slots = h.audit().reserve(s.auditRequired(), profile);   // atomic, as for writes
        if (slots == null) {
            fail(cc, h, ErrorCode.AUDIT_UNAVAILABLE, null, "configEdit audit slots");
            return;
        }
        String auditId = UUID.randomUUID().toString();
        String target = path.toStringFull();
        String description = TagConfigEditor.describe(changes, prevUnit, prevLow, prevHigh);
        CtgAudit.Origin origin = CtgAudit.Origin.of(h.component(), user.userName(), user.remoteHost(),
            user.isDesigner() ? "Designer" : "Client");
        if (profile.isEmpty()) {
            h.audit().warnNoProfile(origin.project());
        }
        CtgAudit.Attempt attempt = h.audit().begin(CtgAudit.ACTION_EDIT, target, origin, auditId,
            "change=\"" + Json.sanitizeForLog(description) + "\"",
            late -> CtgAudit.editValue(description, auditId, late), profile, slots);
        CompletableFuture<List<QualityCode>> raw;
        try {
            raw = TagConfigEditor.save(provider, path, changes, user.securityContext());
        } catch (RuntimeException e) {
            attempt.failedBeforeProvider("Exception");
            h.warnings().warn("configEdit.exception", "saveTagConfigsAsync failed on " + h.describe(), e);
            cc.fail(ErrorCode.INTERNAL, auditDetails(auditId, null));
            return;
        }
        long timeoutMs = s.writeTimeoutMs();
        attempt.attach(raw, timeoutMs);
        h.onQueue(raw, timeoutMs, (codes, err) -> {
            QualityCode q = err == null && codes != null && !codes.isEmpty() ? codes.get(0) : null;
            ErrorCode code;
            if (err instanceof TimeoutException) {
                code = ErrorCode.TIMEOUT;
            } else if (err != null) {
                h.warnings().warn("configEdit.failed", "Tag configuration save failed on " + h.describe(), err);
                code = ErrorCode.INTERNAL;
            } else {
                code = TagConfigEditor.mapResult(q);
            }
            JsonObject previous = new JsonObject();
            previous.addProperty("engUnit", prevUnit);
            previous.add("engLow", TagConfigEditor.num(prevLow));
            previous.add("engHigh", TagConfigEditor.num(prevHigh));
            JsonObject ev = new JsonObject();
            ev.addProperty("tagPath", target);
            ev.addProperty("engUnit", changes.engUnit());
            ev.add("engLow", TagConfigEditor.num(changes.engLow()));
            ev.add("engHigh", TagConfigEditor.num(changes.engHigh()));
            ev.addProperty("previousEngUnit", prevUnit);
            ev.add("previousEngLow", TagConfigEditor.num(prevLow));
            ev.add("previousEngHigh", TagConfigEditor.num(prevHigh));
            ev.addProperty("success", code == null);
            ev.addProperty("quality", q != null ? q.getName() : (code == ErrorCode.TIMEOUT ? "Uncertain" : "Bad"));
            if (code == null) {
                ev.add("errorCode", JsonNull.INSTANCE);
            } else {
                ev.addProperty("errorCode", code.name());
            }
            ev.addProperty("user", user.userName());
            ev.addProperty("timestamp", System.currentTimeMillis());
            ev.addProperty("auditId", auditId);
            h.fire("onTagConfigEdit", ev);
            if (code == null) {
                h.configEdited();
                JsonObject data = new JsonObject();
                data.addProperty("tagPath", target);
                data.add("applied", changes.toJson());
                data.add("previous", previous);
                data.add("quality", qualityJson(q));
                data.addProperty("auditId", auditId);
                cc.reply(data);
            } else {
                cc.fail(code, auditDetails(auditId, q));
            }
        });
    }

    // =========================================================================================================
    // dt.trendAdd / dt.trendRemove
    // =========================================================================================================

    /** {@code dt.trendAdd {expectedTagPath}}. */
    public static void trendAdd(CallContext cc, Host h) {
        String expected = Json.string(cc.body(), "expectedTagPath", null);
        if (expected == null) {
            fail(cc, h, ErrorCode.BAD_REQUEST, null, "missing expectedTagPath");
            return;
        }
        DisplayGates.Target t = DisplayGates.trend(cc.props(), cc.user(), h.defaultProvider());
        if (!t.ok()) {
            fail(cc, h, t.error(), null, "trend gate");
            return;
        }
        if (!DisplayGates.sameTarget(expected, t.path(), h.defaultProvider())) {
            fail(cc, h, ErrorCode.STALE_TARGET, null, "trend target");
            return;
        }
        TagPath path = t.path();
        Map<String, TagPath> reads = new LinkedHashMap<>();
        for (String k : List.of(TagMetaReader.VALUE, TagMetaReader.TAG_TYPE, TagMetaReader.DATA_TYPE,
                TagMetaReader.HISTORY_ENABLED, TagMetaReader.HISTORY_PROVIDER)) {
            reads.put(k, TagMetaReader.path(path, k, null));
        }
        ModuleSettings.Settings s = h.services().settings().get();
        h.onQueue(TagMetaReader.read(h.tagManager(), reads, cc.user().securityContext()), s.readTimeoutMs(), (m, err) -> {
            if (err != null) {
                readFailed(cc, h, err, "trendAdd");
                return;
            }
            TagMetaReader.Meta meta = new TagMetaReader.Meta(m);
            ErrorCode facts = DisplayGates.tagFacts(m.get(TagMetaReader.VALUE), meta, true, false, false);
            if (facts != null) {
                fail(cc, h, facts, null, "trend tag facts");
                return;
            }
            HistoryAvailability.Status hist = h.history(meta);
            if (!hist.available()) {
                fail(cc, h, "unsupportedType".equals(hist.reason()) ? ErrorCode.UNSUPPORTED_TYPE : ErrorCode.NO_HISTORY,
                    null, "trend history");
                return;
            }
            UserContext user = h.user();
            if (user.generation() != cc.user().generation()) {
                fail(cc, h, ErrorCode.AUTH_CHANGED, null, "trend auth changed");
                return;
            }
            DisplayGates.Target again = DisplayGates.trend(h.props(), user, h.defaultProvider());
            if (!again.ok() || !again.path().equals(path)) {
                fail(cc, h, again.ok() ? ErrorCode.STALE_TARGET : again.error(), null, "trend gate after read");
                return;
            }
            TrendListStore store = h.services().trendStore();
            String group = h.trendGroup();
            TrendListStore.AddResult r = store.add(h.sessionId(), group, path.toStringFull(), user.userName());
            int max = h.services().settings().get().trendMaxPens();
            if (r == TrendListStore.AddResult.FULL || r == TrendListStore.AddResult.GROUPS_FULL) {
                JsonObject d = new JsonObject();
                d.addProperty("max", max);
                fail(cc, h, ErrorCode.TREND_LIST_FULL, d, "trend full");
                return;
            }
            if (r == TrendListStore.AddResult.ADDED) {
                trendEvent(h, "add", path.toStringFull(), group, user);
            }
            JsonObject data = new JsonObject();
            data.addProperty("group", group);
            data.addProperty("trending", true);
            data.addProperty("count", store.get(h.sessionId(), group).size());
            data.addProperty("max", max);
            cc.reply(data);
        });
    }

    /** {@code dt.trendRemove {expectedTagPath}}: same gates as add, no history requirement. */
    public static void trendRemove(CallContext cc, Host h) {
        String expected = Json.string(cc.body(), "expectedTagPath", null);
        if (expected == null) {
            fail(cc, h, ErrorCode.BAD_REQUEST, null, "missing expectedTagPath");
            return;
        }
        DisplayGates.Target t = DisplayGates.trend(cc.props(), cc.user(), h.defaultProvider());
        if (!t.ok()) {
            fail(cc, h, t.error(), null, "trend gate");
            return;
        }
        if (!DisplayGates.sameTarget(expected, t.path(), h.defaultProvider())) {
            fail(cc, h, ErrorCode.STALE_TARGET, null, "trend target");
            return;
        }
        TrendListStore store = h.services().trendStore();
        String group = h.trendGroup();
        String full = t.path().toStringFull();
        if (store.remove(h.sessionId(), group, full)) {
            trendEvent(h, "remove", full, group, cc.user());
        }
        JsonObject data = new JsonObject();
        data.addProperty("group", group);
        data.addProperty("trending", false);
        data.addProperty("count", store.get(h.sessionId(), group).size());
        cc.reply(data);
    }

    private static void trendEvent(Host h, String action, String tagPath, String group, UserContext user) {
        TREND.debugf("trend %s session=%s group=%s user=%s tag=%s", action, h.sessionId(), group,
            Json.sanitizeForLog(user.userName()), Json.sanitizeForLog(tagPath));
        JsonObject ev = new JsonObject();
        ev.addProperty("action", action);
        ev.addProperty("tagPath", tagPath);
        ev.addProperty("group", group);
        ev.addProperty("user", user.userName());
        ev.addProperty("timestamp", System.currentTimeMillis());
        h.fire("onTrendChange", ev);
    }

    // =========================================================================================================
    // dt.auditQuery
    // =========================================================================================================

    /**
     * {@code dt.auditQuery {expectedTagPath}} → {@code {tagPath, rows:[{t, user, action, value, status, auditId?}]}}.
     * Static gates → fresh read of the tag with the caller's context (Read permission; the rows contain values) →
     * user generation + gates + target again → profile query (own executor) → user generation + gates + target again
     * → reply.
     */
    public static void auditQuery(CallContext cc, Host h) {
        String expected = Json.string(cc.body(), "expectedTagPath", null);
        if (expected == null) {
            fail(cc, h, ErrorCode.BAD_REQUEST, null, "missing expectedTagPath");
            return;
        }
        Optional<AuditProfile> profile = h.auditProfile();
        DisplayGates.Target t = DisplayGates.changeHistory(cc.props(), cc.user(), h.defaultProvider(), profile.isPresent());
        if (!t.ok()) {
            fail(cc, h, t.error(), null, "changeHistory gate");
            return;
        }
        if (!DisplayGates.sameTarget(expected, t.path(), h.defaultProvider())) {
            fail(cc, h, ErrorCode.STALE_TARGET, null, "changeHistory target");
            return;
        }
        // The audit rows carry written/previous VALUES ("<new> (was <old>) ..."), so they are as sensitive as the tag
        // value itself: a fresh read with the caller's security context must prove Read access first (the audit
        // profile query itself has no user context). Denied → ACCESS_DENIED, missing → TAG_NOT_FOUND.
        TagPath path = t.path();
        Map<String, TagPath> reads = new LinkedHashMap<>();
        for (String k : List.of(TagMetaReader.VALUE, TagMetaReader.TAG_TYPE)) {
            reads.put(k, TagMetaReader.path(path, k, null));
        }
        ModuleSettings.Settings s = h.services().settings().get();
        h.onQueue(TagMetaReader.read(h.tagManager(), reads, cc.user().securityContext()), s.readTimeoutMs(), (m, err) -> {
            if (err != null) {
                readFailed(cc, h, err, "auditQuery");
                return;
            }
            ErrorCode facts = DisplayGates.tagFacts(m.get(TagMetaReader.VALUE), new TagMetaReader.Meta(m), true, false,
                false);
            if (facts != null) {
                fail(cc, h, facts, null, "changeHistory tag facts");
                return;
            }
            Optional<AuditProfile> nowProfile = changeHistoryStillAllowed(cc, h, expected, path, "after read");
            if (nowProfile.isEmpty()) {
                return;
            }
            auditQueryAfterRead(cc, h, expected, path, nowProfile.get());
        });
    }

    /**
     * Re-check of {@code dt.auditQuery} on the session queue after an asynchronous step (the fresh read, then the
     * profile query): same user generation ({@code AUTH_CHANGED}), the change-history gate on the <em>current</em>
     * trusted props + profile, and the same target ({@code STALE_TARGET}). Returns the current profile, or empty
     * after replying with the error.
     */
    private static Optional<AuditProfile> changeHistoryStillAllowed(CallContext cc, Host h, String expected,
                                                                    TagPath path, String phase) {
        UserContext user = h.user();
        if (user.generation() != cc.user().generation()) {
            fail(cc, h, ErrorCode.AUTH_CHANGED, null, "changeHistory auth changed " + phase);
            return Optional.empty();
        }
        Optional<AuditProfile> nowProfile = h.auditProfile();
        DisplayGates.Target again = DisplayGates.changeHistory(h.props(), user, h.defaultProvider(),
            nowProfile.isPresent());
        if (!again.ok()) {
            fail(cc, h, again.error(), null, "changeHistory gate " + phase);
            return Optional.empty();
        }
        if (!again.path().equals(path) || !DisplayGates.sameTarget(expected, again.path(), h.defaultProvider())) {
            fail(cc, h, ErrorCode.STALE_TARGET, null, "changeHistory target " + phase);
            return Optional.empty();
        }
        return nowProfile;
    }

    private static void auditQueryAfterRead(CallContext cc, Host h, String expected, TagPath path,
                                            AuditProfile profile) {
        OptionalDouble lim = h.props().number("menu.changeHistory.limit");
        int limit = (int) Math.max(1, Math.min(50, lim.isPresent() ? lim.getAsDouble() : 20));
        String target = path.toStringFull();
        AuditQueryService svc = h.services().shared(AuditQueryService.class, AuditQueryService::new);
        CompletableFuture<JsonArray> f;
        long timeoutMs = h.services().settings().get().readTimeoutMs();
        try {
            // Owned by the session (at most 2 outstanding) and given up after the same deadline as the
            // answer below, so an abandoned query never waits in (or blocks) the module-wide executor
            f = svc.query(profile, target, limit, h.sessionId(), timeoutMs);
        } catch (RejectedExecutionException e) {
            fail(cc, h, ErrorCode.RATE_LIMITED, null, "audit query executor full");
            return;
        }
        h.onQueue(f, timeoutMs, (rows, err) -> {
            if (err instanceof TimeoutException) {
                cc.fail(ErrorCode.TIMEOUT);
                return;
            }
            if (err instanceof RejectedExecutionException) {
                cc.fail(ErrorCode.RATE_LIMITED);
                return;
            }
            if (err != null) {
                h.warnings().warn("auditQuery.failed", "Audit profile query failed on " + h.describe(), err);
                cc.fail(ErrorCode.INTERNAL);
                return;
            }
            // tagPath, menu.changeHistory.* or the user may have changed while the profile was queried: the rows
            // must still belong to what the display shows, for a user still allowed to see them.
            if (changeHistoryStillAllowed(cc, h, expected, path, "during the query").isEmpty()) {
                return;
            }
            JsonObject data = new JsonObject();
            data.addProperty("tagPath", target);
            data.add("rows", rows);
            cc.reply(data);
        });
    }

    // =========================================================================================================
    // Helpers
    // =========================================================================================================

    /** {@code ui} of a write → event {@code editMode}: popup | direct | protected | unknown (never authorises). */
    public static String editMode(String ui) {
        switch (ui == null ? "" : ui) {
            case "popup":
            case "direct":
            case "protected":
                return ui;
            default:
                return "unknown";
        }
    }

    /** {@code setpoint.maxStringLength} clamped to 1..4096 (schema default 255). */
    static int maxStringLength(PropsSnapshot p) {
        OptionalDouble d = p.number("setpoint.maxStringLength");
        return (int) Math.max(1, Math.min(4096, d.isPresent() ? d.getAsDouble() : 255));
    }

    /** Validation failure: reply with the code, log at DEBUG only (a client must not be able to trigger a WARN). */
    private static void fail(CallContext cc, Host h, ErrorCode code, JsonObject details, String where) {
        h.logger().debugf("%s %s refused: %s on %s", cc.name(), where, code, h.describe());
        cc.fail(code, details);
    }

    private static void readFailed(CallContext cc, Host h, Throwable err, String what) {
        if (err instanceof TimeoutException) {
            cc.fail(ErrorCode.TIMEOUT);   // nothing was written
        } else {
            h.warnings().warn(what + ".read", "Fresh tag read failed for " + what + " on " + h.describe(), err);
            cc.fail(ErrorCode.INTERNAL);
        }
    }

    private static JsonObject auditDetails(String auditId, QualityCode q) {
        JsonObject d = new JsonObject();
        d.addProperty("auditId", auditId);
        if (q != null) {
            d.addProperty("quality", q.getName());
        }
        return d;
    }

    private static JsonObject qualityJson(QualityCode q) {
        JsonObject o = new JsonObject();
        if (q != null) {
            o.addProperty("code", q.getCode());
            o.addProperty("name", q.getName());
        }
        return o;
    }

    private static Double finite(double d) {
        return Double.isFinite(d) ? d : null;
    }

    /**
     * Debug test hook: completes {@code f}'s value only after {@code delayMs} more (module scheduler). Used only when
     * {@code ctg.debug} is on and a delay is configured; {@code f} itself is never delayed.
     */
    private static <T> CompletableFuture<T> delayed(CompletableFuture<T> f, long delayMs, Host h) {
        if (delayMs <= 0) {
            return f;
        }
        CompletableFuture<T> out = new CompletableFuture<>();
        f.whenComplete((v, err) -> {
            try {
                h.services().scheduler().schedule(() -> {
                    if (err != null) {
                        out.completeExceptionally(err);
                    } else {
                        out.complete(v);
                    }
                }, delayMs, java.util.concurrent.TimeUnit.MILLISECONDS);
            } catch (RejectedExecutionException e) {
                out.completeExceptionally(e);
            }
        });
        return out;
    }
}
