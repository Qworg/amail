import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
    ConfigError,
    DEFAULT_POLL_INTERVAL_MS,
    loadConfig,
    loadConfigWithEnvFiles,
} from "../src/config.mjs";
import {
    AWAY_MARKER_CONTENT,
    getAwayStatePath,
    isAway,
} from "../src/away.mjs";
import { main } from "../bin/amail.mjs";

function captureOutput() {
    const chunks = [];
    return {
        stream: {
            write(chunk) {
                chunks.push(String(chunk));
                return true;
            },
        },
        text() {
            return chunks.join("");
        },
    };
}

test("loads required configuration and applies the default poll interval", () => {
    const config = loadConfig({
        RESEND_API_KEY: "re_test_secret",
        AMAIL_TO: "person@example.com",
        AMAIL_FROM: "amail@example.com",
        AMAIL_RECEIVE_DOMAIN: "inbound.example.com",
    });

    assert.deepEqual(config, {
        resendApiKey: "re_test_secret",
        to: "person@example.com",
        from: "amail@example.com",
        receiveDomain: "inbound.example.com",
        pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    });
});

test("validates each missing or malformed configuration field without exposing values", () => {
    assert.throws(
        () => loadConfig({
            RESEND_API_KEY: "super-secret-api-key",
            AMAIL_TO: " ",
            AMAIL_FROM: "",
            AMAIL_RECEIVE_DOMAIN: "receive.example.com",
            AMAIL_POLL_INTERVAL_MS: "not-a-number",
        }),
        (error) => {
            assert.ok(error instanceof ConfigError);
            assert.match(error.message, /AMAIL_TO/);
            assert.match(error.message, /AMAIL_FROM/);
            assert.match(error.message, /AMAIL_POLL_INTERVAL_MS/);
            assert.doesNotMatch(error.message, /super-secret-api-key/);
            return true;
        },
    );
});

test("accepts an explicitly configured positive poll interval", () => {
    const config = loadConfig({
        RESEND_API_KEY: "key",
        AMAIL_TO: "to@example.com",
        AMAIL_FROM: "from@example.com",
        AMAIL_RECEIVE_DOMAIN: "receive.example.com",
        AMAIL_POLL_INTERVAL_MS: "1500",
    });

    assert.equal(config.pollIntervalMs, 1500);
});

test("rejects zero and unsafe poll intervals", () => {
    for (const value of ["0", String(Number.MAX_SAFE_INTEGER + 1)]) {
        assert.throws(
            () => loadConfig({
                RESEND_API_KEY: "key",
                AMAIL_TO: "to@example.com",
                AMAIL_FROM: "from@example.com",
                AMAIL_RECEIVE_DOMAIN: "receive.example.com",
                AMAIL_POLL_INTERVAL_MS: value,
            }),
            ConfigError,
        );
    }
});

test("loads parent and local env files with process values taking precedence", async () => {
    const files = new Map([
        [
            "C:\\work\\.env",
            [
                "RESEND_API_KEY='parent-key'",
                "AMAIL_TO=parent@example.com",
                "AMAIL_FROM=parent-sender@example.com",
            ].join("\n"),
        ],
        [
            "C:\\work\\repo\\.env",
            [
                "AMAIL_TO=local@example.com",
                "AMAIL_RECEIVE_DOMAIN=receive.example.com # local comment",
            ].join("\n"),
        ],
    ]);

    const config = await loadConfigWithEnvFiles({
        cwd: "C:\\work\\repo",
        env: { AMAIL_FROM: "process-sender@example.com" },
        readFileImpl: async (path) => {
            if (!files.has(path)) {
                const error = new Error("missing");
                error.code = "ENOENT";
                throw error;
            }
            return files.get(path);
        },
    });

    assert.deepEqual(config, {
        resendApiKey: "parent-key",
        to: "local@example.com",
        from: "process-sender@example.com",
        receiveDomain: "receive.example.com",
        pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    });
});

test("resolves the Windows marker beneath LOCALAPPDATA\\amail", () => {
    const markerPath = getAwayStatePath({
        platform: "win32",
        env: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
    });

    assert.equal(
        markerPath,
        "C:\\Users\\test\\AppData\\Local\\amail\\away",
    );
});

test("away CLI writes, reports, and removes only the injected marker path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amail-test-"));
    const markerPath = join(directory, "nested", "away");

    try {
        const enabledOutput = captureOutput();
        assert.equal(
            await main(
                ["away", "on"],
                { statePath: markerPath, stdout: enabledOutput.stream },
            ),
            0,
        );
        assert.equal(await readFile(markerPath, "utf8"), AWAY_MARKER_CONTENT);
        assert.equal(await isAway({ statePath: markerPath }), true);
        assert.deepEqual(await readdir(join(directory, "nested")), ["away"]);
        assert.match(enabledOutput.text(), /enabled/);

        const statusOutput = captureOutput();
        assert.equal(
            await main(
                ["away", "status"],
                { statePath: markerPath, stdout: statusOutput.stream },
            ),
            0,
        );
        assert.equal(statusOutput.text(), "Away mode: on.\n");

        const disabledOutput = captureOutput();
        assert.equal(
            await main(
                ["away", "off"],
                { statePath: markerPath, stdout: disabledOutput.stream },
            ),
            0,
        );
        await assert.rejects(stat(markerPath), { code: "ENOENT" });
        assert.match(disabledOutput.text(), /disabled/);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("away off does not create a missing marker directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amail-test-"));
    const markerPath = join(directory, "not-created", "away");
    const output = captureOutput();

    try {
        assert.equal(
            await main(
                ["away", "off"],
                { statePath: markerPath, stdout: output.stream },
            ),
            0,
        );
        await assert.rejects(stat(join(directory, "not-created")), {
            code: "ENOENT",
        });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
