/**
 * What upgrade mode hides, and what it must leave alone.
 *
 * Two failure modes, and this pins both. Hiding too little lets an action
 * break the pair. Hiding too much is what happened when the pair's rows were
 * given their own `contextValue`: every menu entry is keyed to `database` or
 * `version`, so a third value emptied the entire right-click menu and took
 * read-only actions like "Open in Browser" with it.
 */
import * as assert from 'assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const GUARD = '!odoo-debugger.upgrade_enabled';

/** Actions that would leave the upgrade describing something nobody runs. */
const MUST_BE_HIDDEN = [
    'dbSelector.rename',
    'dbSelector.restore',
    'dbSelector.changeVersion',
    'dbSelector.configureRepoBranches',
    'dbSelector.delete',
    'odoo.changeBranch',
    'odoo.deleteVersion',
    'odoo.setAllSettingsToDefault',
    'odoo.setAllSettingsAsDefault',
    'odoo.setSettingToDefault',
    'odoo.setSettingAsDefault'
];

/** Read-only or additive actions that must survive the mode. */
const MUST_STAY = [
    'dbSelector.copyName',
    'dbSelector.clone',
    'dbSelector.openInBrowser',
    'dbSelector.openPsqlShell',
    'odoo.openVersionInBrowser',
    'odoo.cloneVersion'
];

interface MenuEntry { command: string; when?: string; group?: string }

function itemContextMenus(): MenuEntry[] {
    const manifest = JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')
    );
    return manifest.contributes.menus['view/item/context'] as MenuEntry[];
}

suite('What upgrade mode hides', () => {
    const menus = itemContextMenus();

    for (const command of MUST_BE_HIDDEN) {
        test(`${command} is hidden during an upgrade`, () => {
            const entries = menus.filter(entry => entry.command === command);
            assert.ok(entries.length > 0, `${command} has no menu entry at all`);
            for (const entry of entries) {
                assert.ok(
                    (entry.when ?? '').includes(GUARD),
                    `${command} would still be offered mid-upgrade: when=${entry.when}`
                );
            }
        });
    }

    for (const command of MUST_STAY) {
        test(`${command} still works during an upgrade`, () => {
            const entries = menus.filter(entry => entry.command === command);
            assert.ok(entries.length > 0, `${command} has no menu entry at all`);
            for (const entry of entries) {
                assert.ok(
                    !(entry.when ?? '').includes(GUARD),
                    `${command} was hidden, but it cannot break the pair: when=${entry.when}`
                );
            }
        });
    }

    test('the pair rows keep the contextValue their menus are keyed to', () => {
        // The regression this suite exists for: menus match `viewItem ==
        // database` and /^(version|activeVersion)$/, so renaming the value for
        // a pair member removes every entry rather than the risky ones.
        const dbMenus = menus.filter(entry => (entry.when ?? '').includes('view == dbSelector'));
        assert.ok(dbMenus.length > 0);
        for (const entry of dbMenus) {
            assert.ok(
                (entry.when ?? '').includes('viewItem == database'),
                `a database menu is keyed to something else: ${entry.when}`
            );
        }
    });

    test('a per-branch repository root gets the same file actions as a plain one', () => {
        // Upgrade repositories are always per-branch, and their roots matched
        // none of the root menus: no New File, Reveal or Copy Path on either copy.
        const rootMenus = menus.filter(entry =>
            (entry.when ?? '').includes('view == odt.projectReposExplorer')
            && /projectRepoRoot[|)]/.test(entry.when ?? ''));
        assert.ok(rootMenus.length > 0);
        for (const entry of rootMenus.filter(item => item.command !== 'odt.repo.toggleBranchMode')) {
            assert.ok(
                (entry.when ?? '').includes('projectRepoRootPerBranch'),
                `${entry.command} is offered on plain roots only: ${entry.when}`
            );
        }
    });

    test('"Use a Single Checkout" is no longer offered from a tree', () => {
        assert.deepStrictEqual(
            menus.filter(entry => entry.command === 'odt.repo.useSingleCheckout'),
            [],
            'the action is menu-driven again; it should stay palette-only'
        );
    });
});
