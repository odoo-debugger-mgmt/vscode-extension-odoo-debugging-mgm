/**
 * Which Odoo versions to offer, and why. The strongest signal is already on
 * disk: a custom repository sitting on `17.0-bunka` says the user needs a
 * 17.0 version far more reliably than any hardcoded "latest three" list.
 *
 * Pure: takes the branches and returns rows. The scanning that produces those
 * branches lives in the callers.
 */
import { parseOdooSeries } from './database';

export interface RepoBranch {
    repoName: string;
    branch: string;
}

export interface VersionCandidate {
    branch: string;
    /** Shown as the row description: why this is being offered. */
    reason: string;
    picked: boolean;
}

/** How many series rows are offered beyond the repo-derived ones. */
export const MAX_SERIES_ROWS = 4;

/**
 * The Odoo series a branch belongs to. `parseOdooSeries` already turns
 * `17.0-bunka` into `17.0` and `saas-18.4-client` into `saas-18.4`; only
 * `master`, which carries no numbers, needs handling here.
 */
export function branchToSeries(branch: string): string | undefined {
    const trimmed = branch?.trim();
    if (!trimmed) {
        return undefined;
    }
    if (/^master$/i.test(trimmed)) {
        return 'master';
    }
    return parseOdooSeries(trimmed);
}

function seriesReason(branch: string, index: number): string {
    if (/^master$/i.test(branch)) {
        return 'development branch';
    }
    return index === 0 ? 'latest stable' : 'stable release';
}

export function proposeVersions(
    repoBranches: RepoBranch[],
    seriesBranches: string[],
    existing: string[]
): VersionCandidate[] {
    const taken = new Set(existing.map(entry => entry.trim()).filter(Boolean));
    const candidates: VersionCandidate[] = [];
    const seen = new Set<string>();

    // Repo-derived rows first: the user's own branches are the strongest
    // statement about which versions they need.
    for (const entry of repoBranches) {
        const series = branchToSeries(entry.branch);
        if (!series || taken.has(series) || seen.has(series)) {
            continue;
        }
        seen.add(series);
        candidates.push({
            branch: series,
            reason: `${entry.repoName} has ${entry.branch.trim()}`,
            picked: true
        });
    }

    let offered = 0;
    for (const branch of seriesBranches) {
        if (offered >= MAX_SERIES_ROWS) {
            break;
        }
        const trimmed = branch.trim();
        if (!trimmed || taken.has(trimmed) || seen.has(trimmed)) {
            continue;
        }
        seen.add(trimmed);
        candidates.push({
            branch: trimmed,
            reason: seriesReason(trimmed, offered),
            // Nothing else suggested a version: offer to build the newest.
            picked: candidates.length === 0
        });
        offered += 1;
    }

    return candidates;
}
