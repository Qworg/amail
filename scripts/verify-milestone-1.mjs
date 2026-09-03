import { readFile } from "node:fs/promises";

const [argument] = process.argv.slice(2);
const logPath = argument
    ?? new URL("../test/fixtures/amail-milestone-1-events.jsonl", import.meta.url);

const entries = (await readFile(logPath, "utf8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));

function find(type, predicate = () => true) {
    return entries.find((entry) => entry.type === type && predicate(entry));
}

const interestProbe = find(
    "elicitation.requested",
    (entry) => entry.message?.includes("[amail-probe:elicitation-interest]"),
);
const terminalCompletion = find(
    "elicitation.completed",
    (entry) => entry.content?.response === "Continue",
);
const extensionWin = find(
    "probe.elicitation_answer_result",
    (entry) => entry.content?.response === "amail-probe-auto-answer"
        && entry.success === true,
);
const terminalWin = find(
    "probe.elicitation_answer_result",
    (entry) => entry.content?.response === "amail-probe-delayed-answer"
        && entry.success === false,
);

const assertions = [
    ["extension observed elicitation while TUI was active", interestProbe],
    ["terminal completed the observed elicitation", terminalCompletion],
    ["extension resolved a native request", extensionWin],
    ["terminal-first answer made extension lose safely", terminalWin],
];

const failures = assertions.filter(([, value]) => !value);

for (const [description, value] of assertions) {
    process.stdout.write(`${value ? "PASS" : "FAIL"}: ${description}\n`);
}

if (failures.length > 0) {
    process.exit(1);
}
