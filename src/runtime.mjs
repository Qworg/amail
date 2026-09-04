import { basename } from "node:path";

import { isAway } from "./away.mjs";
import {
    EmailValidationError,
    RejectedEmailError,
    parseInboundEmail,
    renderCompletionEmail,
    renderQuestionEmail,
} from "./email.mjs";
import { createRoutingState, hashToken } from "./routing.mjs";

function rootEvent(event) {
    return event.agentId === undefined;
}

function propertyLabel(name, schema) {
    return typeof schema?.title === "string" && schema.title.trim()
        ? schema.title.trim()
        : name;
}

function schemaOptions(schema) {
    const optionSchema = schema?.type === "array"
        ? schema.items
        : schema;
    if (Array.isArray(optionSchema?.oneOf)) {
        return optionSchema.oneOf.map((option) => ({
            value: option?.const,
            label: typeof option?.title === "string"
                ? option.title
                : String(option?.const ?? ""),
        }));
    }
    if (Array.isArray(optionSchema?.anyOf)) {
        return optionSchema.anyOf.map((option) => ({
            value: option?.const,
            label: typeof option?.title === "string"
                ? option.title
                : String(option?.const ?? ""),
        }));
    }
    if (Array.isArray(optionSchema?.enum)) {
        return optionSchema.enum.map((value, index) => ({
            value,
            label: optionSchema.enumNames?.[index] ?? String(value),
        }));
    }
    return [];
}

function elicitationPrompt(event) {
    const lines = [event.data.message];
    const properties = event.data.requestedSchema?.properties ?? {};
    const entries = Object.entries(properties);
    if (entries.length > 0) {
        lines.push("");
        for (const [name, schema] of entries) {
            const required = event.data.requestedSchema?.required?.includes(name)
                ? " (required)"
                : "";
            const selection = schema?.type === "array" ? " (choose any)" : "";
            lines.push(`${propertyLabel(name, schema)}${required}${selection}`);
            if (typeof schema?.description === "string" && schema.description.trim()) {
                lines.push(`  ${schema.description.trim()}`);
            }
            const options = schemaOptions(schema);
            if (options.length > 0) {
                lines.push("  Choices:");
                lines.push(
                    ...options.map((option) => (
                        `    [${String(option.value)}] ${option.label}`
                    )),
                );
            }
            lines.push("");
        }
    }
    return lines.join("\n");
}

const NATURAL_STOP_WORDS = new Set([
    "a",
    "an",
    "and",
    "as",
    "at",
    "be",
    "for",
    "from",
    "i",
    "in",
    "into",
    "it",
    "me",
    "of",
    "on",
    "one",
    "only",
    "or",
    "the",
    "to",
    "with",
]);

function stemWord(word) {
    if (word.length > 5 && word.endsWith("ing")) {
        return word.slice(0, -3);
    }
    if (word.length > 4 && word.endsWith("ed")) {
        return word.slice(0, -2);
    }
    if (word.length > 4 && word.endsWith("s")) {
        return word.slice(0, -1);
    }
    return word;
}

function naturalTokens(value) {
    return String(value)
        .toLowerCase()
        .replace(/[_-]+/g, " ")
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter(Boolean)
        .map(stemWord)
        .filter((word) => !NATURAL_STOP_WORDS.has(word));
}

function optionScore(replyTokens, option) {
    const optionTokens = new Set([
        ...naturalTokens(option.value),
        ...naturalTokens(option.label),
    ]);
    if (optionTokens.size === 0) {
        return 0;
    }
    let matches = 0;
    for (const token of optionTokens) {
        if (replyTokens.has(token)) {
            matches += 1;
        }
    }
    return matches / Math.min(optionTokens.size, 3);
}

function inferNaturalReply(reply, properties) {
    const replyTokens = new Set(naturalTokens(reply));
    const supplied = {};

    for (const [name, schema] of Object.entries(properties)) {
        const options = schemaOptions(schema);
        if (options.length === 0) {
            continue;
        }
        const ranked = options
            .map((option) => ({
                option,
                score: optionScore(replyTokens, option),
            }))
            .filter(({ score }) => score >= 0.5)
            .sort((left, right) => right.score - left.score);

        if (schema?.type === "array") {
            if (ranked.length > 0) {
                supplied[name] = ranked.map(({ option }) => option.value);
            }
        } else if (
            ranked.length > 0
            && (
                ranked.length === 1
                || ranked[0].score > ranked[1].score
            )
        ) {
            supplied[name] = ranked[0].option.value;
        }
    }

    return supplied;
}

function parseFieldLines(reply) {
    const result = {};
    for (const line of reply.split(/\r?\n/)) {
        if (!line.trim()) {
            continue;
        }
        const separator = line.indexOf(":");
        if (separator < 1) {
            throw new EmailValidationError(
                "Use JSON or one `field: value` line per field.",
                "invalid_elicitation_reply",
            );
        }
        result[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }
    return result;
}

function coerceField(value, schema, name) {
    const options = schemaOptions(schema);
    if (options.length > 0) {
        if (schema?.type === "array") {
            const values = Array.isArray(value)
                ? value
                : String(value).split(/\s*,\s*/);
            return values.map((item) => {
                const normalized = String(item).trim().toLowerCase();
                const matched = options.find(
                    (option) => (
                        String(option.value).toLowerCase() === normalized
                        || option.label.toLowerCase() === normalized
                    ),
                );
                if (!matched) {
                    throw new EmailValidationError(
                        `${name} must contain only: ${options.map(({ label }) => label).join(", ")}`,
                        "invalid_elicitation_reply",
                    );
                }
                return matched.value;
            });
        }
        const normalized = String(value).trim().toLowerCase();
        const numbered = /^\d+$/.test(normalized)
            ? options[Number(normalized) - 1]
            : undefined;
        const matched = options.find(
            (option) => (
                String(option.value).toLowerCase() === normalized
                || option.label.toLowerCase() === normalized
            ),
        );
        const selected = numbered ?? matched;
        if (selected === undefined) {
            throw new EmailValidationError(
                `${name} must be one of: ${options.map(({ label }) => label).join(", ")}`,
                "invalid_elicitation_reply",
            );
        }
        return selected.value;
    }

    if (schema?.type === "boolean") {
        const normalized = String(value).trim().toLowerCase();
        if (["true", "yes", "y", "1"].includes(normalized)) {
            return true;
        }
        if (["false", "no", "n", "0"].includes(normalized)) {
            return false;
        }
        throw new EmailValidationError(
            `${name} must be yes or no.`,
            "invalid_elicitation_reply",
        );
    }

    if (schema?.type === "integer" || schema?.type === "number") {
        const number = Number(value);
        if (!Number.isFinite(number) || (schema.type === "integer" && !Number.isInteger(number))) {
            throw new EmailValidationError(
                `${name} must be a ${schema.type}.`,
                "invalid_elicitation_reply",
            );
        }
        return number;
    }

    if (schema?.type === "array" || schema?.type === "object") {
        try {
            const parsed = typeof value === "string" ? JSON.parse(value) : value;
            if (schema.type === "array" ? Array.isArray(parsed) : parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                return parsed;
            }
        } catch {
            // The stable validation error below is more useful than JSON.parse output.
        }
        throw new EmailValidationError(
            `${name} must be valid JSON for a ${schema.type}.`,
            "invalid_elicitation_reply",
        );
    }

    return String(value).trim();
}

export function parseElicitationReply(reply, requestedSchema) {
    const properties = requestedSchema?.properties ?? {};
    const names = Object.keys(properties);
    if (names.length === 0) {
        return { response: reply };
    }

    let supplied;
    try {
        const parsed = JSON.parse(reply);
        supplied = (
            parsed
            && typeof parsed === "object"
            && !Array.isArray(parsed)
        )
            ? parsed
            : names.length === 1
                ? { [names[0]]: reply }
                : parsed;
    } catch {
        if (names.length === 1) {
            supplied = { [names[0]]: reply };
        } else if (reply.split(/\r?\n/).every(
            (line) => !line.trim() || line.includes(":"),
        )) {
            supplied = parseFieldLines(reply);
        } else {
            supplied = inferNaturalReply(reply, properties);
        }
    }
    if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) {
        throw new EmailValidationError(
            "The elicitation reply must be an object.",
            "invalid_elicitation_reply",
        );
    }

    const content = {};
    for (const name of names) {
        const value = supplied[name];
        if (value === undefined || value === "") {
            if (requestedSchema.required?.includes(name)) {
                throw new EmailValidationError(
                    `Missing required field: ${name}.`,
                    "invalid_elicitation_reply",
                );
            }
            continue;
        }
        content[name] = coerceField(value, properties[name], name);
    }
    return content;
}

export function parseLegacyAnswer(reply, metadata) {
    const answer = reply.trim();
    const choices = metadata.choices ?? [];
    const numberedChoice = answer.match(/^\d+$/)
        ? choices[Number(answer) - 1]
        : undefined;
    const namedChoice = choices.find(
        (choice) => choice.toLowerCase() === answer.toLowerCase(),
    );
    const selected = numberedChoice ?? namedChoice;
    if (selected !== undefined) {
        return { answer: selected, wasFreeform: false };
    }
    if (metadata.allowFreeform === false && choices.length > 0) {
        throw new EmailValidationError(
            "Reply with one of the listed choices or its number.",
            "invalid_choice",
        );
    }
    return { answer, wasFreeform: true };
}

export function createAmailRuntime({
    session,
    config,
    emailClient,
    router = createRoutingState(),
    isAwayImpl = isAway,
    repository = process.env.AMAIL_REPOSITORY ?? basename(process.cwd()),
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
} = {}) {
    if (!session || !config || !emailClient) {
        throw new TypeError("session, config, and emailClient are required");
    }

    const unsubscribers = [];
    const processedEmailIds = new Set();
    const interestHandles = [];
    let timer;
    let stopped = false;
    let polling = false;
    let completionSending = false;
    let lastRootAssistant;
    let lastCompletionMessageId;
    let idleMarker;

    async function log(message, level = "info") {
        const safeMessage = message.replace(
            /reply\+[a-z0-9-]+@/gi,
            "reply+[token]@",
        );
        await session.log(safeMessage, level === "info" ? undefined : { level });
    }

    async function safe(label, operation) {
        try {
            await operation();
        } catch (error) {
            await log(`amail ${label}: ${error.message}`, "error");
        }
    }

    async function sendQuestion(event, metadata, question) {
        if (!await isAwayImpl()) {
            return;
        }
        const issued = router.createQuestion(metadata);
        const rendered = renderQuestionEmail({
            question,
            choices: metadata.choices,
            token: issued.token,
            receiveDomain: config.receiveDomain,
            replyHint: metadata.variant === "elicitation"
                ? "Reply naturally in a sentence. You may also use the bracketed choice values."
                : undefined,
        });
        try {
            await emailClient.sendEmail({
                from: config.from,
                to: config.to,
                ...rendered,
                idempotencyKey: `question-${event.data.requestId}-${hashToken(issued.token).slice(0, 12)}`,
            });
            await log("amail sent a question email");
        } catch (error) {
            router.invalidateQuestion(event.data.requestId);
            throw error;
        }
    }

    async function onUserInputRequested(event) {
        await sendQuestion(event, {
            requestId: event.data.requestId,
            variant: "user_input",
            question: event.data.question,
            choices: event.data.choices ?? [],
            allowFreeform: event.data.allowFreeform ?? true,
        }, event.data.question);
    }

    async function onElicitationRequested(event) {
        if (event.data.mode === "url") {
            return;
        }
        await sendQuestion(event, {
            requestId: event.data.requestId,
            variant: "elicitation",
            message: event.data.message,
            mode: event.data.mode,
            requestedSchema: event.data.requestedSchema,
        }, elicitationPrompt(event));
    }

    async function onIdle(event) {
        if (!rootEvent(event)) {
            return;
        }
        if (event.data.aborted || !lastRootAssistant) {
            idleMarker = undefined;
            return;
        }
        if (
            completionSending
            || lastCompletionMessageId === lastRootAssistant.messageId
        ) {
            return;
        }
        completionSending = true;
        let issued;
        const marker = event.id;
        try {
            if (!await isAwayImpl()) {
                idleMarker = undefined;
                return;
            }

            idleMarker = marker;
            issued = router.createFollowup({
                sessionId: session.sessionId,
                idleMarker,
            });
            const rendered = renderCompletionEmail({
                repository,
                summary: lastRootAssistant.content,
                token: issued.token,
                receiveDomain: config.receiveDomain,
            });
            await emailClient.sendEmail({
                from: config.from,
                to: config.to,
                ...rendered,
                idempotencyKey: `completion-${lastRootAssistant.messageId}-${hashToken(issued.token).slice(0, 12)}`,
            });
        } catch (error) {
            if (issued) {
                router.invalidateFollowup(issued.token);
            }
            if (idleMarker === marker) {
                idleMarker = undefined;
            }
            throw error;
        } finally {
            completionSending = false;
        }
        lastCompletionMessageId = lastRootAssistant.messageId;
        await log("amail sent a completion email");
    }

    async function handleQuestionReply(parsed, inspected) {
        const metadata = inspected.metadata;
        const response = metadata.variant === "elicitation"
            ? {
                requestId: metadata.requestId,
                result: {
                    action: "accept",
                    content: parseElicitationReply(parsed.reply, metadata.requestedSchema),
                },
            }
            : {
                requestId: metadata.requestId,
                response: parseLegacyAnswer(parsed.reply, metadata),
            };
        const result = metadata.variant === "elicitation"
            ? await session.rpc.ui.handlePendingElicitation(response)
            : await session.rpc.ui.handlePendingUserInput(response);

        if (!result.success) {
            router.invalidateQuestion(metadata.requestId);
            await log("amail ignored an answer because the terminal already resolved it", "warning");
            return;
        }
        router.consumeQuestion(parsed.token, { messageId: parsed.id });
        await log("amail applied an email answer");
    }

    async function handleFollowupReply(parsed, inspected) {
        if (
            !idleMarker
            || inspected.metadata.sessionId !== session.sessionId
            || inspected.metadata.idleMarker !== idleMarker
        ) {
            await log("amail ignored a stale follow-up email", "warning");
            return;
        }
        await session.send({
            prompt: parsed.reply,
            displayPrompt: `[amail email reply] ${parsed.reply}`,
            mode: "enqueue",
        });
        const consumed = router.consumeFollowup(parsed.token, {
            messageId: parsed.id,
            sessionId: session.sessionId,
            idleMarker,
        });
        if (!consumed.ok) {
            throw new Error(`follow-up routing failed after send: ${consumed.reason}`);
        }
        idleMarker = undefined;
        await log("amail queued an email follow-up");
    }

    async function processInboundEmail(email) {
        if (processedEmailIds.has(email?.id)) {
            return;
        }

        let parsed;
        try {
            parsed = parseInboundEmail(email, {
                authorizedSender: config.to,
                receiveDomain: config.receiveDomain,
            });
        } catch (error) {
            if (email?.id) {
                processedEmailIds.add(email.id);
            }
            if (!(error instanceof RejectedEmailError)) {
                throw error;
            }
            await log(`amail rejected an inbound email: ${error.code}`, "warning");
            return;
        }

        if (!await isAwayImpl()) {
            processedEmailIds.add(parsed.id);
            return;
        }

        const question = router.inspectQuestion(parsed.token);
        if (question.ok) {
            try {
                await handleQuestionReply(parsed, question);
            } catch (error) {
                if (!(error instanceof EmailValidationError)) {
                    throw error;
                }
                await log(`amail rejected an invalid answer: ${error.message}`, "warning");
            }
            processedEmailIds.add(parsed.id);
            return;
        }

        const followup = router.inspectFollowup(parsed.token);
        if (followup.ok) {
            await handleFollowupReply(parsed, followup);
        } else if (followup.reason !== "wrong_token") {
            await log(
                `amail ignored a reply with an unusable token: ${followup.reason}`,
                "warning",
            );
        }
        processedEmailIds.add(parsed.id);
    }

    async function poll() {
        if (stopped || polling) {
            return;
        }
        polling = true;
        try {
            const page = await emailClient.listReceivedEmails({ limit: 100 });
            for (const summary of [...page.data].reverse()) {
                if (processedEmailIds.has(summary.id)) {
                    continue;
                }
                try {
                    const email = await emailClient.retrieveReceivedEmail(summary.id);
                    await processInboundEmail(email);
                } catch (error) {
                    await log(`amail could not process email ${summary.id}: ${error.message}`, "warning");
                }
            }
        } finally {
            polling = false;
        }
    }

    async function baselineInbox() {
        const page = await emailClient.listReceivedEmails({ limit: 100 });
        for (const summary of page.data) {
            processedEmailIds.add(summary.id);
        }
    }

    function subscribe(eventType, handler) {
        unsubscribers.push(session.on(eventType, (event) => {
            void safe(eventType, () => handler(event));
        }));
    }

    async function start() {
        for (const eventType of ["user_input.requested", "elicitation.requested"]) {
            const { handle } = await session.rpc.eventLog.registerInterest({ eventType });
            interestHandles.push(handle);
        }

        await safe("inbox baseline failed", baselineInbox);

        subscribe("user_input.requested", onUserInputRequested);
        subscribe("elicitation.requested", onElicitationRequested);
        subscribe("user_input.completed", (event) => {
            router.onNativeRequestCompleted(event);
        });
        subscribe("elicitation.completed", (event) => {
            router.onNativeRequestCompleted(event);
        });
        subscribe("assistant.message", (event) => {
            if (
                rootEvent(event)
                && event.data.phase !== "thinking"
                && event.data.content.trim()
            ) {
                const isChunk = event.data.chunkCount > 1
                    && Number.isInteger(event.data.chunkIndex)
                    && event.data.apiCallId;
                if (isChunk && lastRootAssistant?.apiCallId === event.data.apiCallId) {
                    lastRootAssistant.parts[event.data.chunkIndex] = event.data.content;
                    lastRootAssistant.content = lastRootAssistant.parts
                        .filter((part) => part !== undefined)
                        .join("\n\n");
                    return;
                }
                lastRootAssistant = {
                    apiCallId: isChunk ? event.data.apiCallId : undefined,
                    content: event.data.content,
                    messageId: event.data.messageId,
                    parts: isChunk
                        ? Object.assign([], { [event.data.chunkIndex]: event.data.content })
                        : [event.data.content],
                };
            }
        });
        subscribe("user.message", (event) => {
            if (rootEvent(event)) {
                idleMarker = undefined;
            }
        });
        subscribe("assistant.turn_start", (event) => {
            if (rootEvent(event)) {
                idleMarker = undefined;
            }
        });
        subscribe("session.idle", onIdle);
        subscribe("session.shutdown", () => stop());

        timer = setIntervalImpl(() => {
            void safe("poll failed", poll);
        }, config.pollIntervalMs);
        timer?.unref?.();
        await log("amail loaded; use `amail away on` before stepping away");
        return { stop, poll, processInboundEmail };
    }

    async function stop() {
        if (stopped) {
            return;
        }
        stopped = true;
        if (timer !== undefined) {
            clearIntervalImpl(timer);
        }
        for (const unsubscribe of unsubscribers.splice(0)) {
            unsubscribe();
        }
        await Promise.all(interestHandles.splice(0).map((handle) => (
            session.rpc.eventLog.releaseInterest({ handle })
        )));
    }

    return {
        start,
        stop,
        poll,
        processInboundEmail,
        router,
    };
}
