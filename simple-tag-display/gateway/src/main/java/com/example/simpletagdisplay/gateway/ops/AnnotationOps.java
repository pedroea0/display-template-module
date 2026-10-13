package com.example.simpletagdisplay.gateway.ops;

import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import com.example.simpletagdisplay.common.protocol.ErrorCode;
import com.example.simpletagdisplay.gateway.ModuleSettings;
import com.example.simpletagdisplay.gateway.annotations.AnnotationService;
import com.example.simpletagdisplay.gateway.audit.CtgAudit;
import com.example.simpletagdisplay.gateway.delegate.CallContext;
import com.example.simpletagdisplay.gateway.delegate.PropsSnapshot;
import com.example.simpletagdisplay.gateway.security.UserContext;
import com.example.simpletagdisplay.gateway.tags.TagMetaReader;
import com.example.simpletagdisplay.gateway.tags.TagPaths;
import com.example.simpletagdisplay.gateway.util.Json;
import com.inductiveautomation.ignition.common.QualifiedPathUtils;
import com.inductiveautomation.ignition.common.gson.JsonElement;
import com.inductiveautomation.ignition.common.gson.JsonNull;
import com.inductiveautomation.ignition.common.gson.JsonObject;
import com.inductiveautomation.ignition.common.model.values.QualifiedValue;
import com.inductiveautomation.ignition.common.model.values.QualityCode;
import com.inductiveautomation.ignition.common.sqltags.history.annotations.Annotation;
import com.inductiveautomation.ignition.common.sqltags.history.annotations.AnnotationType;
import com.inductiveautomation.ignition.common.tags.model.TagPath;
import com.inductiveautomation.ignition.gateway.audit.AuditProfile;
import com.inductiveautomation.ignition.gateway.historian.TagHistoryManager;
import com.inductiveautomation.perspective.gateway.api.Component;

/**
 * {@code chart.annotationSave} / {@code chart.annotationDelete} and the chart's annotation capability. Stateless; the
 * delegate supplies the state through {@link Host}.
 *
 * <h2>Gates (trusted {@link PropsSnapshot}; fail closed)</h2>
 * <pre>
 *   view   annotations.enabled false                         → ACTION_DISABLED   (binding lint → BOUND_BIDIRECTIONAL)
 *   edit   view gate, then enabled false                     → DISABLED
 *          annotations.edit.enabled false                    → ACTION_DISABLED
 *          binding lint on enabled / annotations.edit        → BOUND_BIDIRECTIONAL
 *          annotations.edit.access (requireLogin default on) → AUTH_REQUIRED / FORBIDDEN_ROLE
 *          Designer in read-only mode                        → DESIGNER_READ_ONLY
 *   others' entries   annotations.edit.ownOnly (default true, anything but an explicit false is true): editing or
 *          deleting an entry whose author is not the session user needs annotations.moderate.enabled +
 *          annotations.moderate.access → else NOT_OWNER. "The session user" = the same user name AND the same
 *          identity provider (session.props.auth.idp). Entries written by other tools (no author) are others'.
 *          An unauthenticated session owns nothing and saves with no author (all anonymous sessions share one
 *          name).
 * </pre>
 *
 * <h2>Save ({@code {tagPath, annotationId?, type, start, end?, text, color?, oldStart?}} → {@code {id, tagPath, auditId}})</h2>
 * The entry id travels as {@code annotationId}, not {@code id}: every delegate message body is merged with the
 * envelope ({@code v}, {@code id} = the request id, {@code build}; ctg-common.js), so a body field {@code id} would be
 * the request id.
 * <ol>
 *   <li>Body: {@code type} ∈ {note, range} and {@code color} empty or {@code #RRGGBB}, text cleaned (control
 *       characters, ≤ 1000 characters) and not empty → else {@code INVALID_VALUE}; malformed JSON types →
 *       {@code BAD_REQUEST}. Times ({@link #checkTimes}): {@code start} at most a day after now, a range's {@code end}
 *       after its start and at most {@code ctg.history.maxRangeDays} later → else {@code INVALID_TIME} with
 *       {@code details {reason: future|order|length, maxRangeDays}} (a time-specific code, not the tag-value text of
 *       {@code INVALID_VALUE}). An edit that keeps the stored start and end of a range is not held to the length bound
 *       (lowering {@code maxRangeDays} must not make existing ranges uneditable).</li>
 *   <li>Edit gate; the tag must be one of the chart's effective pens (normalized key) — {@code STALE_TARGET} — with
 *       history ({@code NO_HISTORY}); a historian known not to support annotations → {@code ANNOTATIONS_UNSUPPORTED};
 *       {@code ctg.audit.required} without a usable audit sink → {@code AUDIT_UNAVAILABLE}.</li>
 *   <li>Fresh read of the tag with the user's context: {@code TAG_NOT_FOUND} / {@code ACCESS_DENIED} (the historian
 *       itself never checks the user).</li>
 *   <li>Back on the session queue: same user ({@code AUTH_CHANGED}), the gates and the pen again.</li>
 *   <li>Edit ({@code id}): every stored version of that id within a day of {@code oldStart} (else {@code start}) →
 *       none current → {@code ANNOTATION_NOT_FOUND}; ownership rule above → {@code NOT_OWNER}.</li>
 *   <li>Edit/delete: the id is claimed module-wide ({@link AnnotationService#claim}): another change of it still
 *       being stored → {@code BUSY}, one that already replaced or deleted it → {@code ANNOTATION_NOT_FOUND} (two tabs
 *       or a double submit never leave two copies). The claim is settled with its own token when the historian
 *       answers, and released (with the quota refunded) when anything fails before the store call: a refusal, or an
 *       unexpected exception → {@code INTERNAL}.</li>
 *   <li>Quota {@code ctg.annotations.maxPerSessionPerHour} → {@code RATE_LIMITED}; audit slots (atomic, as for
 *       writes).</li>
 *   <li>One {@code storeAnnotations} call: a deletion of every old version (edit) + the new entry under a new
 *       {@code storageId} (an edit is delete + add because storing under an existing id appends a version). The data
 *       JSON is built here: the author is the session user (an edit keeps the original author and adds
 *       {@code editedBy}). Audited ({@code "annotation add|edit"}, value = the first 200 text characters + auditId),
 *       raw-future attempt like setpoint writes.</li>
 *   <li>Reply {@code {id: <new storageId>, tagPath, auditId}} (the entry is visible to queries ~0.3 s later; the
 *       client re-queries). Historian refusal → {@code ANNOTATIONS_UNSUPPORTED} (throws "unsupported") /
 *       {@code NO_HISTORY} (no history provider) / {@code WRITE_FAILED}; no answer within {@code ctg.write.timeoutMs}
 *       → {@code TIMEOUT} (the audit records UNCERTAIN, then the late outcome).</li>
 * </ol>
 * Delete ({@code {tagPath, annotationId, start?}} → {@code {deleted, auditId}}) = the same steps without the body/quota rules;
 * without {@code start} the id is searched in the last {@code ctg.history.maxRangeDays}.
 *
 * Validation failures reply the code and log at DEBUG only (a client must not be able to trigger a WARN).
 */
public final class AnnotationOps {

    /** Body field of the entry id ({@code id} is the envelope's request id; see the class comment). */
    public static final String FIELD_ID = "annotationId";

    private AnnotationOps() {
    }

    /** What the annotation actions need from the chart delegate (in addition to {@link ChartOps.Host}). */
    public interface Host extends ChartOps.Host {
        /** The chart's effective pen with this normalized key: its status and history provider; null when none. */
        PenRef annotationPen(String normalizedKey);

        /** The session's historian manager. */
        TagHistoryManager historyManager();

        AnnotationService annotations();

        CtgAudit audit();

        /** Audit profile of the component (project's, else fallback), cached briefly. */
        Optional<AuditProfile> auditProfile();

        /** The component (audit snapshot). */
        Component component();
    }

    /** A pen of the chart as the annotation rules see it. */
    public static final class PenRef {
        final String status;
        final String provider;

        public PenRef(String status, String provider) {
            this.status = status;
            this.provider = provider;
        }

        public String status() {
            return status;
        }

        public String provider() {
            return provider;
        }
    }

    // =========================================================================================================
    // Gates and capability
    // =========================================================================================================

    /** Annotations shown at all (query + draw). */
    public static Optional<ErrorCode> viewGate(PropsSnapshot p) {
        if (!p.gateFlag("annotations.enabled", false)) {
            return Optional.of(ErrorCode.ACTION_DISABLED);
        }
        return p.lintGate("annotations.enabled");
    }

    /** Adding, editing and deleting (see the class comment). */
    public static Optional<ErrorCode> editGate(PropsSnapshot p, UserContext u) {
        Optional<ErrorCode> view = viewGate(p);
        if (view.isPresent()) {
            return view;
        }
        if (!p.gateFlag("enabled", true)) {
            return Optional.of(ErrorCode.DISABLED);
        }
        if (!p.gateFlag("annotations.edit.enabled", false)) {
            return Optional.of(ErrorCode.ACTION_DISABLED);
        }
        Optional<ErrorCode> lint = p.lintGate("enabled", "annotations.edit");
        if (lint.isPresent()) {
            return lint;
        }
        Optional<ErrorCode> access = p.access("annotations.edit", true).evaluate(u);
        if (access.isPresent()) {
            return access;
        }
        return u.designerWritable() ? Optional.empty() : Optional.of(ErrorCode.DESIGNER_READ_ONLY);
    }

    /** Editing and deleting entries of other authors (edit gate + moderate.enabled + moderate.access). */
    public static boolean moderateAllowed(PropsSnapshot p, UserContext u) {
        return editGate(p, u).isEmpty() && p.gateFlag("annotations.moderate.enabled", false)
            && p.lintGate("annotations.moderate").isEmpty() && p.access("annotations.moderate", true).evaluate(u).isEmpty();
    }

    /** {@code annotations.edit.ownOnly}: true unless the trusted value is an explicit {@code false} (fail closed). */
    public static boolean ownOnly(PropsSnapshot p) {
        Optional<JsonElement> e = p.json("annotations.edit.ownOnly");
        return !(e.isPresent() && e.get().isJsonPrimitive() && e.get().getAsJsonPrimitive().isBoolean() && !e.get().getAsBoolean());
    }

    /**
     * {@code annotations {allowed, editAllowed, moderateAllowed, reason}}. {@code unsupported}:
     * every pen with history uses a historian known not to support annotations → nothing is allowed, reason
     * {@code ANNOTATIONS_UNSUPPORTED} (the client hides the annotate button and shows a notice).
     */
    public static JsonObject capability(PropsSnapshot p, UserContext u, boolean unsupported) {
        ErrorCode view = viewGate(p).orElse(null);
        ErrorCode edit = view != null ? view : editGate(p, u).orElse(null);
        if (view == null && unsupported) {
            view = ErrorCode.ANNOTATIONS_UNSUPPORTED;
            edit = view;
        }
        boolean moderate = edit == null && moderateAllowed(p, u);
        JsonObject o = new JsonObject();
        o.addProperty("allowed", view == null);
        o.addProperty("editAllowed", edit == null);
        o.addProperty("moderateAllowed", moderate);
        o.addProperty("ownOnly", ownOnly(p));
        ErrorCode reason = view != null ? view : edit;
        if (reason == null) {
            o.add("reason", JsonNull.INSTANCE);
        } else {
            o.addProperty("reason", reason.name());
        }
        return o;
    }

    // =========================================================================================================
    // chart.annotationSave
    // =========================================================================================================

    /** A validated save body. */
    static final class SaveBody {
        String tagPath;
        UUID id;
        String type;
        long start;
        Long end;
        String text;
        String color;
        Long oldStart;
    }

    /** Validates a save body (pure; JUnit). Returns the error code or null, filling {@code out}. */
    static ErrorCode parseSave(JsonObject b, SaveBody out) {
        JsonElement tp = b.get("tagPath");
        if (!isString(tp)) {
            return ErrorCode.BAD_REQUEST;
        }
        out.tagPath = tp.getAsString();
        JsonElement id = b.get(FIELD_ID);
        if (id != null && !id.isJsonNull()) {
            if (!isString(id)) {
                return ErrorCode.BAD_REQUEST;
            }
            out.id = uuid(id.getAsString());
            if (out.id == null) {
                return ErrorCode.BAD_REQUEST;
            }
        }
        JsonElement type = b.get("type");
        if (!isString(type)) {
            return ErrorCode.BAD_REQUEST;
        }
        out.type = type.getAsString();
        if (!AnnotationService.TYPES.contains(out.type)) {
            return ErrorCode.INVALID_VALUE;
        }
        Long start = time(b.get("start"));
        if (start == null) {
            return ErrorCode.BAD_REQUEST;
        }
        out.start = start;
        JsonElement endEl = b.get("end");
        if (AnnotationService.TYPE_RANGE.equals(out.type)) {
            Long end = time(endEl);
            if (end == null) {
                return endEl == null || endEl.isJsonNull() ? ErrorCode.INVALID_VALUE : ErrorCode.BAD_REQUEST;
            }
            out.end = end;              // its order and length: checkTimes
        }
        JsonElement text = b.get("text");
        if (!isString(text)) {
            return ErrorCode.BAD_REQUEST;
        }
        String raw = text.getAsString();
        if (raw.length() > 4 * AnnotationService.MAX_TEXT_CHARS) {
            return ErrorCode.INVALID_VALUE;
        }
        out.text = AnnotationService.cleanText(raw);
        if (out.text.isEmpty()) {
            return ErrorCode.INVALID_VALUE;
        }
        JsonElement color = b.get("color");
        if (color != null && !color.isJsonNull()) {
            if (!isString(color)) {
                return ErrorCode.BAD_REQUEST;
            }
            String c = color.getAsString();
            if (!AnnotationService.COLOR.matcher(c).matches()) {
                return ErrorCode.INVALID_VALUE;
            }
            out.color = c.isEmpty() ? null : c;
        }
        JsonElement old = b.get("oldStart");
        if (old != null && !old.isJsonNull()) {
            out.oldStart = time(old);
            if (out.oldStart == null) {
                return ErrorCode.BAD_REQUEST;
            }
        }
        return null;
    }

    /** Latest start a note may have: tomorrow (a chart's window ends at most a minute after now). */
    static final long FUTURE_SLACK_MS = AnnotationService.ID_SEARCH_MS;

    /** {@code INVALID_TIME} reasons ({@code details.reason}). */
    static final String TIME_FUTURE = "future";
    static final String TIME_ORDER = "order";
    static final String TIME_LENGTH = "length";

    /**
     * Sanity bounds of a validated body's times: the start at most a day after
     * {@code now} (no chart window reaches further; the history route clamps every window's end to now + 60 s), a
     * range's end after its start, and, when {@code checkLength}, a range no longer than {@code maxRangeDays} (the
     * longest window a chart can show). The past is not bounded: a historical chart can show any past window
     * ({@code 0 <= start}). Returns the {@code INVALID_TIME} reason, or null when the times are fine.
     */
    static String checkTimes(SaveBody b, long now, int maxRangeDays, boolean checkLength) {
        if (b.start > now + FUTURE_SLACK_MS) {
            return TIME_FUTURE;
        }
        if (b.end != null && b.end <= b.start) {
            return TIME_ORDER;
        }
        if (checkLength && b.end != null && b.end - b.start > Math.max(1, maxRangeDays) * AnnotationService.ID_SEARCH_MS) {
            return TIME_LENGTH;
        }
        return null;
    }

    /**
     * True when an edit keeps the stored range exactly (same start and end): such an edit is not held to the current
     * {@code maxRangeDays}. The range was valid when it was stored, and a later, lower setting must not lock its text
     * and colour (deleting it is always possible).
     */
    static boolean keepsStoredRange(SaveBody b, Annotation current) {
        Date s = current == null ? null : current.getRangeStart();
        Date e = current == null ? null : current.getRangeEnd();
        return b.end != null && s != null && e != null && s.getTime() == b.start && e.getTime() == b.end;
    }

    /** Replies {@code INVALID_TIME} with its reason (a validation failure: DEBUG only). */
    private static void failTime(CallContext cc, Host h, String reason, int maxRangeDays) {
        h.logger().debugf("%s times refused: INVALID_TIME (%s) on %s", cc.name(), reason, h.describe());
        JsonObject d = new JsonObject();
        d.addProperty("reason", reason);
        d.addProperty("maxRangeDays", Math.max(1, maxRangeDays));
        cc.fail(ErrorCode.INVALID_TIME, d);
    }

    /** {@code chart.annotationSave} (see the class comment). Session queue. */
    public static void save(CallContext cc, Host h) {
        SaveBody body = new SaveBody();
        ErrorCode bad = parseSave(cc.body(), body);
        if (bad != null) {
            fail(cc, h, bad, "body");
            return;
        }
        // An edit's length bound waits for the stored entry (keepsStoredRange); everything else is checked now.
        int maxDays = h.services().settings().get().historyMaxRangeDays();
        String time = checkTimes(body, System.currentTimeMillis(), maxDays, body.id == null);
        if (time != null) {
            failTime(cc, h, time, maxDays);
            return;
        }
        Target t = target(cc, h, body.tagPath);
        if (t == null) {
            return;
        }
        String action = body.id == null ? CtgAudit.ACTION_ANNOTATION_ADD : CtgAudit.ACTION_ANNOTATION_EDIT;
        freshRead(cc, h, t, () -> {
            if (body.id == null) {
                store(cc, h, t, action, body, List.of(), null);
                return;
            }
            long around = body.oldStart != null ? body.oldStart : body.start;
            lookup(cc, h, t, body.id, around - AnnotationService.ID_SEARCH_MS, around + AnnotationService.ID_SEARCH_MS,
                versions -> store(cc, h, t, action, body, versions, AnnotationService.current(versions)));
        });
    }

    // =========================================================================================================
    // chart.annotationDelete
    // =========================================================================================================

    /** {@code chart.annotationDelete} (see the class comment). Session queue. */
    public static void delete(CallContext cc, Host h) {
        JsonObject b = cc.body();
        JsonElement tp = b.get("tagPath");
        JsonElement idEl = b.get(FIELD_ID);
        UUID id = isString(idEl) ? uuid(idEl.getAsString()) : null;
        if (!isString(tp) || id == null) {
            fail(cc, h, ErrorCode.BAD_REQUEST, "body");
            return;
        }
        JsonElement startEl = b.get("start");
        Long start = startEl == null || startEl.isJsonNull() ? null : time(startEl);
        if (startEl != null && !startEl.isJsonNull() && start == null) {
            fail(cc, h, ErrorCode.BAD_REQUEST, "start");
            return;
        }
        Target t = target(cc, h, tp.getAsString());
        if (t == null) {
            return;
        }
        // The client sends the entry's start; without it the id is searched over the longest period a chart can show.
        long now = System.currentTimeMillis();
        long from;
        long to;
        if (start != null) {
            from = start - AnnotationService.ID_SEARCH_MS;
            to = start + AnnotationService.ID_SEARCH_MS;
        } else {
            from = now - Math.max(1, h.services().settings().get().historyMaxRangeDays()) * AnnotationService.ID_SEARCH_MS;
            to = now + AnnotationService.ID_SEARCH_MS;
        }
        freshRead(cc, h, t, () -> lookup(cc, h, t, id, from, to, versions -> {
            Annotation current = AnnotationService.current(versions);
            if (current == null) {
                fail(cc, h, ErrorCode.ANNOTATION_NOT_FOUND, "delete lookup");
                return;
            }
            AnnotationService.Note note = AnnotationService.parseData(current.getData());
            ErrorCode owner = ownership(h, note);
            if (owner != null) {
                fail(cc, h, owner, "delete owner");
                return;
            }
            List<Annotation> entries = new ArrayList<>(versions.size());
            for (Annotation v : versions) {
                entries.add(v.toBuilder().delete().build());
            }
            commit(cc, h, t, CtgAudit.ACTION_ANNOTATION_DELETE, note.text(), entries, null, id, versions.size());
        }));
    }

    // =========================================================================================================
    // Shared steps
    // =========================================================================================================

    /** The pen an action targets, as resolved on receipt. */
    static final class Target {
        final TagPath path;
        final String nk;
        final String provider;
        final UserContext user;
        final Optional<AuditProfile> profile;

        Target(TagPath path, String nk, String provider, UserContext user, Optional<AuditProfile> profile) {
            this.path = path;
            this.nk = nk;
            this.provider = provider;
            this.user = user;
            this.profile = profile;
        }
    }

    /** Gate + pen + historian + audit requirement on receipt; null after replying an error. */
    private static Target target(CallContext cc, Host h, String raw) {
        Optional<ErrorCode> gate = editGate(cc.props(), cc.user());
        if (gate.isPresent()) {
            fail(cc, h, gate.get(), "edit gate");
            return null;
        }
        TagPaths.Parsed parsed = TagPaths.parse(raw, h.defaultProvider());
        if (!parsed.ok()) {
            fail(cc, h, ErrorCode.INVALID_PATH, "path");
            return null;
        }
        String nk = TagPaths.normalizedKey(parsed.path());
        ErrorCode penError = penError(h.annotationPen(nk));
        if (penError != null) {
            fail(cc, h, penError, "pen");
            return null;
        }
        String provider = h.annotationPen(nk).provider();
        if (h.annotations().unsupported(provider)) {
            fail(cc, h, ErrorCode.ANNOTATIONS_UNSUPPORTED, "historian");
            return null;
        }
        Optional<AuditProfile> profile = h.auditProfile();
        if (h.audit().refuses(h.services().settings().get().auditRequired(), profile)) {
            fail(cc, h, ErrorCode.AUDIT_UNAVAILABLE, "audit");
            return null;
        }
        return new Target(parsed.path(), nk, provider, cc.user(), profile);
    }

    /** {@code STALE_TARGET} (not a pen of this chart), {@code NO_HISTORY} (a pen without history), or null. */
    static ErrorCode penError(PenRef pen) {
        if (pen == null) {
            return ErrorCode.STALE_TARGET;
        }
        if ("ok".equals(pen.status())) {
            return null;
        }
        return "noHistory".equals(pen.status()) ? ErrorCode.NO_HISTORY : ErrorCode.STALE_TARGET;
    }

    /**
     * Fresh read of the tag with the user's context, then (session queue) the re-checks after the hop; runs
     * {@code next} when everything still holds.
     */
    private static void freshRead(CallContext cc, Host h, Target t, Runnable next) {
        CompletableFuture<Map<String, QualifiedValue>> f;
        try {
            f = TagMetaReader.read(h.tagManager(), Map.of(TagMetaReader.VALUE, t.path), t.user.securityContext());
        } catch (RuntimeException e) {
            h.warnings().warn("annotation.read", "Tag read for " + cc.name() + " failed on " + h.describe(), e);
            cc.fail(ErrorCode.INTERNAL);
            return;
        }
        h.onQueue(f, h.services().settings().get().readTimeoutMs(), (m, err) -> {
            if (err != null || m == null) {
                if (unwrap(err) instanceof TimeoutException) {
                    cc.fail(ErrorCode.TIMEOUT);
                } else {
                    h.warnings().warn("annotation.read", "Tag read for " + cc.name() + " failed on " + h.describe(), err);
                    cc.fail(ErrorCode.INTERNAL);
                }
                return;
            }
            QualifiedValue v = m.get(TagMetaReader.VALUE);
            QualityCode q = v == null ? null : v.getQuality();
            if (q == null || TagPaths.isNotFound(q)) {
                fail(cc, h, ErrorCode.TAG_NOT_FOUND, "read");
                return;
            }
            if (TagPaths.isAccessDenied(q)) {
                fail(cc, h, ErrorCode.ACCESS_DENIED, "read");
                return;
            }
            if (recheck(cc, h, t)) {
                next.run();
            }
        });
    }

    /** The re-checks after an asynchronous hop (same user, gates, pen); false after replying an error. */
    private static boolean recheck(CallContext cc, Host h, Target t) {
        UserContext u = h.user();
        if (u.generation() != t.user.generation()) {
            fail(cc, h, ErrorCode.AUTH_CHANGED, "auth changed");
            return false;
        }
        Optional<ErrorCode> gate = editGate(h.props(), u);
        if (gate.isPresent()) {
            fail(cc, h, gate.get(), "edit gate after hop");
            return false;
        }
        ErrorCode penError = penError(h.annotationPen(t.nk));
        if (penError != null) {
            fail(cc, h, penError, "pen after hop");
            return false;
        }
        return true;
    }

    /** NOT_OWNER when the session user may not change {@code note} (see the class comment); null when allowed. */
    private static ErrorCode ownership(Host h, AnnotationService.Note note) {
        PropsSnapshot p = h.props();
        UserContext u = h.user();
        if (!ownOnly(p) || AnnotationService.isOwn(note, u) || moderateAllowed(p, u)) {
            return null;
        }
        return ErrorCode.NOT_OWNER;
    }

    /**
     * Looks up every stored version of {@code id} whose start is in {@code [from, to]} (annotation thread) and
     * continues on the session queue after the re-checks; none → {@code ANNOTATION_NOT_FOUND}.
     */
    private static void lookup(CallContext cc, Host h, Target t, UUID id, long from, long to,
                               java.util.function.Consumer<List<Annotation>> next) {
        CompletableFuture<List<Annotation>> f;
        try {
            f = h.annotations().versions(h.historyManager(), t.provider, t.path, id, from, to);
        } catch (RejectedExecutionException e) {
            fail(cc, h, ErrorCode.BUSY, "lookup queue");
            return;
        }
        h.onQueue(f, h.services().settings().get().readTimeoutMs(), (versions, err) -> {
            if (err != null || versions == null) {
                historianError(cc, h, unwrap(err), "lookup");
                return;
            }
            if (versions.isEmpty()) {
                fail(cc, h, ErrorCode.ANNOTATION_NOT_FOUND, "lookup");
                return;
            }
            if (recheck(cc, h, t)) {
                next.accept(versions);
            }
        });
    }

    /** Quota, entries, audit, store (save). */
    private static void store(CallContext cc, Host h, Target t, String action, SaveBody body, List<Annotation> versions,
                              Annotation current) {
        long now = System.currentTimeMillis();
        // An anonymous save records no author (every anonymous session shares one name), so only
        // moderators can change it later.
        String author = AnnotationService.authorOf(h.user());
        String authorSource = AnnotationService.authorSourceOf(h.user());
        String data;
        if (body.id != null) {
            if (current == null) {
                fail(cc, h, ErrorCode.ANNOTATION_NOT_FOUND, "edit lookup");
                return;
            }
            AnnotationService.Note note = AnnotationService.parseData(current.getData());
            ErrorCode owner = ownership(h, note);
            if (owner != null) {
                fail(cc, h, owner, "edit owner");
                return;
            }
            if (!keepsStoredRange(body, current)) {
                int maxDays = h.services().settings().get().historyMaxRangeDays();
                String time = checkTimes(body, now, maxDays, true);
                if (time != null) {
                    failTime(cc, h, time, maxDays);
                    return;
                }
            }
            data = AnnotationService.dataJson(body.text, note.author(), note.authorSource(), body.color,
                note.created() != null ? note.created() : now, author, now);
        } else {
            data = AnnotationService.dataJson(body.text, author, authorSource, body.color, now, null, null);
        }
        UUID newId = UUID.randomUUID();
        Annotation.Builder nb = Annotation.newBuilder().path(QualifiedPathUtils.fromTagPathNew(t.path)).data(data)
            .storageId(newId);
        if (AnnotationService.TYPE_RANGE.equals(body.type)) {
            nb.type(AnnotationType.RANGE).start(new Date(body.start)).end(new Date(body.end));
        } else {
            nb.type(AnnotationType.NOTE).time(new Date(body.start));
        }
        List<Annotation> entries = new ArrayList<>(versions.size() + 1);
        for (Annotation v : versions) {
            entries.add(v.toBuilder().delete().build());
        }
        entries.add(nb.build());
        commit(cc, h, t, action, body.text, entries, newId, body.id, versions.size());
    }

    /**
     * Claim of the changed entry, quota (adds and edits), audit slots, the audited store, and the reply. {@code newId}
     * null = delete ({@code removed} versions). {@code changed}: the id an edit or delete replaces (null for an add);
     * it is claimed first ({@link AnnotationService#claim}) so two changes of one entry can never both store: the
     * second gets {@code BUSY} while the first is in flight and {@code ANNOTATION_NOT_FOUND} once it succeeded.
     * The claim is settled with its token when the historian answers the store.
     *
     * <p>Until the store call has been made, everything this method took is given back on every way out: a refusal
     * releases the claim and refunds the quota; an unexpected exception does the same, records the audit attempt as
     * failed when it was begun, logs a rate-limited WARN and replies {@code INTERNAL}. Otherwise an exception between
     * the claim and the store would leave the note answering {@code BUSY} for {@code CLAIM_MAX_MS} and the session one
     * save short. Once the store call returned, its future owns the claim.
     *
     * <p>Any {@link Throwable} is handled (an {@code Error} would otherwise leave the request unanswered and the audit
     * attempt open). A failure <em>after</em> the store call returned never records the attempt as failed nor replies
     * {@code INTERNAL}: the note may be stored, so {@link #afterStore} closes the attempt, settles the claim and
     * answers on the historian's real answer, and the failure is only logged.
     */
    private static void commit(CallContext cc, Host h, Target t, String action, String text, List<Annotation> entries,
                               UUID newId, UUID changed, int removed) {
        ModuleSettings.Settings s = h.services().settings().get();
        long now = System.currentTimeMillis();
        AnnotationService svc = h.annotations();
        long token = 0L;
        if (changed != null) {
            AnnotationService.Ticket claim = svc.claim(changed, now);
            if (claim.result() != AnnotationService.ClaimResult.OK) {
                fail(cc, h, claim.result() == AnnotationService.ClaimResult.BUSY ? ErrorCode.BUSY
                    : ErrorCode.ANNOTATION_NOT_FOUND, "claim");
                return;
            }
            token = claim.token();
        }
        final long claimToken = token;
        boolean quotaTaken = false;
        CtgAudit.Attempt attempt = null;
        CompletableFuture<List<QualityCode>> raw = null;
        boolean settleHooked = false;
        String replyTarget = null;
        String replyAuditId = null;
        try {
            if (newId != null) {
                if (!svc.takeQuota(h.sessionId(), s.annotationsMaxPerSessionPerHour(), now)) {
                    JsonObject d = new JsonObject();
                    d.addProperty("max", s.annotationsMaxPerSessionPerHour());
                    h.logger().debugf("%s refused: RATE_LIMITED (annotation quota) on %s", cc.name(), h.describe());
                    cc.fail(ErrorCode.RATE_LIMITED, d);
                    return;                                         // finally: claim released
                }
                quotaTaken = true;
            }
            String auditId = UUID.randomUUID().toString();
            String target = t.path.toStringFull();
            replyAuditId = auditId;
            replyTarget = target;
            UserContext user = h.user();
            CtgAudit.Origin origin = CtgAudit.Origin.of(h.component(), user.userName(), user.remoteHost(),
                user.isDesigner() ? "Designer" : "Client");
            if (t.profile.isEmpty()) {
                h.audit().warnNoProfile(origin.project());
            }
            String clipped = text == null ? "" : text.length() > AnnotationService.AUDIT_TEXT_CHARS
                ? text.substring(0, AnnotationService.AUDIT_TEXT_CHARS) : text;
            String logFields = (newId != null ? "id=" + newId : "versions=" + removed) + " text=" + Json.sanitizeForLog(clipped);
            // Slots are booked last, right before begin(): nothing in between can fail, and from begin() on the attempt
            // gives them back (attach → its completion, or failedBeforeProvider).
            CtgAudit.Reservation slots = h.audit().reserve(s.auditRequired(), t.profile);
            if (slots == null) {
                fail(cc, h, ErrorCode.AUDIT_UNAVAILABLE, "audit slots");
                return;                                             // finally: claim released, quota refunded
            }
            attempt = h.audit().begin(action, target, origin, auditId, logFields,
                late -> CtgAudit.annotationValue(clipped, auditId, late), t.profile, slots);
            try {
                raw = svc.store(h.historyManager(), t.provider, entries);
            } catch (RejectedExecutionException e) {
                attempt.failedBeforeProvider("Busy");
                attempt = null;
                fail(cc, h, ErrorCode.BUSY, "store queue");
                return;                                             // finally: claim released, quota refunded
            }
            if (changed != null) {
                // Settled on the historian's real answer (also when the reply below already said TIMEOUT), and only
                // while the claim is still this change's (compare-and-remove by token).
                raw.whenComplete((codes, err) -> svc.settle(changed, claimToken, err == null && worst(codes).isGood(),
                    System.currentTimeMillis()));
            }
            settleHooked = true;
            CompletableFuture<List<QualityCode>> overall = raw.thenApply(codes -> List.of(worst(codes)));
            attempt.attach(overall, s.writeTimeoutMs());
            attempt = null;
            reply(cc, h, overall, s.writeTimeoutMs(), newId, removed, target, auditId);
        } catch (Throwable e) {
            // Throwable, not only RuntimeException: an Error (e.g. a LinkageError from the SDK) must still answer
            // the request and close the audit attempt; the finally below gives back the claim and the quota.
            if (raw == null) {
                if (attempt != null) {
                    attempt.failedBeforeProvider("Exception");
                }
                warnCommit(h, cc, " failed on ", e);
                if (!cc.isDone()) {
                    cc.fail(ErrorCode.INTERNAL);
                }
            } else {
                // The store call returned, so the note may well be stored: never record BAD or reply INTERNAL for it.
                // The claim, the audit record and the reply all follow the historian's real answer.
                warnCommit(h, cc, " failed after the store call (the reply follows the historian's answer) on ", e);
                afterStore(cc, h, svc, raw, changed, claimToken, settleHooked, attempt, s.writeTimeoutMs(), newId,
                    removed, replyTarget, replyAuditId);
            }
            if (e instanceof VirtualMachineError && !(e instanceof StackOverflowError)) {
                throw (VirtualMachineError) e;          // answered and closed above; an OutOfMemoryError is not ours
            }
        } finally {
            if (raw == null) {
                // The store was never called: give back the claim and the quota (refusals and exceptions alike).
                if (changed != null) {
                    svc.settle(changed, claimToken, false, System.currentTimeMillis());
                }
                if (quotaTaken) {
                    svc.refund(h.sessionId(), now);
                }
            }
        }
    }

    /** The rate-limited {@code annotation.commit} WARN (no stack trace for a StackOverflowError, as in the base). */
    private static void warnCommit(Host h, CallContext cc, String what, Throwable e) {
        try {
            h.warnings().warn("annotation.commit", "Annotation " + cc.name() + what + h.describe(),
                e instanceof StackOverflowError ? null : e);
        } catch (RuntimeException ignored) {
            // logging must never keep the request from being answered
        }
    }

    /**
     * An unexpected failure after {@code store()} returned: the note may be stored, so the
     * outcome is the historian's. Hooks what the normal path did not get to: the claim's settle, the audit attempt
     * (closed on the real answer: GOOD / BAD / UNCERTAIN, never "Exception"), and the reply, which is sent from the
     * completing thread (the session queue may be what failed) with the same mapping and timeout as {@link #reply}.
     */
    private static void afterStore(CallContext cc, Host h, AnnotationService svc, CompletableFuture<List<QualityCode>> raw,
                                   UUID changed, long claimToken, boolean settleHooked, CtgAudit.Attempt attempt,
                                   long timeoutMs, UUID newId, int removed, String target, String auditId) {
        try {
            if (changed != null && !settleHooked) {
                raw.whenComplete((codes, err) -> svc.settle(changed, claimToken, err == null && worst(codes).isGood(),
                    System.currentTimeMillis()));
            }
            CompletableFuture<List<QualityCode>> overall = raw.thenApply(codes -> List.of(worst(codes)));
            if (attempt != null) {
                attempt.attach(overall, timeoutMs);
            }
            if (!cc.isDone()) {
                // a copy, so the timeout cannot complete the future the audit attempt watches (that one says UNCERTAIN)
                overall.copy().orTimeout(timeoutMs, TimeUnit.MILLISECONDS).whenComplete((codes, err) -> {
                    if (!cc.isDone()) {
                        answer(cc, codes, unwrap(err), newId, removed, target, auditId);
                    }
                });
            }
        } catch (RuntimeException | StackOverflowError e) {
            warnCommit(h, cc, " could not follow the store's answer on ", e);
        }
    }

    /** The reply of a store: the new id (or the deleted count), or the error the historian's answer maps to. */
    private static void reply(CallContext cc, Host h, CompletableFuture<List<QualityCode>> overall, long timeoutMs,
                              UUID newId, int removed, String target, String auditId) {
        h.onQueue(overall, timeoutMs, (codes, err) -> answer(cc, codes, unwrap(err), newId, removed, target, auditId));
    }

    /** Maps the historian's answer (or {@code cause}) to the reply. */
    private static void answer(CallContext cc, List<QualityCode> codes, Throwable cause, UUID newId, int removed,
                               String target, String auditId) {
        if (cause instanceof TimeoutException) {
            cc.fail(ErrorCode.TIMEOUT, auditDetails(auditId));
            return;
        }
        if (cause != null || codes == null || codes.isEmpty()) {
            if (cause instanceof AnnotationService.StoreFailed
                    && AnnotationService.STATUS_UNSUPPORTED.equals(((AnnotationService.StoreFailed) cause).status())) {
                cc.fail(ErrorCode.ANNOTATIONS_UNSUPPORTED, auditDetails(auditId));
            } else {
                cc.fail(ErrorCode.WRITE_FAILED, auditDetails(auditId));
            }
            return;
        }
        QualityCode q = codes.get(0);
        if (!q.isGood()) {
            cc.fail(storeError(q), auditDetails(auditId));
            return;
        }
        JsonObject data = new JsonObject();
        if (newId != null) {
            data.addProperty("id", newId.toString());
        } else {
            data.addProperty("deleted", removed);
        }
        data.addProperty("tagPath", target);
        data.addProperty("auditId", auditId);
        cc.reply(data);
    }

    /** The first non-good code, else Good (an edit is one store of several entries; all must succeed). */
    static QualityCode worst(List<QualityCode> codes) {
        if (codes == null || codes.isEmpty()) {
            return QualityCode.Bad;
        }
        for (QualityCode q : codes) {
            if (q == null || !q.isGood()) {
                return q == null ? QualityCode.Bad : q;
            }
        }
        return codes.get(0);
    }

    /**
     * Error of a store the historian answered with a bad quality: {@code NO_HISTORY} when it says the tag's history
     * provider does not exist (the historian answers {@code Error_Configuration "History provider '…' not found"}), else
     * {@code WRITE_FAILED}.
     */
    static ErrorCode storeError(QualityCode q) {
        String d = q == null ? null : q.getDiagnosticMessage();
        String n = q == null ? null : q.getName();
        String text = ((d == null ? "" : d) + " " + (n == null ? "" : n)).toLowerCase(java.util.Locale.ROOT);
        if (text.contains("provider") && text.contains("not found")) {
            return ErrorCode.NO_HISTORY;
        }
        if (text.contains("not supported") || text.contains("unsupported")) {
            return ErrorCode.ANNOTATIONS_UNSUPPORTED;
        }
        return ErrorCode.WRITE_FAILED;
    }

    /** Lookup failure: unsupported historian, queue full, or an error. */
    private static void historianError(CallContext cc, Host h, Throwable cause, String where) {
        if (cause instanceof TimeoutException) {
            cc.fail(ErrorCode.TIMEOUT);
        } else if (cause instanceof AnnotationService.StoreFailed
                && AnnotationService.STATUS_UNSUPPORTED.equals(((AnnotationService.StoreFailed) cause).status())) {
            fail(cc, h, ErrorCode.ANNOTATIONS_UNSUPPORTED, where);
        } else if (cause instanceof RejectedExecutionException) {
            fail(cc, h, ErrorCode.BUSY, where);
        } else {
            cc.fail(ErrorCode.HISTORY_QUERY_FAILED);
        }
    }

    private static JsonObject auditDetails(String auditId) {
        JsonObject d = new JsonObject();
        d.addProperty("auditId", auditId);
        return d;
    }

    // =========================================================================================================
    // Helpers
    // =========================================================================================================

    private static void fail(CallContext cc, Host h, ErrorCode code, String where) {
        h.logger().debugf("%s %s refused: %s on %s", cc.name(), where, code, h.describe());
        cc.fail(code);
    }

    private static boolean isString(JsonElement e) {
        return e != null && e.isJsonPrimitive() && e.getAsJsonPrimitive().isString();
    }

    /** A whole, non-negative epoch-ms number (fractions are cut), or null. */
    static Long time(JsonElement e) {
        if (e == null || !e.isJsonPrimitive() || !e.getAsJsonPrimitive().isNumber()) {
            return null;
        }
        double d = e.getAsDouble();
        if (!Double.isFinite(d) || d < 0 || d > 253_402_300_799_000d) {    // year 9999
            return null;
        }
        return (long) d;
    }

    /** A canonical UUID string, or null. */
    static UUID uuid(String s) {
        if (s == null || s.length() != 36) {
            return null;
        }
        try {
            return UUID.fromString(s);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private static Throwable unwrap(Throwable t) {
        Throwable c = t;
        while ((c instanceof CompletionException || c instanceof ExecutionException) && c.getCause() != null) {
            c = c.getCause();
        }
        return c;
    }
}
