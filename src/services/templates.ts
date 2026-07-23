import { DatabaseTemplateModel } from '../models/dbTemplate';
import { SettingsStore } from '../settingsStore';
import { stripSettings, DebuggerData } from '../utils';
import { RESERVED_DATABASE_NAMES } from './postgres';

/**
 * Database-template metadata management. A template is a PostgreSQL database
 * (cloned via `createdb -T`) plus a metadata record stored in the workspace
 * data file. `templateDbName` is the real PostgreSQL name; `name` is a label
 * kept in sync with it (legacy records that only carry `name` are healed on
 * load by sanitizeDatabaseTemplates).
 */

export const TEMPLATE_DB_NAME_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/;

/** Normalizes raw stored/imported template records, deduping by DB name. */
export function sanitizeDatabaseTemplates(source: unknown): DatabaseTemplateModel[] {
    if (!Array.isArray(source)) {
        return [];
    }

    const seenTemplateDbNames = new Set<string>();
    const normalized: DatabaseTemplateModel[] = [];

    for (const entry of source) {
        if (!entry || typeof entry !== 'object') {
            continue;
        }

        const candidate = entry as Partial<DatabaseTemplateModel> & { [key: string]: unknown };
        const templateDbName = typeof candidate.templateDbName === 'string'
            ? candidate.templateDbName.trim()
            : typeof candidate.name === 'string'
                ? candidate.name.trim()
                : '';

        if (!templateDbName) {
            continue;
        }

        const dedupeKey = templateDbName.toLowerCase();
        if (seenTemplateDbNames.has(dedupeKey)) {
            continue;
        }
        seenTemplateDbNames.add(dedupeKey);

        const name = typeof candidate.name === 'string' && candidate.name.trim() !== ''
            ? candidate.name.trim()
            : templateDbName;
        const sourceDbName = typeof candidate.sourceDbName === 'string' && candidate.sourceDbName.trim() !== ''
            ? candidate.sourceDbName.trim()
            : undefined;
        const createdAt = typeof candidate.createdAt === 'string' && candidate.createdAt.trim() !== ''
            ? candidate.createdAt
            : new Date().toISOString();
        const updatedAt = typeof candidate.updatedAt === 'string' && candidate.updatedAt.trim() !== ''
            ? candidate.updatedAt
            : undefined;

        normalized.push({
            name,
            templateDbName,
            sourceDbName,
            createdAt,
            updatedAt
        });
    }

    return normalized.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/** Input validation for template PostgreSQL names. */
export function validateTemplateDatabaseName(value: string, existingTemplateNames: Set<string>, originalName?: string): string | null {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
        return 'Template name cannot be empty.';
    }

    if (!TEMPLATE_DB_NAME_PATTERN.test(trimmed)) {
        return 'Use letters, numbers, "-" or "_" only. The name must not start with "-".';
    }

    if (RESERVED_DATABASE_NAMES.has(trimmed.toLowerCase())) {
        return `"${trimmed}" is reserved and cannot be used as a template name.`;
    }

    const isRenamingSameTemplate = originalName && originalName.toLowerCase() === trimmed.toLowerCase();
    if (!isRenamingSameTemplate && existingTemplateNames.has(trimmed.toLowerCase())) {
        return 'A template with this PostgreSQL name already exists.';
    }

    return null;
}

/** Persists a normalized template list into the workspace data file. */
export async function persistDatabaseTemplates(data: DebuggerData, templates: DatabaseTemplateModel[]): Promise<DatabaseTemplateModel[]> {
    const normalized = sanitizeDatabaseTemplates(templates);
    data.dbTemplates = normalized;
    await SettingsStore.saveWithoutComments(stripSettings(data));
    return normalized;
}
