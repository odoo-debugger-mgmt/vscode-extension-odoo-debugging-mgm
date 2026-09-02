/**
 * The queue that builds versions one at a time.
 *
 * Setup can select several versions at once. Building them all inside one
 * progress notification means watching a bar for ten minutes before touching
 * anything, so the first is built in the foreground and the rest are queued.
 * One at a time, deliberately: concurrent `pip install`s contend for the same
 * wheel cache and finish no sooner than sequential ones.
 *
 * The transitions are pure and tested as data; only the accessors at the
 * bottom touch vscode. State is persisted so a window reload resumes the
 * queue rather than silently dropping what is left.
 */
import type * as vscode from 'vscode';
import { logger } from './logger';
import { showInfo } from './notifications';

export interface QueuedVersion {
    branch: string;
    name: string;
}

export interface QueueState {
    /** The entry being built right now, if any. */
    active?: QueuedVersion;
    pending: QueuedVersion[];
}

export const EMPTY_QUEUE: QueueState = { pending: [] };

export const QUEUE_STATE_KEY = 'odt.provisionQueue';

function knownBranches(state: QueueState): Set<string> {
    const branches = new Set(state.pending.map(entry => entry.branch));
    if (state.active) {
        branches.add(state.active.branch);
    }
    return branches;
}

/** Appends entries, skipping any branch already queued or being built. */
export function enqueue(state: QueueState, entries: QueuedVersion[]): QueueState {
    const known = knownBranches(state);
    const added: QueuedVersion[] = [];

    for (const entry of entries) {
        if (known.has(entry.branch)) {
            continue;
        }
        known.add(entry.branch);
        added.push(entry);
    }

    return { active: state.active, pending: [...state.pending, ...added] };
}

/** Promotes the head to active. A queue that is already busy is unchanged. */
export function takeNext(state: QueueState): QueueState {
    if (state.active || state.pending.length === 0) {
        return state;
    }
    const [next, ...rest] = state.pending;
    return { active: next, pending: rest };
}

/**
 * Clears the active entry. Success and failure share this transition: an
 * entry is removed either way, so one unbuildable branch cannot wedge the
 * queue behind it.
 */
export function finishActive(state: QueueState): QueueState {
    return { active: undefined, pending: state.pending };
}

/** What the Versions row should say for a branch, if the queue owns it. */
export function queueLabel(state: QueueState, branch: string): 'building…' | 'queued' | undefined {
    if (state.active?.branch === branch) {
        return 'building…';
    }
    return state.pending.some(entry => entry.branch === branch) ? 'queued' : undefined;
}

/**
 * Whether a queued branch should rebuild a version that already exists or
 * create a new one.
 *
 * The queue serves two callers with the same entries: setup, where no version
 * exists yet, and the migration offer, where one does and must be repointed
 * rather than duplicated. Creating unconditionally left the legacy version in
 * place, still pointing at its hand-built paths, beside a new version that
 * derived a different port because the original had taken the matching one.
 */
export function resolveQueueTarget(
    branch: string,
    versions: Array<{ id: string; odooVersion?: string }>
): { kind: 'rebuild'; versionId: string } | { kind: 'create' } {
    const wanted = branch.trim();
    const existing = versions.find(version => (version.odooVersion ?? '').trim() === wanted);
    return existing ? { kind: 'rebuild', versionId: existing.id } : { kind: 'create' };
}

/** One summary sentence for the whole drain, rather than one per version. */
export function describeDrain(succeeded: string[], failed: string[]): string {
    const parts: string[] = [];
    if (succeeded.length > 0) {
        parts.push(`Provisioned ${succeeded.join(', ')}.`);
    }
    if (failed.length > 0) {
        parts.push(`Failed: ${failed.join(', ')} - use Check Version Environments to retry.`);
    }
    return parts.join(' ');
}

// ---------------------------------------------------------------------------
// vscode-backed accessors
// ---------------------------------------------------------------------------

export function readQueue(context: vscode.ExtensionContext): QueueState {
    const stored = context.globalState.get<QueueState>(QUEUE_STATE_KEY);
    if (!stored || !Array.isArray(stored.pending)) {
        return EMPTY_QUEUE;
    }
    return { active: stored.active, pending: stored.pending };
}

export async function writeQueue(context: vscode.ExtensionContext, state: QueueState): Promise<void> {
    await context.globalState.update(QUEUE_STATE_KEY, state);
}

/**
 * The tree builds its items synchronously, so it cannot await `readQueue`.
 * The runner keeps this snapshot in step with what it persists.
 */
let snapshot: QueueState = EMPTY_QUEUE;

export function currentQueueSnapshot(): QueueState {
    return snapshot;
}

export function setQueueSnapshot(state: QueueState): void {
    snapshot = state;
}

/**
 * How the queue builds one version. Injected at activation rather than
 * imported: `odooInstaller` pulls in the whole provisioning stack and imports
 * this module's siblings, so a direct import would be a cycle.
 */
export type QueueProvisioner = (branch: string, name: string) => Promise<boolean>;

let provisioner: QueueProvisioner | undefined;

export function setQueueProvisioner(fn: QueueProvisioner): void {
    provisioner = fn;
}

let draining = false;

async function persist(
    context: vscode.ExtensionContext,
    state: QueueState,
    onProgress: () => void
): Promise<void> {
    setQueueSnapshot(state);
    await writeQueue(context, state);
    onProgress();
}

/**
 * Builds every queued version, one at a time, reporting once at the end.
 * Re-entrant calls return immediately: activation and a fresh enqueue can
 * both ask for a drain, and only one may run.
 */
export async function drainProvisionQueue(
    context: vscode.ExtensionContext,
    onProgress: () => void = () => undefined
): Promise<void> {
    if (draining || !provisioner) {
        return;
    }
    draining = true;

    const succeeded: string[] = [];
    const failed: string[] = [];

    try {
        for (;;) {
            const next = takeNext(readQueue(context));
            if (!next.active) {
                break;
            }
            const entry = next.active;
            await persist(context, next, onProgress);

            try {
                const built = await provisioner(entry.branch, entry.name);
                (built ? succeeded : failed).push(entry.branch);
            } catch (error) {
                logger.warn(`[queue] provisioning ${entry.branch} failed:`, error);
                failed.push(entry.branch);
            }

            await persist(context, finishActive(readQueue(context)), onProgress);
        }
    } finally {
        draining = false;
    }

    if (succeeded.length + failed.length > 0) {
        void showInfo(describeDrain(succeeded, failed));
    }
}

/**
 * Clears everything not yet built. Versions already provisioned are left
 * alone: this stops future work, it does not undo finished work.
 */
export async function stopProvisionQueue(context: vscode.ExtensionContext): Promise<void> {
    const state = readQueue(context);
    const cleared: QueueState = { active: state.active, pending: [] };
    setQueueSnapshot(cleared);
    await writeQueue(context, cleared);
}

/**
 * The in-flight drain's companion: offered while entries remain so a long
 * build can be abandoned without waiting it out.
 */
export async function offerStop(context: vscode.ExtensionContext, remaining: number): Promise<void> {
    if (remaining === 0) {
        return;
    }
    const choice = await showInfo(`Building ${remaining} more version(s).`, 'Stop Building');
    if (choice === 'Stop Building') {
        await stopProvisionQueue(context);
        void showInfo('Stopped. Versions already built are untouched.');
    }
}
