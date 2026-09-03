/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
    mutate: [
        "src/config.mjs",
        "src/away.mjs",
        "src/email.mjs",
        "src/routing.mjs",
        "src/runtime.mjs",
    ],
    testRunner: "command",
    commandRunner: {
        command: "node --test",
    },
    coverageAnalysis: "off",
    concurrency: 4,
    reporters: ["clear-text", "progress", "html", "json"],
    htmlReporter: {
        fileName: "mutation/index.html",
    },
    jsonReporter: {
        fileName: "mutation/mutation.json",
    },
    thresholds: {
        high: 80,
        low: 60,
        break: 0,
    },
    cleanTempDir: "always",
};
