/**
 * Comparison partner: the database (or checkpoint) a database is compared
 * with. Pure rules, no vscode import. Projects from the store are plain JSON,
 * so every field is read through a normalizer.
 */
import { checkpointsOf } from './checkpoints';

export type PartnerKind = 'database' | 'checkpoint';

export interface PartnerModel {
    dbName: string;
    kind: PartnerKind;
}

export interface PartnerProject {
    dbs?: Array<{ id: string; versionId?: string; comparePartner?: unknown; checkpoints?: unknown; clonedFrom?: unknown }>;
    upgradeConfig?: unknown;
}

export interface ResolvedPartner {
    dbName: string;
    kind: PartnerKind;
    source: 'upgrade' | 'stored';
    versionId?: string;
    label: string;
}

interface PartnerPair {
    original: { dbName: string; versionId?: string };
    upgraded: { dbName: string; versionId?: string };
}

export function partnerOf(db: { comparePartner?: unknown }): PartnerModel | undefined {
    const raw = db.comparePartner;
    if (!raw || typeof raw !== 'object') {
        return undefined;
    }
    const { dbName, kind } = raw as { dbName?: unknown; kind?: unknown };
    if (typeof dbName !== 'string' || dbName.trim() === '' || (kind !== 'database' && kind !== 'checkpoint')) {
        return undefined;
    }
    return { dbName: dbName.trim(), kind };
}

export function setPartner(db: { comparePartner?: unknown }, partner: PartnerModel | undefined): void {
    db.comparePartner = partner ? { dbName: partner.dbName, kind: partner.kind } : undefined;
}

export function resolveStoredPartner(
    project: PartnerProject | undefined,
    dbId: string,
    pair: PartnerPair | undefined
): ResolvedPartner | undefined {
    if (pair) {
        const other = dbId === pair.original.dbName ? pair.upgraded
            : dbId === pair.upgraded.dbName ? pair.original : undefined;
        if (other) {
            return { dbName: other.dbName, kind: 'database', source: 'upgrade', versionId: other.versionId, label: other.dbName };
        }
    }
    const dbs = project?.dbs ?? [];
    const db = dbs.find(d => d.id === dbId);
    const partner = db ? partnerOf(db) : undefined;
    if (!db || !partner) {
        return undefined;
    }
    if (partner.kind === 'database') {
        const target = dbs.find(d => d.id === partner.dbName);
        return target
            ? { dbName: partner.dbName, kind: 'database', source: 'stored', versionId: target.versionId, label: partner.dbName }
            : undefined;
    }
    const checkpoint = checkpointsOf(db).find(c => c.id === partner.dbName);
    return checkpoint
        ? { dbName: checkpoint.id, kind: 'checkpoint', source: 'stored', versionId: db.versionId, label: checkpoint.label }
        : undefined;
}

export function comparisonSides(
    current: string,
    partner: ResolvedPartner,
    pair?: { original: { dbName: string } }
): { left: string; right: string; editable: 'left' | 'right' | 'none' } {
    if (pair && partner.source === 'upgrade') {
        const left = pair.original.dbName;
        return { left, right: left === current ? partner.dbName : current, editable: 'right' };
    }
    return { left: partner.dbName, right: current, editable: 'right' };
}

export function isCopyPartner(project: PartnerProject | undefined, dbId: string, partner: ResolvedPartner): boolean {
    if (partner.kind === 'checkpoint' || partner.source === 'upgrade') {
        return true;
    }
    const dbs = project?.dbs ?? [];
    const clonedFrom = (id: string) => dbs.find(d => d.id === id)?.clonedFrom;
    return clonedFrom(partner.dbName) === dbId || clonedFrom(dbId) === partner.dbName;
}

export function partnerChoices(
    project: PartnerProject | undefined,
    dbId: string,
    running: ReadonlySet<string>
): Array<{ dbName: string; kind: PartnerKind; label: string; running: boolean }> {
    const dbs = project?.dbs ?? [];
    const others = dbs
        .filter(d => d.id !== dbId)
        .map(d => ({ dbName: d.id, kind: 'database' as const, label: d.id, running: running.has(d.id) }));
    const live = others.filter(c => c.running);
    const stopped = others.filter(c => !c.running);
    const own = dbs.find(d => d.id === dbId);
    const checkpoints = own
        ? checkpointsOf(own)
            .slice()
            .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
            .map(c => ({ dbName: c.id, kind: 'checkpoint' as const, label: c.label, running: running.has(c.id) }))
        : [];
    return [...live, ...stopped, ...checkpoints];
}
