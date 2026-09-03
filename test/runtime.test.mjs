import assert from "node:assert/strict";
import test from "node:test";

import {
    createAmailRuntime,
    parseElicitationReply,
    parseLegacyAnswer,
} from "../src/runtime.mjs";

const config = {
    resendApiKey: "re_test",
    to: "jeff@example.com",
    from: "amail@example.com",
    receiveDomain: "inbound.example.com",
    pollIntervalMs: 30_000,
};

function createFakeSession() {
    const handlers = new Map();
    const calls = {
        interests: [],
        logs: [],
        userInputs: [],
        elicitations: [],
        sends: [],
    };

    const session = {
        sessionId: "session-1",
        rpc: {
            eventLog: {
                async registerInterest(input) {
                    calls.interests.push(input);
                    return { handle: input.eventType };
                },
                async releaseInterest(input) {
                    calls.interests.push({ released: input.handle });
                    return { success: true };
                },
            },
            ui: {
                async handlePendingUserInput(input) {
                    calls.userInputs.push(input);
                    return { success: true };
                },
                async handlePendingElicitation(input) {
                    calls.elicitations.push(input);
                    return { success: true };
                },
            },
        },
        async log(message, options) {
            calls.logs.push({ message, options });
        },
        async send(input) {
            calls.sends.push(input);
            return "message-1";
        },
        on(type, handler) {
            const list = handlers.get(type) ?? [];
            list.push(handler);
            handlers.set(type, list);
            return () => {
                handlers.set(type, (handlers.get(type) ?? []).filter(
                    (candidate) => candidate !== handler,
                ));
            };
        },
        emit(type, data, extra = {}) {
            const event = {
                id: `${type}-${Math.random()}`,
                type,
                data,
                ...extra,
            };
            for (const handler of handlers.get(type) ?? []) {
                handler(event);
            }
            return event;
        },
    };
    return { session, calls };
}

function createFakeEmailClient() {
    const sent = [];
    const received = [];
    return {
        sent,
        received,
        async sendEmail(message) {
            sent.push(message);
            return { id: `sent-${sent.length}` };
        },
        async listReceivedEmails() {
            return {
                data: received.map(({ id }) => ({ id })),
                hasMore: false,
            };
        },
        async retrieveReceivedEmail(id) {
            return received.find((email) => email.id === id);
        },
    };
}

async function waitFor(predicate) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        if (predicate()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.fail("condition was not reached");
}

function receivedEmail({ id, replyTo, text }) {
    return {
        id,
        from: "jeff@example.com",
        to: [replyTo],
        subject: "Re: amail",
        text,
        html: null,
        headers: {},
        attachments: [],
        created_at: "2026-09-03T12:00:00Z",
    };
}

function createRuntime(overrides = {}) {
    const { session, calls } = createFakeSession();
    const emailClient = createFakeEmailClient();
    const runtime = createAmailRuntime({
        session,
        config,
        emailClient,
        isAwayImpl: async () => true,
        repository: "Qworg/amail",
        setIntervalImpl: () => ({ unref() {} }),
        clearIntervalImpl: () => {},
        ...overrides,
    });
    return { runtime, session, calls, emailClient };
}

test("parses typed structured elicitation replies", () => {
    const schema = {
        type: "object",
        required: ["strategy", "confirm"],
        properties: {
            strategy: { type: "string", enum: ["links", "pages"] },
            confirm: { type: "boolean" },
            count: { type: "integer" },
        },
    };

    assert.deepEqual(
        parseElicitationReply(
            "strategy: Pages\nconfirm: yes\ncount: 3",
            schema,
        ),
        { strategy: "pages", confirm: true, count: 3 },
    );
    assert.deepEqual(
        parseElicitationReply('{"strategy":"links","confirm":false}', schema),
        { strategy: "links", confirm: false },
    );
    assert.throws(
        () => parseElicitationReply("strategy: links", schema),
        /Missing required field: confirm/,
    );
});

test("maps legacy numbered choices and rejects unsupported freeform answers", () => {
    assert.deepEqual(
        parseLegacyAnswer("2", {
            choices: ["Previous", "Next"],
            allowFreeform: false,
        }),
        { answer: "Next", wasFreeform: false },
    );
    assert.throws(
        () => parseLegacyAnswer("Something else", {
            choices: ["Previous", "Next"],
            allowFreeform: false,
        }),
        /listed choices/,
    );
});

test("emails and resolves a native question while leaving the terminal race authoritative", async () => {
    const { runtime, session, calls, emailClient } = createRuntime();
    await runtime.start();

    session.emit("user_input.requested", {
        requestId: "request-1",
        question: "Which option?",
        choices: ["Alpha", "Beta"],
        allowFreeform: false,
    });
    await waitFor(() => emailClient.sent.length === 1);

    await runtime.processInboundEmail(receivedEmail({
        id: "received-1",
        replyTo: emailClient.sent[0].replyTo,
        text: "2",
    }));

    assert.deepEqual(calls.userInputs, [{
        requestId: "request-1",
        response: { answer: "Beta", wasFreeform: false },
    }]);
    assert.equal(runtime.router.pendingQuestionCount, 0);
});

test("keeps a question token available after an invalid structured answer", async () => {
    const { runtime, session, emailClient, calls } = createRuntime();
    await runtime.start();
    session.emit("elicitation.requested", {
        requestId: "request-2",
        message: "Choose settings",
        mode: "form",
        requestedSchema: {
            type: "object",
            required: ["approved"],
            properties: { approved: { type: "boolean" } },
        },
    });
    await waitFor(() => emailClient.sent.length === 1);
    const token = emailClient.sent[0].replyTo.match(/reply\+([^@]+)/)[1];

    await runtime.processInboundEmail(receivedEmail({
        id: "received-invalid",
        replyTo: emailClient.sent[0].replyTo,
        text: "maybe",
    }));

    assert.equal(calls.elicitations.length, 0);
    assert.equal(runtime.router.inspectQuestion(token).ok, true);
    assert.match(calls.logs.at(-1).message, /rejected an invalid answer/);
});

test("invalidates a token when the terminal answers first", async () => {
    const { runtime, session, calls, emailClient } = createRuntime();
    await runtime.start();
    session.emit("user_input.requested", {
        requestId: "request-3",
        question: "Continue?",
        choices: ["Yes", "No"],
    });
    await waitFor(() => emailClient.sent.length === 1);
    session.emit("user_input.completed", {
        requestId: "request-3",
        answer: "Yes",
    });
    await waitFor(() => runtime.router.pendingQuestionCount === 0);

    await runtime.processInboundEmail(receivedEmail({
        id: "received-stale",
        replyTo: emailClient.sent[0].replyTo,
        text: "No",
    }));
    assert.equal(calls.userInputs.length, 0);
});

test("invalidates a question when the native RPC reports that the terminal won", async () => {
    const { runtime, session, calls, emailClient } = createRuntime();
    session.rpc.ui.handlePendingUserInput = async (input) => {
        calls.userInputs.push(input);
        return { success: false };
    };
    await runtime.start();
    session.emit("user_input.requested", {
        requestId: "request-race",
        question: "Continue?",
        choices: ["Yes", "No"],
    });
    await waitFor(() => emailClient.sent.length === 1);
    const token = emailClient.sent[0].replyTo.match(/reply\+([^@]+)/)[1];

    await runtime.processInboundEmail(receivedEmail({
        id: "received-race",
        replyTo: emailClient.sent[0].replyTo,
        text: "Yes",
    }));

    assert.equal(calls.userInputs.length, 1);
    assert.equal(runtime.router.inspectQuestion(token).reason, "invalidated");
    assert.match(calls.logs.at(-1).message, /terminal already resolved/);
});

test("emails one completion and injects one same-idle-session follow-up", async () => {
    const { runtime, session, calls, emailClient } = createRuntime();
    await runtime.start();
    session.emit("assistant.message", {
        messageId: "assistant-1",
        content: "Implemented the requested change.",
    });
    session.emit("session.idle", { aborted: false });
    await waitFor(() => emailClient.sent.length === 1);

    await runtime.processInboundEmail(receivedEmail({
        id: "received-followup",
        replyTo: emailClient.sent[0].replyTo,
        text: "Now update the README.",
    }));
    assert.deepEqual(calls.sends, [{
        prompt: "Now update the README.",
        displayPrompt: "[amail email reply] Now update the README.",
        mode: "enqueue",
    }]);

    await runtime.processInboundEmail(receivedEmail({
        id: "received-followup-duplicate",
        replyTo: emailClient.sent[0].replyTo,
        text: "Run it again.",
    }));
    assert.equal(calls.sends.length, 1);
});

test("keeps a completion token valid across duplicate and sub-agent idle events", async () => {
    const { runtime, session, calls, emailClient } = createRuntime();
    await runtime.start();
    session.emit("assistant.message", {
        messageId: "assistant-stable",
        content: "Finished.",
    });
    session.emit("session.idle", { aborted: false });
    await waitFor(() => emailClient.sent.length === 1);
    session.emit("session.idle", { aborted: false });
    session.emit("session.idle", { aborted: false }, { agentId: "subagent-1" });
    session.emit("assistant.turn_start", { turnId: "sub-turn" }, { agentId: "subagent-1" });

    await runtime.processInboundEmail(receivedEmail({
        id: "received-stable",
        replyTo: emailClient.sent[0].replyTo,
        text: "Continue from email.",
    }));
    assert.equal(emailClient.sent.length, 1);
    assert.equal(calls.sends.length, 1);
});

test("ignores aborted and sub-agent responses when choosing a completion summary", async () => {
    const { runtime, session, emailClient } = createRuntime();
    await runtime.start();
    session.emit("assistant.message", {
        messageId: "sub-message",
        content: "Sub-agent output",
    }, { agentId: "subagent-1" });
    session.emit("session.idle", { aborted: false }, { agentId: "subagent-1" });
    session.emit("assistant.message", {
        messageId: "root-message",
        content: "Root output",
    });
    session.emit("session.idle", { aborted: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(emailClient.sent.length, 0);

    session.emit("session.idle", { aborted: false });
    await waitFor(() => emailClient.sent.length === 1);
    assert.match(emailClient.sent[0].text, /Root output/);
    assert.doesNotMatch(emailClient.sent[0].text, /Sub-agent output/);
});

test("processes each received message ID only once", async () => {
    const { runtime, session, calls, emailClient } = createRuntime();
    await runtime.start();
    session.emit("user_input.requested", {
        requestId: "request-dedup",
        question: "Continue?",
    });
    await waitFor(() => emailClient.sent.length === 1);
    const email = receivedEmail({
        id: "received-dedup",
        replyTo: emailClient.sent[0].replyTo,
        text: "Yes",
    });

    await runtime.processInboundEmail(email);
    await runtime.processInboundEmail(email);
    assert.equal(calls.userInputs.length, 1);
});

test("uses a new idempotency key when retrying a failed completion send", async () => {
    const { session } = createFakeSession();
    const keys = [];
    let attempts = 0;
    const emailClient = {
        async sendEmail(message) {
            keys.push(message.idempotencyKey);
            attempts += 1;
            if (attempts === 1) {
                throw new Error("temporary send failure");
            }
            return { id: "sent" };
        },
        async listReceivedEmails() {
            return { data: [] };
        },
        async retrieveReceivedEmail() {
            throw new Error("not called");
        },
    };
    const runtime = createAmailRuntime({
        session,
        config,
        emailClient,
        isAwayImpl: async () => true,
        setIntervalImpl: () => ({ unref() {} }),
        clearIntervalImpl: () => {},
    });
    await runtime.start();
    session.emit("assistant.message", {
        messageId: "assistant-idempotency",
        content: "Finished.",
    });
    session.emit("session.idle", { aborted: false });
    await waitFor(() => attempts === 1);
    session.emit("session.idle", { aborted: false });
    await waitFor(() => attempts === 2);

    assert.notEqual(keys[0], keys[1]);
});

test("coalesces concurrent idle events into one completion email and valid token", async () => {
    const { session, calls } = createFakeSession();
    let releaseSend;
    const sendGate = new Promise((resolve) => {
        releaseSend = resolve;
    });
    const sent = [];
    const emailClient = {
        async sendEmail(message) {
            sent.push(message);
            await sendGate;
            return { id: "sent" };
        },
        async listReceivedEmails() {
            return { data: [] };
        },
        async retrieveReceivedEmail() {
            throw new Error("not called");
        },
    };
    const runtime = createAmailRuntime({
        session,
        config,
        emailClient,
        isAwayImpl: async () => true,
        setIntervalImpl: () => ({ unref() {} }),
        clearIntervalImpl: () => {},
    });
    await runtime.start();
    session.emit("assistant.message", {
        messageId: "assistant-concurrent",
        content: "Finished.",
    });
    session.emit("session.idle", { aborted: false });
    session.emit("session.idle", { aborted: false });
    await waitFor(() => sent.length === 1);
    releaseSend();
    await waitFor(() => calls.logs.some(({ message }) => message.includes("completion email")));

    await runtime.processInboundEmail(receivedEmail({
        id: "received-concurrent",
        replyTo: sent[0].replyTo,
        text: "Continue once.",
    }));
    assert.equal(sent.length, 1);
    assert.equal(calls.sends.length, 1);
});

test("retries a follow-up when session injection fails before consuming the token", async () => {
    const { session, calls } = createFakeSession();
    let attempts = 0;
    session.send = async (input) => {
        attempts += 1;
        if (attempts === 1) {
            throw new Error("temporary RPC failure");
        }
        calls.sends.push(input);
        return "message-1";
    };
    const emailClient = createFakeEmailClient();
    const runtime = createAmailRuntime({
        session,
        config,
        emailClient,
        isAwayImpl: async () => true,
        setIntervalImpl: () => ({ unref() {} }),
        clearIntervalImpl: () => {},
    });
    await runtime.start();
    session.emit("assistant.message", {
        messageId: "assistant-retry",
        content: "Finished.",
    });
    session.emit("session.idle", { aborted: false });
    await waitFor(() => emailClient.sent.length === 1);
    const reply = receivedEmail({
        id: "received-retry",
        replyTo: emailClient.sent[0].replyTo,
        text: "Retry me.",
    });

    await assert.rejects(runtime.processInboundEmail(reply), /temporary RPC failure/);
    await runtime.processInboundEmail(reply);
    assert.equal(attempts, 2);
    assert.equal(calls.sends.length, 1);
});

test("poll retrieves only unseen messages", async () => {
    const { runtime, emailClient } = createRuntime();
    const reply = receivedEmail({
        id: "unknown-message",
        replyTo: "reply+aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@inbound.example.com",
        text: "Unknown token",
    });
    emailClient.received.push(reply);
    let retrievals = 0;
    const retrieve = emailClient.retrieveReceivedEmail;
    emailClient.retrieveReceivedEmail = async (id) => {
        retrievals += 1;
        return retrieve(id);
    };

    await runtime.start();
    await runtime.poll();
    assert.equal(retrievals, 1);
});

test("continues polling after one message retrieval fails", async () => {
    const { runtime, emailClient, calls } = createRuntime();
    emailClient.received.push(
        receivedEmail({
            id: "good-message",
            replyTo: "reply+aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@inbound.example.com",
            text: "Unknown token",
        }),
        { id: "bad-message" },
    );
    const retrieve = emailClient.retrieveReceivedEmail;
    emailClient.retrieveReceivedEmail = async (id) => {
        if (id === "bad-message") {
            throw new Error("temporary retrieve failure");
        }
        return retrieve(id);
    };

    await runtime.start();
    assert.match(
        calls.logs.find(({ message }) => message.includes("bad-message")).message,
        /temporary retrieve failure/,
    );
    assert.match(
        calls.logs.find(({ message }) => message.includes("unusable token")).message,
        /wrong_token/,
    );
});

test("combines chunked final assistant content in the completion email", async () => {
    const { runtime, session, emailClient } = createRuntime();
    await runtime.start();
    session.emit("assistant.message", {
        apiCallId: "call-1",
        messageId: "chunk-1",
        chunkIndex: 0,
        chunkCount: 2,
        content: "First part.",
    });
    session.emit("assistant.message", {
        apiCallId: "call-1",
        messageId: "chunk-2",
        chunkIndex: 1,
        chunkCount: 2,
        content: "Second part.",
    });
    session.emit("session.idle", { aborted: false });
    await waitFor(() => emailClient.sent.length === 1);

    assert.match(emailClient.sent[0].text, /First part\.\n\nSecond part\./);
});

test("does not inject a completion reply after terminal activity", async () => {
    const { runtime, session, calls, emailClient } = createRuntime();
    await runtime.start();
    session.emit("assistant.message", {
        messageId: "assistant-2",
        content: "Finished.",
    });
    session.emit("session.idle", { aborted: false });
    await waitFor(() => emailClient.sent.length === 1);
    session.emit("user.message", { content: "A terminal follow-up" });

    await runtime.processInboundEmail(receivedEmail({
        id: "received-late",
        replyTo: emailClient.sent[0].replyTo,
        text: "Email follow-up",
    }));
    assert.equal(calls.sends.length, 0);
    assert.match(calls.logs.at(-1).message, /stale follow-up/);
});

test("does not send mail while away mode is off", async () => {
    const { session, calls } = createFakeSession();
    const emailClient = createFakeEmailClient();
    const runtime = createAmailRuntime({
        session,
        config,
        emailClient,
        isAwayImpl: async () => false,
        setIntervalImpl: () => ({ unref() {} }),
        clearIntervalImpl: () => {},
    });
    await runtime.start();
    session.emit("user_input.requested", {
        requestId: "request-4",
        question: "Question",
    });
    session.emit("assistant.message", {
        messageId: "assistant-3",
        content: "Done",
    });
    session.emit("session.idle", { aborted: false });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(emailClient.sent.length, 0);
    assert.equal(calls.userInputs.length, 0);
});
