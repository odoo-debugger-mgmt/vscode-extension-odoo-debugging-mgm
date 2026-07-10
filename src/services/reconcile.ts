import { SettingsStore } from '../settingsStore';
import { listPostgresDatabases } from './postgres';
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

export interface StaleReferences {
    databases: StaleDatabaseReference[];
    templates: DatabaseTemplateModel[];
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

    return { databases, templates };
}

/** Activation-time check: logs stale references, never prompts. */
export async function logStaleReferences(): Promise<void> {
    try {
        const stale = await findStaleReferences();
        if (!stale) {
            return;
        }
        const total = stale.databases.length + stale.templates.length;
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
