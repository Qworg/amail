#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { clearAway, isAway, setAway } from "../src/away.mjs";

const USAGE = [
    "Usage: amail away <on|off|status>",
    "",
    "Commands:",
    "  amail away on       Enable away mode",
    "  amail away off      Disable away mode",
    "  amail away status   Show away mode status",
].join("\n");

function write(stream, message) {
    stream.write(`${message}\n`);
}

export async function main(
    argv = process.argv.slice(2),
    {
        env = process.env,
        platform = process.platform,
        homeDirectory,
        localAppData,
        stateDirectory,
        statePath,
        markerPath,
        stdout = process.stdout,
        stderr = process.stderr,
    } = {},
) {
    if (argv.length !== 2 || argv[0] !== "away") {
        write(stderr, USAGE);
        return 2;
    }

    const awayOptions = {
        env,
        platform,
        homeDirectory,
        localAppData,
        stateDirectory,
        statePath,
        markerPath,
    };

    if (argv[1] === "on") {
        await setAway(awayOptions);
        write(stdout, "Away mode enabled.");
        return 0;
    }

    if (argv[1] === "off") {
        await clearAway(awayOptions);
        write(stdout, "Away mode disabled.");
        return 0;
    }

    if (argv[1] === "status") {
        write(stdout, `Away mode: ${await isAway(awayOptions) ? "on" : "off"}.`);
        return 0;
    }

    write(stderr, USAGE);
    return 2;
}

if (
    process.argv[1]
    && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
    try {
        process.exitCode = await main();
    } catch (error) {
        process.stderr.write(`amail: ${error.message}\n`);
        process.exitCode = 1;
    }
}
