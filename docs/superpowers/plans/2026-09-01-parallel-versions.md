# Parallel Version Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let two or more provisioned versions run at the same time — each with its own debugger name, ports, database and launch entry — and show in the Databases view which databases are currently live.

**Architecture:** Version identity (`debuggerName`, `portNumber`, `shellPortNumber`) stops being three editable settings inherited from one global default and becomes derived read-only state computed from the version's branch. Debug-session tracking widens from "the one active session" to a `Map<debuggerName, DebugSession>`. Database resolution widens from one selection per project to one per version, which lets `setupDebugger` write one launch entry per provisioned version instead of overwriting a single shared one. A new `runningState` service merges the session map with a PostgreSQL probe so the Databases view can mark live databases.

**Tech Stack:** TypeScript, VS Code extension API (`vscode.debug`, TreeDataProvider, `ConfigurationTarget`), Mocha `suite`/`test` with node `assert` under `@vscode/test-cli`, `jsonc-parser` for surgical launch.json edits, `psql` via `execFile`.

**Spec:** `docs/superpowers/specs/2026-08-27-native-version-provisioning-design.md` — sections 11, 12 and 13. Sections 1–10 were implemented by `docs/superpowers/plans/2026-08-27-version-provisioning.md` and are already on the branch.

## Global Constraints

These hold for every task. They are the invariants the existing codebase already maintains.

- **Never spawn a shell.** All process execution goes through `runCommand`/`tryRunCommand` in `src/services/process.ts` or `execFile` with an argument array. No `exec`, no string interpolation into a command line.
- **All user-facing messages go through `src/services/notifications.ts`** (`showInfo`, `showWarning`, `showError`) and all logging through `src/services/logger.ts` (`logger.debug/info/warn/error`, `errorMessage`). Never call `vscode.window.showInformationMessage` directly.
- **launch.json is edited surgically** through `updateManagedLaunchConfig` (`src/services/launchConfig.ts`), which uses `jsonc-parser` so user comments and unmanaged configurations survive.
- **Pure logic is separated from I/O and tested.** Ranking, parsing, merging and resolution functions take plain data and return plain data; the `vscode` and filesystem calls live in thin wrappers. This is the pattern established by `src/services/pythonToolchain.ts` (pure `rankInterpreters`, impure `discoverInterpreters`).
- **Derived identity values:** `debuggerName` = `${prefix}:${branch}`, `portNumber` = `8000 + major`, `shellPortNumber` = `5000 + major`, where `major` is the leading major number of the branch series. Non-numeric branches (`master`) use base `8000`/`5000`. Collisions step upward to the next free value.
- **The identity setting keys are exactly** `debuggerName`, `portNumber`, `shellPortNumber`. `debuggerVersion` is NOT one of them — it stays a normal editable setting.
- **State reads by shape, not colour** in tree views (see the comment block at the top of `src/views/icons.ts`): when a row is highlighted VS Code repaints the icon with the selection foreground and any tint is lost.
- **Verification gate for every task:** `npm run compile-tests` (check the output for `error TS` — a stale `out/` will otherwise let tests appear to pass against old code), `npm run lint`, `npm run compile`, `npm test`. All four must be clean before committing. The suite is at 91 passing at the start of this plan.
- **Commit message style:** `[ADD]`, `[FIX]`, `[IMP]`, `[REF]`, `[DOC]` prefix followed by an imperative sentence, matching `git log`.

---

### Task 1: Version identity derivation

Pure module computing a version's debugger name and ports from its branch. No `vscode` import, no I/O, so it is fully unit-testable. Everything else in §11 builds on this.

**Files:**
- Create: `src/services/versionIdentity.ts`
- Test: `src/test/versionIdentity.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces:
  - `interface VersionIdentity { debuggerName: string; portNumber: number; shellPortNumber: number; }`
  - `interface IdentityTaken { names: Set<string>; ports: Set<number>; }`
  - `interface IdentityCandidate { id: string; odooVersion: string; createdAt: Date | string; settings: { debuggerName?: string; portNumber?: number; shellPortNumber?: number } }`
  - `const DERIVED_SETTING_KEYS: readonly ['debuggerName', 'portNumber', 'shellPortNumber']`
  - `const SERVER_PORT_BASE = 8000`, `const SHELL_PORT_BASE = 5000`
  - `function isDerivedSetting(key: string): boolean`
  - `function parseSeriesMajor(branch: string): number | undefined`
  - `function deriveIdentity(branch: string, prefix: string, taken: IdentityTaken): VersionIdentity`
  - `function collectTaken(candidates: IdentityCandidate[], exceptId?: string): IdentityTaken`
  - `function healIdentities(candidates: IdentityCandidate[], prefix: string): Array<{ id: string; identity: VersionIdentity }>`
  - `function candidatePortsFor(branch: string, window?: number): number[]`
  - `async function probeBusyPorts(ports: number[]): Promise<Set<number>>`

- [ ] **Step 1: Write the failing tests**

Create `src/test/versionIdentity.test.ts`:

```ts
import * as assert from 'assert';
import {
    parseSeriesMajor,
    deriveIdentity,
    collectTaken,
    healIdentities,
    isDerivedSetting,
    candidatePortsFor,
    IdentityCandidate
} from '../services/versionIdentity';

const EMPTY = { names: new Set<string>(), ports: new Set<number>() };

function candidate(
    id: string,
    odooVersion: string,
    createdAt: string,
    settings: Partial<{ debuggerName: string; portNumber: number; shellPortNumber: number }> = {}
): IdentityCandidate {
    return { id, odooVersion, createdAt, settings };
}

suite('Version identity', () => {
    test('parses the major series number from a branch name', () => {
        assert.strictEqual(parseSeriesMajor('17.0'), 17);
        assert.strictEqual(parseSeriesMajor('19.0'), 19);
        assert.strictEqual(parseSeriesMajor('saas-17.4'), 17);
        assert.strictEqual(parseSeriesMajor('saas~17.4'), 17);
        // Dev branches keep their series prefix, so they share the series port.
        assert.strictEqual(parseSeriesMajor('17.0-my-fix-abc'), 17);
        assert.strictEqual(parseSeriesMajor('master'), undefined);
        assert.strictEqual(parseSeriesMajor(''), undefined);
    });

    test('derives name and ports from the branch', () => {
        assert.deepStrictEqual(deriveIdentity('17.0', 'odoo', EMPTY), {
            debuggerName: 'odoo:17.0',
            portNumber: 8017,
            shellPortNumber: 5017
        });
        assert.deepStrictEqual(deriveIdentity('saas-17.4', 'odoo', EMPTY), {
            debuggerName: 'odoo:saas-17.4',
            portNumber: 8017,
            shellPortNumber: 5017
        });
    });

    test('falls back to the base ports for a non-numeric branch', () => {
        assert.deepStrictEqual(deriveIdentity('master', 'odoo', EMPTY), {
            debuggerName: 'odoo:master',
            portNumber: 8000,
            shellPortNumber: 5000
        });
    });

    test('steps past taken ports and names', () => {
        const taken = {
            names: new Set(['odoo:17.0']),
            ports: new Set([8017, 5017, 8018])
        };
        assert.deepStrictEqual(deriveIdentity('17.0', 'odoo', taken), {
            debuggerName: 'odoo:17.0 (2)',
            portNumber: 8019,
            shellPortNumber: 5018
        });
    });

    test('collects taken values, optionally excluding one version', () => {
        const candidates = [
            candidate('a', '17.0', '2026-01-01', { debuggerName: 'odoo:17.0', portNumber: 8017, shellPortNumber: 5017 }),
            candidate('b', '18.0', '2026-01-02', { debuggerName: 'odoo:18.0', portNumber: 8018, shellPortNumber: 5018 })
        ];

        const all = collectTaken(candidates);
        assert.deepStrictEqual([...all.names].sort(), ['odoo:17.0', 'odoo:18.0']);
        assert.deepStrictEqual([...all.ports].sort(), [5017, 5018, 8017, 8018]);

        const withoutA = collectTaken(candidates, 'a');
        assert.deepStrictEqual([...withoutA.names], ['odoo:18.0']);
    });

    test('heals only the newer side of a collision and leaves the rest alone', () => {
        // Both inherited the same global default; the older one keeps it.
        const candidates = [
            candidate('old', '17.0', '2026-01-01', { debuggerName: 'odoo:19.0', portNumber: 8019, shellPortNumber: 5019 }),
            candidate('new', '18.0', '2026-02-01', { debuggerName: 'odoo:19.0', portNumber: 8019, shellPortNumber: 5019 }),
            candidate('fine', 'master', '2026-03-01', { debuggerName: 'odoo:master', portNumber: 8000, shellPortNumber: 5000 })
        ];

        const patches = healIdentities(candidates, 'odoo');
        assert.strictEqual(patches.length, 1);
        assert.strictEqual(patches[0].id, 'new');
        assert.deepStrictEqual(patches[0].identity, {
            debuggerName: 'odoo:18.0',
            portNumber: 8018,
            shellPortNumber: 5018
        });
    });

    test('heals a version that carries no identity at all', () => {
        const patches = healIdentities([candidate('bare', '17.0', '2026-01-01')], 'odoo');
        assert.deepStrictEqual(patches, [
            { id: 'bare', identity: { debuggerName: 'odoo:17.0', portNumber: 8017, shellPortNumber: 5017 } }
        ]);
    });

    test('lists the candidate ports a new version might claim', () => {
        // The window a live-socket probe has to check before deriving.
        assert.deepStrictEqual(candidatePortsFor('17.0', 3), [8017, 8018, 8019, 5017, 5018, 5019]);
        assert.deepStrictEqual(candidatePortsFor('master', 2), [8000, 8001, 5000, 5001]);
    });

    test('identifies the derived setting keys', () => {
        assert.strictEqual(isDerivedSetting('debuggerName'), true);
        assert.strictEqual(isDerivedSetting('portNumber'), true);
        assert.strictEqual(isDerivedSetting('shellPortNumber'), true);
        // debuggerVersion stays user-editable.
        assert.strictEqual(isDerivedSetting('debuggerVersion'), false);
        assert.strictEqual(isDerivedSetting('odooPath'), false);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run compile-tests`
Expected: FAIL with `error TS2307: Cannot find module '../services/versionIdentity'`.

- [ ] **Step 3: Write the implementation**

Create `src/services/versionIdentity.ts`:

```ts
/**
 * Derives a version's debugger identity - launch configuration name, HTTP
 * port and shell port - from its branch, so two versions can run at once
 * without overwriting each other's launch.json entry.
 *
 * The derivation rules are pure and unit-tested; only the live-socket probe
 * at the bottom does I/O, mirroring how pythonToolchain.ts keeps
 * `rankInterpreters` pure and `discoverInterpreters` impure.
 */
import * as net from 'node:net';

export interface VersionIdentity {
    debuggerName: string;
    portNumber: number;
    shellPortNumber: number;
}

/** Names and ports already spoken for by other versions (or live sockets). */
export interface IdentityTaken {
    names: Set<string>;
    ports: Set<number>;
}

/** The shape of a stored version this module needs; VersionModel satisfies it. */
export interface IdentityCandidate {
    id: string;
    odooVersion: string;
    createdAt: Date | string;
    settings: {
        debuggerName?: string;
        portNumber?: number;
        shellPortNumber?: number;
    };
}

/** Settings computed from the branch: visible in the tree, never editable. */
export const DERIVED_SETTING_KEYS = ['debuggerName', 'portNumber', 'shellPortNumber'] as const;

export const SERVER_PORT_BASE = 8000;
export const SHELL_PORT_BASE = 5000;

/** Branch names carry the series first: `17.0`, `saas-17.4`, `17.0-fix-abc`. */
const SERIES_PATTERN = /^(?:saas[~-])?(\d+)\.\d+/;

export function isDerivedSetting(key: string): boolean {
    return (DERIVED_SETTING_KEYS as readonly string[]).includes(key);
}

export function parseSeriesMajor(branch: string): number | undefined {
    const match = SERIES_PATTERN.exec(branch.trim());
    return match ? Number(match[1]) : undefined;
}

function nextFreePort(base: number, taken: Set<number>): number {
    let port = base;
    while (taken.has(port)) {
        port += 1;
    }
    return port;
}

function nextFreeName(base: string, taken: Set<string>): string {
    if (!taken.has(base)) {
        return base;
    }
    let suffix = 2;
    while (taken.has(`${base} (${suffix})`)) {
        suffix += 1;
    }
    return `${base} (${suffix})`;
}

/**
 * The identity for `branch`, avoiding everything in `taken`. A branch with no
 * numeric series (`master`) starts from the bases and walks up from there.
 */
export function deriveIdentity(branch: string, prefix: string, taken: IdentityTaken): VersionIdentity {
    const major = parseSeriesMajor(branch);
    const serverBase = major === undefined ? SERVER_PORT_BASE : SERVER_PORT_BASE + major;
    const shellBase = major === undefined ? SHELL_PORT_BASE : SHELL_PORT_BASE + major;

    return {
        debuggerName: nextFreeName(`${prefix}:${branch}`, taken.names),
        portNumber: nextFreePort(serverBase, taken.ports),
        shellPortNumber: nextFreePort(shellBase, taken.ports)
    };
}

export function collectTaken(candidates: IdentityCandidate[], exceptId?: string): IdentityTaken {
    const names = new Set<string>();
    const ports = new Set<number>();

    for (const candidate of candidates) {
        if (candidate.id === exceptId) {
            continue;
        }
        const { debuggerName, portNumber, shellPortNumber } = candidate.settings ?? {};
        if (debuggerName) {
            names.add(debuggerName);
        }
        if (typeof portNumber === 'number') {
            ports.add(portNumber);
        }
        if (typeof shellPortNumber === 'number') {
            ports.add(shellPortNumber);
        }
    }

    return { names, ports };
}

function timestamp(value: Date | string): number {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

/**
 * Existing versions are healed, not rewritten: a stored identity is kept
 * unless it collides with an older version's, or is missing entirely. Returns
 * a patch per version that needs changing, in creation order.
 */
export function healIdentities(
    candidates: IdentityCandidate[],
    prefix: string
): Array<{ id: string; identity: VersionIdentity }> {
    const ordered = [...candidates].sort((a, b) => timestamp(a.createdAt) - timestamp(b.createdAt));

    const taken: IdentityTaken = { names: new Set(), ports: new Set() };
    const patches: Array<{ id: string; identity: VersionIdentity }> = [];

    for (const candidate of ordered) {
        const stored = candidate.settings ?? {};
        const complete = !!stored.debuggerName
            && typeof stored.portNumber === 'number'
            && typeof stored.shellPortNumber === 'number';
        const collides = complete && (
            taken.names.has(stored.debuggerName!)
            || taken.ports.has(stored.portNumber!)
            || taken.ports.has(stored.shellPortNumber!)
        );

        if (complete && !collides) {
            taken.names.add(stored.debuggerName!);
            taken.ports.add(stored.portNumber!);
            taken.ports.add(stored.shellPortNumber!);
            continue;
        }

        const identity = deriveIdentity(candidate.odooVersion, prefix, taken);
        taken.names.add(identity.debuggerName);
        taken.ports.add(identity.portNumber);
        taken.ports.add(identity.shellPortNumber);
        patches.push({ id: candidate.id, identity });
    }

    return patches;
}

/** The ports a new version for `branch` could land on, both ranges. */
export function candidatePortsFor(branch: string, window = 10): number[] {
    const major = parseSeriesMajor(branch);
    const serverBase = major === undefined ? SERVER_PORT_BASE : SERVER_PORT_BASE + major;
    const shellBase = major === undefined ? SHELL_PORT_BASE : SHELL_PORT_BASE + major;

    const ports: number[] = [];
    for (let offset = 0; offset < window; offset += 1) {
        ports.push(serverBase + offset);
    }
    for (let offset = 0; offset < window; offset += 1) {
        ports.push(shellBase + offset);
    }
    return ports;
}

/**
 * Which of `ports` already have something listening. Other versions are the
 * primary authority, but a port can also be held by an unrelated process -
 * another project's server, a stray container - and deriving onto it would
 * produce a version that cannot start.
 */
export async function probeBusyPorts(ports: number[]): Promise<Set<number>> {
    const results = await Promise.all(ports.map(port => new Promise<number | undefined>(resolve => {
        const socket = net.connect({ port, host: '127.0.0.1' });
        const finish = (busy: boolean) => {
            socket.destroy();
            resolve(busy ? port : undefined);
        };
        socket.setTimeout(250, () => finish(false));
        socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
    })));

    return new Set(results.filter((port): port is number => port !== undefined));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run compile-tests && npm run lint && npm run compile && npm test`
Expected: 100 passing (91 existing + 9 new), no `error TS`, no lint errors.

- [ ] **Step 5: Commit**

```bash
git add src/services/versionIdentity.ts src/test/versionIdentity.test.ts
git commit -m "[ADD] Derive debugger identity from a version's branch"
```

---

### Task 2: Make identity read-only everywhere

Wires Task 1 into version creation, cloning, repair, the settings tree and the settings-editing commands, and removes the three global default configuration keys that caused every version to share one identity.

**Files:**
- Modify: `src/versionsService.ts` (`createVersion`, `cloneVersion`, `validateAndRepairVersions`, `setSettingToDefault`, `setAllSettingsToDefault`, `setAllSettingsAsDefault`)
- Modify: `src/utils.ts:780-804` (`getDefaultVersionSettings`)
- Modify: `src/commands/versionCommands.ts:232-279` (`odoo.editVersionSetting`)
- Modify: `src/versionsTreeProvider.ts:73-117` (`VersionSettingTreeItem`)
- Modify: `package.json` (configuration properties)

**Interfaces:**
- Consumes: `deriveIdentity`, `collectTaken`, `healIdentities`, `isDerivedSetting`, `DERIVED_SETTING_KEYS`, `VersionIdentity` from `src/services/versionIdentity.ts` (Task 1).
- Produces: `VersionsService.getDebuggerNamePrefix(): string` — reads `odooDebugger.debuggerNamePrefix`, used by Tasks 3 and 5. Every stored version is guaranteed to carry a unique `settings.debuggerName`, `settings.portNumber` and `settings.shellPortNumber` after `initialize()`.

- [ ] **Step 1: Remove the three default-identity configuration keys**

In `package.json`, delete these three properties from `contributes.configuration.properties`:

```json
"odooDebugger.defaultVersion.debuggerName": { ... },
"odooDebugger.defaultVersion.portNumber": { ... },
"odooDebugger.defaultVersion.shellPortNumber": { ... },
```

Add, alongside `odooDebugger.provisioning.root`:

```json
"odooDebugger.debuggerNamePrefix": {
    "type": "string",
    "default": "odoo",
    "markdownDescription": "Prefix for each version's generated launch configuration name: `<prefix>:<branch>`, for example `odoo:17.0`. The name, HTTP port and shell port are derived from the version's branch and cannot be edited per version."
}
```

- [ ] **Step 2: Drop the three keys from `getDefaultVersionSettings`**

In `src/utils.ts`, in `getDefaultVersionSettings()`, delete these three lines:

```ts
        debuggerName: config.get('debuggerName', 'odoo:19.0'),
        portNumber: config.get('portNumber', 8019),
        shellPortNumber: config.get('shellPortNumber', 5019),
```

Leave `debuggerVersion` and every other key untouched.

- [ ] **Step 3: Run the compiler to see what breaks**

Run: `npm run compile-tests`
Expected: PASS. `getDefaultVersionSettings` returns `any`, so nothing type-errors — this step is to confirm the removal did not break an unrelated typed consumer. The behavioural gap (versions created with no identity) is closed in the next step.

- [ ] **Step 4: Derive identity on create and clone**

In `src/versionsService.ts`, add to the imports at the top:

```ts
import {
    collectTaken,
    deriveIdentity,
    healIdentities,
    isDerivedSetting,
    candidatePortsFor,
    probeBusyPorts
} from './services/versionIdentity';
```

Add this method to the class, just above `createVersion`:

```ts
    /** Prefix for generated launch configuration names (`<prefix>:<branch>`). */
    public getDebuggerNamePrefix(): string {
        const configured = vscode.workspace
            .getConfiguration('odooDebugger')
            .get<string>('debuggerNamePrefix', 'odoo')
            .trim();
        return configured || 'odoo';
    }

    /**
     * A fresh identity for `odooVersion`, avoiding both the other versions'
     * values and any port something else is already listening on.
     */
    private async deriveFreshIdentity(odooVersion: string, exceptId?: string): Promise<VersionIdentity> {
        const taken = collectTaken(Array.from(this.versions.values()), exceptId);
        for (const port of await probeBusyPorts(candidatePortsFor(odooVersion))) {
            taken.ports.add(port);
        }
        return deriveIdentity(odooVersion, this.getDebuggerNamePrefix(), taken);
    }
```

Add `VersionIdentity` to the `versionIdentity` import as a type.

Replace the body of `createVersion` (currently `src/versionsService.ts:247-264`) with:

```ts
    public async createVersion(name: string, odooVersion: string, settingsOverrides: Partial<VersionSettings> = {}): Promise<VersionModel> {
        await this.initialize(); // Ensure initialization

        // Get default settings from VS Code configuration
        const defaultSettings = getDefaultVersionSettings();
        // Identity is derived from the branch, so it wins over both the
        // configured defaults and any caller-supplied override: two versions
        // sharing a debuggerName would overwrite each other in launch.json.
        const identity = await this.deriveFreshIdentity(odooVersion);
        const mergedSettings = { ...defaultSettings, ...settingsOverrides, ...identity };

        const version = new VersionModel(name, odooVersion, mergedSettings);
        this.versions.set(version.id, version);

        await this.saveVersions();
        vscode.commands.executeCommand('odoo.versionsChanged');

        return version;
    }
```

In `cloneVersion`, the clone copies `{ ...this.settings }` through `VersionModel.clone()`, which would duplicate the source's identity. Replace these two lines in the `try` block:

```ts
            const clonedVersion = sourceVersion.clone(newName);
            this.versions.set(clonedVersion.id, clonedVersion);
```

with:

```ts
            const clonedVersion = sourceVersion.clone(newName);
            this.versions.set(clonedVersion.id, clonedVersion);
            // A clone must not inherit the source's identity - that is exactly
            // the collision this derivation exists to prevent.
            clonedVersion.settings = {
                ...clonedVersion.settings,
                ...(await this.deriveFreshIdentity(clonedVersion.odooVersion, clonedVersion.id))
            };
```

- [ ] **Step 5: Heal stored identities on load**

In `src/versionsService.ts`, in `validateAndRepairVersions()`, insert this block immediately before the final `if (needsRepair) {`:

```ts
        // Identity is derived, but existing versions are healed rather than
        // rewritten: a stored name/port survives unless it is missing or
        // collides with an older version's - the case where every version
        // inherited one global default and they overwrote each other.
        const patches = healIdentities(Array.from(this.versions.values()), this.getDebuggerNamePrefix());
        for (const patch of patches) {
            const version = this.versions.get(patch.id);
            if (!version) {
                continue;
            }
            logger.info(
                `[identity] ${version.name}: ${version.settings.debuggerName ?? 'none'} -> ` +
                `${patch.identity.debuggerName} (ports ${patch.identity.portNumber}/${patch.identity.shellPortNumber})`
            );
            version.settings = { ...version.settings, ...patch.identity };
            needsRepair = true;
        }
```

- [ ] **Step 6: Stop the default-value operations from touching identity**

Three methods in `src/versionsService.ts` treat every settings key uniformly and must now skip the derived ones.

In `setSettingToDefault`, immediately after the `if (!version) { ... }` guard, add:

```ts
        if (isDerivedSetting(settingKey)) {
            void showInfo(`"${settingKey}" is derived from the version's branch and has no default to restore.`);
            return false;
        }
```

In `setAllSettingsToDefault`, replace `version.updateSettings(defaultSettings);` with:

```ts
            // Identity is derived from the branch; resetting to defaults must
            // not clear it, or two versions collide again.
            version.updateSettings({
                ...defaultSettings,
                debuggerName: version.settings.debuggerName,
                portNumber: version.settings.portNumber,
                shellPortNumber: version.settings.shellPortNumber
            });
```

In `setAllSettingsAsDefault`, replace the `for (const [key, value] of Object.entries(settings))` loop body's `await config.update(key, value, ...)` with a guarded version:

```ts
            for (const [key, value] of Object.entries(settings)) {
                // No configuration keys exist for derived identity.
                if (isDerivedSetting(key)) {
                    continue;
                }
                await config.update(key, value, vscode.ConfigurationTarget.Workspace);
            }
```

- [ ] **Step 7: Refuse to edit derived settings from the tree**

In `src/commands/versionCommands.ts`, in the `odoo.editVersionSetting` handler, immediately after `const { versionId, key, value } = ref;` add:

```ts
            if (isDerivedSetting(key)) {
                void showInfo(
                    `"${getSettingDisplayName(key)}" is derived from this version's branch so two versions can run at once. ` +
                    `Change the version's branch to change it.`
                );
                return;
            }
```

Add to that file's imports:

```ts
import { isDerivedSetting } from '../services/versionIdentity';
```

and widen the existing `../utils` import on line 8 from:

```ts
import { normalizePath } from '../utils';
```

to:

```ts
import { getSettingDisplayName, normalizePath } from '../utils';
```

- [ ] **Step 8: Render derived settings as read-only rows**

In `src/versionsTreeProvider.ts`, add to the imports:

```ts
import { isDerivedSetting } from './services/versionIdentity';
```

In the `VersionSettingTreeItem` constructor, replace the trailing command assignment:

```ts
        // Add command to edit this setting
        this.command = {
            command: 'odoo.editVersionSetting',
            title: 'Edit Setting',
            arguments: [versionId, key, value]
        };
```

with:

```ts
        // Derived identity is shown but never editable: it is a function of
        // the version's branch, and editing it would let two versions collide.
        if (isDerivedSetting(key)) {
            this.contextValue = 'versionSettingDerived';
            this.description = 'derived from branch';
            this.tooltip = `${displayName}: ${displayValue}\n\nDerived from the version's branch (${key}). Not editable.`;
            return;
        }

        this.command = {
            command: 'odoo.editVersionSetting',
            title: 'Edit Setting',
            arguments: [versionId, key, value]
        };
```

- [ ] **Step 9: Hide the reset/set-default menu items on derived rows**

In `package.json`, find every entry under `contributes.menus.view/item/context` whose `when` clause references `viewItem == versionSetting`. Those are the "Reset to Default" / "Set as Default" actions. They already only match `versionSetting`, and derived rows now carry `versionSettingDerived`, so no change is needed — confirm this by grepping and record the result:

Run: `grep -n "versionSetting" package.json`
Expected: every `when` clause uses `viewItem == versionSetting` exactly (not `=~`), so derived rows show no edit actions. If any clause uses a regex match that would also match `versionSettingDerived`, tighten it to `==`.

- [ ] **Step 10: Verify the whole gate**

Run: `npm run compile-tests && npm run lint && npm run compile && npm test`
Expected: 100 passing, no `error TS`, no lint errors.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "[IMP] Make debugger name and ports derived, read-only per version"
```

---

### Task 3: Track every version's debug session

Replaces the two "there is one session" assumptions (`isOwnSession` in `src/services/server.ts:69` and `findOwnDebugSession` in `src/debugger.ts:380`) with a registry keyed by debugger name.

**Files:**
- Create: `src/services/debugSessions.ts`
- Test: `src/test/debugSessions.test.ts`
- Modify: `src/services/server.ts:62-117`
- Modify: `src/debugger.ts:379-424`

**Interfaces:**
- Consumes: `VersionsService.getVersions()` (each version's `settings.debuggerName` and `settings.portNumber`, guaranteed unique by Task 2).
- Produces:
  - `function trackSession(session: vscode.DebugSession): void`
  - `function untrackSession(session: vscode.DebugSession): void`
  - `function getSessionByName(name: string): vscode.DebugSession | undefined`
  - `function runningDebuggerNames(): string[]`
  - `function anySessionRunning(): boolean`
  - `function clearSessions(): void`
  - `function resolveStopTarget(running: string[], activeName: string | undefined): { kind: 'none' } | { kind: 'single'; name: string } | { kind: 'prompt'; names: string[] }`

- [ ] **Step 1: Write the failing tests**

Create `src/test/debugSessions.test.ts`:

```ts
import * as assert from 'assert';
import * as vscode from 'vscode';
import {
    trackSession,
    untrackSession,
    getSessionByName,
    runningDebuggerNames,
    anySessionRunning,
    clearSessions,
    resolveStopTarget
} from '../services/debugSessions';

function fakeSession(name: string): vscode.DebugSession {
    return { configuration: { name } } as unknown as vscode.DebugSession;
}

suite('Debug session registry', () => {
    setup(() => clearSessions());
    teardown(() => clearSessions());

    test('tracks and retrieves sessions by configuration name', () => {
        const seventeen = fakeSession('odoo:17.0');
        const eighteen = fakeSession('odoo:18.0');

        trackSession(seventeen);
        trackSession(eighteen);

        assert.strictEqual(getSessionByName('odoo:17.0'), seventeen);
        assert.strictEqual(getSessionByName('odoo:18.0'), eighteen);
        assert.deepStrictEqual(runningDebuggerNames().sort(), ['odoo:17.0', 'odoo:18.0']);
        assert.strictEqual(anySessionRunning(), true);
    });

    test('untracking one session leaves the others running', () => {
        trackSession(fakeSession('odoo:17.0'));
        trackSession(fakeSession('odoo:18.0'));

        untrackSession(fakeSession('odoo:17.0'));

        assert.strictEqual(getSessionByName('odoo:17.0'), undefined);
        assert.deepStrictEqual(runningDebuggerNames(), ['odoo:18.0']);
        // server_running must stay true while any version is up.
        assert.strictEqual(anySessionRunning(), true);
    });

    test('ignores sessions with no configuration name', () => {
        trackSession({ configuration: {} } as unknown as vscode.DebugSession);
        assert.strictEqual(anySessionRunning(), false);
    });

    test('resolves what Stop Server should target', () => {
        assert.deepStrictEqual(resolveStopTarget([], 'odoo:17.0'), { kind: 'none' });
        assert.deepStrictEqual(
            resolveStopTarget(['odoo:18.0'], 'odoo:17.0'),
            { kind: 'single', name: 'odoo:18.0' }
        );
        // The active version's own session wins without prompting.
        assert.deepStrictEqual(
            resolveStopTarget(['odoo:17.0', 'odoo:18.0'], 'odoo:17.0'),
            { kind: 'single', name: 'odoo:17.0' }
        );
        // Several running, none of them the active version: ask.
        assert.deepStrictEqual(
            resolveStopTarget(['odoo:18.0', 'odoo:19.0'], 'odoo:17.0'),
            { kind: 'prompt', names: ['odoo:18.0', 'odoo:19.0'] }
        );
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run compile-tests`
Expected: FAIL with `error TS2307: Cannot find module '../services/debugSessions'`.

- [ ] **Step 3: Write the registry**

Create `src/services/debugSessions.ts`:

```ts
/**
 * Registry of the extension's running debug sessions, keyed by launch
 * configuration name. Versions derive a unique debuggerName (see
 * versionIdentity.ts), so several can run at once and each is addressable
 * on its own - which the previous single-active-session assumption made
 * impossible.
 */
import type * as vscode from 'vscode';

const sessions = new Map<string, vscode.DebugSession>();

function nameOf(session: vscode.DebugSession): string | undefined {
    const name = session.configuration?.name;
    return typeof name === 'string' && name.length > 0 ? name : undefined;
}

export function trackSession(session: vscode.DebugSession): void {
    const name = nameOf(session);
    if (name) {
        sessions.set(name, session);
    }
}

export function untrackSession(session: vscode.DebugSession): void {
    const name = nameOf(session);
    if (name) {
        sessions.delete(name);
    }
}

export function getSessionByName(name: string): vscode.DebugSession | undefined {
    return sessions.get(name);
}

export function runningDebuggerNames(): string[] {
    return Array.from(sessions.keys());
}

export function anySessionRunning(): boolean {
    return sessions.size > 0;
}

/** Test seam: the registry is module state that outlives a single suite. */
export function clearSessions(): void {
    sessions.clear();
}

/**
 * What "Stop Server" should act on. The active version's session wins
 * outright; otherwise a lone session is unambiguous and anything else needs
 * the user to choose.
 */
export function resolveStopTarget(
    running: string[],
    activeName: string | undefined
): { kind: 'none' } | { kind: 'single'; name: string } | { kind: 'prompt'; names: string[] } {
    if (running.length === 0) {
        return { kind: 'none' };
    }
    if (activeName && running.includes(activeName)) {
        return { kind: 'single', name: activeName };
    }
    if (running.length === 1) {
        return { kind: 'single', name: running[0] };
    }
    return { kind: 'prompt', names: [...running] };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run compile-tests && npm test`
Expected: 104 passing (100 + 4 new).

- [ ] **Step 5: Feed the registry from the lifecycle listeners**

In `src/services/server.ts`, add to the imports:

```ts
import { trackSession, untrackSession, anySessionRunning } from './debugSessions';
```

Replace `isOwnSession` (lines 68-76) with a version-aware lookup:

```ts
/** The version whose launch configuration this session was started from. */
async function versionForSession(session: vscode.DebugSession): Promise<{ portNumber: number } | undefined> {
    const name = session.configuration?.name;
    if (typeof name !== 'string' || name.length === 0) {
        return undefined;
    }
    try {
        const service = VersionsService.getInstance();
        await service.initialize();
        const version = service.getVersions().find(entry => entry.settings?.debuggerName === name);
        if (!version) {
            return undefined;
        }
        const port = Number(version.settings.portNumber);
        return { portNumber: Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_ODOO_PORT };
    } catch {
        return undefined;
    }
}
```

Replace the body of `registerServerLifecycle` (lines 84-117) with:

```ts
export function registerServerLifecycle(
    context: vscode.ExtensionContext,
    hooks: {
        onRunningChanged: (running: boolean) => void;
        getSelectedDbName: () => Promise<string | undefined>;
    }
): void {
    context.subscriptions.push(vscode.debug.onDidStartDebugSession(async session => {
        const version = await versionForSession(session);
        if (!version) {
            return;
        }
        trackSession(session);
        hooks.onRunningChanged(anySessionRunning());

        const openBrowser = vscode.workspace
            .getConfiguration('odooDebugger')
            .get<boolean>('server.openBrowserOnStart', false);
        if (!openBrowser) {
            return;
        }
        // The session's own port, not the active version's: another version
        // may have been activated since this one was launched.
        if (await waitForPort(version.portNumber, 60000)) {
            const dbName = await hooks.getSelectedDbName();
            await vscode.env.openExternal(buildServerUrl(version.portNumber, dbName));
        } else {
            logger.debug(`Server port ${version.portNumber} did not open within 60s; not opening browser.`);
        }
    }));

    context.subscriptions.push(vscode.debug.onDidTerminateDebugSession(session => {
        untrackSession(session);
        hooks.onRunningChanged(anySessionRunning());
    }));
}
```

- [ ] **Step 6: Address the running session, not the active one, in debugger.ts**

In `src/debugger.ts`, add to the imports:

```ts
import { getSessionByName, runningDebuggerNames, resolveStopTarget } from './services/debugSessions';
```

Replace `findOwnDebugSession` and `stopDebugServer` (lines 379-398) with:

```ts
/** Stops one of the extension's running sessions, asking only when ambiguous. */
export async function stopDebugServer(): Promise<void> {
    const settings = await VersionsService.getInstance().getActiveVersionSettings();
    const target = resolveStopTarget(runningDebuggerNames(), settings.debuggerName);

    if (target.kind === 'none') {
        void showInfo('No Odoo debug session is currently running.');
        return;
    }

    let name: string;
    if (target.kind === 'single') {
        name = target.name;
    } else {
        const picked = await vscode.window.showQuickPick(target.names, {
            title: 'Stop which Odoo server?',
            placeHolder: 'Several versions are running'
        });
        if (!picked) {
            return;
        }
        name = picked;
    }

    const session = getSessionByName(name);
    if (!session) {
        void showInfo('No Odoo debug session is currently running.');
        return;
    }
    await vscode.debug.stopDebugging(session);
}
```

In `startDebugServer` (lines 400-424), replace the "stop the existing session" block:

```ts
    // Stop only the session launched from the extension's own configuration;
    // unrelated debug sessions must survive a server (re)start.
    const existingSession = vscode.debug.activeDebugSession;
    if (existingSession && existingSession.configuration?.name === workspaceSettings.debuggerName) {
        await vscode.debug.stopDebugging(existingSession);
    }
```

with:

```ts
    // Restarting this version stops only this version's session; other
    // versions running side by side must survive.
    const existingSession = getSessionByName(workspaceSettings.debuggerName);
    if (existingSession) {
        await vscode.debug.stopDebugging(existingSession);
    }
```

- [ ] **Step 7: Verify the whole gate**

Run: `npm run compile-tests && npm run lint && npm run compile && npm test`
Expected: 104 passing, no `error TS`, no lint errors.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "[IMP] Track a debug session per version instead of one active session"
```

---

### Task 4: Resolve the database per version

`prepareArgs` resolves the database globally (`project.dbs.find(isSelected)` at `src/debugger.ts:145`), so both versions would launch against the same `-d`. Databases already carry `versionId`; this adds the per-version memory and the resolution order.

**Files:**
- Create: `src/services/dbResolution.ts`
- Test: `src/test/dbResolution.test.ts`
- Modify: `src/models/project.ts`
- Modify: `src/debugger.ts:111-151`, `:318-351`
- Modify: `src/dbs.ts:760-806` (`selectDatabase`)

**Interfaces:**
- Consumes: `DatabaseModel.versionId` (already populated by `detectOdooSeries`), `VersionsService.getActiveVersion()`.
- Produces:
  - `interface VersionScopedDb { id: string; isSelected?: boolean; versionId?: string }`
  - `function resolveDbForVersion<T extends VersionScopedDb>(dbs: T[], selectedDbByVersion: Record<string, string> | undefined, versionId: string | undefined): T | undefined`
  - `function rememberDbForVersion(existing: Record<string, string> | undefined, versionId: string | undefined, dbId: string): Record<string, string>`
  - `ProjectModel.selectedDbByVersion: Record<string, string>`
  - `prepareArgs(project, settings, options?: { isShell?: boolean; versionId?: string })`

- [ ] **Step 1: Write the failing tests**

Create `src/test/dbResolution.test.ts`:

```ts
import * as assert from 'assert';
import { resolveDbForVersion, rememberDbForVersion, VersionScopedDb } from '../services/dbResolution';

const DBS: VersionScopedDb[] = [
    { id: 'shop-17', versionId: 'v17' },
    { id: 'shop-18', versionId: 'v18', isSelected: true },
    { id: 'orphan' }
];

suite('Per-version database resolution', () => {
    test('prefers the database remembered for that version', () => {
        const resolved = resolveDbForVersion(DBS, { v17: 'shop-17' }, 'v17');
        assert.strictEqual(resolved?.id, 'shop-17');
    });

    test('falls back to the selected database when it belongs to the version', () => {
        const resolved = resolveDbForVersion(DBS, {}, 'v18');
        assert.strictEqual(resolved?.id, 'shop-18');
    });

    test('falls back to the selected database when nothing else matches', () => {
        // v17 has no memory and the selection belongs to v18: still better
        // than no -d at all, and matches the pre-existing global behaviour.
        const resolved = resolveDbForVersion(DBS, {}, 'v17');
        assert.strictEqual(resolved?.id, 'shop-18');
    });

    test('ignores a remembered database that no longer exists', () => {
        const resolved = resolveDbForVersion(DBS, { v17: 'deleted-db' }, 'v17');
        assert.strictEqual(resolved?.id, 'shop-18');
    });

    test('resolves the selected database when no version is given', () => {
        assert.strictEqual(resolveDbForVersion(DBS, {}, undefined)?.id, 'shop-18');
    });

    test('returns undefined when there is nothing to resolve', () => {
        assert.strictEqual(resolveDbForVersion([], {}, 'v17'), undefined);
        assert.strictEqual(resolveDbForVersion([{ id: 'a' }], {}, 'v17'), undefined);
    });

    test('remembers a database against a version without touching the others', () => {
        assert.deepStrictEqual(
            rememberDbForVersion({ v17: 'shop-17' }, 'v18', 'shop-18'),
            { v17: 'shop-17', v18: 'shop-18' }
        );
        // No active version: nothing to key the memory on.
        assert.deepStrictEqual(rememberDbForVersion({ v17: 'shop-17' }, undefined, 'x'), { v17: 'shop-17' });
        assert.deepStrictEqual(rememberDbForVersion(undefined, 'v17', 'shop-17'), { v17: 'shop-17' });
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run compile-tests`
Expected: FAIL with `error TS2307: Cannot find module '../services/dbResolution'`.

- [ ] **Step 3: Write the resolver**

Create `src/services/dbResolution.ts`:

```ts
/**
 * Which database a version launches against. Selection used to be one flag
 * per project, so two versions running at once shared a single `-d`; each
 * version now remembers its own, falling back to the project selection.
 */

export interface VersionScopedDb {
    id: string;
    isSelected?: boolean;
    versionId?: string;
}

/**
 * Resolution order: the database remembered for this version, then the
 * selected database when it belongs to this version, then the selected
 * database regardless - which is the behaviour that existed before.
 */
export function resolveDbForVersion<T extends VersionScopedDb>(
    dbs: T[],
    selectedDbByVersion: Record<string, string> | undefined,
    versionId: string | undefined
): T | undefined {
    const selected = dbs.find(db => db.isSelected);

    if (versionId) {
        const rememberedId = selectedDbByVersion?.[versionId];
        const remembered = rememberedId ? dbs.find(db => db.id === rememberedId) : undefined;
        if (remembered) {
            return remembered;
        }
        if (selected?.versionId === versionId) {
            return selected;
        }
    }

    return selected;
}

/** Records `dbId` against `versionId`, leaving other versions' memory intact. */
export function rememberDbForVersion(
    existing: Record<string, string> | undefined,
    versionId: string | undefined,
    dbId: string
): Record<string, string> {
    const base = { ...(existing ?? {}) };
    if (!versionId) {
        return base;
    }
    base[versionId] = dbId;
    return base;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run compile-tests && npm test`
Expected: 111 passing (104 + 7 new).

- [ ] **Step 5: Add the per-version memory to the project model**

In `src/models/project.ts`, add the field to the class body, immediately after `tickets: ProjectTicketModel[] = [];`:

```ts
    /** versionId -> dbId: which database each version last launched against. */
    selectedDbByVersion: Record<string, string> = {};
```

Do not add it to the constructor signature — projects are read back from `odoo-debugger-data.json` as plain objects, so an additive optional field round-trips without a migration.

- [ ] **Step 6: Resolve per version in `prepareArgs`**

In `src/debugger.ts`, add to the imports:

```ts
import { resolveDbForVersion } from './services/dbResolution';
```

Change the signature (line 111) from:

```ts
async function prepareArgs(project: ProjectModel, settings: SettingsModel, isShell = false): Promise<string[]> {
```

to:

```ts
async function prepareArgs(
    project: ProjectModel,
    settings: SettingsModel,
    options: { isShell?: boolean; versionId?: string } = {}
): Promise<string[]> {
    const isShell = options.isShell === true;
```

Replace the database lookup (lines 145-148):

```ts
    const db = project.dbs.find(database => database.isSelected);
    if (!db) {
        throw new Error('Select a database before running this action.');
    }
```

with:

```ts
    const db = resolveDbForVersion(project.dbs, project.selectedDbByVersion, options.versionId);
    if (!db) {
        throw new Error('Select a database before running this action.');
    }
```

- [ ] **Step 7: Pass the version id from both callers**

In `setupDebugger` (line 72), replace:

```ts
        args = await prepareArgs(project, settings);
```

with:

```ts
        args = await prepareArgs(project, settings, { versionId: versionsService.getActiveVersion()?.id });
```

In `buildOdooCommandLine` (line 331), replace:

```ts
        args = await prepareArgs(project, workspaceSettings, isShell);
```

with:

```ts
        args = await prepareArgs(project, workspaceSettings, {
            isShell,
            versionId: versionsService.getActiveVersion()?.id
        });
```

- [ ] **Step 8: Record the selection against the active version**

In `src/dbs.ts`, add to the imports:

```ts
import { rememberDbForVersion } from './services/dbResolution';
```

In `selectDatabase`, replace this line (line 791):

```ts
    await SettingsStore.saveWithoutComments(stripSettings(data));
```

with:

```ts
    // Remember the choice against the active version so each version keeps
    // its own -d when several run side by side.
    // `project` is the object inside `data.projects`, so mutating it here is
    // what the save below persists - the same way the dbs loop above works.
    project.selectedDbByVersion = rememberDbForVersion(
        project.selectedDbByVersion,
        VersionsService.getInstance().getActiveVersion()?.id,
        selectedDatabase.id
    );

    await SettingsStore.saveWithoutComments(stripSettings(data));
```

`VersionsService` is already imported in `src/dbs.ts` (line 15) — do not add a second import.

- [ ] **Step 9: Verify the whole gate**

Run: `npm run compile-tests && npm run lint && npm run compile && npm test`
Expected: 111 passing, no `error TS`, no lint errors.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "[ADD] Resolve the launch database per version"
```

---

### Task 5: One launch entry per provisioned version

`setupDebugger` writes a single managed entry for the active version. With unique names (Task 2) and per-version databases (Task 4), it can write one durable entry per provisioned version — which is what makes the Run and Debug dropdown a version switcher and F5 correct.

**Files:**
- Modify: `src/services/provisioning.ts` (add `isVersionProvisioned`)
- Modify: `src/versionsTreeProvider.ts:17-28` (use the shared predicate)
- Modify: `src/debugger.ts:54-109` (`setupDebugger`)
- Test: `src/test/provisioning.test.ts` (extend)

**Interfaces:**
- Consumes: `resolveDbForVersion` (Task 4), `venvPythonPath` from `src/services/pythonToolchain.ts`, `updateManagedLaunchConfig` from `src/services/launchConfig.ts`.
- Produces: `function isVersionProvisioned(pythonPath: string | undefined): boolean` in `src/services/provisioning.ts`.

- [ ] **Step 1: Write the failing test**

Append to `src/test/provisioning.test.ts`, inside the existing `suite`:

```ts
    test('recognises a provisioned version by its interpreter', () => {
        assert.strictEqual(isVersionProvisioned(undefined), false);
        assert.strictEqual(isVersionProvisioned('   '), false);
        assert.strictEqual(isVersionProvisioned('/nonexistent/venv/bin/python'), false);
        // The interpreter running this suite is by definition on disk.
        assert.strictEqual(isVersionProvisioned(process.execPath), true);
    });
```

Add `isVersionProvisioned` to the existing import from `../services/provisioning`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run compile-tests`
Expected: FAIL with `error TS2305: Module '"../services/provisioning"' has no exported member 'isVersionProvisioned'`.

- [ ] **Step 3: Add the shared predicate**

In `src/services/provisioning.ts`, add after `isFullySatisfied`:

```ts
/**
 * A version is provisioned when the interpreter its pythonPath points at
 * actually exists - a fact about the filesystem, never stored state.
 */
export function isVersionProvisioned(pythonPath: string | undefined): boolean {
    const trimmed = pythonPath?.trim();
    if (!trimmed) {
        return false;
    }
    return fs.existsSync(trimmed);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run compile-tests && npm test`
Expected: 112 passing.

- [ ] **Step 5: Have the versions tree use the shared predicate**

In `src/versionsTreeProvider.ts`, replace the local `provisioningLabel` helper (lines 17-28) with:

```ts
/** Provisioned state for the tree description, from the shared predicate. */
function provisioningLabel(version: VersionModel): string {
    return isVersionProvisioned(normalizePath(version.settings.pythonPath ?? ''))
        ? 'provisioned'
        : 'not provisioned';
}
```

Replace the now-unused imports: remove `import * as fs from 'node:fs';`, `import * as path from 'node:path';` and `import { venvPythonPath } from './services/pythonToolchain';`, and add:

```ts
import { isVersionProvisioned } from './services/provisioning';
```

Keep `normalizePath` in the existing `./utils` import.

- [ ] **Step 6: Write one launch entry per provisioned version**

In `src/debugger.ts`, replace the whole body of `setupDebugger` (lines 54-109) with:

```ts
export async function setupDebugger(): Promise<any> {
    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
        return undefined;
    }
    const result = await SettingsStore.getSelectedProject();
    if (!result) {
        return undefined;
    }
    const { project } = result;

    const versionsService = VersionsService.getInstance();
    await versionsService.initialize();
    const activeVersion = versionsService.getActiveVersion();
    const activeSettings = await versionsService.getActiveVersionSettings();

    // One entry per provisioned version, each with its own name, ports and
    // database: launch.json accumulates durable entries instead of one being
    // renamed out from under the Run and Debug dropdown, and two versions can
    // run at once. Unprovisioned versions have no interpreter to launch.
    const targets = versionsService.getVersions()
        .filter(version => isVersionProvisioned(normalizePath(version.settings.pythonPath ?? '')));
    if (activeVersion && !targets.some(version => version.id === activeVersion.id)) {
        targets.push(activeVersion);
    }

    let activeConfig: unknown;

    for (const version of targets) {
        const settings = version.settings;
        const normalizedOdooPath = normalizePath(settings.odooPath);
        const normalizedPythonPath = normalizePath(settings.pythonPath);

        let args: string[];
        try {
            args = await prepareArgs(project, settings as SettingsModel, { versionId: version.id });
        } catch (error) {
            // A version with no resolvable database is skipped rather than
            // failing the sync for every other version. Only the active one
            // is worth telling the user about.
            if (version.id === activeVersion?.id) {
                logger.warn('Could not prepare debugger launch arguments:', error);
                if (error instanceof Error && error.message === 'Select a database before running this action.') {
                    void showInfo('Select a database before configuring the debugger.');
                } else {
                    void showError(error instanceof Error ? error.message : 'Could not prepare debugger launch arguments.');
                }
            } else {
                logger.debug(`Skipping launch entry for "${version.name}": ${errorMessage(error)}`);
            }
            continue;
        }

        try {
            // Only the extension's own entries in launch.json are rewritten;
            // user comments and other configurations are preserved.
            const config = await updateManagedLaunchConfig(workspacePath, {
                name: settings.debuggerName,
                type: 'debugpy',
                request: 'launch',
                cwd: workspacePath,
                program: `${normalizedOdooPath}/odoo-bin`,
                python: normalizedPythonPath,
                console: 'integratedTerminal',
                args
            });
            if (version.id === activeVersion?.id) {
                activeConfig = config;
            }
        } catch (error) {
            void showError(`Unable to update launch.json: ${errorMessage(error)}`);
            return undefined;
        }
    }

    await selectPythonInterpreter(activeSettings.pythonPath);

    return activeConfig;
}
```

Add to `src/debugger.ts` imports:

```ts
import { isVersionProvisioned } from './services/provisioning';
```

- [ ] **Step 7: Verify the whole gate**

Run: `npm run compile-tests && npm run lint && npm run compile && npm test`
Expected: 112 passing, no `error TS`, no lint errors.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "[IMP] Sync one launch entry per provisioned version"
```

---

### Task 6: Include the active version's checkout in the generated workspace

`buildWorkspaceFile` (`src/projectWorkspace.ts:45-66`) builds the multi-root workspace from `project.repos` only, so a project workspace opens the custom addons but not the Odoo checkout the active version actually runs. With one worktree per version (§2, already shipped), files opened from the workspace should belong to the version being run — which is also what makes breakpoints bind to the right checkout.

**Files:**
- Create: `src/services/workspaceFolders.ts`
- Test: `src/test/workspaceFolders.test.ts`
- Modify: `src/projectWorkspace.ts:45-66`

**Interfaces:**
- Consumes: `VersionModel.settings` (`odooPath`, `enterprisePath`, `designThemesPath`).
- Produces: `interface WorkspaceFolderEntry { path: string; name?: string }` and `function versionFolderEntries(version: { name: string; settings: { odooPath?: string; enterprisePath?: string; designThemesPath?: string } } | undefined, existingPaths: string[]): WorkspaceFolderEntry[]`.

- [ ] **Step 1: Write the failing test**

Create `src/test/workspaceFolders.test.ts`:

```ts
import * as assert from 'assert';
import { versionFolderEntries } from '../services/workspaceFolders';

const VERSION = {
    name: 'Odoo 17.0',
    settings: {
        odooPath: '/srv/odt/odoo-17.0',
        enterprisePath: '/srv/odt/enterprise-17.0',
        designThemesPath: '/srv/odt/design-themes-17.0'
    }
};

suite('Workspace folders', () => {
    test('contributes the active version core checkouts, named by version', () => {
        assert.deepStrictEqual(versionFolderEntries(VERSION, []), [
            { path: '/srv/odt/odoo-17.0', name: 'odoo (Odoo 17.0)' },
            { path: '/srv/odt/enterprise-17.0', name: 'enterprise (Odoo 17.0)' },
            { path: '/srv/odt/design-themes-17.0', name: 'design-themes (Odoo 17.0)' }
        ]);
    });

    test('skips paths a project repo already contributes', () => {
        const entries = versionFolderEntries(VERSION, ['/srv/odt/enterprise-17.0']);
        assert.deepStrictEqual(entries.map(entry => entry.path), [
            '/srv/odt/odoo-17.0',
            '/srv/odt/design-themes-17.0'
        ]);
    });

    test('skips unset paths and returns nothing without an active version', () => {
        assert.deepStrictEqual(
            versionFolderEntries({ name: 'Bare', settings: { odooPath: '/srv/odoo' } }, []),
            [{ path: '/srv/odoo', name: 'odoo (Bare)' }]
        );
        assert.deepStrictEqual(versionFolderEntries({ name: 'Empty', settings: {} }, []), []);
        assert.deepStrictEqual(versionFolderEntries(undefined, []), []);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run compile-tests`
Expected: FAIL with `error TS2307: Cannot find module '../services/workspaceFolders'`.

- [ ] **Step 3: Write the helper**

Create `src/services/workspaceFolders.ts`:

```ts
/**
 * The active version's core checkouts, as multi-root workspace folders. Each
 * version owns its own worktree, so a project workspace that lists only the
 * project repos opens the custom addons without the Odoo source being run -
 * and breakpoints set in a stale checkout bind to the wrong files.
 */
import { normalizePath } from '../utils';

export interface WorkspaceFolderEntry {
    path: string;
    name?: string;
}

interface VersionLike {
    name: string;
    settings: {
        odooPath?: string;
        enterprisePath?: string;
        designThemesPath?: string;
    };
}

export function versionFolderEntries(
    version: VersionLike | undefined,
    existingPaths: string[]
): WorkspaceFolderEntry[] {
    if (!version) {
        return [];
    }

    const seen = new Set(existingPaths.map(entry => normalizePath(entry)));
    const entries: WorkspaceFolderEntry[] = [];

    const add = (rawPath: string | undefined, label: string) => {
        const trimmed = rawPath?.trim();
        if (!trimmed) {
            return;
        }
        const resolved = normalizePath(trimmed);
        if (seen.has(resolved)) {
            return;
        }
        seen.add(resolved);
        entries.push({ path: resolved, name: `${label} (${version.name})` });
    };

    add(version.settings.odooPath, 'odoo');
    add(version.settings.enterprisePath, 'enterprise');
    add(version.settings.designThemesPath, 'design-themes');

    return entries;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run compile-tests && npm test`
Expected: 113 passing.

- [ ] **Step 5: Add the folders to the generated workspace**

In `src/projectWorkspace.ts`, add to the imports:

```ts
import { VersionsService } from './versionsService';
import { versionFolderEntries } from './services/workspaceFolders';
```

In `buildWorkspaceFile`, after the `for (const repo of project.repos as RepoModel[])` loop closes and before `const workspaceData = {`, insert:

```ts
    // The active version's own checkouts, so files opened from this workspace
    // belong to the version being run.
    const versionsService = VersionsService.getInstance();
    await versionsService.initialize();
    folders.push(...versionFolderEntries(
        versionsService.getActiveVersion(),
        folders.map(folder => folder.path)
    ));
```

- [ ] **Step 6: Verify the whole gate**

Run: `npm run compile-tests && npm run lint && npm run compile && npm test`
Expected: 113 passing, no `error TS`, no lint errors.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "[ADD] Include the active version's checkouts in the project workspace"
```

---

### Task 7: Running-state service

Merges the session map (Task 3) with a PostgreSQL probe so any feature can ask which databases are live — the Databases view in Task 7, and split-view comparison later.

**Files:**
- Modify: `src/services/database.ts` (add the `pg_stat_activity` probe and its parser)
- Modify: `src/services/runtimeCache.ts` (add the cache slot)
- Create: `src/services/runningState.ts`
- Test: `src/test/runningState.test.ts`
- Test: `src/test/postgres.test.ts` (extend)

**Interfaces:**
- Consumes: `runningDebuggerNames()` (Task 3), `resolveDbForVersion` (Task 4), `VersionsService.getVersions()`.
- Produces:
  - `interface RunningInstance { versionId?: string; debuggerName?: string; dbName: string; port?: number; origin: 'managed' | 'external' }`
  - `function mergeRunningInstances(managed: RunningInstance[], external: RunningInstance[]): RunningInstance[]`
  - `async function getRunningInstances(): Promise<RunningInstance[]>`
  - `function invalidateRunningState(): void`
  - `function parseActiveDatabaseNames(output: string): string[]` in `src/services/database.ts`
  - `async function getActiveDatabaseNames(): Promise<string[]>` in `src/services/database.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/test/runningState.test.ts`:

```ts
import * as assert from 'assert';
import { mergeRunningInstances, RunningInstance } from '../services/runningState';

const managed: RunningInstance = {
    versionId: 'v17',
    debuggerName: 'odoo:17.0',
    dbName: 'shop-17',
    port: 8017,
    origin: 'managed'
};

suite('Running state', () => {
    test('managed instances win over an external report of the same database', () => {
        const merged = mergeRunningInstances(
            [managed],
            [{ dbName: 'shop-17', origin: 'external' }]
        );
        assert.strictEqual(merged.length, 1);
        assert.deepStrictEqual(merged[0], managed);
    });

    test('keeps external instances the extension did not start', () => {
        const merged = mergeRunningInstances(
            [managed],
            [{ dbName: 'shop-17', origin: 'external' }, { dbName: 'shop-18', origin: 'external' }]
        );
        assert.deepStrictEqual(
            merged.map(entry => [entry.dbName, entry.origin]).sort(),
            [['shop-17', 'managed'], ['shop-18', 'external']]
        );
    });

    test('deduplicates repeated managed entries for one database', () => {
        const merged = mergeRunningInstances([managed, managed], []);
        assert.strictEqual(merged.length, 1);
    });

    test('returns an empty list when nothing is running', () => {
        assert.deepStrictEqual(mergeRunningInstances([], []), []);
    });
});
```

Append to `src/test/postgres.test.ts`, inside the existing `suite`:

```ts
    test('parses active database names from the pg_stat_activity probe', () => {
        assert.deepStrictEqual(
            parseActiveDatabaseNames('shop-17\nshop-18\n\n  postgres  \n'),
            ['shop-17', 'shop-18', 'postgres']
        );
        assert.deepStrictEqual(parseActiveDatabaseNames(''), []);
        assert.deepStrictEqual(parseActiveDatabaseNames('   \n  '), []);
    });
```

Add `parseActiveDatabaseNames` to that file's existing import from `../services/database`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run compile-tests`
Expected: FAIL with `error TS2307: Cannot find module '../services/runningState'` and `error TS2305` for `parseActiveDatabaseNames`.

- [ ] **Step 3: Add the PostgreSQL probe**

In `src/services/database.ts`, add alongside the other query constants:

```ts
const ACTIVE_DATABASES_QUERY = `
    SELECT datname
    FROM pg_stat_activity
    WHERE datname IS NOT NULL
    GROUP BY datname;
`.trim();
```

Add these two exports at the end of the file:

```ts
export function parseActiveDatabaseNames(output: string): string[] {
    return output
        .split('\n')
        .map(entry => entry.trim())
        .filter(Boolean);
}

/**
 * Databases with at least one live backend, which catches servers started
 * from a terminal or another window - not just the ones this extension
 * launched. Queried through the `postgres` maintenance database because the
 * view is cluster-wide. Best-effort: an unreachable cluster reports nothing.
 */
export async function getActiveDatabaseNames(): Promise<string[]> {
    return runtimeCache.getActiveDatabases(async () => {
        try {
            return parseActiveDatabaseNames(await runPsqlQuery('postgres', ACTIVE_DATABASES_QUERY));
        } catch (error) {
            logger.debug('Could not read active databases from pg_stat_activity:', error);
            return [];
        }
    });
}
```

- [ ] **Step 4: Add the cache slot**

In `src/services/runtimeCache.ts`, add to `DEFAULT_TTLS`:

```ts
    activeDatabasesMs: 3000
```

Add the store to the class alongside the others:

```ts
    private readonly activeDatabases = new Map<string, TimedEntry<string[]>>();
```

Add the accessor next to `getGitBranch`:

```ts
    async getActiveDatabases(loader: () => Promise<string[]>, ttlMs = DEFAULT_TTLS.activeDatabasesMs): Promise<string[]> {
        // Cluster-wide, so a single key.
        return this.getOrComputeAsync(this.activeDatabases, 'cluster', ttlMs, loader);
    }

    invalidateActiveDatabasesCache(): void {
        this.activeDatabases.clear();
    }
```

Add `this.invalidateActiveDatabasesCache();` to `invalidateAll()`, and export the free function next to the others:

```ts
export function invalidateActiveDatabasesCache(): void {
    runtimeCache.invalidateActiveDatabasesCache();
}
```

- [ ] **Step 5: Write the running-state service**

Create `src/services/runningState.ts`:

```ts
/**
 * Which Odoo databases are live right now, from two merged signals: the
 * extension's own debug sessions (authoritative for what it started) and a
 * pg_stat_activity probe (catches servers started from a terminal or another
 * window). Exists as a service, not tree-decoration logic, so later features -
 * split-view comparison of two running instances - share one state source.
 */
import { SettingsStore } from '../settingsStore';
import { VersionsService } from '../versionsService';
import { getActiveDatabaseNames } from './database';
import { runningDebuggerNames } from './debugSessions';
import { resolveDbForVersion } from './dbResolution';
import { invalidateActiveDatabasesCache } from './runtimeCache';
import { logger } from './logger';

export interface RunningInstance {
    versionId?: string;
    debuggerName?: string;
    dbName: string;
    port?: number;
    origin: 'managed' | 'external';
}

/**
 * One entry per database. A managed instance always wins: it knows the
 * version and port, which the external probe cannot report.
 */
export function mergeRunningInstances(managed: RunningInstance[], external: RunningInstance[]): RunningInstance[] {
    const byDb = new Map<string, RunningInstance>();

    for (const instance of external) {
        byDb.set(instance.dbName, instance);
    }
    for (const instance of managed) {
        byDb.set(instance.dbName, instance);
    }

    return Array.from(byDb.values());
}

/** Sessions this extension started, resolved to the database each runs. */
async function collectManaged(): Promise<RunningInstance[]> {
    const names = new Set(runningDebuggerNames());
    if (names.size === 0) {
        return [];
    }

    // Read without getSelectedProject(): this runs on every tree refresh and
    // that helper toasts when no project is selected.
    const data = await SettingsStore.get('odoo-debugger-data.json').catch(() => undefined);
    const project = data?.projects?.find(entry => entry.isSelected);
    const dbs = project?.dbs ?? [];
    const selectedDbByVersion = project?.selectedDbByVersion;

    const instances: RunningInstance[] = [];
    for (const version of VersionsService.getInstance().getVersions()) {
        const debuggerName = version.settings?.debuggerName;
        if (!debuggerName || !names.has(debuggerName)) {
            continue;
        }
        const db = resolveDbForVersion(dbs, selectedDbByVersion, version.id);
        if (!db) {
            continue;
        }
        instances.push({
            versionId: version.id,
            debuggerName,
            dbName: db.id,
            port: Number(version.settings.portNumber) || undefined,
            origin: 'managed'
        });
    }

    return instances;
}

export async function getRunningInstances(): Promise<RunningInstance[]> {
    try {
        const [managed, activeNames] = await Promise.all([collectManaged(), getActiveDatabaseNames()]);
        const external: RunningInstance[] = activeNames.map(dbName => ({ dbName, origin: 'external' }));
        return mergeRunningInstances(managed, external);
    } catch (error) {
        logger.debug('Could not resolve running instances:', error);
        return [];
    }
}

/** Drops the cached PostgreSQL probe so the next read is fresh. */
export function invalidateRunningState(): void {
    invalidateActiveDatabasesCache();
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run compile-tests && npm run lint && npm run compile && npm test`
Expected: 118 passing (113 + 4 + 1), no `error TS`, no lint errors.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "[ADD] Running-state service merging debug sessions and pg_stat_activity"
```

---

### Task 8: Running indicators in the Databases view

Surfaces Task 6 in the tree, and refreshes it from the debug lifecycle events that already fire.

**Files:**
- Modify: `src/views/dbsView.ts:25-105`
- Modify: `src/extension.ts:79-94`
- Test: `src/test/runningState.test.ts` (extend)

**Interfaces:**
- Consumes: `getRunningInstances`, `invalidateRunningState`, `RunningInstance` (Task 7).
- Produces: `function runningDescriptionPart(instance: RunningInstance | undefined): string | undefined` in `src/services/runningState.ts`.

- [ ] **Step 1: Write the failing test**

Append to `src/test/runningState.test.ts`, inside the existing `suite`:

```ts
    test('describes running state as text, with the port when known', () => {
        assert.strictEqual(runningDescriptionPart(undefined), undefined);
        assert.strictEqual(
            runningDescriptionPart({ dbName: 'shop-17', port: 8017, origin: 'managed' }),
            'running :8017'
        );
        assert.strictEqual(
            runningDescriptionPart({ dbName: 'shop-17', origin: 'managed' }),
            'running'
        );
        assert.strictEqual(
            runningDescriptionPart({ dbName: 'shop-18', origin: 'external' }),
            'running (external)'
        );
    });
```

Add `runningDescriptionPart` to that file's import from `../services/runningState`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run compile-tests`
Expected: FAIL with `error TS2305: Module '"../services/runningState"' has no exported member 'runningDescriptionPart'`.

- [ ] **Step 3: Add the description helper**

In `src/services/runningState.ts`, add:

```ts
/**
 * The running marker for a database row, as plain text. TreeItem.description
 * does not render codicons - unlike a QuickPickItem - so state is carried by
 * words here, leaving the row's icon free to keep showing selection.
 */
export function runningDescriptionPart(instance: RunningInstance | undefined): string | undefined {
    if (!instance) {
        return undefined;
    }
    if (instance.origin === 'external') {
        return 'running (external)';
    }
    return instance.port ? `running :${instance.port}` : 'running';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run compile-tests && npm test`
Expected: 119 passing.

- [ ] **Step 5: Render the marker in the Databases view**

In `src/views/dbsView.ts`, add to the imports:

```ts
import { getRunningInstances, runningDescriptionPart, RunningInstance } from '../services/runningState';
```

In `getChildren`, replace the final return (line 41):

```ts
        return sortedDbs.map(db => this.buildDatabaseItem(db));
```

with:

```ts
        // Probed once per refresh, not once per row.
        const running = new Map<string, RunningInstance>(
            (await getRunningInstances()).map(instance => [instance.dbName, instance])
        );

        return sortedDbs.map(db => this.buildDatabaseItem(db, running.get(db.id)));
```

Change `buildDatabaseItem` (line 44) to take the instance and pass it through:

```ts
    private buildDatabaseItem(db: DatabaseModel, running?: RunningInstance): vscode.TreeItem {
```

and inside it, change the description line (line 58) to:

```ts
        treeItem.description = this.buildDescription(db, running);
```

Change `buildDescription` (line 74) to:

```ts
    /** Description shows running state, branch, version and origin as subtext. */
    private buildDescription(db: DatabaseModel, running?: RunningInstance): string {
        const parts: string[] = [];

        // Running state leads: when switching databases, what is already up
        // is the thing worth seeing first.
        const runningPart = runningDescriptionPart(running);
        if (runningPart) {
            parts.push(runningPart);
        }
```

leaving the rest of the method body unchanged.

In `buildTooltip`, add the running detail. Change the signature to accept it and add after the `**Internal name:**` line:

```ts
        if (running) {
            tooltipDetails.push(
                running.origin === 'managed'
                    ? `**Status:** running${running.port ? ` on port ${running.port}` : ''}`
                    : `**Status:** running outside this window`
            );
        }
```

Update the `buildTooltip` call site in `buildDatabaseItem` to pass `running`.

- [ ] **Step 6: Refresh the view when a session starts or stops**

In `src/extension.ts`, add to the imports:

```ts
import { invalidateRunningState } from './services/runningState';
```

Change the `registerServerLifecycle` call (lines 82-89) so the running-state cache is dropped and the views repaint whenever a session starts or terminates:

```ts
    registerServerLifecycle(context, {
        onRunningChanged: running => {
            updateServerRunningContext(running);
            // A session just started or stopped: the cached probe is stale and
            // the Databases view is showing the previous state.
            invalidateRunningState();
            void refreshViews();
        },
        getSelectedDbName: async () => {
            const result = await SettingsStore.getSelectedProject();
            const db = (result?.project.dbs as DatabaseModel[] | undefined)?.find(entry => entry.isSelected);
            return db?.id;
        }
    });
```

`refreshViews` is declared below this call as a `const` arrow function, so it is not initialised yet at registration time. Move the `registerServerLifecycle` block to just after `refreshViews` is defined (after line 129), keeping `updateServerRunningContext(false);` where it is.

- [ ] **Step 7: Verify the whole gate**

Run: `npm run compile-tests && npm run lint && npm run compile && npm test`
Expected: 119 passing, no `error TS`, no lint errors.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "[ADD] Running indicators in the Databases view"
```

---

### Task 9: Documentation and spec reconciliation

Brings the shipped docs in line with the behaviour, and records the one place the implementation deliberately differs from the spec.

**Files:**
- Modify: `docs/superpowers/specs/2026-08-27-native-version-provisioning-design.md` (§13 rendering paragraph)
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Correct the §13 rendering paragraph in the spec**

The spec says running state renders as `$(debug-alt)` / `$(pulse)` icons in the description. `TreeItem.description` does not render codicons, so the implementation uses words and leaves the icon showing selection. Replace that paragraph:

```markdown
Rendering follows the v1.2 rule that state is carried by icon **shape**, not color, so it survives row highlighting: `$(debug-alt)` for managed-running, `$(pulse)` for external, nothing for idle, with the port appended to the existing `•`-joined description. The green check for *selected* is unchanged and orthogonal.
```

with:

```markdown
Rendering keeps running state and selection on separate channels. `TreeItem.description` does not render codicons (unlike a `QuickPickItem`), so the marker is words rather than an icon: `running :8017` for managed-running, `running (external)` for a server started elsewhere, nothing for idle, prepended to the existing `•`-joined description. The row's icon is left entirely to selection — the green check is unchanged and orthogonal — so a selected database that is also running reads as both.
```

- [ ] **Step 2: Document the behaviour in the README**

In `README.md`, in the Versions section, add:

```markdown
Each version's **debugger name, HTTP port and shell port are derived from its branch** — `odoo:17.0` on ports 8017/5017, `odoo:18.0` on 8018/5018 — and shown in the Versions tree as read-only rows. That is what lets two versions run at the same time, which is the point when you are comparing a database before and after an upgrade. `odooDebugger.debuggerNamePrefix` changes the `odoo` part; the ports follow the series and step upward if something else has already claimed one.

Every provisioned version gets its own durable entry in `.vscode/launch.json`, each carrying its own database, so the Run and Debug dropdown works as a version switcher. Databases remember which version last launched them, and the Databases view marks the ones that are live — `running :8017` for a server this extension started, `running (external)` for one started from a terminal or another window.

Because launch entries are stable and unique, F5 follows whatever the Run and Debug dropdown has selected, while `Ctrl+Alt+O S` always follows the *active* version. That divergence is deliberate: it is what lets you debug one version from the dropdown while launching another from the chord.

Generated project workspaces now also include the active version's own `odoo`, `enterprise` and `design-themes` checkouts, so files you open belong to the version you are running and breakpoints bind to the right worktree.
```

- [ ] **Step 3: Add the CHANGELOG entries**

In `CHANGELOG.md`, under the unreleased/current heading:

```markdown
- Versions can now run in parallel: each derives a unique debugger name and port pair from its branch (`odoo:17.0` on 8017/5017), shown read-only in the Versions tree. Existing versions are healed only where they collide.
- `odooDebugger.defaultVersion.debuggerName`, `.portNumber` and `.shellPortNumber` are removed — they made every version share one identity, so two versions overwrote each other's `launch.json` entry. `odooDebugger.debuggerNamePrefix` replaces them.
- Each provisioned version gets its own durable `launch.json` entry with its own database, so the Run and Debug dropdown switches versions and F5 launches the one it names.
- Databases are remembered per version, and the Databases view marks which ones are live (`running :8017`, or `running (external)` for servers started outside this window).
- Stop Server now targets the active version's session, prompting only when several versions are running and none is the active one.
- Generated project workspaces include the active version's core checkouts, so opened files and breakpoints belong to the version being run.
```

- [ ] **Step 4: Verify the whole gate one final time**

Run: `npm run compile-tests && npm run lint && npm run compile && npm test`
Expected: 119 passing, no `error TS`, no lint errors.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "[DOC] Document parallel version execution and running indicators"
```

---

## Manual verification

Automated tests cover the pure logic; these are the behaviours only a running extension can confirm. Run them in the Extension Development Host against a workspace with at least two provisioned versions (17.0 and 18.0).

1. **Identity is derived and read-only.** Open the Versions view, expand 17.0. `Debugger`, `Port` and `Shell Port` read `odoo:17.0`, `8017`, `5017`, are described as *derived from branch*, and clicking one shows the explanatory message instead of an input box.
2. **Healing on load.** Before upgrading, both existing versions share `odoo:19.0`/`8019`. After the first activation, the newer one has been re-derived; the "Odoo DevTools" output channel logs the `[identity]` line naming the change.
3. **Two launch entries.** `.vscode/launch.json` contains one entry per provisioned version, each with its own `-p` and `-d`. Any user-added configurations and comments in that file are intact.
4. **Parallel run.** Start 17.0 from the Run and Debug dropdown, then start 18.0. Both stay up; `http://localhost:8017` and `http://localhost:8018` each serve their own database.
5. **Running indicators.** With both up, the Databases view shows `running :8017` and `running :8018` on the right rows. Stop 18.0 and its marker clears without a manual refresh.
6. **External detection.** Start an Odoo server from a terminal against a third database; that row shows `running (external)`.
7. **Stop Server disambiguation.** With both running and 17.0 active, `Ctrl+Alt+O` then the stop chord stops 17.0 without prompting. Activate a third version that is not running and repeat: a picker offers the two running names.
8. **Per-version database memory.** With 17.0 active, select database A; activate 18.0 and select database B; return to 17.0 — its launch entry still names A.
9. **Workspace folders.** With 17.0 active, rebuild the project workspace. It lists the project repos plus `odoo (Odoo 17.0)`, `enterprise (Odoo 17.0)` and `design-themes (Odoo 17.0)`, pointing at that version's worktrees rather than the source repo.
10. **Port already in use.** Occupy 8018 with an unrelated process (`python3 -m http.server 8018`), then create an 18.0 version. It derives 8019 rather than a port it cannot bind.
