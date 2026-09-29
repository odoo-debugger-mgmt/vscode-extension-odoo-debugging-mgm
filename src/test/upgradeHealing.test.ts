/**
 * A side of the pair whose version is still being built.
 *
 * Setup queues a version that does not exist yet and finishes; the version
 * arrives minutes later. Nothing else fills the id in, and without it the side
 * has no port, no launch entry, and `Start Both Servers` would fall through to
 * the active version - starting the wrong server twice.
 */
import * as assert from 'assert';
import { UpgradeConfigModel } from '../models/upgrade';
import { healUpgradePairVersions, healUpgradeSelection } from '../upgrade';
import { VersionsService } from '../versionsService';
import type { ProjectModel } from '../models/project';

function projectWith(config: UpgradeConfigModel): ProjectModel {
    return {
        name: 'acme',
        dbs: [{ id: 'crm-17' }, { id: 'crm-19' }],
        selectedDbByVersion: {},
        upgradeConfig: config
    } as unknown as ProjectModel;
}

/** Replaces the version list for one call. */
function withVersions<T>(versions: Array<{ id: string; odooVersion: string }>, body: () => T): T {
    const service = VersionsService.getInstance() as unknown as { getVersions: () => unknown };
    const real = service.getVersions;
    service.getVersions = () => versions;
    try {
        return body();
    } finally {
        service.getVersions = real;
    }
}

const pending = () => new UpgradeConfigModel(
    true,
    { versionId: 'v17', dbId: 'crm-17', series: '17.0' },
    { dbId: 'crm-19', series: '19.0' },
    []
);

suite('Healing an upgrade pair once its version is built', () => {
    test('the missing side is linked to the version that now matches its series', () => {
        const proj = projectWith(pending());

        const changed = withVersions(
            [{ id: 'v17', odooVersion: '17.0' }, { id: 'v19', odooVersion: '19.0' }],
            () => healUpgradePairVersions(proj));

        assert.strictEqual(changed, true);
        assert.strictEqual(proj.upgradeConfig.to?.versionId, 'v19');
    });

    test('the healed side also remembers its own database', () => {
        // Otherwise its server resolves whichever database is merely selected.
        const proj = projectWith(pending());

        withVersions([{ id: 'v19', odooVersion: '19.0' }], () => healUpgradePairVersions(proj));

        assert.strictEqual(proj.selectedDbByVersion['v19'], 'crm-19');
    });

    test('nothing changes while the version is still missing', () => {
        const proj = projectWith(pending());

        const changed = withVersions([{ id: 'v17', odooVersion: '17.0' }], () => healUpgradePairVersions(proj));

        assert.strictEqual(changed, false);
        assert.strictEqual(proj.upgradeConfig.to?.versionId, undefined);
    });

    test('an already-linked pair is left alone', () => {
        const proj = projectWith(new UpgradeConfigModel(
            true,
            { versionId: 'v17', dbId: 'crm-17', series: '17.0' },
            { versionId: 'v19', dbId: 'crm-19', series: '19.0' },
            []
        ));

        const changed = withVersions(
            [{ id: 'other', odooVersion: '19.0' }],
            () => healUpgradePairVersions(proj));

        assert.strictEqual(changed, false, 'a linked side was re-pointed at another version');
        assert.strictEqual(proj.upgradeConfig.to?.versionId, 'v19');
    });

    test('an upgrade that is off is never healed', () => {
        const proj = projectWith(new UpgradeConfigModel(false));

        assert.strictEqual(
            withVersions([{ id: 'v19', odooVersion: '19.0' }], () => healUpgradePairVersions(proj)),
            false
        );
    });
});

suite('Keeping the selection on the upgrade pair', () => {
    const linked = (active = true) => new UpgradeConfigModel(
        active,
        { versionId: 'v17', dbId: 'crm-17', series: '17.0' },
        { versionId: 'v19', dbId: 'crm-19', series: '19.0' },
        []
    );

    function withDbs(config: UpgradeConfigModel, selected?: string, ids = ['crm-17', 'crm-19', 'scratch']): ProjectModel {
        return {
            name: 'acme',
            dbs: ids.map(id => ({ id, isSelected: id === selected })),
            upgradeConfig: config
        } as unknown as ProjectModel;
    }

    const selectedIds = (proj: ProjectModel) => proj.dbs.filter(db => db.isSelected).map(db => db.id);

    test('a database outside the pair gives the selection to the side upgraded from', () => {
        // It kept its selected icon next to the two pair members, and could
        // not be moved off because selecting outside the pair is refused.
        const proj = withDbs(linked(), 'scratch');

        assert.strictEqual(healUpgradeSelection(proj), true);
        assert.deepStrictEqual(selectedIds(proj), ['crm-17']);
    });

    test('the side it lands on is also what that version remembers', () => {
        // The memory left behind made the window launch the database it had
        // before the upgrade once the upgrade was switched off again.
        const proj = withDbs(linked(), 'scratch');
        (proj as any).selectedDbByVersion = { v17: 'scratch', v19: 'crm-19' };

        healUpgradeSelection(proj);

        assert.deepStrictEqual(proj.selectedDbByVersion, { v17: 'crm-17', v19: 'crm-19' });
    });

    test('nothing selected at all also lands on the side upgraded from', () => {
        const proj = withDbs(linked());

        assert.strictEqual(healUpgradeSelection(proj), true);
        assert.deepStrictEqual(selectedIds(proj), ['crm-17']);
    });

    test('either side already selected is left alone', () => {
        // Selecting a side is how you choose whose modules you are editing.
        const proj = withDbs(linked(), 'crm-19');

        assert.strictEqual(healUpgradeSelection(proj), false);
        assert.deepStrictEqual(selectedIds(proj), ['crm-19']);
    });

    test('a side whose database is gone falls back to the other side', () => {
        const proj = withDbs(linked(), 'scratch', ['crm-19', 'scratch']);

        assert.strictEqual(healUpgradeSelection(proj), true);
        assert.deepStrictEqual(selectedIds(proj), ['crm-19']);
    });

    test('with the mode off, any database may stay selected', () => {
        const proj = withDbs(linked(false), 'scratch');

        assert.strictEqual(healUpgradeSelection(proj), false);
        assert.deepStrictEqual(selectedIds(proj), ['scratch']);
    });
});
