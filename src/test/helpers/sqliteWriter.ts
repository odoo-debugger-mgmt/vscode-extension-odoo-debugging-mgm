/**
 * A second "window" for the SQLite store's integration test: a separate
 * process that repeatedly reads the store, changes its own database's counter
 * and commits against what it read. Run with `fork`, never as a test itself.
 *
 * argv: <store file> <database id> <iterations>
 */
import Module = require('node:module');

// The store logs through the extension's logger, which imports vscode. A
// forked process has no vscode module, so a minimal stand-in is provided.
const moduleWithLoad = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
const originalLoad = moduleWithLoad._load;
moduleWithLoad._load = function (request: string, ...rest: unknown[]) {
    if (request === 'vscode') {
        const stub: unknown = new Proxy(function () { /* stand-in */ }, {
            get: () => stub,
            apply: () => stub,
            construct: () => ({})
        });
        return stub;
    }
    return originalLoad.call(this, request, ...rest);
};

async function main(): Promise<void> {
    const [file, dbId, iterationsArg] = process.argv.slice(2);
    // Required only after the stand-in above is in place.
    const { SqliteMainStore, loadSqlite } = require('../../services/sqliteMainStore') as typeof import('../../services/sqliteMainStore');
    const sqlite = loadSqlite();
    if (!sqlite) {
        throw new Error('node:sqlite is not available');
    }
    const store = new SqliteMainStore(file, '/', sqlite);
    const seenVersions = new Set<number>();
    let merges = 0;

    for (let i = 0; i < Number(iterationsArg); i += 1) {
        const base = await store.read();
        seenVersions.add(base.mtimeMs);
        const next = structuredClone(base.data);
        const db = (next.projects[0] as any).dbs.find((entry: any) => entry.id === dbId);
        db.counter = (db.counter ?? 0) + 1;
        const result = await store.commit(base, next);
        merges += result.merged.length;
        await new Promise(resolve => setTimeout(resolve, Math.random() * 5));
    }

    store.dispose();
    process.send?.({ seenVersions: seenVersions.size, merges });
}

main().catch(error => {
    process.send?.({ error: String(error) });
    process.exitCode = 1;
});
