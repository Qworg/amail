import assert from "node:assert/strict";
import { test } from "node:test";

import {
    createRoutingState,
    hashToken,
    TOKEN_BYTES,
} from "../src/routing.mjs";

function clock() {
    let current = 1_000;
    return {
        now: () => current,
        advance(ms) {
            current += ms;
        },
    };
}

test("issues lowercase cryptographically random 128-bit tokens", () => {
    const router = createRoutingState();
    const first = router.createQuestion({ requestId: "request-1" });
    const second = router.createQuestion({ requestId: "request-2" });

    assert.equal(first.token.length, TOKEN_BYTES * 2);
    assert.match(first.token, /^[a-z0-9]+$/);
    assert.notEqual(first.token, second.token);
    assert.equal(hashToken(first.token).length, 64);
});

test("stores question metadata for legacy user_input and structured elicitation", () => {
    const router = createRoutingState();
    const legacy = router.createQuestion({
        requestId: "legacy-request",
        variant: "user_input",
        question: "Pick one",
        choices: ["one", "two"],
        allowFreeform: true,
    });
    const structured = router.createQuestion({
        requestId: "structured-request",
        variant: "elicitation",
        message: "Provide settings",
        mode: "form",
        requestedSchema: { type: "object" },
    });

    assert.deepEqual(
        router.getPendingQuestion("legacy-request").metadata,
        {
            requestId: "legacy-request",
            variant: "user_input",
            question: "Pick one",
            choices: ["one", "two"],
            allowFreeform: true,
        },
    );
    assert.deepEqual(
        router.getPendingQuestion("structured-request").metadata,
        {
            requestId: "structured-request",
            variant: "elicitation",
            message: "Provide settings",
            mode: "form",
            requestedSchema: { type: "object" },
        },
    );
    assert.equal(legacy.kind, "question");
    assert.equal(structured.kind, "question");
});

test("stores follow-up session and idle metadata", () => {
    const router = createRoutingState();
    const issued = router.createFollowup({
        sessionId: "session-1",
        idleMarker: "turn-7-idle",
        promptSubject: "Continue",
    });

    assert.deepEqual(router.getPendingFollowups(), [{
        kind: "followup",
        expiresAt: issued.expiresAt,
        metadata: {
            sessionId: "session-1",
            idleMarker: "turn-7-idle",
            promptSubject: "Continue",
        },
    }]);
});

test("rejects a question token used as a follow-up token without consuming it", () => {
    const router = createRoutingState();
    const issued = router.createQuestion({ requestId: "request-1" });

    const wrongKind = router.consumeFollowup(issued.token);
    assert.equal(wrongKind.ok, false);
    assert.equal(wrongKind.reason, "wrong_kind");
    assert.equal(router.pendingQuestionCount, 1);

    assert.equal(router.consumeQuestion(issued.token).ok, true);
});

test("rejects wrong tokens and keeps the valid token available", () => {
    const router = createRoutingState();
    const issued = router.createQuestion({ requestId: "request-1" });

    const wrong = router.consumeQuestion(`${issued.token}x`);
    assert.equal(wrong.ok, false);
    assert.equal(wrong.reason, "wrong_token");
    assert.equal(router.pendingQuestionCount, 1);
    assert.equal(router.consumeQuestion(issued.token).ok, true);
});

test("consumption is single-use", () => {
    const router = createRoutingState();
    const issued = router.createQuestion({ requestId: "request-1" });

    assert.equal(router.consumeQuestion(issued.token).ok, true);
    const reused = router.consumeQuestion(issued.token);
    assert.equal(reused.ok, false);
    assert.equal(reused.reason, "wrong_token");
});

test("expired questions and follow-ups cannot be consumed", () => {
    const time = clock();
    const router = createRoutingState({ now: time.now, ttlMs: 100 });
    const question = router.createQuestion({ requestId: "request-1" });
    const followup = router.createFollowup({
        sessionId: "session-1",
        idleMarker: "idle-1",
    });

    time.advance(100);
    assert.equal(router.consumeQuestion(question.token).reason, "expired");
    assert.equal(router.consumeFollowup(followup.token).reason, "expired");
    assert.equal(router.pendingQuestionCount, 0);
    assert.equal(router.pendingFollowupCount, 0);
});

test("duplicate Resend message IDs are accepted once and do not consume on duplicate", () => {
    const router = createRoutingState();
    const first = router.createQuestion({ requestId: "request-1" });
    const second = router.createQuestion({ requestId: "request-2" });

    assert.equal(router.consumeQuestion(first.token, { messageId: "resend-1" }).ok, true);
    const duplicate = router.consumeQuestion(second.token, {
        messageId: "resend-1",
    });
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.reason, "duplicate_message_id");
    assert.equal(router.pendingQuestionCount, 1);
    assert.equal(router.isDuplicateMessageId("resend-1"), true);
    assert.equal(router.claimMessageId("resend-1"), false);
    assert.equal(router.claimMessageId("resend-2"), true);
});

test("message IDs expire independently from routing tokens", () => {
    const time = clock();
    const router = createRoutingState({
        now: time.now,
        ttlMs: 1_000,
        messageIdTtlMs: 100,
    });
    const issued = router.createQuestion({ requestId: "request-1" });

    assert.equal(router.consumeQuestion(issued.token, { messageId: "resend-1" }).ok, true);
    time.advance(100);
    assert.equal(router.claimMessageId("resend-1"), true);
});

test("completion handlers invalidate the exact native request", () => {
    const router = createRoutingState();
    const first = router.createQuestion({ requestId: "request-1" });
    const second = router.createQuestion({ requestId: "request-2" });

    assert.equal(
        router.handleUserInputCompleted({ data: { requestId: "request-1" } }),
        true,
    );
    assert.equal(router.consumeQuestion(first.token).reason, "invalidated");
    assert.equal(router.pendingQuestionCount, 1);
    assert.equal(router.consumeQuestion(second.token).ok, true);
    assert.equal(router.handleElicitationCompleted("request-1"), false);
});

test("invalidating a question never converts it into a follow-up", () => {
    const router = createRoutingState();
    const question = router.createQuestion({ requestId: "request-1" });

    assert.equal(router.onNativeRequestCompleted("request-1"), true);
    assert.equal(router.pendingFollowupCount, 0);
    assert.equal(router.consumeFollowup(question.token).reason, "invalidated");
});

test("follow-ups require matching session and idle marker", () => {
    const router = createRoutingState();
    const issued = router.createFollowup({
        sessionId: "session-1",
        idleMarker: "idle-1",
    });

    assert.equal(
        router.consumeFollowup(issued.token, {
            sessionId: "session-2",
            idleMarker: "idle-1",
        }).reason,
        "stale_session",
    );
    assert.equal(
        router.consumeFollowup(issued.token, {
            sessionId: "session-1",
            idleMarker: "idle-2",
        }).reason,
        "stale_session",
    );
    assert.equal(
        router.consumeFollowup(issued.token, {
            sessionId: "session-1",
            idleMarker: "idle-1",
        }).ok,
        true,
    );
});

test("independent requests do not interfere with one another", () => {
    const router = createRoutingState();
    const first = router.createQuestion({
        requestId: "request-1",
        question: "First",
    });
    const second = router.createQuestion({
        requestId: "request-2",
        question: "Second",
    });

    const result = router.consumeQuestion(second.token);
    assert.equal(result.ok, true);
    assert.equal(result.metadata.question, "Second");
    assert.equal(router.pendingQuestionCount, 1);
    assert.equal(router.consumeQuestion(first.token).metadata.question, "First");
});

test("reissuing a native request invalidates its stale token", () => {
    const router = createRoutingState();
    const stale = router.createQuestion({ requestId: "request-1" });
    const current = router.createQuestion({ requestId: "request-1" });

    assert.equal(router.consumeQuestion(stale.token).reason, "invalidated");
    assert.equal(router.consumeQuestion(current.token).ok, true);
});

test("inspects token metadata without consuming it", () => {
    const router = createRoutingState();
    const question = router.createQuestion({
        requestId: "request-1",
        question: "Choose",
    });
    const followup = router.createFollowup({
        sessionId: "session-1",
        idleMarker: "idle-1",
    });

    assert.equal(router.inspectQuestion(question.token).metadata.question, "Choose");
    assert.equal(router.inspectFollowup(question.token).reason, "wrong_kind");
    assert.equal(router.inspectFollowup(followup.token).metadata.idleMarker, "idle-1");
    assert.equal(router.pendingQuestionCount, 1);
    assert.equal(router.pendingFollowupCount, 1);
});

test("invalidates an unsent follow-up token", () => {
    const router = createRoutingState();
    const followup = router.createFollowup({
        sessionId: "session-1",
        idleMarker: "idle-1",
    });

    assert.equal(router.invalidateFollowup(followup.token), true);
    assert.equal(router.inspectFollowup(followup.token).reason, "invalidated");
    assert.equal(router.invalidateFollowup(followup.token), false);
});

test("rejects invalid routing kinds and message IDs without consuming tokens", () => {
    const router = createRoutingState();
    const question = router.createQuestion({ requestId: "request-1" });

    assert.equal(router.consume(question.token, "other").reason, "invalid_kind");
    assert.equal(
        router.consumeQuestion(question.token, { messageId: 123 }).reason,
        "invalid_message_id",
    );
    assert.equal(router.inspect(question.token, "other").reason, "invalid_kind");
    assert.equal(router.pendingQuestionCount, 1);
});
