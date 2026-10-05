/**
 * Keeps each database's view note (viewNotes.ts) up to date: the views the
 * upgrade report lists and that are still off are noted, with a baseline,
 * whenever the tree reads the report; every save and Turn On through the
 * extension goes in the journal. A note belongs to one database: one written
 * for another database under the same name (dropped and recreated, or a
 * different restore) has another database.uuid and reads as empty.
 * Bookkeeping never fails what triggered it.
 */
import { logger } from '../logger';
import { getDatabaseUuid, getViewFingerprints } from './viewQueries';
import { baseline, buildNote, emptyNote, recordJournal, type Fingerprint, type NoteRow, type ViewNote, type ViewNoteStore } from './viewNotes';

export interface NoteQueries {
    /** undefined when they cannot be read: then nothing can be proven, and every arch is kept. */
    fingerprints(dbName: string, ids: number[]): Promise<Map<number, Fingerprint> | undefined>;
    databaseUuid(dbName: string): Promise<string | undefined>;
}

export const psqlNoteQueries: NoteQueries = {
    fingerprints: async (dbName, ids) => {
        try {
            return await getViewFingerprints(dbName, ids);
        } catch (error) {
            logger.warn(`Could not fingerprint the views of ${dbName}:`, error);
            return undefined;
        }
    },
    databaseUuid: async dbName => {
        try {
            return await getDatabaseUuid(dbName);
        } catch {
            return undefined;
        }
    }
};

/** The note when it is this database's, an empty one when it belongs to another under the same name. */
function ownNote(note: ViewNote, uuid: string | undefined): ViewNote {
    return note.dbUuid && uuid && note.dbUuid !== uuid ? emptyNote() : note;
}

export class ViewNoteService {
    constructor(
        private readonly store: ViewNoteStore,
        private readonly queries: NoteQueries = psqlNoteQueries,
        private readonly now: () => number = Date.now
    ) {}

    async read(dbName: string): Promise<ViewNote> {
        const uuid = await this.queries.databaseUuid(dbName);
        return ownNote(await this.store.load(dbName), uuid);
    }

    /**
     * Notes what `listed` (view id -> versions whose report listed it) has
     * that is still off in `rows`, and baselines older entries where that is
     * provable. Fingerprints are read only when there is something to note or
     * baseline, and the file is written only when the note changed.
     */
    async observe(dbName: string, listed: Map<number, string[]>, rows: Map<number, NoteRow>): Promise<ViewNote> {
        const uuid = await this.queries.databaseUuid(dbName);
        return this.store.update(dbName, async stored => {
            const note = ownNote(stored, uuid);
            const known = new Set(note.views.map(view => view.id));
            const fresh = [...listed.keys()].filter(id => !known.has(id) && rows.get(id)?.active === false);
            const unbaselined = note.views.filter(view => view.archMd5 === undefined).map(view => view.id);
            const ids = [...fresh, ...unbaselined];
            const fingerprints = ids.length > 0 ? await this.queries.fingerprints(dbName, ids) : new Map<number, Fingerprint>();
            const withHashes = new Map(rows);
            for (const id of fresh) {
                const hash = fingerprints?.get(id)?.archMd5;
                const row = rows.get(id);
                if (row && typeof hash === 'string') {
                    withHashes.set(id, { ...row, archMd5: hash });
                }
            }
            const now = this.now();
            const built = buildNote(note, listed, withHashes, now);
            const based = baseline(built.note, fingerprints);
            const write = built.summary.added > 0 || built.summary.extended > 0 || based.tried > 0;
            return { note: write ? { ...based.note, dbUuid: uuid ?? note.dbUuid, updatedAt: now } : note, write };
        });
    }

    async recordSave(dbName: string, viewId: number, activated: boolean): Promise<void> {
        await this.journal(dbName, viewId, activated ? ['saved', 'activated'] : ['saved']);
    }

    async recordActivate(dbName: string, viewId: number): Promise<void> {
        await this.journal(dbName, viewId, ['activated']);
    }

    private async journal(dbName: string, viewId: number, kinds: Array<'saved' | 'activated'>): Promise<void> {
        try {
            const uuid = await this.queries.databaseUuid(dbName);
            await this.store.update(dbName, async stored => {
                const note = ownNote(stored, uuid);
                return { note: { ...recordJournal(note, viewId, kinds, this.now()), dbUuid: uuid ?? note.dbUuid }, write: true };
            });
        } catch (error) {
            logger.warn(`Could not note the change to view ${viewId} in ${dbName}:`, error);
        }
    }
}
