import { runCommand } from './process';
import { clearInstalledModuleCache, ownQueryEnv } from './database';
import { logger } from './logger';
import { VIEW_WORKER_APP_NAME } from './views/viewWorkerArgs';

/**
 * All PostgreSQL CLI operations (psql/createdb/dropdb). Every call passes
 * arguments as arrays with no shell, so database names and paths can never be
 * interpreted by a shell regardless of their content.
 */

export const RESERVED_DATABASE_NAMES = new Set(['postgres', 'template0', 'template1']);

/** Quotes a PostgreSQL identifier for embedding in SQL text. */
export function quotePgIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
}

type DatabaseReleaseListener = (dbName: string) => Promise<void>;
const releaseListeners = new Set<DatabaseReleaseListener>();

/**
 * Registers something that holds connections to databases (the View
 * Doctor's shells). Postgres refuses to drop, rename or copy a database that
 * has other sessions, so each listener lets go of `dbName` first.
 */
export function onBeforeDatabaseRelease(listener: DatabaseReleaseListener): { dispose(): void } {
    releaseListeners.add(listener);
    return { dispose: () => releaseListeners.delete(listener) };
}

// psql expands :'db' only in what it reads, not in -c: the statement goes on
// stdin, and the name stays a variable that is never spliced into the SQL.
const TERMINATE_VIEW_WORKERS_SQL = `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
WHERE datname = :'db' AND application_name = '${VIEW_WORKER_APP_NAME}' AND pid <> pg_backend_pid();
`;

/**
 * Asks every listener to let go of `dbName`, then ends the View Doctor shells
 * other windows still hold on it (the running probe hides them by design);
 * such a shell restarts on its next use. A failure here never blocks the caller.
 */
export async function releaseDatabase(dbName: string): Promise<void> {
    await Promise.all([...releaseListeners].map(listener =>
        listener(dbName).catch(error => logger.warn(`Could not release ${dbName}:`, error))));
    try {
        await runCommand('psql', [
            '--no-psqlrc',
            '-v', 'ON_ERROR_STOP=1',
            '-v', `db=${dbName}`,
            '-d', 'postgres',
            '-tA'
        ], { env: ownQueryEnv(), input: TERMINATE_VIEW_WORKERS_SQL });
    } catch (error) {
        logger.warn(`Could not end other View Doctor shells on ${dbName}:`, error);
    }
}

/** Runs a single SQL statement against `dbName` and returns trimmed stdout. */
export async function runSql(dbName: string, sql: string): Promise<string> {
    const { stdout } = await runCommand('psql', [
        '--no-psqlrc',
        '-v', 'ON_ERROR_STOP=1',
        '-d', dbName,
        '-tAc', sql
    ], { env: ownQueryEnv() });
    return stdout.trim();
}

/** Lists all databases on the local PostgreSQL instance. */
export async function listPostgresDatabases(): Promise<string[]> {
    try {
        const output = await runSql('postgres', 'SELECT datname FROM pg_database ORDER BY datname;');
        return output
            .split('\n')
            .map(name => name.trim())
            .filter(name => name.length > 0);
    } catch (error) {
        logger.warn('Failed to query PostgreSQL database list:', error);
        return [];
    }
}

export async function databaseExists(dbName: string): Promise<boolean> {
    const result = await runSql('postgres', `SELECT 1 FROM pg_database WHERE datname = '${dbName.replace(/'/g, "''")}'`);
    return result === '1';
}

/** Creates a database, optionally cloning from a template (createdb -T). */
export async function createDatabase(dbName: string, templateDbName?: string): Promise<void> {
    if (templateDbName) {
        await releaseDatabase(templateDbName);
    }
    const args = templateDbName ? ['-T', templateDbName, dbName] : [dbName];
    await runCommand('createdb', args);
    clearInstalledModuleCache(dbName);
}

export async function dropDatabase(dbName: string, options: { ifExists?: boolean } = {}): Promise<void> {
    await releaseDatabase(dbName);
    const args = options.ifExists ? ['--if-exists', dbName] : [dbName];
    await runCommand('dropdb', args);
    clearInstalledModuleCache(dbName);
}

/** Drops `dbName` if it exists (no error when missing). */
export async function dropDatabaseIfExists(dbName: string): Promise<void> {
    await dropDatabase(dbName, { ifExists: true });
}

export async function renameDatabase(oldName: string, newName: string): Promise<void> {
    await releaseDatabase(oldName);
    const sql = `ALTER DATABASE ${quotePgIdentifier(oldName)} RENAME TO ${quotePgIdentifier(newName)};`;
    await runCommand('psql', ['-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', sql]);
    clearInstalledModuleCache(oldName);
    clearInstalledModuleCache(newName);
}

/**
 * Development-mode neutralization applied after restoring a dump: disables
 * crons and outgoing mail, resets logins/passwords, regenerates the database
 * UUID and extends the enterprise expiration date.
 */
export async function neutralizeDatabase(dbName: string, newUuid: string): Promise<void> {
    const statements: Array<{ description: string; sql: string }> = [
        { description: 'Disabling cron jobs', sql: "UPDATE ir_cron SET active='f';" },
        { description: 'Disabling mail servers', sql: 'UPDATE ir_mail_server SET active=false;' },
        { description: 'Extending database expiry', sql: "UPDATE ir_config_parameter SET value = '2090-09-21 00:00:00' WHERE key = 'database.expiration_date';" },
        { description: 'Updating database UUID', sql: `UPDATE ir_config_parameter SET value = '${newUuid}' WHERE key = 'database.uuid';` },
        { description: 'Adding mailcatcher server', sql: "INSERT INTO ir_mail_server(active,name,smtp_host,smtp_port,smtp_encryption) VALUES (true,'mailcatcher','localhost',1025,false);" },
        { description: 'Resetting user passwords to login names', sql: 'UPDATE res_users SET password=login;' },
        { description: 'Configuring admin password', sql: "UPDATE res_users SET password='admin' WHERE id=2;" },
        { description: 'Configuring admin login', sql: "UPDATE res_users SET login='admin' WHERE id=2;" },
        { description: 'Clearing admin TOTP', sql: "UPDATE res_users SET totp_secret='' WHERE id=2;" },
        { description: 'Activating admin user', sql: 'UPDATE res_users SET active=true WHERE id=2;' },
        { description: 'Clearing employee PINs', sql: "UPDATE hr_employee SET pin = '';" }
    ];

    // Every statement is tolerant: dumps vary (e.g. no hr_employee without the
    // hr module), and a failed tweak must never abort the whole restore.
    for (const statement of statements) {
        logger.debug(`${statement.description} on ${dbName}`);
        try {
            await runSql(dbName, statement.sql);
        } catch (error) {
            logger.warn(`${statement.description} failed (continuing setup):`, error);
        }
    }
}
