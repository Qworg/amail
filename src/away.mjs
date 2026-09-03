import { access, mkdir, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const AWAY_DIRECTORY_NAME = "amail";
export const AWAY_MARKER_NAME = "away";
export const AWAY_MARKER_CONTENT = "away\n";

function nonEmptyString(value) {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function getAwayStatePath(options = {}) {
    const markerPath = nonEmptyString(options.statePath)
        ?? nonEmptyString(options.markerPath);
    if (markerPath) {
        return resolve(markerPath);
    }

    const environment = options.env ?? process.env;
    const platform = options.platform ?? process.platform;
    const homeDirectory = options.homeDirectory ?? homedir();
    const stateDirectory = nonEmptyString(options.stateDirectory);

    let baseDirectory = stateDirectory;
    if (!baseDirectory && platform === "win32") {
        baseDirectory = nonEmptyString(options.localAppData)
            ?? nonEmptyString(environment.LOCALAPPDATA)
            ?? join(homeDirectory, "AppData", "Local");
    }
    if (!baseDirectory) {
        baseDirectory = nonEmptyString(environment.XDG_STATE_HOME)
            ?? join(homeDirectory, ".local", "state");
    }

    return join(baseDirectory, AWAY_DIRECTORY_NAME, AWAY_MARKER_NAME);
}

export const getAwayPath = getAwayStatePath;

export async function isAway(options = {}) {
    const markerPath = getAwayStatePath(options);
    try {
        await access(markerPath, constants.F_OK);
        return true;
    } catch (error) {
        if (error?.code === "ENOENT") {
            return false;
        }
        throw error;
    }
}

export async function setAway(options = {}) {
    const markerPath = getAwayStatePath(options);
    await mkdir(dirname(markerPath), { recursive: true });
    await writeFile(markerPath, AWAY_MARKER_CONTENT, "utf8");
    return markerPath;
}

export async function clearAway(options = {}) {
    const markerPath = getAwayStatePath(options);
    try {
        await unlink(markerPath);
    } catch (error) {
        if (error?.code !== "ENOENT") {
            throw error;
        }
    }
    return markerPath;
}

export async function getAwayStatus(options = {}) {
    return isAway(options);
}
