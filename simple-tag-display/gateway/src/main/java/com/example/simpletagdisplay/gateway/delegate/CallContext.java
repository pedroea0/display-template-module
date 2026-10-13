package com.example.simpletagdisplay.gateway.delegate;

import java.util.concurrent.CompletableFuture;

import com.example.simpletagdisplay.common.protocol.ErrorCode;
import com.example.simpletagdisplay.gateway.delegate.HandlerRegistry.RateClass;
import com.example.simpletagdisplay.gateway.security.UserContext;
import com.inductiveautomation.ignition.common.gson.JsonObject;
import com.inductiveautomation.perspective.gateway.api.Component;
import com.inductiveautomation.perspective.gateway.api.Session;

/**
 * Everything a handler needs about one inbound message, and the way it answers.
 *
 * Built on the session queue by {@link CtgDelegateBase#handleEvent}. Handlers stay transport-agnostic: they read
 * the request, the user and the <b>trusted</b> props snapshot from here and complete the call with
 * {@link #reply(JsonObject)} or {@link #fail(ErrorCode)} — from any thread, at any later time. The delegate sends
 * the {@code ctg.reply} on the session queue when the call completes; for MUTATE messages the same completion
 * answers every duplicate of the request id ({@link IdempotencyMap}). Completing twice is a no-op (first wins).
 *
 * {@link #user()} and {@link #props()} are the values at receipt. Code that hops off the queue and comes back must
 * compare {@code user().generation()} with the delegate's current user before acting (and answer
 * {@code AUTH_CHANGED} when the user changed in between) and re-read the snapshot.
 */
public final class CallContext {

    private final Component component;
    private final Session session;
    private final UserContext user;
    private final PropsSnapshot props;
    private final String name;
    private final String id;
    private final JsonObject body;
    private final RateClass rateClass;
    private final CompletableFuture<JsonObject> result;

    CallContext(Component component, Session session, UserContext user, PropsSnapshot props, String name, String id,
                JsonObject body, RateClass rateClass, CompletableFuture<JsonObject> result) {
        this.component = component;
        this.session = session;
        this.user = user;
        this.props = props;
        this.name = name;
        this.id = id;
        this.body = body;
        this.rateClass = rateClass;
        this.result = result;
    }

    public Component component() {
        return component;
    }

    public Session session() {
        return session;
    }

    /** User at the time the message was received (compare {@code generation()} after async hops). */
    public UserContext user() {
        return user;
    }

    /** Trusted security props + lint verdicts at receipt. */
    public PropsSnapshot props() {
        return props;
    }

    /** Message name, e.g. {@code ctg.ping}. */
    public String name() {
        return name;
    }

    /** Correlation id, or null for {@code ctg.hello}. */
    public String id() {
        return id;
    }

    /** Message body (never null; {@code {}} when the client sent nothing). */
    public JsonObject body() {
        return body;
    }

    public RateClass rateClass() {
        return rateClass;
    }

    /** Completes the call successfully with {@code data} (null → {@code {}}). */
    public void reply(JsonObject data) {
        result.complete(okReply(id, data));
    }

    /** Completes the call with an error code and its standard message. */
    public void fail(ErrorCode code) {
        fail(code, null);
    }

    /** Completes the call with an error code, its standard message and optional {@code details}. */
    public void fail(ErrorCode code, JsonObject details) {
        result.complete(errorReply(id, code, details));
    }

    /** True once {@link #reply} or {@link #fail} was called. */
    public boolean isDone() {
        return result.isDone();
    }

    CompletableFuture<JsonObject> result() {
        return result;
    }

    // ---- reply bodies (shared with CtgDelegateBase) ----------------------------------------------------------

    static JsonObject okReply(String id, JsonObject data) {
        JsonObject r = new JsonObject();
        if (id != null) {
            r.addProperty("id", id);
        }
        r.addProperty("ok", true);
        r.add("data", data == null ? new JsonObject() : data);
        return r;
    }

    static JsonObject errorReply(String id, ErrorCode code, JsonObject details) {
        JsonObject err = new JsonObject();
        err.addProperty("code", code.name());
        err.addProperty("message", code.defaultMessage());
        err.addProperty("retryable", code.retryable());
        if (details != null) {
            err.add("details", details);
        }
        JsonObject r = new JsonObject();
        if (id != null) {
            r.addProperty("id", id);
            r.addProperty("ok", false);
        }
        r.add("error", err);
        return r;
    }
}
