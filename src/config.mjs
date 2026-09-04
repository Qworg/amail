import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const REQUIRED_FIELDS = [
    ["RESEND_API_KEY", "resendApiKey"],
    ["AMAIL_TO", "to"],
    ["AMAIL_FROM", "from"],
    ["AMAIL_RECEIVE_DOMAIN", "receiveDomain"],
];

export const DEFAULT_POLL_INTERVAL_MS = 30_000;

export class ConfigError extends Error {
    constructor(errors) {
        super(errors.join("\n"));
        this.name = "ConfigError";
        this.errors = errors;
    }
}

function getEnvironment(input) {
    if (input && typeof input === "object" && "env" in input) {
        return input.env ?? {};
    }
    return input ?? process.env;
}

function readString(environment, name) {
    const value = environment[name];
    return typeof value === "string" ? value.trim() : "";
}

export function loadConfig(input = process.env) {
    const environment = getEnvironment(input);
    const errors = [];
    const config = {};

    for (const [name, property] of REQUIRED_FIELDS) {
        const value = readString(environment, name);
        if (!value) {
            errors.push(`Missing required environment variable: ${name}.`);
        } else {
            config[property] = value;
        }
    }

    const pollInterval = readString(environment, "AMAIL_POLL_INTERVAL_MS");
    if (!pollInterval) {
        config.pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
    } else if (!/^\d+$/.test(pollInterval)) {
        errors.push(
            "Invalid environment variable AMAIL_POLL_INTERVAL_MS: expected a positive integer in milliseconds.",
        );
    } else {
        const parsedPollInterval = Number(pollInterval);
        if (
            !Number.isSafeInteger(parsedPollInterval)
            || parsedPollInterval < 1
        ) {
            errors.push(
                "Invalid environment variable AMAIL_POLL_INTERVAL_MS: expected a positive integer in milliseconds.",
            );
        } else {
            config.pollIntervalMs = parsedPollInterval;
        }
    }

    if (errors.length > 0) {
        throw new ConfigError(errors);
    }

    return Object.freeze(config);
}

function parseEnvFile(content) {
    const values = {};
    for (const line of content.split(/\r?\n/)) {
        const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!match) {
            continue;
        }

        let value = match[2];
        if (
            (value.startsWith("\"") && value.endsWith("\""))
            || (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        } else {
            value = value.replace(/\s+#.*$/, "").trim();
        }
        values[match[1]] = value;
    }
    return values;
}

export async function loadConfigWithEnvFiles({
    env = process.env,
    cwd = process.cwd(),
    readFileImpl = readFile,
} = {}) {
    const environment = {};
    const paths = [
        resolve(cwd, "..", ".env"),
        join(cwd, ".env"),
    ];

    for (const path of paths) {
        try {
            Object.assign(environment, parseEnvFile(await readFileImpl(path, "utf8")));
        } catch (error) {
            if (error?.code !== "ENOENT") {
                throw error;
            }
        }
    }

    Object.assign(environment, env);
    return loadConfig(environment);
}

export const validateConfig = loadConfig;
