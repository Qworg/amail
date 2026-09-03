const RESEND_API_URL = "https://api.resend.com";
const DEFAULT_REPLY_LIMIT = 100;
const DEFAULT_REPLY_MAX_BYTES = 4 * 1024;
const DEFAULT_SUMMARY_MAX_BYTES = 4 * 1024;

export class ResendApiError extends Error {
    constructor(message, { status, operation, details } = {}) {
        super(message);
        this.name = "ResendApiError";
        this.status = status;
        this.operation = operation;
        this.details = details;
    }
}

export class EmailValidationError extends Error {
    constructor(message, code) {
        super(message);
        this.name = "EmailValidationError";
        this.code = code;
    }
}

export class RejectedEmailError extends EmailValidationError {
    constructor(message, code) {
        super(message, code);
        this.name = "RejectedEmailError";
    }
}

function requireNonEmptyString(value, name) {
    if (typeof value !== "string" || value.trim() === "") {
        throw new EmailValidationError(`${name} must be a non-empty string`, "invalid_input");
    }
    return value;
}

function validateAddress(value, name) {
    const address = requireNonEmptyString(value, name).trim();
    if (!/^[^@\s<>]+@[^@\s<>]+$/.test(address)) {
        throw new EmailValidationError(`${name} must be an email address`, "invalid_address");
    }
    return address;
}

function validateToken(token) {
    requireNonEmptyString(token, "token");
    if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(token)) {
        throw new EmailValidationError(
            "token must contain only lowercase letters, numbers, and hyphens",
            "invalid_token",
        );
    }
    return token;
}

function validateLimit(limit) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new EmailValidationError("limit must be an integer from 1 to 100", "invalid_limit");
    }
    return limit;
}

function parseJson(raw, operation) {
    if (raw === "") {
        return {};
    }

    try {
        return JSON.parse(raw);
    } catch (error) {
        throw new ResendApiError(`Resend returned invalid JSON while ${operation}`, {
            operation,
            details: error.message,
        });
    }
}

function requireObject(value, description) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new ResendApiError(`Resend returned an invalid ${description}`, {
            operation: description,
            details: value,
        });
    }
    return value;
}

async function requestJson(fetchImpl, apiKey, baseUrl, path, { method, body, idempotencyKey } = {}) {
    const response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
            Accept: "application/json",
            Authorization: `Bearer ${apiKey}`,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            ...(idempotencyKey === undefined ? {} : { "Idempotency-Key": idempotencyKey }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    const operation = `${method} ${path}`;
    const raw = typeof response.text === "function"
        ? await response.text()
        : JSON.stringify(await response.json());
    const payload = parseJson(raw, operation);

    if (!response.ok) {
        const message = typeof payload?.message === "string"
            ? payload.message
            : `Resend request failed with HTTP ${response.status}`;
        throw new ResendApiError(message, {
            status: response.status,
            operation,
            details: payload,
        });
    }

    return payload;
}

function normalizeBaseUrl(baseUrl) {
    const value = requireNonEmptyString(baseUrl, "baseUrl").replace(/\/+$/, "");
    try {
        new URL(value);
    } catch (error) {
        throw new EmailValidationError(`baseUrl must be a valid URL: ${error.message}`, "invalid_base_url");
    }
    return value;
}

/**
 * Creates the small Resend transport used by the extension.
 *
 * The returned methods are sendEmail, listReceivedEmails, retrieveReceivedEmail,
 * and pollReceivedEmails. The optional fetchImpl is useful for deterministic tests.
 */
export function createResendClient({
    apiKey,
    fetchImpl = globalThis.fetch,
    baseUrl = RESEND_API_URL,
} = {}) {
    requireNonEmptyString(apiKey, "apiKey");
    if (typeof fetchImpl !== "function") {
        throw new EmailValidationError("fetchImpl must be a function", "invalid_fetch");
    }

    const normalizedBaseUrl = normalizeBaseUrl(baseUrl);

    async function sendEmail({
        from,
        to,
        subject,
        text,
        replyTo,
        headers,
        tags,
        idempotencyKey,
    } = {}) {
        const payload = {
            from: requireNonEmptyString(from, "from"),
            to: Array.isArray(to)
                ? to.map((address) => validateAddress(address, "to"))
                : validateAddress(to, "to"),
            subject: requireNonEmptyString(subject, "subject"),
            text: requireNonEmptyString(text, "text"),
        };

        if (replyTo !== undefined) {
            payload.reply_to = validateAddress(replyTo, "replyTo");
        }
        if (headers !== undefined) {
            requireObject(headers, "headers");
            payload.headers = headers;
        }
        if (tags !== undefined) {
            if (!Array.isArray(tags)) {
                throw new EmailValidationError("tags must be an array", "invalid_tags");
            }
            payload.tags = tags;
        }
        if (idempotencyKey !== undefined) {
            requireNonEmptyString(idempotencyKey, "idempotencyKey");
        }

        const result = requireObject(
            await requestJson(fetchImpl, apiKey, normalizedBaseUrl, "/emails", {
                method: "POST",
                body: payload,
                idempotencyKey,
            }),
            "send response",
        );
        const id = requireNonEmptyString(result.id, "Resend send response id");
        return { id };
    }

    async function listReceivedEmails({ limit = DEFAULT_REPLY_LIMIT, after } = {}) {
        validateLimit(limit);
        const query = new URLSearchParams({ limit: String(limit) });
        if (after !== undefined) {
            requireNonEmptyString(after, "after");
            query.set("after", after);
        }

        const result = requireObject(
            await requestJson(
                fetchImpl,
                apiKey,
                normalizedBaseUrl,
                `/emails/receiving?${query.toString()}`,
                { method: "GET" },
            ),
            "received-email list response",
        );
        if (!Array.isArray(result.data)) {
            throw new ResendApiError("Resend received-email list has no data array", {
                operation: "GET /emails/receiving",
                details: result,
            });
        }
        return {
            object: result.object,
            hasMore: result.has_more === true,
            data: result.data,
        };
    }

    async function retrieveReceivedEmail(id) {
        requireNonEmptyString(id, "id");
        return requireObject(
            await requestJson(
                fetchImpl,
                apiKey,
                normalizedBaseUrl,
                `/emails/receiving/${encodeURIComponent(id)}`,
                { method: "GET" },
            ),
            "received-email response",
        );
    }

    async function pollReceivedEmails(options = {}) {
        const page = await listReceivedEmails(options);
        const emails = [];
        for (const summary of page.data) {
            const id = requireNonEmptyString(summary?.id, "received email id");
            emails.push(await retrieveReceivedEmail(id));
        }
        return {
            ...page,
            data: emails,
        };
    }

    return {
        sendEmail,
        listReceivedEmails,
        retrieveReceivedEmail,
        pollReceivedEmails,
    };
}

function extractMailbox(value, name) {
    const input = requireNonEmptyString(value, name).trim();
    const angleAddress = input.match(/<([^<>]+)>$/);
    return angleAddress ? angleAddress[1] : input;
}

/**
 * Returns a lowercase routing token only for reply+token@domain recipients.
 * Passing receiveDomain restricts matches to the configured receiving domain.
 */
export function extractReplyToken(recipient, receiveDomain) {
    const mailbox = extractMailbox(recipient, "recipient").toLowerCase();
    const match = mailbox.match(/^reply\+([a-z0-9][a-z0-9-]{0,127})@([^@\s]+)$/);
    if (!match) {
        return null;
    }
    if (receiveDomain !== undefined) {
        const domain = requireNonEmptyString(receiveDomain, "receiveDomain");
        if (match[2].toLowerCase() !== domain.toLowerCase()) {
            return null;
        }
    }
    return match[1];
}

export function buildReplyAddress(token, receiveDomain) {
    validateToken(token);
    const domain = validateAddress(`reply@${requireNonEmptyString(receiveDomain, "receiveDomain")}`, "receiveDomain")
        .split("@")[1];
    return `reply+${token}@${domain}`;
}

function utf8ByteLength(value) {
    return Buffer.byteLength(value, "utf8");
}

function capUtf8(value, maxBytes) {
    if (utf8ByteLength(value) <= maxBytes) {
        return value;
    }

    let bytes = 0;
    let result = "";
    for (const character of value) {
        const characterBytes = utf8ByteLength(character);
        if (bytes + characterBytes > maxBytes) {
            break;
        }
        result += character;
        bytes += characterBytes;
    }
    return result;
}

/**
 * Redacts common API-key, bearer-token, and key=value credential forms.
 */
export function redactSecrets(value, maxBytes = DEFAULT_SUMMARY_MAX_BYTES) {
    requireNonEmptyString(value, "value");
    if (!Number.isInteger(maxBytes) || maxBytes < 1) {
        throw new EmailValidationError("maxBytes must be a positive integer", "invalid_limit");
    }

    let redacted = value
        .replace(/\b(?:re|sk|rk|pk|ghp|gho|ghu|ghs|ghr|github_pat)[-_][A-Za-z0-9_-]{8,}\b/gi, "[REDACTED]")
        .replace(/\bxox[baprs]-[A-Za-z0-9-]{8,}\b/gi, "[REDACTED]")
        .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]")
        .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [REDACTED]")
        .replace(/(\b(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|password|secret)\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi, "$1[REDACTED]");

    return capUtf8(redacted, maxBytes);
}

function cleanQuotedHistory(value, maxBytes) {
    const lines = value.replace(/\r\n?/g, "\n").split("\n");
    const cleaned = [];
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const wrappedLine = `${line} ${lines[index + 1] ?? ""}`;
        if (
            /^\s*(?:On .+wrote:|-----Original Message-----|_{5,})\s*$/i.test(line)
            || /^\s*On .+wrote:\s*$/i.test(wrappedLine)
            || /^--\s*$/.test(line)
        ) {
            break;
        }
        if (/^\s*>/.test(line)) {
            continue;
        }
        if (/^\s*From:\s+\S/i.test(line) && cleaned.length > 0) {
            break;
        }
        cleaned.push(line.replace(/[ \t]+$/g, ""));
    }
    return capUtf8(cleaned.join("\n").trim(), maxBytes);
}

function getHeader(headers, name) {
    if (headers === null || typeof headers !== "object" || Array.isArray(headers)) {
        return undefined;
    }
    const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    return key === undefined ? undefined : headers[key];
}

function headerText(value) {
    return Array.isArray(value) ? value.join(",") : typeof value === "string" ? value : "";
}

function isAutoReply(email) {
    const autoSubmitted = headerText(getHeader(email.headers, "auto-submitted")).toLowerCase();
    if (autoSubmitted !== "" && autoSubmitted !== "no") {
        return true;
    }

    const precedence = headerText(getHeader(email.headers, "precedence")).toLowerCase();
    if (/\b(?:bulk|list|junk)\b/.test(precedence)) {
        return true;
    }

    for (const header of ["x-autoreply", "x-autorespond", "x-auto-response-suppress"]) {
        if (getHeader(email.headers, header) !== undefined) {
            return true;
        }
    }

    return /^(?:auto(?:matic)?\s*reply|out of office)\b/i.test(email.subject ?? "");
}

/**
 * Parses a retrieved Resend email into a safe one-shot reply.
 *
 * Invalid or unsafe inbound messages throw RejectedEmailError with a stable code.
 * The returned id is the Resend message ID; duplicate handling belongs to the caller.
 */
export function parseInboundEmail(
    email,
    { authorizedSender, receiveDomain, maxReplyBytes = DEFAULT_REPLY_MAX_BYTES } = {},
) {
    requireObject(email, "email");
    const id = requireNonEmptyString(email.id, "email.id");
    const sender = extractMailbox(email.from, "email.from");
    const configuredSender = validateAddress(authorizedSender, "authorizedSender");
    const configuredDomain = requireNonEmptyString(receiveDomain, "receiveDomain");
    if (sender.toLowerCase() !== configuredSender.toLowerCase()) {
        throw new RejectedEmailError("email sender is not authorized", "unauthorized_sender");
    }
    if (isAutoReply(email)) {
        throw new RejectedEmailError("automatic replies are not accepted", "auto_reply");
    }
    if (email.attachments !== undefined && !Array.isArray(email.attachments)) {
        throw new EmailValidationError("email.attachments must be an array", "invalid_attachments");
    }
    if (email.attachments?.length > 0) {
        throw new RejectedEmailError("emails with attachments are not accepted", "attachments");
    }
    if (!Number.isInteger(maxReplyBytes) || maxReplyBytes < 1) {
        throw new EmailValidationError("maxReplyBytes must be a positive integer", "invalid_limit");
    }

    const recipients = Array.isArray(email.to) ? email.to : [email.to];
    const token = recipients
        .map((recipient) => extractReplyToken(recipient, configuredDomain))
        .find((candidate) => candidate !== null);
    if (token === undefined) {
        throw new RejectedEmailError("email recipient has no valid reply token", "missing_reply_token");
    }

    if (typeof email.text !== "string") {
        throw new RejectedEmailError("HTML-only or missing-text emails are not accepted", "html_only");
    }
    const reply = cleanQuotedHistory(email.text, maxReplyBytes);
    if (reply === "") {
        throw new RejectedEmailError("empty email replies are not accepted", "empty_reply");
    }

    return {
        id,
        token,
        reply,
        from: sender,
        subject: typeof email.subject === "string" ? email.subject : "",
        receivedAt: typeof email.created_at === "string" ? email.created_at : undefined,
    };
}

export function renderQuestionEmail({
    question,
    choices = [],
    token,
    receiveDomain,
    replyHint,
} = {}) {
    const prompt = redactSecrets(requireNonEmptyString(question, "question").trim());
    validateToken(token);
    if (!Array.isArray(choices) || choices.some((choice) => typeof choice !== "string" || choice.trim() === "")) {
        throw new EmailValidationError("choices must be an array of non-empty strings", "invalid_choices");
    }

    const lines = ["Copilot needs your input:", "", prompt];
    if (choices.length > 0) {
        lines.push(
            "",
            ...choices.map(
                (choice, index) => `${index + 1}. ${redactSecrets(choice.trim())}`,
            ),
        );
    }
    lines.push(
        "",
        replyHint ?? (
            choices.length > 0
                ? "Reply with one option or its number."
                : "Reply with your answer."
        ),
    );

    return {
        subject: "amail: input needed",
        text: lines.join("\n"),
        replyTo: buildReplyAddress(token, receiveDomain),
    };
}

export function renderCompletionEmail({
    repository,
    summary,
    token,
    receiveDomain,
    maxSummaryBytes = DEFAULT_SUMMARY_MAX_BYTES,
} = {}) {
    const repo = requireNonEmptyString(repository, "repository").trim();
    validateToken(token);
    const safeSummary = redactSecrets(summary, maxSummaryBytes);
    return {
        subject: `amail: ${repo} complete`,
        text: [
            `Repository: ${repo}`,
            "",
            safeSummary,
            "",
            "Reply with one follow-up instruction while this session remains idle.",
        ].join("\n"),
        replyTo: buildReplyAddress(token, receiveDomain),
    };
}
