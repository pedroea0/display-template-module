package com.example.simpletagdisplay.common.protocol;

import com.example.simpletagdisplay.common.SimpleTagDisplayModule;

/**
 * Names and constants of the v2 wire protocol.
 *
 * <h2>Transport</h2>
 * Every session-bound operation travels over Perspective's own websocket as a <em>model event</em> between the
 * browser-side {@code ComponentStoreDelegate} ({@code NS.delegate.CtgDelegateBase} in ctg-common.js) and the
 * gateway-side {@code ComponentModelDelegate} ({@code CtgDelegateBase}). History is the only HTTP route
 * ({@link #HISTORY_ROUTE}, POST + JSON + {@link #HEADER_TOKEN}).
 *
 * <h2>Envelope</h2>
 * Client → gateway: {@code {v:2, id, build, ...fields}}. Gateway → client: {@code {v:2, epoch, seq, serverNow, ...}}.
 * Replies are {@link #REPLY} with {@code {id, ok, data | error}}; unsolicited errors are {@link #ERROR}.
 *
 * Message names are dotted: {@code ctg.*} common, {@code dt.*} Display Template, {@code chart.*} chart. The JS
 * side spells the same strings; keep both in sync (this class is the catalogue).
 */
public final class Protocol {

    private Protocol() {
    }

    /** Protocol version carried in every envelope ({@code v}) and the {@link #HEADER_PROTOCOL} header. */
    public static final int VERSION = SimpleTagDisplayModule.PROTOCOL_VERSION;

    // ---- common (both components) ---------------------------------------------------------------------------
    /** C→G handshake {@code {component:"dt"|"chart", resync, clientBuild}}; answered by WELCOME + snapshot. */
    public static final String HELLO = "ctg.hello";
    /** C→G {@code {}} → reply {@code {t: serverNow}} (gateway clock + page watchdog). */
    public static final String PING = "ctg.ping";
    /** C→G debug-only: fire a declared component event with a gateway-built payload. */
    public static final String DEBUG_FIRE = "ctg.debug.fire";
    /** C→G debug-only: reload module settings. */
    public static final String DEBUG_RELOAD_SETTINGS = "ctg.debug.reloadSettings";
    /** G→C handshake answer {@code {protocol, build, user, scope, designerWritable, staleClient, allowCrossOriginFrames}}. */
    public static final String WELCOME = "ctg.welcome";
    /** G→C "reload the page" {@code {reason, serverProtocol, serverBuild}}. */
    public static final String RELOAD = "ctg.reload";
    /** G→C reply to a request {@code {id, ok, data | error}}. */
    public static final String REPLY = "ctg.reply";
    /** G→C unsolicited error {@code {error}}. */
    public static final String ERROR = "ctg.error";
    /** G→C heartbeat after a period of silence. */
    public static final String HEARTBEAT = "ctg.hb";

    // ---- Display Template --------------------------------------------------------------------------------------
    public static final String DT_SNAPSHOT = "dt.snapshot";
    public static final String DT_VALUES = "dt.values";
    public static final String DT_WRITE = "dt.write";
    public static final String DT_CONFIG_EDIT = "dt.configEdit";
    public static final String DT_TREND_ADD = "dt.trendAdd";
    public static final String DT_TREND_REMOVE = "dt.trendRemove";
    public static final String DT_AUDIT_QUERY = "dt.auditQuery";

    // ---- chart ------------------------------------------------------------------------------------------------
    public static final String CHART_SNAPSHOT = "chart.snapshot";
    public static final String CHART_PENS = "chart.pens";
    public static final String CHART_VALUES = "chart.values";
    /** G→C token push and C→G token request (same name in both directions). */
    public static final String CHART_TOKEN = "chart.token";
    public static final String CHART_TREND_ADD = "chart.trendAdd";
    public static final String CHART_TREND_REMOVE = "chart.trendRemove";
    public static final String CHART_TREND_CLEAR = "chart.trendClear";
    public static final String CHART_BROWSE = "chart.browse";
    public static final String CHART_ANNOTATION_SAVE = "chart.annotationSave";
    public static final String CHART_ANNOTATION_DELETE = "chart.annotationDelete";

    // ---- history route ---------------------------------------------------------------------------------------
    /** Path of the history route relative to {@code /data/<URL_ALIAS>/}. */
    public static final String HISTORY_ROUTE = "/v2/history";
    /** Absolute URL path of the history route as the browser calls it. */
    public static final String HISTORY_URL = "/data/" + SimpleTagDisplayModule.URL_ALIAS + HISTORY_ROUTE;
    /** Header carrying the per-session history token issued by the chart delegate. */
    public static final String HEADER_TOKEN = "X-CTG-Token";
    /** Header carrying the protocol version; a mismatch is answered with 409. */
    public static final String HEADER_PROTOCOL = "X-CTG-Protocol";

    // ---- envelope limits ---------------------------------------------------------------------------------------
    /** Largest accepted inbound message (characters of the serialized body); larger → BAD_REQUEST. */
    public static final int MAX_MESSAGE_CHARS = 65_536;
    /** Request ids: 1..64 chars of {@code [A-Za-z0-9_.:-]}. */
    public static final String ID_PATTERN = "[A-Za-z0-9_.:-]{1,64}";

    /** Component kinds sent in {@code ctg.hello.component}. */
    public static final String KIND_DISPLAY = "dt";
    public static final String KIND_CHART = "chart";
}
