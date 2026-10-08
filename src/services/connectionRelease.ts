/**
 * Freeing a database for a copy, a rename or a drop: PostgreSQL refuses all
 * three while anyone else is connected. Our own server is stopped (after
 * asking) and restarted afterwards; our own backends are ended silently; and
 * anything else is listed, ended only after the user says so. Pure over
 * ReleaseHost and ReleaseUi; copyRuntime.ts provides the real ones.
 */
import { OWN_QUERY_APP_NAME } from './database';
import { VIEW_WORKER_APP_NAME } from './views/viewWorkerArgs';

export interface DbConnection {
    pid: number;
    application: string;
    client: string;
    user: string;
}

/** A server this window started on the database. */
export interface ManagedRun {
    versionId: string;
    debuggerName: string;
    noDebug: boolean;
    /** The database it was started on (its `-d`), whatever its version selects now. */
    dbName: string;
}

export interface ReleaseHost {
    /** Release listeners and View Doctor shells everywhere (postgres.releaseDatabase). */
    letGo(db: string): Promise<void>;
    ownRun(db: string): Promise<ManagedRun | undefined>;
    /** Resolves once the session has ended. */
    stop(run: ManagedRun): Promise<void>;
    start(run: ManagedRun): Promise<void>;
    /** Everyone else's client connections: not ours, not the View Doctor's. */
    connections(db: string): Promise<DbConnection[]>;
    endOwnQueries(db: string): Promise<void>;
    end(db: string, pids: number[]): Promise<void>;
    sleep(ms: number): Promise<void>;
    /** Called when releaseForCopy's own restart of a stopped server fails. */
    restartFailed?(run: ManagedRun, error: unknown): void;
}

export interface ReleaseUi {
    confirmStop(db: string, run: ManagedRun): Promise<boolean>;
    confirmEnd(db: string, connections: DbConnection[]): Promise<boolean>;
}

export interface Release {
    stopped?: ManagedRun;
    restart(): Promise<void>;
}

const POLL_MS = 250;
/** A stopped Odoo closes its connections as it exits: up to 10 s. */
const SERVER_EXIT_POLLS = 40;
const ENDED_POLLS = 20;

// psql reads it on stdin, so :'db' stays a variable, never spliced in.
export const CONNECTIONS_SQL = `SELECT pid, coalesce(application_name, ''), coalesce(host(client_addr), ''), coalesce(usename, '')
FROM pg_stat_activity
WHERE datname = :'db' AND pid <> pg_backend_pid() AND backend_type = 'client backend'
  AND coalesce(application_name, '') NOT IN ('${OWN_QUERY_APP_NAME}', '${VIEW_WORKER_APP_NAME}');
`;

/** Rows separated by newlines, fields by the unit separator (psql -F '\x1f'). */
export function parseConnections(output: string): DbConnection[] {
    const rows: DbConnection[] = [];
    for (const line of output.split('\n')) {
        const [pid, application = '', client = '', user = ''] = line.split('\x1f');
        const id = Number.parseInt(pid ?? '', 10);
        if (Number.isSafeInteger(id) && id > 0) {
            rows.push({ pid: id, application, client, user });
        }
    }
    return rows;
}

export function describeConnection(connection: DbConnection): string {
    const who = connection.application || 'an unnamed client';
    return `${who} (${connection.client || 'local socket'})`;
}

async function pollUntilEmpty(host: ReleaseHost, db: string, polls: number): Promise<DbConnection[]> {
    let current = await host.connections(db);
    for (let i = 0; i < polls && current.length > 0; i++) {
        await host.sleep(POLL_MS);
        current = await host.connections(db);
    }
    return current;
}

export async function releaseForCopy(db: string, host: ReleaseHost, ui: ReleaseUi): Promise<Release | undefined> {
    await host.letGo(db);

    const run = await host.ownRun(db);
    if (run) {
        if (!await ui.confirmStop(db, run)) {
            return undefined;
        }
        await host.stop(run);
    }
    const release: Release = {
        stopped: run,
        restart: async () => {
            if (run) {
                await host.start(run);
            }
        }
    };

    // From here the server is down: whatever goes wrong, bring it back and
    // report the original problem. A failed restart is reported, not thrown.
    let restartedHere = false;
    const restartQuietly = async () => {
        if (!run || restartedHere) {
            return;
        }
        restartedHere = true;
        try {
            await host.start(run);
        } catch (error) {
            host.restartFailed?.(run, error);
        }
    };
    try {
        await host.endOwnQueries(db);
        let others = run ? await pollUntilEmpty(host, db, SERVER_EXIT_POLLS) : await host.connections(db);
        if (others.length === 0) {
            return release;
        }

        if (!await ui.confirmEnd(db, others)) {
            await restartQuietly();
            return undefined;
        }
        await host.end(db, others.map(connection => connection.pid));
        others = await pollUntilEmpty(host, db, ENDED_POLLS);
        if (others.length > 0) {
            throw new Error(`Could not end the connections to "${db}": ${others.map(describeConnection).join(', ')}.`);
        }
        return release;
    } catch (error) {
        await restartQuietly();
        throw error;
    }
}
