import * as crypto from 'crypto';

export type DatabaseKind = 'dump' | 'fresh' | 'dev' | 'test' | 'feature' | 'clone' | 'temp' | 'shell' | 'existing';

export interface DatabaseNamingOptions {
    projectName: string;
    kind: DatabaseKind | string;
    timestamp?: Date;
    deterministicSeed?: string;
    existingInternalNames?: Set<string>;
}

export interface DatabaseIdentifiers {
    internalName: string;
    displayName: string;
    hash: string;
}

const MAX_IDENTIFIER_LENGTH = 63;

const KIND_LABELS: Record<string, string> = {
    dump: 'Dump',
    fresh: 'Fresh',
    dev: 'Dev',
    test: 'Test',
    feature: 'Feature',
    clone: 'Clone',
    temp: 'Temp',
    shell: 'Shell',
    existing: 'Existing'
};

function slugifySegment(value: string | undefined, fallback: string): string {
    if (!value || value.trim().length === 0) {
        return fallback;
    }

    const normalized = value
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '');

    return normalized || fallback;
}

function shortHash(input: string): string {
    return crypto.createHash('sha1').update(input).digest('hex').slice(0, 6);
}

function formatDateStamp(date: Date): string {
    const day = `${date.getUTCDate()}`.padStart(2, '0');
    const month = `${date.getUTCMonth() + 1}`.padStart(2, '0');
    const year = `${date.getUTCFullYear()}`;
    return `${day}${month}${year}`;
}

function formatDisplayDate(date: Date): string {
    try {
        return new Intl.DateTimeFormat(undefined, {
            year: 'numeric',
            month: 'short',
            day: '2-digit'
        }).format(date);
    } catch {
        return date.toISOString().split('T')[0];
    }
}

function buildInternalIdentifier(projectSlug: string, kindSlug: string, dateStamp: string, hash: string): string {
    const suffix = `_${hash}`;
    let prefix = `${projectSlug}_${kindSlug}_${dateStamp}`;

    if (prefix.length + suffix.length > MAX_IDENTIFIER_LENGTH) {
        const allowed = MAX_IDENTIFIER_LENGTH - suffix.length;
        prefix = prefix.slice(0, Math.max(1, allowed));
        prefix = prefix.replace(/_+$/g, '');
        if (!prefix) {
            prefix = 'db';
        }
    }

    return `${prefix}${suffix}`;
}

function buildDisplayName(projectName: string, kindSlug: string, date: Date, hash: string): string {
    const trimmedName = projectName.trim() || 'Odoo Database';
    const kindLabel = KIND_LABELS[kindSlug] || kindSlug.replace(/_/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
    const prettyDate = formatDisplayDate(date);
    return `${trimmedName} • ${kindLabel} • ${prettyDate} • #${hash}`;
}

export function generateDatabaseIdentifiers(options: DatabaseNamingOptions): DatabaseIdentifiers {
    const timestamp = options.timestamp ?? new Date();
    const projectSlug = slugifySegment(options.projectName, 'project');
    const kindSlug = slugifySegment(options.kind, 'db');
    const dateStamp = formatDateStamp(timestamp);
    const existing = options.existingInternalNames ?? new Set<string>();

    const baseSeed = options.deterministicSeed ?? `${projectSlug}|${kindSlug}|${timestamp.toISOString()}|${crypto.randomUUID()}`;
    let attempt = 0;
    let internalName: string;
    let hash: string;

    do {
        const attemptSeed = attempt === 0 ? baseSeed : `${baseSeed}|${attempt}`;
        hash = shortHash(attemptSeed);
        internalName = buildInternalIdentifier(projectSlug, kindSlug, dateStamp, hash);
        attempt++;
    } while (existing.has(internalName.toLowerCase()));

    return {
        internalName,
        displayName: buildDisplayName(options.projectName, kindSlug, timestamp, hash),
        hash
    };
}
