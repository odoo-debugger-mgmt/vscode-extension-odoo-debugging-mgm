/**
 * Server URL helpers: resolves the local Odoo URL from the active
 * version's port setting and opens databases in the browser, optionally
 * waiting for the HTTP port to accept connections first.
 */
import * as vscode from 'vscode';
import * as net from 'node:net';
import { VersionsService } from '../versionsService';
import { logger } from './logger';
import { showWarning } from './notifications';
import { getRunningInstances, RunningInstance } from './runningState';
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

export interface PortResolution {
    port: number;
    /** Where the port came from, so callers can explain a surprising choice. */
    source: 'running' | 'version' | 'active';
    versionName?: string;
}

export interface PortCandidateVersion {
    id: string;
    name: string;
    portNumber?: number;
}

/**
 * Which port serves `dbId`. With several versions running, the active
 * version's port is usually the wrong answer: a database belongs to the
 * version that is actually serving it.
 */
export function pickPortForDatabase(
    dbId: string | undefined,
    running: RunningInstance[],
    versions: PortCandidateVersion[],
    dbVersionId: string | undefined,
    activePort: number
): PortResolution {
    const byId = (id: string | undefined) => versions.find(version => version.id === id);

    if (dbId) {
        const live = running.find(instance => instance.dbName === dbId && !!instance.port);
        if (live?.port) {
            return { port: live.port, source: 'running', versionName: byId(live.versionId)?.name };
        }
    }

    const owner = byId(dbVersionId);
    if (owner?.portNumber) {
        return { port: owner.portNumber, source: 'version', versionName: owner.name };
    }

    return { port: activePort, source: 'active' };
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

/** Resolves the port serving `dbId`, consulting live sessions first. */
export async function resolvePortForDatabase(
    dbId: string | undefined,
    dbVersionId?: string
): Promise<PortResolution> {
    try {
        const service = VersionsService.getInstance();
        await service.initialize();
        const versions: PortCandidateVersion[] = service.getVersions().map(version => ({
            id: version.id,
            name: version.name,
            portNumber: Number(version.settings.portNumber) || undefined
        }));
        return pickPortForDatabase(
            dbId,
            await getRunningInstances(),
            versions,
            dbVersionId,
            await getActiveServerPort()
        );
    } catch (error) {
        logger.debug('Could not resolve the port for a database, using the active version:', error);
        return { port: await getActiveServerPort(), source: 'active' };
    }
}

/**
 * Opens the Odoo web client for the given (or server-selected) database, on
 * the port actually serving it. A dead port is reported rather than opened:
 * a browser tab showing a connection error is worse than being told why.
 */
export async function openServerInBrowser(dbName?: string, dbVersionId?: string): Promise<void> {
    const resolved = await resolvePortForDatabase(dbName, dbVersionId);
    const url = buildServerUrl(resolved.port, dbName);

    if (await waitForPort(resolved.port, 400)) {
        await vscode.env.openExternal(url);
        return;
    }

    const target = resolved.versionName
        ? `${resolved.versionName} (port ${resolved.port})`
        : `port ${resolved.port}`;
    const choice = await showWarning(`No Odoo server is answering on ${target}.`, 'Open Anyway');
    if (choice === 'Open Anyway') {
        await vscode.env.openExternal(url);
    }
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
