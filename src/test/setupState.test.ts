import * as assert from 'assert';
import * as path from 'node:path';
import {
    evaluateSetup,
    isOdooSourceRepo,
    defaultProvisioningRoot,
    shouldAdoptLegacySourceRepo
} from '../services/setupState';
import { classifyByName, pickBest, searchRoots, RepoCandidate } from '../services/setupDetection';

const HOME = '/home/dev';

/** Only these paths exist on the imaginary filesystem under test. */
function probe(...present: string[]) {
    const set = new Set(present);
    return (candidate: string) => set.has(candidate);
}

suite('Setup state', () => {
    test('a source repo is a directory holding odoo-bin', () => {
        const exists = probe('/src/odoo/odoo-bin');
        assert.strictEqual(isOdooSourceRepo('/src/odoo', exists), true);
        // Configured but moved or deleted: not set up.
        assert.strictEqual(isOdooSourceRepo('/src/gone', exists), false);
        assert.strictEqual(isOdooSourceRepo('   ', exists), false);
        assert.strictEqual(isOdooSourceRepo(undefined, exists), false);
    });

    test('defaults the provisioning root beside the home directory', () => {
        assert.strictEqual(defaultProvisioningRoot(HOME), path.join(HOME, 'odoo-dev'));
    });

    test('reports a fully configured machine', () => {
        const state = evaluateSetup(
            {
                sourceRepo: '/src/odoo',
                enterpriseRepo: '/src/enterprise',
                provisioningRoot: '/work/envs'
            },
            probe('/src/odoo/odoo-bin', '/src/enterprise'),
            HOME
        );
        assert.deepStrictEqual(state, {
            sourceRepo: '/src/odoo',
            enterpriseRepo: '/src/enterprise',
            designThemesRepo: undefined,
            provisioningRoot: '/work/envs',
            isConfigured: true
        });
    });

    test('falls back to the default provisioning root when unset', () => {
        const state = evaluateSetup({ sourceRepo: '/src/odoo' }, probe('/src/odoo/odoo-bin'), HOME);
        assert.strictEqual(state.provisioningRoot, path.join(HOME, 'odoo-dev'));
        assert.strictEqual(state.isConfigured, true);
    });

    test('an empty or vanished source repo means not configured', () => {
        assert.strictEqual(evaluateSetup({}, probe(), HOME).isConfigured, false);
        assert.strictEqual(
            evaluateSetup({ sourceRepo: '/src/gone' }, probe(), HOME).isConfigured,
            false
        );
        // The stale value is not reported back as if it were usable.
        assert.strictEqual(evaluateSetup({ sourceRepo: '/src/gone' }, probe(), HOME).sourceRepo, undefined);
    });

    test('drops optional repos whose directory is missing', () => {
        const state = evaluateSetup(
            { sourceRepo: '/src/odoo', enterpriseRepo: '/src/gone' },
            probe('/src/odoo/odoo-bin'),
            HOME
        );
        assert.strictEqual(state.enterpriseRepo, undefined);
        assert.strictEqual(state.isConfigured, true);
    });

    test('adopts a legacy odooPath that points at a real checkout', () => {
        const exists = probe('/legacy/odoo/odoo-bin');
        assert.strictEqual(shouldAdoptLegacySourceRepo({}, '/legacy/odoo', exists), '/legacy/odoo');
        // Already configured: never overwrite an explicit choice.
        assert.strictEqual(
            shouldAdoptLegacySourceRepo({ sourceRepo: '/src/odoo' }, '/legacy/odoo', exists),
            undefined
        );
        // Legacy default that never pointed anywhere real.
        assert.strictEqual(shouldAdoptLegacySourceRepo({}, '/nowhere', exists), undefined);
        assert.strictEqual(shouldAdoptLegacySourceRepo({}, undefined, exists), undefined);
    });
});

suite('Setup detection', () => {
    test('classifies the optional repos by directory name', () => {
        assert.strictEqual(classifyByName('enterprise'), 'enterprise');
        assert.strictEqual(classifyByName('odoo-enterprise'), 'enterprise');
        assert.strictEqual(classifyByName('design-themes'), 'design-themes');
        assert.strictEqual(classifyByName('Design-Themes'), 'design-themes');
        // "odoo" is identified by odoo-bin, never by name: a fork is usually
        // named after the client.
        assert.strictEqual(classifyByName('odoo'), undefined);
        assert.strictEqual(classifyByName('something-else'), undefined);
    });

    test('searches configured paths and their parents before anything else', () => {
        const roots = searchRoots(['/src/odoo', undefined], ['/ws'], HOME);
        assert.strictEqual(roots[0], '/src/odoo');
        assert.strictEqual(roots[1], '/src');
        assert.strictEqual(roots[2], '/ws');
        assert.ok(roots.includes(path.join(HOME, 'src')));
        assert.ok(roots.includes(HOME));
    });

    test('deduplicates search roots', () => {
        const roots = searchRoots(['/ws'], ['/ws'], HOME);
        assert.strictEqual(roots.filter(root => root === '/ws').length, 1);
    });

    test('picks the best candidate per kind by rank', () => {
        const candidates: RepoCandidate[] = [
            { path: '/home/dev/odoo', kind: 'odoo', rank: 300 },
            { path: '/src/odoo', kind: 'odoo', rank: 1 },
            { path: '/src/enterprise', kind: 'enterprise', rank: 2 }
        ];
        const best = pickBest(candidates);
        assert.strictEqual(best.odoo?.path, '/src/odoo');
        assert.strictEqual(best.enterprise?.path, '/src/enterprise');
        assert.strictEqual(best['design-themes'], undefined);
    });

    test('returns nothing when there are no candidates', () => {
        assert.deepStrictEqual(pickBest([]), {});
    });
});
