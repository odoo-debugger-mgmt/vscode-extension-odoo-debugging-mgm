/**
 * Moving data between stores: paths made absolute, and a merge that fills gaps
 * without overwriting, matching versions by branch.
 */
import * as assert from 'assert';
import * as path from 'node:path';
import type { DebuggerData } from '../utils';
import { absolutizePaths, buildExport, describeMerge, mergeData, readImportFile } from '../services/dataImport';

function target(): DebuggerData {
    return {
        projects: [{
            uid: 'p1', name: 'Acme',
            dbs: [{ id: 'acme-17', versionId: 'v17-here', modules: [{ name: 'sale', state: 'install' }] }],
            repos: [{ name: 'acme', path: '/work/v17/acme' }],
            tickets: [{ id: 'T-1' }],
            selectedDbByVersion: { 'v17-here': 'acme-17' }
        }] as never,
        versions: { 'v17-here': { id: 'v17-here', odooVersion: '17.0', settings: { portNumber: 8017 } } },
        dbTemplates: [{ name: 'base', templateDbName: 'tpl' }] as never
    };
}

function incoming(): DebuggerData {
    return {
        projects: [
            {
                uid: 'p1', name: 'Acme (theirs)',
                dbs: [
                    { id: 'acme-17', versionId: 'v17-there', modules: [] },
                    { id: 'acme-19', versionId: 'v19-there', modules: [] }
                ],
                repos: [{ name: 'acme', path: '/other/acme' }, { name: 'shared-lib', path: '/other/lib' }],
                tickets: [{ id: 'T-1' }, { id: 'T-2' }],
                selectedDbByVersion: { 'v17-there': 'acme-17', 'v19-there': 'acme-19' },
                upgradeConfig: { from: { versionId: 'v17-there', dbId: 'acme-17', series: '17.0' }, to: { versionId: 'v19-there', dbId: 'acme-19', series: '19.0' } }
            },
            { uid: 'p2', name: 'Other', dbs: [{ id: 'other-19', versionId: 'v19-there' }] }
        ] as never,
        versions: {
            'v17-there': { id: 'v17-there', odooVersion: '17.0' },
            'v19-there': { id: 'v19-there', odooVersion: '19.0' }
        },
        dbTemplates: [{ name: 'base', templateDbName: 'other' }, { name: 'crm', templateDbName: 'tpl_crm' }] as never
    };
}

suite('Data import', () => {
    test('merging never overwrites what is already there', () => {
        const { data } = mergeData(target(), incoming());
        const acme = data.projects.find(project => project.uid === 'p1') as any;

        assert.strictEqual(acme.name, 'Acme');
        assert.deepStrictEqual(acme.dbs.find((db: any) => db.id === 'acme-17').modules, [{ name: 'sale', state: 'install' }]);
        assert.strictEqual(acme.repos.find((repo: any) => repo.name === 'acme').path, '/work/v17/acme');
        assert.strictEqual((data.dbTemplates as any[]).find(template => template.name === 'base').templateDbName, 'tpl');
    });

    test('merging fills what is missing', () => {
        const { data, summary } = mergeData(target(), incoming());
        const acme = data.projects.find(project => project.uid === 'p1') as any;

        assert.deepStrictEqual(acme.dbs.map((db: any) => db.id), ['acme-17', 'acme-19']);
        assert.deepStrictEqual(acme.repos.map((repo: any) => repo.name), ['acme', 'shared-lib']);
        assert.deepStrictEqual(acme.tickets.map((ticket: any) => ticket.id), ['T-1', 'T-2']);
        assert.ok(data.projects.some(project => project.uid === 'p2'));
        assert.deepStrictEqual(summary, {
            projectsAdded: 1, projectsMerged: 1, databasesAdded: 2, versionsAdded: 1, versionsMatched: 1, templatesAdded: 1
        });
    });

    test('versions match by branch, and every reference follows', () => {
        const { data } = mergeData(target(), incoming());
        const acme = data.projects.find(project => project.uid === 'p1') as any;
        const other = data.projects.find(project => project.uid === 'p2') as any;
        const v19 = Object.values(data.versions ?? {}).find((version: any) => version.odooVersion === '19.0') as any;

        assert.strictEqual(Object.keys(data.versions ?? {}).length, 2, 'the 17.0 version is not duplicated');
        assert.strictEqual(acme.dbs.find((db: any) => db.id === 'acme-19').versionId, v19.id);
        assert.strictEqual(other.dbs[0].versionId, v19.id);
        // A per-window choice: the target's stays as it was, nothing is added.
        assert.deepStrictEqual(acme.selectedDbByVersion, { 'v17-here': 'acme-17' });
    });

    test('an upgrade in a new project points at this store\'s versions', () => {
        const source = incoming();
        (source.projects[1] as any).upgradeConfig = { from: { versionId: 'v17-there', dbId: 'x', series: '17.0' } };
        const { data } = mergeData(target(), source);

        assert.strictEqual((data.projects.find(project => project.uid === 'p2') as any).upgradeConfig.from.versionId, 'v17-here');
    });

    test('the merge does not touch its inputs', () => {
        const before = target();
        mergeData(before, incoming());

        assert.deepStrictEqual(before, target());
    });

    test('paths become absolute against the workspace the data came from', () => {
        const data = absolutizePaths({
            settings: { customAddonsPath: './custom-addons' },
            projects: [{
                repos: [{ name: 'acme', path: 'addons/acme' }],
                dbs: [{ id: 'd', sqlFilePath: 'dumps/d.sql', projectRepoBranches: [{ repoPath: 'addons/acme', branch: 'main' }] }]
            }],
            versions: { v: { settings: { odooPath: '/abs/odoo', pythonPath: './venv/bin/python', subModulesPaths: 'a, /b', enterprisePath: '' } } }
        } as never, '/work/v17');
        const version = (data.versions as any).v.settings;
        const project = data.projects[0] as any;

        assert.strictEqual((data.settings as any).customAddonsPath, path.resolve('/work/v17', 'custom-addons'));
        assert.strictEqual(version.odooPath, '/abs/odoo');
        assert.strictEqual(version.pythonPath, path.resolve('/work/v17', 'venv/bin/python'));
        assert.strictEqual(version.subModulesPaths, `${path.resolve('/work/v17', 'a')},/b`);
        assert.strictEqual(version.enterprisePath, '');
        assert.strictEqual(project.repos[0].path, path.resolve('/work/v17', 'addons/acme'));
        assert.strictEqual(project.dbs[0].sqlFilePath, path.resolve('/work/v17', 'dumps/d.sql'));
        assert.strictEqual(project.dbs[0].projectRepoBranches[0].repoPath, path.resolve('/work/v17', 'addons/acme'));
    });

    test('an import file is an export or a raw data file, and nothing else', () => {
        const data = target();

        assert.deepStrictEqual(readImportFile(buildExport(data, new Date(0))), data);
        assert.deepStrictEqual(readImportFile(data), data);
        assert.strictEqual(readImportFile([]), undefined);
        assert.strictEqual(readImportFile({ unrelated: true }), undefined);
    });

    test('the summary lists what is added; what was already there is a note, not a change', () => {
        assert.deepStrictEqual(
            describeMerge({ projectsAdded: 1, projectsMerged: 0, databasesAdded: 2, versionsAdded: 0, versionsMatched: 1, templatesAdded: 0 }),
            { adds: ['1 new project', '2 databases added'], notes: ['1 version is already there, matched by branch'] }
        );
    });

    test('re-importing what is already there adds nothing, and says so', () => {
        const { data } = mergeData(target(), incoming());
        const { summary } = mergeData(data, incoming());

        assert.deepStrictEqual(describeMerge(summary).adds, []);
        assert.strictEqual(summary.projectsMerged, 0);
    });

    test('a cloned version keeps its own match instead of collapsing onto the first of its branch', () => {
        const here = target();
        here.versions!['v17-clone'] = { id: 'v17-clone', name: 'Odoo 17.0 (Copy)', odooVersion: '17.0' };
        (here.versions!['v17-here'] as any).name = 'Odoo 17.0';
        const there: DebuggerData = {
            projects: [{ uid: 'p9', name: 'New', dbs: [{ id: 'a', versionId: 'x1' }, { id: 'b', versionId: 'x2' }] }] as never,
            versions: {
                x1: { id: 'x1', name: 'Odoo 17.0 (Copy)', odooVersion: '17.0' },
                x2: { id: 'x2', name: 'Odoo 17.0', odooVersion: '17.0' }
            }
        };
        const { data, summary } = mergeData(here, there);
        const dbs = (data.projects.find(project => project.uid === 'p9') as any).dbs;

        assert.strictEqual(dbs.find((db: any) => db.id === 'a').versionId, 'v17-clone');
        assert.strictEqual(dbs.find((db: any) => db.id === 'b').versionId, 'v17-here');
        assert.strictEqual(summary.versionsAdded, 0);
    });

    test('the same id on the same branch is the same version, whatever its name', () => {
        const there: DebuggerData = {
            projects: [{ uid: 'p9', name: 'New', dbs: [{ id: 'a', versionId: 'v17-here' }] }] as never,
            versions: { 'v17-here': { id: 'v17-here', name: 'Renamed elsewhere', odooVersion: '17.0' } }
        };
        const { data } = mergeData(target(), there);

        assert.strictEqual((data.projects.find(project => project.uid === 'p9') as any).dbs[0].versionId, 'v17-here');
    });

});
