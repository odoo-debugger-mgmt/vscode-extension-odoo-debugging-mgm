import * as assert from 'assert';
import * as path from 'node:path';
import {
    copyDatabase, createDatabaseSql, discardDatabase, retryWhileBusy, stageRestore, swapInRestored, verifyCheckpoint, CopyBackend
} from '../services/databaseCopy';
import { checkpointComment } from '../services/checkpoints';

interface Fake extends CopyBackend {
    dbs: Set<string>;
    dirs: Set<string>;
    calls: string[];
    failOn?: (call: string) => boolean;
    busyTimes: number;
    /** Statements that report "being accessed by other users" this many more times. */
    busy: Map<string, number>;
    /** Protected databases and their comment, as pg_database would report them. */
    templates: Map<string, string>;
    owner: string;
}

const fromSqlText = (hex: string) => Buffer.from(hex, 'hex').toString('utf8');

const ROOT = '/data/filestore';

function fake(dbs: string[], dirs: string[] = [], versionNum = 170006): Fake {
    const f: Fake = {
        dbs: new Set(dbs),
        dirs: new Set(dirs.map(dir => path.join(ROOT, dir))),
        calls: [],
        busyTimes: 0,
        busy: new Map(),
        templates: new Map(),
        owner: 'odoo',
        log: () => undefined,
        sleep: async () => undefined,
        freeOwnConnections: async db => { f.calls.push(`free ${db}`); },
        sql: async statement => {
            f.calls.push(statement);
            if (f.failOn?.(statement)) {
                throw new Error(`failed: ${statement}`);
            }
            const busyLeft = f.busy.get(statement) ?? 0;
            if (busyLeft > 0) {
                f.busy.set(statement, busyLeft - 1);
                throw new Error('database is being accessed by other users');
            }
            if (statement === 'SHOW server_version_num;') {
                return String(versionNum);
            }
            if (/^COMMENT ON DATABASE .* IS (?!')/.test(statement)) {
                throw new Error('syntax error: COMMENT takes a string literal');
            }
            let m = /^CREATE DATABASE "([^"]+)" TEMPLATE "([^"]+)"/.exec(statement);
            if (m) {
                if (f.busyTimes > 0) {
                    f.busyTimes--;
                    throw new Error(`source database "${m[2]}" is being accessed by other users`);
                }
                f.dbs.add(m[1]);
                return '';
            }
            m = /^DROP DATABASE IF EXISTS "([^"]+)"/.exec(statement);
            if (m) {
                f.dbs.delete(m[1]);
                return '';
            }
            m = /^ALTER DATABASE "([^"]+)" RENAME TO "([^"]+)"/.exec(statement);
            if (m) {
                f.dbs.delete(m[1]);
                f.dbs.add(m[2]);
                return '';
            }
            m = /^SELECT 1 FROM pg_database WHERE datname = convert_from\(decode\('([0-9a-f]+)'/.exec(statement);
            if (m) {
                return f.dbs.has(fromSqlText(m[1])) ? '1' : '';
            }
            m = /^SELECT datistemplate::text \|\| '\|' \|\| coalesce\(shobj_description\(oid,'pg_database'\),''\) FROM pg_database WHERE datname = convert_from\(decode\('([0-9a-f]+)'/.exec(statement);
            if (m) {
                const name = fromSqlText(m[1]);
                return f.dbs.has(name) ? `${f.templates.has(name)}|${f.templates.get(name) ?? ''}` : '';
            }
            m = /^SELECT pg_get_userbyid\(datdba\) FROM pg_database WHERE datname = convert_from\(decode\('([0-9a-f]+)'/.exec(statement);
            if (m) {
                return f.dbs.has(fromSqlText(m[1])) ? f.owner : '';
            }
            return '';
        },
        files: {
            exists: async dir => f.dirs.has(dir),
            linkTree: async (src, dst) => {
                f.calls.push(`link ${path.basename(src)} -> ${path.basename(dst)}`);
                if (f.failOn?.(`link ${path.basename(dst)}`)) {
                    throw new Error('link failed');
                }
                f.dirs.add(dst);
                return { files: 3, copied: 0 };
            },
            rename: async (from, to) => {
                const call = `mv ${path.basename(from)} -> ${path.basename(to)}`;
                f.calls.push(call);
                if (f.failOn?.(call)) {
                    throw new Error(`failed: ${call}`);
                }
                f.dirs.delete(from);
                f.dirs.add(to);
            },
            remove: async dir => {
                const call = `rm ${path.basename(dir)}`;
                f.calls.push(call);
                if (f.failOn?.(call)) {
                    throw new Error(`failed: ${call}`);
                }
                f.dirs.delete(dir);
            }
        }
    };
    return f;
}

const sqlCalls = (f: Fake) => f.calls.filter(call => !call.startsWith('SELECT 1') && call !== 'SHOW server_version_num;');

suite('Database copy', () => {
    test('FILE_COPY from PostgreSQL 15, the plain template copy before', () => {
        assert.strictEqual(createDatabaseSql('b', 'a', 150000), 'CREATE DATABASE "b" TEMPLATE "a" STRATEGY FILE_COPY;');
        assert.strictEqual(createDatabaseSql('b', 'a', 140010), 'CREATE DATABASE "b" TEMPLATE "a";');
    });

    test('a checkpoint copy: database, filestore links, comment, protection', async () => {
        const f = fake(['shop'], ['shop']);
        const result = await copyDatabase(f, 'shop', 'shop__cp_1', { filestoreRoot: ROOT, protect: { comment: 'odoo-devtools checkpoint of shop' } });
        assert.deepStrictEqual(result, { filestore: true, copiedFiles: 0 });
        const calls = sqlCalls(f);
        assert.strictEqual(calls[0], 'CREATE DATABASE "shop__cp_1" TEMPLATE "shop" STRATEGY FILE_COPY;');
        assert.strictEqual(calls[1], 'link shop -> shop__cp_1');
        assert.ok(calls[2].startsWith(`DO $$ BEGIN EXECUTE format('COMMENT ON DATABASE %I IS %L', convert_from(`));
        assert.strictEqual(calls[3], 'ALTER DATABASE "shop__cp_1" WITH ALLOW_CONNECTIONS false IS_TEMPLATE true;');
    });

    test('no filestore folder: filestore false, nothing linked', async () => {
        const f = fake(['shop']);
        const result = await copyDatabase(f, 'shop', 'shop__cp_1', { filestoreRoot: ROOT });
        assert.deepStrictEqual(result, { filestore: false, copiedFiles: 0 });
        assert.ok(!f.calls.some(call => call.startsWith('link')));
    });

    test('a stray filestore folder under the target name is moved aside', async () => {
        const f = fake(['shop'], ['shop', 'copy']);
        await copyDatabase(f, 'shop', 'copy', { filestoreRoot: ROOT });
        const mv = f.calls.findIndex(call => call.startsWith('mv copy -> copy.orphan-'));
        assert.ok(mv >= 0 && mv < f.calls.indexOf('link shop -> copy'));
        assert.ok(!f.calls.includes('rm copy'));
    });

    test('refuses a target that already exists', async () => {
        const f = fake(['shop', 'copy']);
        await assert.rejects(copyDatabase(f, 'shop', 'copy', {}), /already exists/);
        assert.ok(!f.calls.some(call => call.startsWith('CREATE')));
    });

    test('a failure removes everything the copy made, and leaves the source', async () => {
        const f = fake(['shop'], ['shop']);
        f.failOn = call => call.startsWith('ALTER DATABASE "shop__cp_1" WITH ALLOW');
        await assert.rejects(copyDatabase(f, 'shop', 'shop__cp_1', { filestoreRoot: ROOT, protect: { comment: 'c' } }));
        assert.deepStrictEqual([...f.dbs], ['shop']);
        assert.deepStrictEqual([...f.dirs], [path.join(ROOT, 'shop')]);
    });

    test('a busy source is retried after freeing our own connections, then reported', async () => {
        const f = fake(['shop']);
        f.busyTimes = 2;
        await copyDatabase(f, 'shop', 'copy', {});
        assert.strictEqual(f.calls.filter(call => call === 'free shop').length, 2);
        assert.ok(f.dbs.has('copy'));

        const g = fake(['shop']);
        g.busyTimes = 10;
        await assert.rejects(copyDatabase(g, 'shop', 'copy', {}), /being accessed by other users/);
    });

    test('retryWhileBusy does not retry other errors', async () => {
        const f = fake([]);
        let runs = 0;
        await assert.rejects(retryWhileBusy(f, 'x', async () => { runs++; throw new Error('disk full'); }), /disk full/);
        assert.strictEqual(runs, 1);
    });

    test('discard unprotects, drops and removes the filestore', async () => {
        const f = fake(['shop__cp_1'], ['shop__cp_1']);
        await discardDatabase(f, 'shop__cp_1', ROOT);
        assert.deepStrictEqual(sqlCalls(f), [
            'ALTER DATABASE "shop__cp_1" WITH IS_TEMPLATE false;',
            'DROP DATABASE IF EXISTS "shop__cp_1";',
            'rm shop__cp_1'
        ]);
        assert.strictEqual(f.dbs.size + f.dirs.size, 0);
    });

    test('discard moves a folder aside when no database of that name existed', async () => {
        const f = fake([], ['ghost']);
        await discardDatabase(f, 'ghost', ROOT);
        assert.ok(!f.dirs.has(path.join(ROOT, 'ghost')));
        assert.ok([...f.dirs].some(dir => dir.startsWith(path.join(ROOT, 'ghost.orphan-'))));
        assert.ok(!f.calls.includes('rm ghost'));
    });

    test('stageRestore copies the checkpoint, unprotected, and drops a leftover staging copy first', async () => {
        const f = fake(['shop', 'shop__cp_1', 'shop__restoring'], ['shop__cp_1']);
        const staged = await stageRestore(f, 'shop', 'shop__cp_1', ROOT);
        assert.strictEqual(staged, 'shop__restoring');
        const calls = sqlCalls(f);
        assert.ok(calls.indexOf('DROP DATABASE IF EXISTS "shop__restoring";') < calls.indexOf('CREATE DATABASE "shop__restoring" TEMPLATE "shop__cp_1" STRATEGY FILE_COPY;'));
        assert.ok(!calls.some(call => call.includes('ALLOW_CONNECTIONS false')));
        assert.ok(f.dirs.has(path.join(ROOT, 'shop__restoring')));
    });

    test('stageRestore refuses when an interrupted restore left the old data behind', async () => {
        const f = fake(['shop', 'shop__cp_1', 'shop__replaced']);
        await assert.rejects(stageRestore(f, 'shop', 'shop__cp_1', ROOT), /shop__replaced/);
        assert.ok(!f.calls.some(call => call.startsWith('CREATE') || call.startsWith('DROP')));
    });

    test('the swap: rename both ways, swap the folders, drop the old state', async () => {
        const f = fake(['shop', 'shop__restoring'], ['shop', 'shop__restoring']);
        await swapInRestored(f, 'shop', 'shop__restoring', ROOT);
        assert.deepStrictEqual(sqlCalls(f), [
            'ALTER DATABASE "shop" RENAME TO "shop__replaced";',
            'ALTER DATABASE "shop__restoring" RENAME TO "shop";',
            'mv shop -> shop__replaced',
            'mv shop__restoring -> shop',
            'ALTER DATABASE "shop__replaced" WITH IS_TEMPLATE false;',
            'DROP DATABASE IF EXISTS "shop__replaced";',
            'rm shop__replaced'
        ]);
        assert.deepStrictEqual([...f.dbs], ['shop']);
        assert.deepStrictEqual([...f.dirs], [path.join(ROOT, 'shop')]);
    });

    test('a checkpoint without a filestore removes the live folder', async () => {
        const f = fake(['shop', 'shop__restoring'], ['shop']);
        await swapInRestored(f, 'shop', 'shop__restoring', ROOT);
        assert.deepStrictEqual([...f.dirs], []);
    });

    test('a failed second rename puts the database back', async () => {
        const f = fake(['shop', 'shop__restoring'], ['shop', 'shop__restoring']);
        f.failOn = call => call === 'ALTER DATABASE "shop__restoring" RENAME TO "shop";';
        await assert.rejects(swapInRestored(f, 'shop', 'shop__restoring', ROOT), /failed/);
        assert.deepStrictEqual([...f.dbs].sort(), ['shop', 'shop__restoring']);
        assert.ok(f.dirs.has(path.join(ROOT, 'shop')));
    });

    test('a failed folder swap undoes the folders and both renames', async () => {
        const f = fake(['shop', 'shop__restoring'], ['shop', 'shop__restoring']);
        f.failOn = call => call === 'mv shop__restoring -> shop';
        await assert.rejects(swapInRestored(f, 'shop', 'shop__restoring', ROOT));
        assert.deepStrictEqual([...f.dbs].sort(), ['shop', 'shop__restoring']);
        assert.deepStrictEqual([...f.dirs].sort(), [path.join(ROOT, 'shop'), path.join(ROOT, 'shop__restoring')]);
    });

    test('when the undo fails too, the error names where the data is', async () => {
        const f = fake(['shop', 'shop__restoring'], []);
        f.failOn = call => call === 'ALTER DATABASE "shop__restoring" RENAME TO "shop";'
            || call === 'ALTER DATABASE "shop__replaced" RENAME TO "shop";';
        await assert.rejects(swapInRestored(f, 'shop', 'shop__restoring', ROOT), /shop__replaced/);
    });

    test('when the folder undo fails, the error names the folder', async () => {
        const f = fake(['shop', 'shop__restoring'], ['shop', 'shop__restoring']);
        f.failOn = call => call === 'mv shop__restoring -> shop' || call === 'mv shop__replaced -> shop';
        await assert.rejects(swapInRestored(f, 'shop', 'shop__restoring', ROOT), /folder ".*shop__replaced"/);
    });

    test('stageRestore refuses when a shop__replaced folder was left behind', async () => {
        const f = fake(['shop', 'shop__cp_1'], ['shop__replaced']);
        await assert.rejects(stageRestore(f, 'shop', 'shop__cp_1', ROOT), /shop__replaced/);
        assert.ok(!f.calls.some(call => call.startsWith('CREATE') || call.startsWith('DROP')));
    });

    test('failing to drop the old state is logged, not a failed restore', async () => {
        const f = fake(['shop', 'shop__restoring']);
        const logs: string[] = [];
        f.log = message => logs.push(message);
        f.failOn = call => call === 'DROP DATABASE IF EXISTS "shop__replaced";';
        await swapInRestored(f, 'shop', 'shop__restoring', ROOT);
        assert.ok(logs.some(line => line.includes('shop__replaced')));
    });

    test('discard: a folder that cannot be removed after the drop is logged, not an error', async () => {
        const f = fake(['shop__cp_1'], ['shop__cp_1']);
        const logs: string[] = [];
        f.log = message => logs.push(message);
        f.failOn = call => call === 'rm shop__cp_1';
        await discardDatabase(f, 'shop__cp_1', ROOT);
        assert.ok(!f.dbs.has('shop__cp_1'));
        assert.ok(logs.some(line => line.includes(path.join(ROOT, 'shop__cp_1'))));
    });

    test('stageRestore refuses a checkpoint whose recorded filestore is missing, before anything else', async () => {
        const f = fake(['shop', 'shop__cp_1', 'shop__restoring'], []);
        await assert.rejects(
            stageRestore(f, 'shop', 'shop__cp_1', ROOT, { expectFilestore: true }),
            new RegExp(`The filestore of this checkpoint \\(${path.join(ROOT, 'shop__cp_1')}\\) is missing, so restoring it would lose the attachments\\.`)
        );
        assert.deepStrictEqual(f.calls, []);
        assert.ok(f.dbs.has('shop__restoring'), 'nothing was dropped');
    });

    test('stageRestore without a recorded filestore, or with it present, goes ahead', async () => {
        const f = fake(['shop', 'shop__cp_1'], []);
        assert.strictEqual(await stageRestore(f, 'shop', 'shop__cp_1', ROOT, { expectFilestore: false }), 'shop__restoring');
        const g = fake(['shop', 'shop__cp_1'], ['shop__cp_1']);
        assert.strictEqual(await stageRestore(g, 'shop', 'shop__cp_1', ROOT, { expectFilestore: true }), 'shop__restoring');
        assert.ok(g.dirs.has(path.join(ROOT, 'shop__restoring')));
    });

    test('stageRestore gives the staged copy the live database\'s owner', async () => {
        const f = fake(['shop', 'shop__cp_1']);
        f.owner = 'alice';
        await stageRestore(f, 'shop', 'shop__cp_1', ROOT);
        const create = f.calls.indexOf('CREATE DATABASE "shop__restoring" TEMPLATE "shop__cp_1" STRATEGY FILE_COPY;');
        const read = f.calls.findIndex(call => call.startsWith('SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = convert_from('));
        const alter = f.calls.findIndex(call => call.startsWith(`DO $$ BEGIN EXECUTE format('ALTER DATABASE %I OWNER TO %I', convert_from(`));
        assert.ok(create >= 0 && create < read && read < alter, f.calls.join('\n'));
        const hex = (value: string) => Buffer.from(value, 'utf8').toString('hex');
        assert.ok(f.calls[read].includes(hex('shop')) && !f.calls[read].includes(hex('shop__restoring')));
        assert.ok(f.calls[alter].includes(hex('shop__restoring')) && f.calls[alter].includes(hex('alice')));
    });

    test('stageRestore: failing to set the owner is logged, and the staged copy is kept', async () => {
        const f = fake(['shop', 'shop__cp_1']);
        const logs: string[] = [];
        f.log = message => logs.push(message);
        f.failOn = call => call.includes('OWNER TO');
        assert.strictEqual(await stageRestore(f, 'shop', 'shop__cp_1', ROOT), 'shop__restoring');
        assert.ok(f.dbs.has('shop__restoring'));
        assert.ok(logs.some(line => line.includes('owner')));
    });

    test('the undo renames are retried while the database is busy', async () => {
        const f = fake(['shop', 'shop__restoring'], ['shop', 'shop__restoring']);
        f.failOn = call => call === 'mv shop__restoring -> shop';
        f.busy.set('ALTER DATABASE "shop" RENAME TO "shop__restoring";', 1);
        f.busy.set('ALTER DATABASE "shop__replaced" RENAME TO "shop";', 1);
        await assert.rejects(swapInRestored(f, 'shop', 'shop__restoring', ROOT), /failed: mv/);
        assert.deepStrictEqual([...f.dbs].sort(), ['shop', 'shop__restoring']);
        assert.ok(f.calls.includes('free shop'));
        assert.ok(f.calls.includes('free shop__replaced'));
    });

    test('verifyCheckpoint accepts a template carrying the checkpoint comment, in one query', async () => {
        const f = fake(['shop__cp_1']);
        f.templates.set('shop__cp_1', checkpointComment('shop'));
        await verifyCheckpoint(f, 'shop__cp_1', 'shop', { mustExist: true });
        await verifyCheckpoint(f, 'shop__cp_1', 'shop', { mustExist: false });
        assert.strictEqual(f.calls.length, 2);
    });

    test('verifyCheckpoint refuses anything else, naming it', async () => {
        const refused = /"shop__cp_1" is not a checkpoint of "shop", so it was left alone\./;
        const plain = fake(['shop__cp_1']);
        await assert.rejects(verifyCheckpoint(plain, 'shop__cp_1', 'shop', { mustExist: false }), refused);

        const other = fake(['shop__cp_1']);
        other.templates.set('shop__cp_1', checkpointComment('crm'));
        await assert.rejects(verifyCheckpoint(other, 'shop__cp_1', 'shop', { mustExist: false }), refused);

        const uncommented = fake(['shop__cp_1']);
        uncommented.templates.set('shop__cp_1', '');
        await assert.rejects(verifyCheckpoint(uncommented, 'shop__cp_1', 'shop', { mustExist: true }), refused);
    });

    test('verifyCheckpoint: a missing database is nothing to delete, but cannot be restored', async () => {
        const f = fake([]);
        await verifyCheckpoint(f, 'shop__cp_1', 'shop', { mustExist: false });
        await assert.rejects(verifyCheckpoint(f, 'shop__cp_1', 'shop', { mustExist: true }), /"shop__cp_1" is not a checkpoint of "shop"/);
    });
});
