import { SettingsStore } from '../settingsStore';
import { listPostgresDatabases, runSql } from './postgres';
import { checkpointsOf, CHECKPOINT_COMMENTS_SQL, parseCheckpointComments, findOrphanCheckpoints, CheckpointModel } from './checkpoints';
import { logger } from './logger';
import type { DatabaseModel } from '../models/db';
import type { DatabaseTemplateModel } from '../models/dbTemplate';

/**
 * Reconciliation between the workspace data file and the live PostgreSQL
 * instance: databases and templates are global to PostgreSQL, so references
 * stored here can go stale when a database is dropped elsewhere (another
 * workspace, psql, ...).
 */

export interface StaleDatabaseReference {
    projectName: string;
    db: DatabaseModel;
}

export interface StaleCheckpointReference {
    projectName: string;
    dbId: string;
    checkpoint: CheckpointModel;
}

export interface StaleReferences {
    databases: StaleDatabaseReference[];
    templates: DatabaseTemplateModel[];
    checkpoints: StaleCheckpointReference[];
    orphanCheckpoints: Array<{ name: string; source: string }>;
}

/** Checkpoint records whose database is gone, and every name recorded at all. */
export function collectStaleCheckpoints(
    projects: Array<{ name: string; dbs?: Array<{ id?: string; checkpoints?: unknown }> }>,
    existingLower: Set<string>
): { stale: StaleCheckpointReference[]; recorded: Set<string> } {
    const stale: StaleCheckpointReference[] = [];
    const recorded = new Set<string>();
    for (const project of projects) {
        for (const db of project.dbs ?? []) {
            for (const checkpoint of checkpointsOf(db ?? {})) {
                recorded.add(checkpoint.id.toLowerCase());
                if (db?.id && !existingLower.has(checkpoint.id.toLowerCase())) {
                    stale.push({ projectName: project.name, dbId: db.id, checkpoint });
                }
            }
        }
    }
    return { stale, recorded };
}

/**
 * Returns references to PostgreSQL databases that no longer exist, or
 * undefined when PostgreSQL is unreachable (nothing can be verified then).
 */
export async function findStaleReferences(): Promise<StaleReferences | undefined> {
    const existing = await listPostgresDatabases();
    if (existing.length === 0) {
        // psql unavailable or no databases at all: treat as unverifiable
        // rather than flagging everything as stale.
        return undefined;
    }
    const existingLower = new Set(existing.map(name => name.toLowerCase()));

    const data = await SettingsStore.get('odoo-debugger-data.json');

    const databases: StaleDatabaseReference[] = [];
    for (const project of data.projects ?? []) {
        for (const db of project.dbs ?? []) {
            if (db?.id && !existingLower.has(db.id.toLowerCase())) {
                databases.push({ projectName: project.name, db });
            }
        }
    }

    const templates = (data.dbTemplates ?? []).filter(template =>
        template.templateDbName && !existingLower.has(template.templateDbName.toLowerCase())
    );

    const { stale: checkpoints, recorded } = collectStaleCheckpoints(data.projects ?? [], existingLower);
    let orphanCheckpoints: Array<{ name: string; source: string }> = [];
    try {
        orphanCheckpoints = findOrphanCheckpoints(parseCheckpointComments(await runSql('postgres', CHECKPOINT_COMMENTS_SQL)), existingLower, recorded);
    } catch (error) {
        logger.debug('Could not read checkpoint comments:', error);
    }

    return { databases, templates, checkpoints, orphanCheckpoints };
}

/** Activation-time check: logs stale references, never prompts. */
export async function logStaleReferences(): Promise<void> {
    try {
        const stale = await findStaleReferences();
        if (!stale) {
            return;
        }
        const total = stale.databases.length + stale.templates.length + stale.checkpoints.length + stale.orphanCheckpoints.length;
        if (total === 0) {
            return;
        }
        logger.warn(
            `${total} stored reference(s) point to PostgreSQL databases that no longer exist ` +
            `(${stale.databases.map(entry => entry.db.id).join(', ')}${stale.templates.length ? `; templates: ${stale.templates.map(t => t.templateDbName).join(', ')}` : ''}). ` +
            'Run "Reconcile Databases" from the Databases view to clean them up.'
        );
    } catch (error) {
        logger.debug('Stale-reference check failed:', error);
    }
}
