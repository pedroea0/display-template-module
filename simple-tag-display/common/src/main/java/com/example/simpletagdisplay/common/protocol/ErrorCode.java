package com.example.simpletagdisplay.common.protocol;

/**
 * Stable error codes shared by delegate replies ({@code ctg.reply {ok:false, error:{code,...}}}) and the history
 * route.
 *
 * Replies always carry one of these codes plus a short, safe English sentence ({@link #defaultMessage()}); they
 * never carry exception text. The frontend may localise by code ({@code NS.i18n.errorText}).
 *
 * {@code httpStatus} is 0 for codes the history route never returns. Client-only codes ({@code CLIENT_TIMEOUT},
 * {@code DISCONNECTED}, {@code DETACHED}) are not in this enum; the browser generates them.
 */
public enum ErrorCode {

    // ---- protocol / transport ----------------------------------------------------------------------------
    BAD_REQUEST(false, 400, "The request was not valid."),
    UNKNOWN_MESSAGE(false, 0, "Unknown request."),
    PROTOCOL_MISMATCH(false, 409, "The module was updated. Reload the page."),
    RATE_LIMITED(true, 429, "Too many requests. Try again in a moment."),
    MODULE_STOPPING(true, 503, "The module is restarting. Try again in a moment."),
    INTERNAL(true, 500, "Internal error."),

    // ---- component gates -------------------------------------------------------------------------------------
    DISABLED(false, 0, "This component is disabled."),
    WRITE_DISABLED(false, 0, "Writing is not enabled for this value."),
    ACTION_DISABLED(false, 0, "This action is not enabled."),
    NO_TAG_PATH(false, 0, "No tag is configured."),
    INVALID_PATH(false, 400, "The tag path is not valid."),
    STALE_TARGET(false, 0, "The tag changed. Try again."),
    AUTH_REQUIRED(false, 0, "Log in to do this."),
    FORBIDDEN_ROLE(false, 0, "You do not have permission to do this."),
    DESIGNER_READ_ONLY(false, 0, "The Designer is in read-only mode. Switch to Read/Write to write values."),

    // ---- tag results ------------------------------------------------------------------------------------------
    TAG_NOT_FOUND(false, 0, "The tag does not exist."),
    ACCESS_DENIED(false, 403, "You may not read this tag."),
    READ_ONLY(false, 0, "The tag is read-only."),
    WRITE_DENIED(false, 0, "The tag's permissions do not allow you to write it."),
    EDIT_DENIED(false, 0, "You may not edit this tag's configuration."),
    INVALID_VALUE(false, 0, "The value is not valid for this tag."),
    UNSUPPORTED_TYPE(false, 0, "This tag's data type is not supported here."),
    NOT_AN_OPTION(false, 0, "The value is not one of the allowed options."),
    OUT_OF_RANGE(false, 0, "The value is outside the allowed range."),
    TIMEOUT(true, 504, "The gateway did not answer in time. The result is unknown."),
    WRITE_FAILED(false, 0, "The write failed."),
    PROVIDER_UNRESOLVED(false, 0, "The tag provider could not be determined."),
    NO_HISTORY(false, 0, "No history is available for this tag."),
    TREND_LIST_FULL(false, 0, "The trend list is full."),
    BROWSE_ROOT_VIOLATION(false, 0, "Browsing is limited to another folder."),

    // ---- history route -----------------------------------------------------------------------------------------
    TOKEN_INVALID(true, 401, "The history session is not valid."),
    TOKEN_EXPIRED(true, 401, "The history session expired."),
    SESSION_MISMATCH(false, 403, "The request does not belong to this session."),
    UNSUPPORTED_MEDIA_TYPE(false, 415, "Unsupported content type."),
    BODY_TOO_LARGE(false, 413, "The request is too large."),
    TOO_MANY_PENS(false, 400, "Too many pens."),
    RANGE_INVALID(false, 400, "The time range is not valid."),
    RANGE_TOO_LARGE(false, 400, "The time range is too large."),
    TOO_MANY_REQUESTS(true, 429, "Too many history requests. Try again in a moment."),
    BUSY(true, 503, "The gateway is busy. Try again in a moment."),
    HISTORY_QUERY_FAILED(true, 502, "The history query failed."),

    // ---- scope, write safety, audit ----------------------------------------------------------------------------
    OUT_OF_SCOPE(false, 0, "This tag is outside the area this screen may use."),
    LIMITS_INVALID(false, 0, "The allowed range for this value is misconfigured."),
    LIMITS_UNAVAILABLE(true, 0, "The allowed range for this value cannot be read right now."),
    AUTH_CHANGED(false, 0, "The logged-in user changed. Try again."),
    BAD_QUALITY(false, 0, "The current value has bad quality, so writing is blocked."),
    STEP_TOO_LARGE(false, 0, "The change is larger than allowed."),
    AUDIT_UNAVAILABLE(false, 0, "No audit log is configured for this project."),
    BOUND_BIDIRECTIONAL(false, 0, "Editing is turned off: this screen's configuration is not safe (ask the integrator)."),
    NOT_OWNER(false, 0, "You can only change your own notes."),
    LENGTH_REQUIRED(false, 411, "Content-Length is required."),

    // ---- annotations -------------------------------------------------------------------------------------------
    ANNOTATIONS_UNSUPPORTED(false, 0, "This historian does not support annotations."),
    ANNOTATION_NOT_FOUND(false, 0, "The note no longer exists."),
    /**
     * A note's time is outside what a chart can show: its start more than a day ahead, a range that does not end
     * after it starts, or a range longer than {@code ctg.history.maxRangeDays}. Details:
     * {@code {reason: "future"|"order"|"length", maxRangeDays}}.
     */
    INVALID_TIME(false, 0, "The note's time is not allowed: check its start and end.");

    private final boolean retryable;
    private final int httpStatus;
    private final String defaultMessage;

    ErrorCode(boolean retryable, int httpStatus, String defaultMessage) {
        this.retryable = retryable;
        this.httpStatus = httpStatus;
        this.defaultMessage = defaultMessage;
    }

    /** True when the same request may succeed later without any change (rate limits, timeouts, restarts). */
    public boolean retryable() {
        return retryable;
    }

    /** HTTP status used by the history route, or 0 when the route never returns this code. */
    public int httpStatus() {
        return httpStatus;
    }

    /** Short, safe sentence the UI may show verbatim. */
    public String defaultMessage() {
        return defaultMessage;
    }
}
