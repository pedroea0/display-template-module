package com.example.simpletagdisplay.gateway.history;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Locale;
import java.util.Optional;
import java.util.UUID;
import java.util.zip.GZIPOutputStream;

import com.example.simpletagdisplay.common.protocol.ErrorCode;
import com.example.simpletagdisplay.common.protocol.Protocol;
import com.example.simpletagdisplay.gateway.GatewayServices;
import com.example.simpletagdisplay.gateway.ModuleSettings;
import com.example.simpletagdisplay.gateway.perspective.PerspectiveInternals;
import com.inductiveautomation.ignition.common.gson.JsonElement;
import com.inductiveautomation.ignition.common.util.LoggerEx;
import com.inductiveautomation.ignition.gateway.dataroutes.HttpMethod;
import com.inductiveautomation.ignition.gateway.dataroutes.RequestContext;
import com.inductiveautomation.ignition.gateway.dataroutes.RouteAccess;
import com.inductiveautomation.ignition.gateway.dataroutes.RouteGroup;
import com.inductiveautomation.perspective.gateway.api.Session;
import com.inductiveautomation.perspective.gateway.api.SessionScope;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

/**
 * {@code POST /data/simpletagdisplay/v2/history} — the module's only HTTP route.
 *
 * <h2>Why HTTP at all</h2>
 * History responses can be megabytes; Perspective's websocket is the wrong pipe for them (2 MiB frame cap, and a big
 * frame stalls every other message of the page). Everything else travels over the component delegates.
 *
 * <h2>Validation order</h2>
 * <ol>
 *   <li>module stopped → 503 {@code MODULE_STOPPING};</li>
 *   <li>{@code Sec-Fetch-Site: cross-site} → 403 {@code SESSION_MISMATCH}; {@code Content-Type} not JSON → 415;
 *       {@code X-CTG-Protocol} ≠ 2 → 409;</li>
 *   <li>{@code X-CTG-Token} unknown, expired, or its session no longer alive ({@code LiveSessions}) → 401;</li>
 *   <li>Client tokens: the request's cookie session must be the token's session → 403; Designer tokens (the
 *       Designer's browser has no Perspective cookie session): short TTL, and the request must come from the remote
 *       address bound at issue (a Designer token without a bound address is refused too) → 403;</li>
 *   <li>no {@code Content-Length} → 411; a claim above 4× {@code ctg.history.bodyMaxKb} → 413 at once, without
 *       reading a byte;</li>
 *   <li><b>admission</b> ({@link HistoryService#admit}: global in-flight slot, per-session slot) → 503 / 429 with
 *       {@code Retry-After} — <b>before a byte of the body is read</b>, so a client that sends its headers and then
 *       stalls the body cannot park a Jetty thread outside every module limit;</li>
 *   <li>body read under a {@value #BODY_READ_DEADLINE_MS} ms deadline ({@link HistoryService#bodyDeadline}; expired →
 *       400 + {@code Connection: close}): a claim above {@code bodyMaxKb} (up to 4×) is drained so a browser can read
 *       the 413; otherwise the bounded, depth-limited parse ({@link BoundedJson}, depth 8) → 400 / 413;</li>
 *   <li>per-token rate limit ({@link HistoryService#checkInterval}: a token bucket, burst 8, refilled at one per
 *       {@code ctg.history.minIntervalMs}) → 429;</li>
 *   <li>{@link HistoryRequest} rules → 400 / 409; execution with the overall deadline
 *       ({@code ctg.history.timeoutMs}) → 504 / 502 / 503;</li>
 *   <li>the response is streamed ({@link HistoryJsonWriter}, gzip when accepted) and every slot is released after the
 *       body was written (a client that goes away mid-stream is logged at DEBUG only).</li>
 * </ol>
 * CSRF: a cross-origin page cannot send {@code application/json} with a custom header without a CORS preflight,
 * which the gateway does not grant, and cannot know the token; browsers that send {@code Sec-Fetch-Site}
 * are refused explicitly.
 *
 * <h2>Framework access check</h2>
 * The route's {@code AccessControlStrategy} only lets requests through that carry a well-formed token header (43
 * base64url characters); everything else gets the framework's 401 without reaching the handler. Token validity
 * itself is checked in the handler, so the documented order above holds and every refusal has our JSON body.
 *
 * <h2>Streaming</h2>
 * The handler writes the body itself to {@link HttpServletResponse#getOutputStream()} (wrapped in
 * {@link GZIPOutputStream} when the client accepts gzip; the route is mounted without {@code .gzip()}) and returns
 * {@code null}, so the framework renders nothing.
 */
public final class HistoryRoute {

    private static final LoggerEx LOG = LoggerEx.newBuilder().build("SimpleTagDisplay.History");
    private static final int MAX_DEPTH = 8;
    /** Oversized bodies up to this multiple of the limit are drained before the 413 (so browsers can read it). */
    private static final long DRAIN_FACTOR = 4;

    private HistoryRoute() {
    }

    /**
     * Framework concurrency limit of the route. Ignition gives every route a small default semaphore
     * ({@code SystemProps.ROUTES_DEFAULT_CONCURRENCY}; observed on 8.3.10: 5 requests, the rest wait 2 s and get an
     * HTML {@code 503 "Route concurrency limit reached."} without {@code Retry-After}). That cap is global for all
     * sessions, so five slow requests of one user would lock everybody else out — the opposite of the fair admission
     * of {@link HistoryService}. It is set to the module's own in-flight ceiling
     * ({@code HistoryService.MAX_IN_FLIGHT_CEILING}, 64) plus a margin of 16 for requests that are refused at once
     * (401/403/411/413/429/503 never read the body and release the slot within a millisecond). The module's admission
     * (default 32 in flight, JSON {@code BUSY} + {@code Retry-After}, live-reloadable) stays the limit clients see, and
     * the route can never hold more than 80 of Jetty's 300 threads (a much higher cap would let slow bodies starve
     * the gateway).
     */
    static final int FRAMEWORK_CONCURRENCY = HistoryService.MAX_IN_FLIGHT_CEILING + 16;
    private static final int FRAMEWORK_CONCURRENCY_WAIT_MS = 1_000;
    /** Total time a request body may take to arrive (the admission slot is held meanwhile). */
    static final long BODY_READ_DEADLINE_MS = 5_000L;

    /** Mounts the route. Called by the hook, possibly before startup: nothing is captured at mount time. */
    public static void mount(RouteGroup routes) {
        routes.newRoute(Protocol.HISTORY_ROUTE)
            .method(HttpMethod.POST)
            .type(RouteGroup.TYPE_JSON)
            .accessControl(HistoryRoute::access)
            .nocache()
            .concurrency(FRAMEWORK_CONCURRENCY, FRAMEWORK_CONCURRENCY_WAIT_MS)
            .handler(HistoryRoute::handle)
            .mount();
    }

    /** Framework gate: a syntactically valid token header must be present (validity is checked in the handler). */
    static RouteAccess access(RequestContext ctx) {
        String t = ctx.getRequest().getHeader(Protocol.HEADER_TOKEN);
        return t != null && t.length() == 43 && t.chars().allMatch(HistoryRoute::base64url)
            ? RouteAccess.GRANTED : RouteAccess.UNAUTHORIZED;
    }

    private static boolean base64url(int c) {
        return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_';
    }

    /** Route handler: writes the response itself and returns null (the framework then renders nothing). */
    static Object handle(RequestContext ctx, HttpServletResponse resp) throws IOException {
        HttpServletRequest req = ctx.getRequest();
        GatewayServices services = GatewayServices.current();
        if (services == null || services.isClosed()) {
            return refuse(resp, ErrorCode.MODULE_STOPPING, null, 2);
        }

        // 2. Site, media type, protocol.
        String site = req.getHeader("Sec-Fetch-Site");
        if (site != null && site.trim().equalsIgnoreCase("cross-site")) {
            LOG.debug("history: cross-site request refused");
            return refuse(resp, ErrorCode.SESSION_MISMATCH, null, 0);
        }
        String contentType = req.getContentType();
        if (contentType == null || !contentType.trim().toLowerCase(Locale.ROOT).startsWith("application/json")) {
            return refuse(resp, ErrorCode.UNSUPPORTED_MEDIA_TYPE, null, 0);
        }
        if (!String.valueOf(Protocol.VERSION).equals(trim(req.getHeader(Protocol.HEADER_PROTOCOL)))) {
            return refuse(resp, ErrorCode.PROTOCOL_MISMATCH, null, 0);
        }

        // 3. Token + live session.
        HistoryTokenStore.Validation v = services.tokens().validate(req.getHeader(Protocol.HEADER_TOKEN));
        if (v.status() != HistoryTokenStore.Status.OK || v.info().isEmpty()) {
            return refuse(resp, v.status() == HistoryTokenStore.Status.EXPIRED ? ErrorCode.TOKEN_EXPIRED
                : ErrorCode.TOKEN_INVALID, null, 0);
        }
        HistoryTokenStore.TokenInfo token = v.info().get();
        Optional<Session> session = services.liveSessions().session(token.sessionId());
        if (session.isEmpty()) {
            return refuse(resp, ErrorCode.TOKEN_INVALID, null, 0);
        }

        // 4. The request must belong to the token's session.
        if (token.scope() == SessionScope.Designer) {
            // A Designer token without a bound address is never issued; treat one as a mismatch anyway (fail closed).
            String bound = token.boundRemoteAddr();
            if (bound == null || !bound.equals(req.getRemoteAddr())) {
                LOG.debugf("history: Designer token used from another address (session %s)", token.sessionId());
                return refuse(resp, ErrorCode.SESSION_MISMATCH, null, 0);
            }
        } else {
            Optional<UUID> cookieSession = PerspectiveInternals.sessionIdFromRequest(req, token.project());
            if (cookieSession.isEmpty() || !cookieSession.get().equals(token.sessionId())) {
                LOG.debugf("history: token of session %s used without that session's cookie", token.sessionId());
                return refuse(resp, ErrorCode.SESSION_MISMATCH, null, 0);
            }
        }

        // 5. Declared length before reading anything.
        ModuleSettings.Settings s = services.settings().get();
        long maxBytes = s.historyBodyMaxKb() * 1024L;
        long declared = req.getContentLengthLong();
        if (declared < 0) {
            return refuse(resp, ErrorCode.LENGTH_REQUIRED, null, 0);
        }
        if (declared > DRAIN_FACTOR * maxBytes) {
            // Absurd claims (e.g. 2 GB) are refused at once, without reading a byte; the connection is then closed.
            return refuse(resp, ErrorCode.BODY_TOO_LARGE, null, 0);
        }

        // 6. Admission BEFORE the body is read: every thread that waits for a body holds a global and a per-session
        //    slot, so slow bodies are bounded by the module's limits (and the deadline below), never by Jetty's pool.
        HistoryService history = services.history();
        String requestId = null;
        try (HistoryService.Admission admission = history.admit(token)) {
            // 7. Body: drained for a moderately oversized claim (a browser that is still sending its body sees a
            //    connection reset instead of our 413 when the server answers early), else the bounded parse.
            JsonElement body = null;
            ErrorCode bodyError = null;
            boolean expired;
            try (HistoryService.Deadline deadline = history.bodyDeadline(BODY_READ_DEADLINE_MS)) {
                if (declared > maxBytes) {
                    drain(req, declared);
                    bodyError = ErrorCode.BODY_TOO_LARGE;
                } else {
                    try {
                        body = BoundedJson.parse(req.getInputStream(), maxBytes, MAX_DEPTH);
                    } catch (BoundedJson.TooLarge e) {
                        bodyError = ErrorCode.BODY_TOO_LARGE;
                    } catch (BoundedJson.BadJson e) {
                        LOG.debugf("history: bad body (%s)", e.getMessage());
                        bodyError = ErrorCode.BAD_REQUEST;
                    }
                }
                expired = deadline.expired();
            }
            if (body == null && expired) {
                LOG.debugf("history: request body not received within %d ms", BODY_READ_DEADLINE_MS);
                resp.setHeader("Connection", "close");
                return refuse(resp, ErrorCode.BAD_REQUEST, null, 0);
            }
            if (bodyError != null) {
                return refuse(resp, bodyError, null, 0);
            }
            requestId = HistoryRequest.peekRequestId(body);

            // 8. Per-token rate limit, request rules + execution, 9. streamed response; slots released after the body
            //    was written.
            history.checkInterval(token);
            HistoryRequest request;
            try {
                request = HistoryRequest.parse(body, s, System.currentTimeMillis());
            } catch (HistoryRequest.Invalid e) {
                LOG.debugf("history: invalid request (%s: %s)", e.code(), e.getMessage());
                return refuse(resp, e.code(), requestId, 0);
            }
            HistoryResult result;
            try {
                result = history.execute(request, token, session.get(), System.currentTimeMillis() + s.historyTimeoutMs(),
                    admission);
            } catch (HistoryService.Failed e) {
                return refuse(resp, e.code(), requestId, e.code().retryable() ? 1 : 0);
            }
            resp.setStatus(HttpServletResponse.SC_OK);
            resp.setContentType("application/json;charset=UTF-8");
            try (OutputStream os = body(req, resp)) {
                HistoryJsonWriter.write(result, os);
            } catch (IOException e) {
                // The client went away mid-stream (tab closed, request aborted): nothing to answer, not an error.
                LOG.debugf("history: response not delivered (%s)", e.getClass().getSimpleName());
            }
            return null;
        } catch (HistoryService.Refused e) {
            limitHeaders(resp, e);
            return refuse(resp, e.code(), requestId, e.retryAfterS());
        } catch (RuntimeException e) {
            LOG.warn("history: unexpected failure", e);
            return refuse(resp, ErrorCode.INTERNAL, requestId, 0);
        }
    }

    /**
     * Additive headers of an admission / rate refusal (the error body has a fixed protocol shape, so the extra
     * detail travels in headers):
     * {@code X-CTG-Limit} names the limit ({@link HistoryService.Limit}) and {@code X-CTG-Retry-After-Ms} carries the
     * exact wait when it is known (the token bucket's refill time; {@code Retry-After} is whole seconds by HTTP).
     */
    private static void limitHeaders(HttpServletResponse resp, HistoryService.Refused e) {
        if (resp.isCommitted()) {
            return;
        }
        if (e.limit() != null) {
            resp.setHeader("X-CTG-Limit", e.limit().header());
        }
        if (e.retryAfterMs() > 0) {
            resp.setHeader("X-CTG-Retry-After-Ms", Long.toString(e.retryAfterMs()));
        }
    }

    /** Writes an error response with the code's HTTP status and returns null (the body is ours). */
    private static Object refuse(HttpServletResponse resp, ErrorCode code, String requestId, int retryAfterS)
            throws IOException {
        if (resp.isCommitted()) {
            return null;
        }
        int status = code.httpStatus() > 0 ? code.httpStatus() : HttpServletResponse.SC_BAD_REQUEST;
        resp.setStatus(status);
        resp.setContentType("application/json;charset=UTF-8");
        if (retryAfterS > 0) {
            resp.setHeader("Retry-After", Integer.toString(retryAfterS));
        }
        try (OutputStream os = resp.getOutputStream()) {
            HistoryJsonWriter.writeError(requestId, code, os);
        } catch (IOException e) {
            LOG.debugf("history: error response not delivered (%s)", e.getClass().getSimpleName());
        }
        return null;
    }

    /** The response body stream, gzip-compressed when the client accepts it. */
    private static OutputStream body(HttpServletRequest req, HttpServletResponse resp) throws IOException {
        String ae = req.getHeader("Accept-Encoding");
        if (ae != null && ae.toLowerCase(Locale.ROOT).contains("gzip")) {
            resp.setHeader("Content-Encoding", "gzip");
            resp.addHeader("Vary", "Accept-Encoding");
            return new GZIPOutputStream(resp.getOutputStream(), 8192);
        }
        return resp.getOutputStream();
    }

    /** Reads and discards at most {@code max} bytes of the request body (bounded; errors ignored). */
    private static void drain(HttpServletRequest req, long max) {
        byte[] buf = new byte[8192];
        long left = max;
        try (InputStream in = req.getInputStream()) {
            while (left > 0) {
                int n = in.read(buf, 0, (int) Math.min(buf.length, left));
                if (n < 0) {
                    break;
                }
                left -= n;
            }
        } catch (IOException | RuntimeException ignored) {
            // the client went away: nothing to answer
        }
    }

    private static String trim(String s) {
        return s == null ? null : s.trim();
    }
}
