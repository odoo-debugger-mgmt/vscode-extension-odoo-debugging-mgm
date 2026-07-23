import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { readModuleManifest, extractTicketIdsFromBranch } from '../services/manifest';

async function writeModule(manifestContent: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'odoo-manifest-test-'));
    await fs.writeFile(path.join(dir, '__manifest__.py'), manifestContent, 'utf-8');
    return dir;
}

suite('Manifest parsing', () => {
    test('extracts depends list', async () => {
        const dir = await writeModule(`{
            'name': 'My Module',
            'depends': [
                'base',
                "sale",
                'account',  # comment
            ],
            'data': ['views/view.xml'],
        }`);
        const info = await readModuleManifest(dir);
        assert.deepStrictEqual(info?.depends, ['base', 'sale', 'account']);
    });

    test('extracts ticket ids from keys and description mentions', async () => {
        const dir = await writeModule(`{
            'name': 'PS Module',
            'task_id': 4123456,
            'description': """
                Solves task-id: 7654321 for the customer.
            """,
            'depends': ['base'],
        }`);
        const info = await readModuleManifest(dir);
        assert.ok(info);
        assert.ok(info.ticketIds.includes('4123456'));
        assert.ok(info.ticketIds.includes('7654321'));
    });

    test('returns undefined without a manifest', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'odoo-manifest-test-'));
        assert.strictEqual(await readModuleManifest(dir), undefined);
    });

    test('extracts ticket ids from PS branch names', () => {
        assert.deepStrictEqual(extractTicketIdsFromBranch('17.0-project-1234567-dev'), ['1234567']);
        assert.deepStrictEqual(extractTicketIdsFromBranch('saas-17.4'), []);
        assert.deepStrictEqual(extractTicketIdsFromBranch('16.0-fix-4455667-and-7788990'), ['4455667', '7788990']);
        assert.deepStrictEqual(extractTicketIdsFromBranch(null), []);
    });
});
