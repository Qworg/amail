import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
    EmailValidationError,
    RejectedEmailError,
    ResendApiError,
    buildReplyAddress,
    createResendClient,
    extractReplyToken,
    parseInboundEmail,
    redactSecrets,
    renderCompletionEmail,
    renderQuestionEmail,
} from "../src/email.mjs";

const fixture = JSON.parse(await readFile(new URL("./fixtures/resend-received-email.json", import.meta.url)));

function response(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}

test("sends plain-text mail through the Resend API", async () => {
    const calls = [];
    const client = createResendClient({
        apiKey: "re_test_key",
        baseUrl: "https://resend.test",
        fetchImpl: async (url, init) => {
            calls.push({ url, init });
            return response({ id: "sent-1" });
        },
    });

    const result = await client.sendEmail({
        from: "amail@example.com",
        to: "jeff@example.com",
        subject: "[amail:abc] Complete",
        text: "Repository: Qworg/amail",
        replyTo: "reply+abc@inbound.example.com",
        idempotencyKey: "completion-1",
    });

    assert.deepEqual(result, { id: "sent-1" });
    assert.equal(calls[0].url, "https://resend.test/emails");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers.Authorization, "Bearer re_test_key");
    assert.equal(calls[0].init.headers["Idempotency-Key"], "completion-1");
    assert.deepEqual(JSON.parse(calls[0].init.body), {
        from: "amail@example.com",
        to: "jeff@example.com",
        subject: "[amail:abc] Complete",
        text: "Repository: Qworg/amail",
        reply_to: "reply+abc@inbound.example.com",
    });
});

test("lists, retrieves, and polls received Resend messages", async () => {
    const calls = [];
    const client = createResendClient({
        apiKey: "re_test_key",
        baseUrl: "https://resend.test",
        fetchImpl: async (url, init) => {
            calls.push({ url, init });
            if (url.includes("/emails/receiving?")) {
                return response({
                    object: "list",
                    has_more: false,
                    data: [{ id: "received-1" }],
                });
            }
            return response({ ...fixture, id: "received-1" });
        },
    });

    const page = await client.pollReceivedEmails({ limit: 10, after: "cursor-1" });
    assert.equal(page.hasMore, false);
    assert.equal(page.data[0].id, "received-1");
    assert.equal(calls[0].url, "https://resend.test/emails/receiving?limit=10&after=cursor-1");
    assert.equal(calls[1].url, "https://resend.test/emails/receiving/received-1");
});

test("surfaces Resend HTTP and malformed-response errors", async () => {
    const failedClient = createResendClient({
        apiKey: "re_test_key",
        fetchImpl: async () => response({ message: "invalid api key" }, 401),
    });
    await assert.rejects(
        failedClient.listReceivedEmails(),
        (error) => error instanceof ResendApiError
            && error.status === 401
            && error.message === "invalid api key",
    );

    const malformedClient = createResendClient({
        apiKey: "re_test_key",
        fetchImpl: async () => response({ nope: true }),
    });
    await assert.rejects(
        malformedClient.sendEmail({
            from: "a@example.com",
            to: "b@example.com",
            subject: "Subject",
            text: "Body",
        }),
        (error) => error instanceof EmailValidationError
            && error.code === "invalid_input",
    );
});

test("renders question and completion messages without leaking routing addresses", () => {
    const question = renderQuestionEmail({
        question: "Which pagination style should I implement?",
        choices: ["Previous/next links", "Page numbers"],
        token: "abc123",
        receiveDomain: "inbound.example.com",
    });
    assert.equal(question.subject, "amail: input needed");
    assert.match(question.text, /1\. Previous\/next links/);
    assert.doesNotMatch(question.text, /reply\+abc123/);
    assert.equal(question.replyTo, "reply+abc123@inbound.example.com");

    const completion = renderCompletionEmail({
        repository: "Qworg/amail",
        summary: "Used api_key=re_secret-value and finished the transport.",
        token: "abc123",
        receiveDomain: "inbound.example.com",
    });
    assert.equal(completion.subject, "amail: Qworg/amail complete");
    assert.match(completion.text, /api_key=\[REDACTED\]/);
    assert.doesNotMatch(completion.text, /reply\+abc123/);
});

test("extracts case-insensitive reply tokens for the configured domain", () => {
    assert.equal(extractReplyToken("reply+abc123@inbound.example.com", "inbound.example.com"), "abc123");
    assert.equal(extractReplyToken("Copilot <reply+abc123@INBOUND.EXAMPLE.COM>", "inbound.example.com"), "abc123");
    assert.equal(extractReplyToken("reply+ABC123@inbound.example.com", "inbound.example.com"), "abc123");
    assert.equal(extractReplyToken("reply+abc123@other.example.com", "inbound.example.com"), null);
    assert.equal(buildReplyAddress("abc123", "inbound.example.com"), "reply+abc123@inbound.example.com");
});

test("parses a realistic Resend reply, strips quoted history, and exposes its Resend ID", () => {
    const parsed = parseInboundEmail(fixture, {
        authorizedSender: "jeff@example.com",
        receiveDomain: "inbound.example.com",
    });
    assert.deepEqual(parsed, {
        id: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c",
        token: "abc123def456",
        reply: "Ship it.",
        from: "jeff@example.com",
        subject: "Re: [amail:abc123def456] Complete",
        receivedAt: "2026-09-03T14:13:42.674981+00:00",
    });
});

test("matches sender and routing mailbox casing without exposing the token in subjects", () => {
    const parsed = parseInboundEmail({
        ...fixture,
        from: "Jeff <JEFF@EXAMPLE.COM>",
        to: ["Reply+ABC123DEF456@INBOUND.EXAMPLE.COM"],
    }, {
        authorizedSender: "jeff@example.com",
        receiveDomain: "inbound.example.com",
    });

    assert.equal(parsed.token, "abc123def456");
    const rendered = renderQuestionEmail({
        question: "Use api_key=re_1234567890abcdef?",
        token: parsed.token,
        receiveDomain: "inbound.example.com",
    });
    assert.doesNotMatch(rendered.subject, /abc123def456/);
    assert.doesNotMatch(rendered.text, /re_1234567890abcdef/);
});

test("rejects unauthorized, automatic, attached, HTML-only, and empty mail", () => {
    const base = {
        ...fixture,
        from: "jeff@example.com",
        text: "A valid answer",
        attachments: [],
    };
    const config = {
        authorizedSender: "jeff@example.com",
        receiveDomain: "inbound.example.com",
    };

    const cases = [
        ["unauthorized_sender", { from: "attacker@example.com" }],
        ["auto_reply", { headers: { "Auto-Submitted": "auto-replied" } }],
        ["attachments", { attachments: [{ filename: "note.txt" }] }],
        ["html_only", { text: null, html: "<p>A reply</p>" }],
        ["empty_reply", { text: " \n\t" }],
    ];
    for (const [code, changes] of cases) {
        assert.throws(
            () => parseInboundEmail({ ...base, ...changes }, config),
            (error) => error instanceof RejectedEmailError && error.code === code,
        );
    }
});

test("strips common quoted formats and caps replies at 4KB without splitting UTF-8", () => {
    const email = {
        ...fixture,
        from: "jeff@example.com",
        text: "Keep this.\n\n-----Original Message-----\nFrom: Copilot <copilot@example.com>\nSent: yesterday",
    };
    const parsed = parseInboundEmail(email, {
        authorizedSender: "jeff@example.com",
        receiveDomain: "inbound.example.com",
    });
    assert.equal(parsed.reply, "Keep this.");

    const long = parseInboundEmail({
        ...fixture,
        from: "jeff@example.com",
        text: "🙂".repeat(3000),
    }, {
        authorizedSender: "jeff@example.com",
        receiveDomain: "inbound.example.com",
    });
    assert.ok(Buffer.byteLength(long.reply) <= 4096);
    assert.doesNotMatch(long.reply, /�/);
});

test("strips wrapped Gmail attribution and signature separators", () => {
    const gmail = parseInboundEmail({
        ...fixture,
        from: "jeff@example.com",
        text: [
            "Ship it.",
            "",
            "On Thu, Sep 3, 2026 at 7:00 AM Copilot <copilot@example.com>",
            "wrote:",
            "> old content",
        ].join("\n"),
    }, {
        authorizedSender: "jeff@example.com",
        receiveDomain: "inbound.example.com",
    });
    assert.equal(gmail.reply, "Ship it.");

    const signature = parseInboundEmail({
        ...fixture,
        from: "jeff@example.com",
        text: "Use option one.\n-- \nJeff",
    }, {
        authorizedSender: "jeff@example.com",
        receiveDomain: "inbound.example.com",
    });
    assert.equal(signature.reply, "Use option one.");
});

test("redacts credentials and applies the outgoing summary cap", () => {
    const redacted = redactSecrets(
        "re_1234567890abcdef password=hunter2 Bearer abcdefghijklmnop",
        100,
    );
    assert.match(redacted, /\[REDACTED\]/);
    assert.match(redacted, /password=\[REDACTED\]/);
    assert.match(redacted, /Bearer \[REDACTED\]/);
    assert.ok(Buffer.byteLength(redacted) <= 100);
});
