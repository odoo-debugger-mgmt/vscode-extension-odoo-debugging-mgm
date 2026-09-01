/**
 * Server URL helpers: resolves the local Odoo URL from the active
 * version's port setting and opens databases in the browser, optionally
 * waiting for the HTTP port to accept connections first.
 */
import * as vscode from 'vscode';
import * as net from 'node:net';
import { VersionsService } from '../versionsService';
import { logger } from './logger';
import { trackSession, untrackSession, anySessionRunning } from './debugSessions';

const DEFAULT_ODOO_PORT = 8069;

/** Port the Odoo server listens on, from the active version's settings. */
export async function getActiveServerPort(): Promise<number> {
    try {
        const settings = await VersionsService.getInstance().getActiveVersionSettings();
        const port = Number(settings.portNumber);
        if (Number.isInteger(port) && port > 0 && port <= 65535) {
            return port;
        }
    } catch (error) {
        logger.debug('Could not read active version port, using default:', error);
    }
    return DEFAULT_ODOO_PORT;
}

/** Local server URL, optionally routed straight into a database. */
export function buildServerUrl(port: number, dbName?: string): vscode.Uri {
    const base = `http://localhost:${port}`;
    if (!dbName) {
        return vscode.Uri.parse(base);
    }
    return vscode.Uri.parse(`${base}/web?db=${encodeURIComponent(dbName)}`);
}

/** Resolves true once the port accepts a TCP connection, false on timeout. */
export function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    const tryOnce = (): Promise<boolean> => new Promise(resolve => {
        const socket = net.connect({ port, host: '127.0.0.1' });
        const finish = (result: boolean) => {
            socket.destroy();
            resolve(result);
        };
        socket.setTimeout(1000, () => finish(false));
        socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
    });

    return (async () => {
        while (Date.now() < deadline) {
            if (await tryOnce()) {
                return true;
            }
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        return false;
    })();
}

/** Opens the Odoo web client for the given (or server-selected) database. */
export async function openServerInBrowser(dbName?: string): Promise<void> {
    const port = await getActiveServerPort();
    await vscode.env.openExternal(buildServerUrl(port, dbName));
}

/** The version whose launch configuration this session was started from. */
async function versionForSession(session: vscode.DebugSession): Promise<{ portNumber: number } | undefined> {
    const name = session.configuration?.name;
    if (typeof name !== 'string' || name.length === 0) {
        return undefined;
    }
    try {
        const service = VersionsService.getInstance();
        await service.initialize();
        const version = service.getVersions().find(entry => entry.settings?.debuggerName === name);
        if (!version) {
            return undefined;
        }
        const port = Number(version.settings.portNumber);
        return { portNumber: Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_ODOO_PORT };
    } catch {
        return undefined;
    }
}

/**
 * Tracks the extension's own debug session: maintains the
 * 'odoo-debugger.server_running' context key and, when
 * odooDebugger.server.openBrowserOnStart is enabled, opens the web
 * client once the server port starts accepting connections.
 */
export function registerServerLifecycle(
    context: vscode.ExtensionContext,
    hooks: {
        onRunningChanged: (running: boolean) => void;
        getSelectedDbName: () => Promise<string | undefined>;
    }
): void {
    context.subscriptions.push(vscode.debug.onDidStartDebugSession(async session => {
        const version = await versionForSession(session);
        if (!version) {
            return;
        }
        trackSession(session);
        hooks.onRunningChanged(anySessionRunning());

        const openBrowser = vscode.workspace
            .getConfiguration('odooDebugger')
            .get<boolean>('server.openBrowserOnStart', false);
        if (!openBrowser) {
            return;
        }
        // The session's own port, not the active version's: another version
        // may have been activated since this one was launched.
        if (await waitForPort(version.portNumber, 60000)) {
            const dbName = await hooks.getSelectedDbName();
            await vscode.env.openExternal(buildServerUrl(version.portNumber, dbName));
        } else {
            logger.debug(`Server port ${version.portNumber} did not open within 60s; not opening browser.`);
        }
    }));

    context.subscriptions.push(vscode.debug.onDidTerminateDebugSession(session => {
        untrackSession(session);
        hooks.onRunningChanged(anySessionRunning());
    }));
}
