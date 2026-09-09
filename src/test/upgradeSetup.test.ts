/**
 * The deduction that lets upgrade setup ask two questions instead of ten.
 */
import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    collectAvailableModules,
    coreAddonsPaths,
    proposeBranchForSeries,
    splitStagedModules
} from '../services/upgradeSetup';

suite('Branch proposal from a series', () => {
    const branches = ['main', 'master', '17.0-bunka', '19.0-bunka', 'dev/upgrade-client'];

    test('one branch on the series answers the question', () => {
        assert.deepStrictEqual(proposeBranchForSeries(branches, '17.0'), {
            branch: '17.0-bunka',
            candidates: ['17.0-bunka']
        });
    });

    test('several branches on the series is a question, not a guess', () => {
        // "17.0" and "17.0-acme" are both honestly on 17.0; only the developer
        // knows which one this upgrade runs.
        const proposal = proposeBranchForSeries(['17.0', '17.0-acme', '19.0-acme'], '17.0');
        assert.strictEqual(proposal.branch, undefined);
        assert.deepStrictEqual(proposal.candidates, ['17.0', '17.0-acme']);
    });

    test('no branch on the series proposes nothing', () => {
        assert.deepStrictEqual(proposeBranchForSeries(branches, '18.0'), { branch: undefined, candidates: [] });
    });

    test('saas series are matched on their own terms', () => {
        assert.strictEqual(proposeBranchForSeries(['saas-18.4-acme', '18.0-acme'], 'saas-18.4').branch, 'saas-18.4-acme');
    });

    test('branches that state no series are never proposed', () => {
        assert.deepStrictEqual(proposeBranchForSeries(['dev/upgrade-client', 'wip'], '17.0').candidates, []);
    });

    test('an empty series proposes nothing rather than matching everything', () => {
        assert.deepStrictEqual(proposeBranchForSeries(branches, '  '), { candidates: [] });
    });
});

suite('Staging the source module set onto the target', () => {
    test('base is never staged', () => {
        // Odoo installs it regardless; naming it in -i says nothing.
        assert.deepStrictEqual(splitStagedModules(['base', 'sale', 'crm']).staged, ['crm', 'sale']);
    });

    test('modules missing from the target version are held back', () => {
        // -i fails on the first unknown module and takes the launch with it.
        const staging = splitStagedModules(
            ['sale', 'crm', 'l10n_be_old', 'website'],
            new Set(['sale', 'crm', 'website'])
        );
        assert.deepStrictEqual(staging.staged, ['crm', 'sale', 'website']);
        assert.deepStrictEqual(staging.unavailable, ['l10n_be_old']);
    });

    test('an unbuilt target stages everything and checks later', () => {
        const staging = splitStagedModules(['sale', 'crm'], undefined);
        assert.deepStrictEqual(staging.staged, ['crm', 'sale']);
        assert.deepStrictEqual(staging.unavailable, []);
    });

    test('duplicates and blanks are dropped, and the order is stable', () => {
        assert.deepStrictEqual(
            splitStagedModules(['sale', 'sale', '  ', 'account', '']).staged,
            ['account', 'sale']
        );
    });

    test('a source with nothing installed stages nothing', () => {
        assert.deepStrictEqual(splitStagedModules([]), { staged: [], unavailable: [] });
    });
});

suite('Reading a version\'s available modules', () => {
    let root: string;

    setup(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'odt-addons-'));
    });

    teardown(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    function addModule(dir: string, name: string): void {
        fs.mkdirSync(path.join(dir, name), { recursive: true });
        fs.writeFileSync(path.join(dir, name, '__manifest__.py'), "{'name': 'x'}\n");
    }

    test('collects manifest directories across every addons path', () => {
        const core = path.join(root, 'odoo', 'addons');
        const enterprise = path.join(root, 'enterprise');
        addModule(core, 'sale');
        addModule(core, 'crm');
        addModule(enterprise, 'account_accountant');
        // A directory with no manifest is not a module.
        fs.mkdirSync(path.join(core, 'not_a_module'), { recursive: true });

        const found = collectAvailableModules([core, enterprise]);
        assert.deepStrictEqual([...(found ?? [])].sort(), ['account_accountant', 'crm', 'sale']);
    });

    test('an unbuilt version reads as undefined, not as an empty set', () => {
        // "not provisioned yet" and "provisioned with no modules" must not look
        // the same: the first defers the check, the second would hold back
        // every module the source had.
        assert.strictEqual(collectAvailableModules([path.join(root, 'nothing-here')]), undefined);
    });

    test('an existing but empty addons directory reads as an empty set', () => {
        const core = path.join(root, 'addons');
        fs.mkdirSync(core, { recursive: true });
        assert.deepStrictEqual(collectAvailableModules([core]), new Set());
    });
});

suite('Core addons paths of a version', () => {
    test('names enterprise, design themes and both core directories', () => {
        assert.deepStrictEqual(
            coreAddonsPaths({
                odooPath: '/dev/odoo-19.0',
                enterprisePath: '/dev/enterprise-19.0',
                designThemesPath: '/dev/design-themes-19.0'
            }),
            [
                '/dev/enterprise-19.0',
                '/dev/design-themes-19.0',
                path.join('/dev/odoo-19.0', 'odoo', 'addons'),
                path.join('/dev/odoo-19.0', 'addons')
            ]
        );
    });

    test('omits what a version does not configure', () => {
        assert.deepStrictEqual(coreAddonsPaths({ odooPath: '  ', enterprisePath: '' }), []);
    });
});
