/**
 * Clone, Create from Template and Delete Database against a real PostgreSQL.
 * Skipped unless ODT_PG_TEST=1. Every database it makes is named odt131_* and
 * dropped afterwards.
 */
import * as assert from 'assert';
import { spawn, ChildProcess } from 'node:child_process';
import * as vscode from 'vscode';
import { createDatabase, databaseExists, dropDatabaseIfExists, runSql } from '../services/postgres';
import { cloneDatabaseFromTemplate, deleteDb, postgresDatabaseNames, setupDatabase } from '../dbs';
import { SettingsStore } from '../settingsStore';
import { DatabaseModel } from '../models/db';

const enabled = process.env.ODT_PG_TEST === '1';

const sessionsOn = async (db: string) =>
    Number(await runSql('postgres', `SELECT count(*) FROM pg_stat_activity WHERE datname = '${db}';`));

/**
 * Holds a connection to `db` open, so dropdb refuses it. Killing psql leaves
 * its backend sleeping, so release terminates that too.
 */
async function holdConnection(db: string): Promise<{ process: ChildProcess; release: () => Promise<void> }> {
    const holder = spawn('psql', ['--no-psqlrc', '-d', db, '-c', 'SELECT pg_sleep(60);'], { stdio: 'ignore' });
    const release = async () => {
        holder.kill();
        await runSql('postgres', `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${db}' AND pid <> pg_backend_pid();`);
        for (let i = 0; i < 50 && await sessionsOn(db) > 0; i++) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    };
    for (let i = 0; i < 50; i++) {
        if (await sessionsOn(db) > 0) {
            return { process: holder, release };
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    await release();
    throw new Error(`could not hold a connection to ${db}`);
}

(enabled ? suite : suite.skip)('Database safety on a real PostgreSQL', function () {
    this.timeout(120000);
    const suffix = `${process.pid}_${Date.now().toString(36)}`;
    const source = `odt131_src_${suffix}`;
    const existing = `odt131_mine_${suffix}`;
    const doomed = `odt131_del_${suffix}`;
    const holders: Array<{ release: () => Promise<void> }> = [];

    suiteSetup(async () => {
        await createDatabase(source);
        await runSql(source, 'CREATE TABLE odt_t (v text); INSERT INTO odt_t VALUES (\'source\');');
        await createDatabase(existing);
        await runSql(existing, 'CREATE TABLE odt_t (v text); INSERT INTO odt_t VALUES (\'mine\');');
    });

    suiteTeardown(async () => {
        for (const holder of holders) {
            await holder.release().catch(() => undefined);
        }
        for (const name of [source, existing, doomed]) {
            await dropDatabaseIfExists(name).catch(() => undefined);
        }
    });

    test('the name prompts see every database in PostgreSQL, linked or not', async () => {
        const names = await postgresDatabaseNames();
        assert.ok(names.has(existing.toLowerCase()));
    });

    test('cloning onto an existing name fails and leaves that database as it was', async () => {
        // It used to drop "existing" first, then copy the source over it.
        await assert.rejects(cloneDatabaseFromTemplate(existing, source));

        assert.strictEqual(await databaseExists(existing), true);
        assert.strictEqual(await runSql(existing, 'SELECT v FROM odt_t;'), 'mine');
    });

    test('creating a fresh database over an existing one creates nothing, and says so', async () => {
        // Create Database records the database only when it was created: a
        // name taken since the prompt must not be linked as the user's own.
        const outcome = await setupDatabase(existing, undefined);

        assert.deepStrictEqual(outcome, { created: false, ok: false });
        assert.strictEqual(await runSql(existing, 'SELECT v FROM odt_t;'), 'mine');
    });

    suite('Delete Database', () => {
        const real = {
            getSelectedProject: SettingsStore.getSelectedProject,
            saveWithoutComments: SettingsStore.saveWithoutComments,
            showWarningMessage: vscode.window.showWarningMessage,
            showInformationMessage: vscode.window.showInformationMessage,
            setStatusBarMessage: vscode.window.setStatusBarMessage
        };
        type Data = { projects: Array<{ uid: string; name: string; isSelected: boolean; dbs: DatabaseModel[]; repos: never[] }> };
        const store = SettingsStore as unknown as Record<string, unknown>;
        const window = vscode.window as unknown as Record<string, unknown>;
        let saved: Data[];
        let infos: string[];
        let data: Data;

        setup(async () => {
            if (!(await databaseExists(doomed))) {
                await createDatabase(doomed);
            }
            saved = [];
            infos = [];
            const db = new DatabaseModel(doomed, new Date(), { isSelected: true, displayName: doomed, internalName: doomed });
            data = { projects: [{ uid: 'p1', name: 'Acme', isSelected: true, dbs: [db], repos: [] }] };
            store.getSelectedProject = async () => ({ data, project: data.projects[0] });
            store.saveWithoutComments = async (value: Data) => { saved.push(value); };
            window.showWarningMessage = async () => 'Delete';
            window.showInformationMessage = async (message: string) => { infos.push(message); return undefined; };
            window.setStatusBarMessage = (message: string) => { infos.push(message); return { dispose() { /* noop */ } }; };
        });

        teardown(() => {
            Object.assign(SettingsStore, { getSelectedProject: real.getSelectedProject, saveWithoutComments: real.saveWithoutComments });
            Object.assign(vscode.window, {
                showWarningMessage: real.showWarningMessage,
                showInformationMessage: real.showInformationMessage,
                setStatusBarMessage: real.setStatusBarMessage
            });
        });

        test('a drop that fails is reported, claims no success, and keeps the record', async () => {
            const holder = await holdConnection(doomed);
            holders.push(holder);
            try {
                await assert.rejects(deleteDb(data.projects[0].dbs[0]), /being accessed|other users|still in use/i);

                assert.strictEqual(await databaseExists(doomed), true);
                assert.deepStrictEqual(saved, [], 'the record must stay');
                assert.ok(!infos.some(message => /deleted/i.test(message)), infos.join(' | '));
            } finally {
                await holder.release();
            }
        });

        test('a drop that succeeds removes the database and its record', async () => {
            await deleteDb(data.projects[0].dbs[0]);

            assert.strictEqual(await databaseExists(doomed), false);
            assert.strictEqual(saved.length, 1);
            assert.deepStrictEqual(saved[0].projects[0].dbs, []);
        });
    });
});
