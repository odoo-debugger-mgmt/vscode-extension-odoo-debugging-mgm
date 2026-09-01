/**
 * Whether this machine is set up: where the Odoo source repository lives and
 * where per-version environments are built. Both are infrastructure rather
 * than per-version defaults, so they are stored at user scope - one setup
 * covers every workspace - with a workspace override available.
 *
 * The predicates are pure and take an `exists` probe so they can be tested;
 * only the read/write helpers at the bottom touch vscode and the filesystem.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { logger } from './logger';

export interface SetupState {
    sourceRepo?: string;
    enterpriseRepo?: string;
    designThemesRepo?: string;
    provisioningRoot: string;
    isConfigured: boolean;
}

export interface RawSetupSettings {
    sourceRepo?: string;
    enterpriseRepo?: string;
    designThemesRepo?: string;
    provisioningRoot?: string;
}

export type ExistsProbe = (candidate: string) => boolean;

export const DEFAULT_PROVISIONING_DIRNAME = 'odoo-dev';

/** Where environments are built when nothing is configured. */
export function defaultProvisioningRoot(home: string = os.homedir()): string {
    return path.join(home, DEFAULT_PROVISIONING_DIRNAME);
}

/**
 * An Odoo source repository is a directory holding `odoo-bin`. Checking the
 * contents rather than just the path means a repo that was moved or deleted
 * reads as unconfigured, which routes the user back to setup instead of into
 * a provisioning failure.
 */
export function isOdooSourceRepo(dir: string | undefined, exists: ExistsProbe): boolean {
    const trimmed = dir?.trim();
    return !!trimmed && exists(path.join(trimmed, 'odoo-bin'));
}

/** A configured path only counts when it is actually there. */
function presentDir(dir: string | undefined, exists: ExistsProbe): string | undefined {
    const trimmed = dir?.trim();
    return trimmed && exists(trimmed) ? trimmed : undefined;
}

export function evaluateSetup(
    raw: RawSetupSettings,
    exists: ExistsProbe,
    home: string = os.homedir()
): SetupState {
    const sourceRepo = raw.sourceRepo?.trim() || undefined;
    const configured = isOdooSourceRepo(sourceRepo, exists);

    return {
        sourceRepo: configured ? sourceRepo : undefined,
        enterpriseRepo: presentDir(raw.enterpriseRepo, exists),
        designThemesRepo: presentDir(raw.designThemesRepo, exists),
        provisioningRoot: raw.provisioningRoot?.trim() || defaultProvisioningRoot(home),
        isConfigured: configured
    };
}

// ---------------------------------------------------------------------------
// vscode-backed accessors
// ---------------------------------------------------------------------------

function config() {
    return vscode.workspace.getConfiguration('odooDebugger');
}

export function readRawSetupSettings(): RawSetupSettings {
    const settings = config();
    return {
        sourceRepo: settings.get<string>('sourceRepo.odoo', ''),
        enterpriseRepo: settings.get<string>('sourceRepo.enterprise', ''),
        designThemesRepo: settings.get<string>('sourceRepo.designThemes', ''),
        provisioningRoot: settings.get<string>('provisioning.root', '')
    };
}

export function readSetupState(): SetupState {
    return evaluateSetup(readRawSetupSettings(), candidate => fs.existsSync(candidate));
}

/**
 * Writes the setup at user scope so it survives into every other workspace -
 * the "set up once and forget" model. A workspace that already overrides a
 * key keeps its override; overwriting it here would silently retarget a
 * client folder that was deliberately pointed elsewhere.
 */
export async function writeSetupSettings(values: RawSetupSettings): Promise<void> {
    const settings = config();
    const entries: Array<[string, string | undefined]> = [
        ['sourceRepo.odoo', values.sourceRepo],
        ['sourceRepo.enterprise', values.enterpriseRepo],
        ['sourceRepo.designThemes', values.designThemesRepo],
        ['provisioning.root', values.provisioningRoot]
    ];

    for (const [key, value] of entries) {
        if (value === undefined) {
            continue;
        }
        await settings.update(key, value, vscode.ConfigurationTarget.Global);
    }
    logger.info(`[setup] wrote source repo ${values.sourceRepo ?? '(unchanged)'} at user scope`);
}

/**
 * Adopts a pre-existing `defaultVersion.odooPath` as the source repo. Before
 * this design that key doubled as the repo worktrees were cut from, so anyone
 * already working has it pointed at a real checkout; adopting it means the
 * upgrade does not interrupt them.
 */
export function shouldAdoptLegacySourceRepo(
    raw: RawSetupSettings,
    legacyOdooPath: string | undefined,
    exists: ExistsProbe
): string | undefined {
    if (raw.sourceRepo?.trim()) {
        return undefined;
    }
    return isOdooSourceRepo(legacyOdooPath, exists) ? legacyOdooPath!.trim() : undefined;
}
