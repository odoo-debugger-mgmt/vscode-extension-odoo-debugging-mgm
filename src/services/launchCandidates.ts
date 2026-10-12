/**
 * The versions that get a launch entry: every provisioned one, and the active
 * one. Versions sharing a debugger name share one entry, written for the
 * owner among these (see sessionOwner) - so a session of that name is that
 * version's too, wherever it is looked up.
 */
import { isVersionProvisioned } from './provisioning';
import { resolveOptionalPath } from '../utils';

export function launchCandidates<T extends { id: string; settings: { pythonPath?: string } }>(
    versions: T[],
    activeVersion: T | undefined
): T[] {
    const candidates = versions.filter(version => isVersionProvisioned(resolveOptionalPath(version.settings.pythonPath)));
    if (activeVersion && !candidates.some(version => version.id === activeVersion.id)) {
        candidates.push(activeVersion);
    }
    return candidates;
}
