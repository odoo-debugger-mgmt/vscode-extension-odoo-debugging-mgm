import * as vscode from 'vscode';

/**
 * Typed extractors for command arguments. Commands are invoked either
 * programmatically (with a plain value) or from a tree item's context menu
 * (with the tree item itself), so every handler receives `unknown` and
 * narrows through these helpers instead of `any`.
 */

interface VersionCarrier {
    version?: { id?: unknown };
}

interface VersionSettingCarrier {
    versionId?: unknown;
    key?: unknown;
    value?: unknown;
}

interface UriCarrier {
    resourceUri?: unknown;
    uri?: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

/** A version id passed directly, or a version tree item. */
export function extractVersionId(arg: unknown): string | undefined {
    if (typeof arg === 'string') {
        return arg;
    }
    if (isObject(arg)) {
        const id = (arg as VersionCarrier).version?.id;
        if (typeof id === 'string') {
            return id;
        }
    }
    return undefined;
}

/** A version-setting tree item, or explicit (versionId, key, value) params. */
export function extractVersionSettingRef(
    arg: unknown,
    settingKey?: string,
    currentValue?: unknown
): { versionId: string; key: string; value: unknown } | undefined {
    if (typeof arg === 'string' && typeof settingKey === 'string') {
        return { versionId: arg, key: settingKey, value: currentValue };
    }
    if (isObject(arg)) {
        const carrier = arg as VersionSettingCarrier;
        if (typeof carrier.versionId === 'string' && typeof carrier.key === 'string') {
            return { versionId: carrier.versionId, key: carrier.key, value: carrier.value };
        }
    }
    return undefined;
}

/** A Uri passed directly, or a tree item carrying resourceUri/uri. */
export function extractUri(arg: unknown): vscode.Uri | undefined {
    if (!arg) {
        return undefined;
    }
    if (arg instanceof vscode.Uri) {
        return arg;
    }
    if (isObject(arg)) {
        const carrier = arg as UriCarrier;
        if (carrier.resourceUri instanceof vscode.Uri) {
            return carrier.resourceUri;
        }
        if (carrier.uri instanceof vscode.Uri) {
            return carrier.uri;
        }
    }
    return undefined;
}

