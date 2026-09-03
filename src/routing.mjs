import { createHash, randomBytes } from "node:crypto";

export const TOKEN_BYTES = 16;
export const DEFAULT_TTL_MS = 15 * 60 * 1000;

const QUESTION_VARIANTS = new Set(["user_input", "elicitation"]);
const ROUTING_KINDS = new Set(["question", "followup"]);

function clone(value) {
    return structuredClone(value);
}

function requireString(value, name) {
    if (typeof value !== "string" || value.length === 0) {
        throw new TypeError(`${name} must be a non-empty string`);
    }
    return value;
}

function validateTtl(ttlMs) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
        throw new RangeError("ttlMs must be a positive finite number");
    }
    return ttlMs;
}

function getTtl(metadata, options, defaultTtlMs) {
    const ttlMs = options.ttlMs ?? metadata.ttlMs ?? defaultTtlMs;
    return validateTtl(ttlMs);
}

function normalizeQuestionMetadata(input) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
        throw new TypeError("question metadata must be an object");
    }

    const requestId = requireString(input.requestId, "requestId");
    const variant = input.variant
        ?? input.questionType
        ?? (input.requestedSchema !== undefined || input.mode !== undefined
            ? "elicitation"
            : "user_input");

    if (!QUESTION_VARIANTS.has(variant)) {
        throw new TypeError(
            "question variant must be user_input or elicitation",
        );
    }

    const metadata = { ...input, requestId, variant };
    delete metadata.ttlMs;

    if (metadata.choices !== undefined) {
        if (!Array.isArray(metadata.choices)
            || metadata.choices.some((choice) => typeof choice !== "string")) {
            throw new TypeError("choices must be an array of strings");
        }
        metadata.choices = [...metadata.choices];
    }

    if (metadata.allowFreeform !== undefined
        && typeof metadata.allowFreeform !== "boolean") {
        throw new TypeError("allowFreeform must be a boolean");
    }

    return metadata;
}

function normalizeFollowupMetadata(input) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
        throw new TypeError("follow-up metadata must be an object");
    }

    const sessionId = requireString(input.sessionId, "sessionId");
    const idleMarker = requireString(input.idleMarker, "idleMarker");
    const metadata = { ...input, sessionId, idleMarker };
    delete metadata.ttlMs;
    return metadata;
}

function requestIdFromCompletion(eventOrRequestId) {
    if (typeof eventOrRequestId === "string") {
        return eventOrRequestId;
    }
    return eventOrRequestId?.requestId
        ?? eventOrRequestId?.data?.requestId
        ?? null;
}

export function generateToken() {
    return randomBytes(TOKEN_BYTES).toString("hex");
}

export function hashToken(token) {
    requireString(token, "token");
    return createHash("sha256").update(token, "utf8").digest("hex");
}

export class RoutingState {
    #defaultTtlMs;
    #messageIdTtlMs;
    #now;
    #questionsByToken = new Map();
    #questionsByRequestId = new Map();
    #followupsByToken = new Map();
    #seenMessageIds = new Map();
    #expiredTokenHashes = new Map();
    #invalidatedTokenHashes = new Map();

    constructor({
        ttlMs = DEFAULT_TTL_MS,
        messageIdTtlMs = ttlMs,
        now = () => Date.now(),
    } = {}) {
        this.#defaultTtlMs = validateTtl(ttlMs);
        this.#messageIdTtlMs = validateTtl(messageIdTtlMs);
        if (typeof now !== "function") {
            throw new TypeError("now must be a function");
        }
        this.#now = now;
    }

    createQuestion(metadata, options = {}) {
        const question = normalizeQuestionMetadata(metadata);
        return this.#issue("question", question, options);
    }

    issueQuestion(metadata, options = {}) {
        return this.createQuestion(metadata, options);
    }

    createFollowup(metadata, options = {}) {
        const followup = normalizeFollowupMetadata(metadata);
        return this.#issue("followup", followup, options);
    }

    issueFollowup(metadata, options = {}) {
        return this.createFollowup(metadata, options);
    }

    #issue(kind, metadata, options) {
        this.#purge();
        const ttlMs = getTtl(metadata, options, this.#defaultTtlMs);
        const expiresAt = this.#now() + ttlMs;

        let token;
        let tokenHash;
        do {
            token = generateToken();
            tokenHash = hashToken(token);
        } while (
            this.#questionsByToken.has(tokenHash)
            || this.#followupsByToken.has(tokenHash)
        );

        const record = {
            kind,
            tokenHash,
            expiresAt,
            metadata: clone(metadata),
        };

        if (kind === "question") {
            const previous = this.#questionsByRequestId.get(metadata.requestId);
            if (previous) {
                this.#removeQuestion(previous, "invalidated");
            }
            this.#questionsByToken.set(tokenHash, record);
            this.#questionsByRequestId.set(metadata.requestId, record);
        } else {
            this.#followupsByToken.set(tokenHash, record);
        }

        return {
            token,
            kind,
            expiresAt,
            metadata: clone(metadata),
        };
    }

    consume(tokenOrInput, kind, options = {}) {
        const input = tokenOrInput !== null
            && typeof tokenOrInput === "object"
            ? tokenOrInput
            : { token: tokenOrInput, kind, ...(
                typeof options === "string"
                    ? { messageId: options }
                    : options
            ) };
        const token = input.token;
        const expectedKind = input.kind;

        if (!ROUTING_KINDS.has(expectedKind)) {
            return this.#failure("invalid_kind");
        }
        if (typeof token !== "string" || token.length === 0) {
            return this.#failure("wrong_token");
        }

        this.#purge();
        const tokenHash = hashToken(token);
        const record = expectedKind === "question"
            ? this.#questionsByToken.get(tokenHash)
            : this.#followupsByToken.get(tokenHash);

        if (!record) {
            if (this.#expiredTokenHashes.has(tokenHash)) {
                return this.#failure("expired");
            }
            if (this.#invalidatedTokenHashes.has(tokenHash)) {
                return this.#failure("invalidated");
            }
            const otherRecord = expectedKind === "question"
                ? this.#followupsByToken.get(tokenHash)
                : this.#questionsByToken.get(tokenHash);
            return this.#failure(otherRecord ? "wrong_kind" : "wrong_token");
        }

        if (expectedKind === "followup") {
            if (input.sessionId !== undefined
                && input.sessionId !== record.metadata.sessionId) {
                return this.#failure("stale_session");
            }
            if (input.idleMarker !== undefined
                && input.idleMarker !== record.metadata.idleMarker) {
                return this.#failure("stale_session");
            }
        }

        const messageId = input.messageId;
        if (messageId !== undefined && typeof messageId !== "string") {
            return this.#failure("invalid_message_id");
        }
        if (messageId !== undefined && this.#seenMessageIds.has(messageId)) {
            return this.#failure("duplicate_message_id");
        }

        // Delete before returning so a second synchronous consumer cannot win.
        if (expectedKind === "question") {
            this.#removeQuestion(record);
        } else {
            this.#followupsByToken.delete(tokenHash);
        }
        if (messageId !== undefined) {
            this.#seenMessageIds.set(
                messageId,
                this.#now() + this.#messageIdTtlMs,
            );
        }

        return {
            ok: true,
            accepted: true,
            kind: expectedKind,
            metadata: clone(record.metadata),
            expiresAt: record.expiresAt,
            messageId,
        };
    }

    consumeToken(tokenOrInput, kind, options = {}) {
        return this.consume(tokenOrInput, kind, options);
    }

    inspect(token, kind) {
        if (!ROUTING_KINDS.has(kind)) {
            return this.#failure("invalid_kind");
        }
        if (typeof token !== "string" || token.length === 0) {
            return this.#failure("wrong_token");
        }

        this.#purge();
        const tokenHash = hashToken(token);
        const record = kind === "question"
            ? this.#questionsByToken.get(tokenHash)
            : this.#followupsByToken.get(tokenHash);

        if (!record) {
            if (this.#expiredTokenHashes.has(tokenHash)) {
                return this.#failure("expired");
            }
            if (this.#invalidatedTokenHashes.has(tokenHash)) {
                return this.#failure("invalidated");
            }
            const otherRecord = kind === "question"
                ? this.#followupsByToken.get(tokenHash)
                : this.#questionsByToken.get(tokenHash);
            return this.#failure(otherRecord ? "wrong_kind" : "wrong_token");
        }

        return {
            ok: true,
            accepted: false,
            kind,
            metadata: clone(record.metadata),
            expiresAt: record.expiresAt,
        };
    }

    inspectQuestion(token) {
        return this.inspect(token, "question");
    }

    inspectFollowup(token) {
        return this.inspect(token, "followup");
    }

    invalidateFollowup(token) {
        if (typeof token !== "string" || token.length === 0) {
            return false;
        }
        this.#purge();
        const tokenHash = hashToken(token);
        if (!this.#followupsByToken.has(tokenHash)) {
            return false;
        }
        this.#followupsByToken.delete(tokenHash);
        this.#invalidatedTokenHashes.set(
            tokenHash,
            this.#now() + this.#defaultTtlMs,
        );
        return true;
    }

    consumeQuestion(token, options = {}) {
        return this.consume(token, "question", options);
    }

    consumeFollowup(token, options = {}) {
        return this.consume(token, "followup", options);
    }

    claimMessageId(messageId) {
        if (typeof messageId !== "string" || messageId.length === 0) {
            return false;
        }
        this.#purge();
        if (this.#seenMessageIds.has(messageId)) {
            return false;
        }
        this.#seenMessageIds.set(
            messageId,
            this.#now() + this.#messageIdTtlMs,
        );
        return true;
    }

    registerMessageId(messageId) {
        return this.claimMessageId(messageId);
    }

    isDuplicateMessageId(messageId) {
        this.#purge();
        return typeof messageId === "string"
            && this.#seenMessageIds.has(messageId);
    }

    invalidateQuestion(requestId) {
        if (typeof requestId !== "string" || requestId.length === 0) {
            return false;
        }
        this.#purge();
        const record = this.#questionsByRequestId.get(requestId);
        if (!record) {
            return false;
        }
        this.#removeQuestion(record, "invalidated");
        return true;
    }

    invalidateRequest(requestId) {
        return this.invalidateQuestion(requestId);
    }

    onNativeRequestCompleted(eventOrRequestId) {
        return this.invalidateQuestion(requestIdFromCompletion(eventOrRequestId));
    }

    onUserInputCompleted(eventOrRequestId) {
        return this.onNativeRequestCompleted(eventOrRequestId);
    }

    onElicitationCompleted(eventOrRequestId) {
        return this.onNativeRequestCompleted(eventOrRequestId);
    }

    handleUserInputCompleted(eventOrRequestId) {
        return this.onUserInputCompleted(eventOrRequestId);
    }

    handleElicitationCompleted(eventOrRequestId) {
        return this.onElicitationCompleted(eventOrRequestId);
    }

    getPendingQuestion(requestId) {
        this.#purge();
        const record = this.#questionsByRequestId.get(requestId);
        if (!record) {
            return undefined;
        }
        return {
            requestId,
            kind: "question",
            expiresAt: record.expiresAt,
            metadata: clone(record.metadata),
        };
    }

    getPendingFollowups() {
        this.#purge();
        return [...this.#followupsByToken.values()].map((record) => ({
            kind: "followup",
            expiresAt: record.expiresAt,
            metadata: clone(record.metadata),
        }));
    }

    get pendingQuestionCount() {
        this.#purge();
        return this.#questionsByToken.size;
    }

    get pendingFollowupCount() {
        this.#purge();
        return this.#followupsByToken.size;
    }

    expire() {
        this.#purge();
    }

    #removeQuestion(record, tombstoneReason) {
        this.#questionsByToken.delete(record.tokenHash);
        if (this.#questionsByRequestId.get(record.metadata.requestId) === record) {
            this.#questionsByRequestId.delete(record.metadata.requestId);
        }
        if (tombstoneReason === "expired") {
            this.#expiredTokenHashes.set(
                record.tokenHash,
                this.#now() + this.#defaultTtlMs,
            );
        } else if (tombstoneReason === "invalidated") {
            this.#invalidatedTokenHashes.set(
                record.tokenHash,
                this.#now() + this.#defaultTtlMs,
            );
        }
    }

    #purge() {
        const now = this.#now();

        for (const record of this.#questionsByToken.values()) {
            if (record.expiresAt <= now) {
                this.#removeQuestion(record, "expired");
            }
        }
        for (const record of this.#followupsByToken.values()) {
            if (record.expiresAt <= now) {
                this.#followupsByToken.delete(record.tokenHash);
                this.#expiredTokenHashes.set(
                    record.tokenHash,
                    now + this.#defaultTtlMs,
                );
            }
        }
        for (const [messageId, expiresAt] of this.#seenMessageIds) {
            if (expiresAt <= now) {
                this.#seenMessageIds.delete(messageId);
            }
        }
        for (const [tokenHash, cleanupAt] of this.#expiredTokenHashes) {
            if (cleanupAt <= now) {
                this.#expiredTokenHashes.delete(tokenHash);
            }
        }
        for (const [tokenHash, cleanupAt] of this.#invalidatedTokenHashes) {
            if (cleanupAt <= now) {
                this.#invalidatedTokenHashes.delete(tokenHash);
            }
        }
    }

    #failure(reason) {
        return {
            ok: false,
            accepted: false,
            reason,
        };
    }
}

export function createRoutingState(options) {
    return new RoutingState(options);
}

export const createRouter = createRoutingState;
