/**
 * What a debug session runs: its version, database and port, read from its own
 * launch configuration. A version's primary entry says it in its args (-d,
 * -p); an alongside run (alongside.ts) carries a marker, because its name
 * belongs to no version. Reading the session itself, not the version's current
 * selection, keeps the answer right after the user selects another database.
 * Pure.
 */
import { sessionOwner } from './versionIdentity';

export const ALONGSIDE_MARKER = 'odooDevtools';

export interface RunDetails {
    versionId: string;
    dbId?: string;
    port?: number;
    kind: 'primary' | 'alongside';
}

export interface RunRecord extends RunDetails {
    name: string;
}

export function argValue(args: string[], flag: string): string | undefined {
    const index = args.indexOf(flag);
    return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}

function validPort(value: unknown): number | undefined {
    const port = Number(value);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}

export function describeSession(
    config: { name?: unknown; args?: unknown; [ALONGSIDE_MARKER]?: unknown } | undefined,
    versions: Array<{ id: string; createdAt?: unknown; settings: { debuggerName?: string; portNumber?: number | string } }>,
    activeVersionId: string | undefined
): RunDetails | undefined {
    if (!config) {
        return undefined;
    }
    const marker = config[ALONGSIDE_MARKER];
    if (marker && typeof marker === 'object') {
        const m = marker as Record<string, unknown>;
        if (typeof m.versionId !== 'string' || !m.versionId) {
            return undefined;
        }
        return {
            versionId: m.versionId,
            dbId: typeof m.dbId === 'string' && m.dbId ? m.dbId : undefined,
            port: validPort(m.port),
            kind: 'alongside'
        };
    }
    if (typeof config.name !== 'string' || !config.name) {
        return undefined;
    }
    const owner = sessionOwner(versions as never[], config.name, activeVersionId) as typeof versions[number] | undefined;
    if (!owner) {
        return undefined;
    }
    const args = Array.isArray(config.args) ? config.args.filter((arg): arg is string => typeof arg === 'string') : [];
    return {
        versionId: owner.id,
        dbId: argValue(args, '-d'),
        port: validPort(argValue(args, '-p')) ?? validPort(owner.settings.portNumber),
        kind: 'primary'
    };
}
