/**
 * The View Doctor's note of a database's disabled views, and the journal of
 * what the extension changed. Port of odoo-manager's view_note.py.
 *
 * The note is a baseline: the views upgrade-util's report in Discuss says the
 * upgrade disabled *and that are still disabled when first listed*. Only what
 * the report lists (a real upgraded database has hundreds of views off by
 * design), and only what is still off (a listed view already on was fixed
 * before anyone looked, and scripting it would claim work nobody did here).
 *
 * Each noted view keeps a hash of its arch as it was when noted, so the script
 * can tell a view that was only re-enabled from one that was edited and leave
 * the arch out for the first kind (unchangedReason). write_date cannot be that
 * signal: turning a view on is an ORM write too.
 *
 * The journal is every view this extension saved or turned on, so a fix made
 * on a view no report lists still reaches the script.
 *
 * One JSON file per database name, machine-local. Both the installed build
 * and the F5 sandbox read it (globalStorageUri is not profile-isolated), and
 * they see the same PostgreSQL, so sharing it is right; writes are atomic and
 * reads tolerate anything.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** External id modules no file ships: Studio's, and what data export/import creates. */
export const NOT_SHIPPED_MODULES: readonly string[] = ['studio_customization', '__export__', '__import__'];

export interface NotedView {
    id: number;
    name: string;
    model: string;
    type: string;
    xmlid: string | null;
    /** The Odoo versions whose upgrade report listed it, in report order. */
    listedIn: string[];
    /** When it was noted, epoch ms. */
    notedAt?: number;
    /** The arch's md5 when noted. Absent: not tried yet. null: tried, cannot be proven. */
    archMd5?: string | null;
}

export interface JournalEntry {
    id: number;
    saved: boolean;
    activated: boolean;
    /** The last change, epoch ms. */
    at: number;
}

export interface ViewNote {
    /** The database's database.uuid when written: a database recreated under the same name has another. */
    dbUuid?: string;
    takenAt?: number;
    updatedAt?: number;
    views: NotedView[];
    journal: JournalEntry[];
}

/** What noting a view needs from its live row. */
export interface NoteRow {
    active: boolean;
    name: string;
    model: string;
    type: string;
    xmlid: string | null;
    archMd5?: string;
}

/** What tells whether a view's arch was edited; see getViewFingerprints. */
export interface Fingerprint {
    archMd5: string | null;
    /** write_date, epoch ms. */
    written: number | null;
    archUpdated: boolean | null;
    /** Module and noupdate of the view's first external id. */
    module: string | null;
    noupdate: boolean | null;
}

export type UnchangedReason = 'noted' | 'not-edited';

export interface BuildSummary {
    listed: number;
    added: number;
    /** Noted views another report now lists too. */
    extended: number;
    alreadyEnabled: number;
    missing: number;
    noted: number;
}

export function emptyNote(): ViewNote {
    return { views: [], journal: [] };
}

function isId(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function finite(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** The note as read from disk: anything that is not a note becomes an empty one, field by field. */
export function normalizeNote(raw: unknown): ViewNote {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return emptyNote();
    }
    const source = raw as Record<string, unknown>;
    const note = emptyNote();
    if (typeof source.dbUuid === 'string') {
        note.dbUuid = source.dbUuid;
    }
    const takenAt = finite(source.takenAt);
    if (takenAt !== undefined) {
        note.takenAt = takenAt;
    }
    const updatedAt = finite(source.updatedAt);
    if (updatedAt !== undefined) {
        note.updatedAt = updatedAt;
    }
    for (const entry of Array.isArray(source.views) ? source.views : []) {
        const view = (entry ?? {}) as Record<string, unknown>;
        if (!isId(view.id)) {
            continue;
        }
        const noted: NotedView = {
            id: view.id,
            name: typeof view.name === 'string' ? view.name : '',
            model: typeof view.model === 'string' ? view.model : '',
            type: typeof view.type === 'string' ? view.type : '',
            xmlid: typeof view.xmlid === 'string' ? view.xmlid : null,
            listedIn: Array.isArray(view.listedIn) ? view.listedIn.filter((v): v is string => typeof v === 'string') : []
        };
        const notedAt = finite(view.notedAt);
        if (notedAt !== undefined) {
            noted.notedAt = notedAt;
        }
        if (typeof view.archMd5 === 'string' || view.archMd5 === null) {
            noted.archMd5 = view.archMd5;
        }
        note.views.push(noted);
    }
    for (const entry of Array.isArray(source.journal) ? source.journal : []) {
        const change = (entry ?? {}) as Record<string, unknown>;
        if (isId(change.id)) {
            note.journal.push({ id: change.id, saved: change.saved === true, activated: change.activated === true, at: finite(change.at) ?? 0 });
        }
    }
    return note;
}

/**
 * The note after reading the report again: `listed` maps each listed view id
 * to the versions whose report listed it, `rows` the live rows (an id with no
 * view is absent). Merged into `existing`: a noted view that has been fixed
 * since no longer shows as disabled, and must not be forgotten. A view already
 * noted is never dropped or re-counted. `existing` is not modified.
 */
export function buildNote(existing: ViewNote, listed: Map<number, string[]>, rows: Map<number, NoteRow>, now: number): { note: ViewNote; summary: BuildSummary } {
    const views = new Map(existing.views.map(view => [view.id, { ...view, listedIn: [...view.listedIn] }]));
    let added = 0;
    let extended = 0;
    let alreadyEnabled = 0;
    let missing = 0;
    for (const [id, versions] of listed) {
        const known = views.get(id);
        if (known) {
            const more = versions.filter(version => !known.listedIn.includes(version));
            if (more.length > 0) {
                known.listedIn.push(...more);
                extended++;
            }
            continue;
        }
        const row = rows.get(id);
        if (!row) {
            missing++;
        } else if (row.active) {
            alreadyEnabled++;
        } else {
            const view: NotedView = { id, name: row.name, model: row.model, type: row.type, xmlid: row.xmlid, listedIn: [...versions], notedAt: now };
            // Left out, not null, when it could not be read: baseline() may still supply it.
            if (row.archMd5 !== undefined) {
                view.archMd5 = row.archMd5;
            }
            views.set(id, view);
            added++;
        }
    }
    return {
        note: { ...existing, takenAt: existing.takenAt ?? now, views: [...views.values()], journal: [...existing.journal] },
        summary: { listed: listed.size, added, extended, alreadyEnabled, missing, noted: views.size }
    };
}

/**
 * Gives every noted view without a baseline one, where its current arch is
 * provably the one it had when noted: its row has not been written since
 * (any ORM write, an edit or turning it on, moves write_date). One written
 * since cannot be proven later, so it is marked tried (null) and not asked
 * about again; unchangedReason then falls back to Odoo's arch_updated flag.
 * `fingerprints` undefined (unreadable) touches nothing; a view with no
 * fingerprint (deleted) is left alone. `note` is not modified.
 */
export function baseline(note: ViewNote, fingerprints: Map<number, Fingerprint> | undefined): { note: ViewNote; baselined: number; tried: number } {
    if (!fingerprints) {
        return { note, baselined: 0, tried: 0 };
    }
    let baselined = 0;
    let tried = 0;
    const views = note.views.map(view => {
        const fp = fingerprints.get(view.id);
        if (view.archMd5 !== undefined || !fp) {
            return view;
        }
        tried++;
        const noted = view.notedAt ?? note.takenAt;
        if (noted !== undefined && fp.written !== null && fp.written < noted) {
            baselined++;
            return { ...view, archMd5: fp.archMd5 };
        }
        return { ...view, archMd5: null };
    });
    return { note: { ...note, views }, baselined, tried };
}

/** Whether the view's arch comes from its module's files, which every upgrade loads again. */
export function isShipped(fp: Fingerprint): boolean {
    return fp.noupdate === false && !!fp.module && !NOT_SHIPPED_MODULES.includes(fp.module);
}

/**
 * Why a re-enabled view's arch need not be written into the script, or null
 * when it must. Leaving an arch out is the risky direction (a wrong
 * "unchanged" drops a fix without a word), so it takes proof:
 * - 'noted': the arch hashes exactly as when the view was noted;
 * - 'not-edited': nobody edited the arch through the ORM. arch_updated flips
 *   when the arch is written, not when `active` is, and a module resets it
 *   when it loads the view; null counts as never edited. Used without a
 *   baseline, or when a shipped view differs from its baseline but was not
 *   edited (a module update rewrote it, and the upgrade loads it again).
 * Every doubt keeps the arch.
 */
export function unchangedReason(entry: { archMd5?: string | null } | undefined, fp: Fingerprint | undefined): UnchangedReason | null {
    if (!fp) {
        return null;
    }
    const edited = fp.archUpdated === true;
    const noted = entry?.archMd5;
    if (noted) {
        if (noted === fp.archMd5) {
            return 'noted';
        }
        return isShipped(fp) && !edited ? 'not-edited' : null;
    }
    return edited ? null : 'not-edited';
}

/** The note with this view's save or Turn On recorded. `note` is not modified. */
export function recordJournal(note: ViewNote, viewId: number, kinds: Array<'saved' | 'activated'>, now: number): ViewNote {
    const journal = note.journal.map(entry => ({ ...entry }));
    let entry = journal.find(change => change.id === viewId);
    if (!entry) {
        entry = { id: viewId, saved: false, activated: false, at: now };
        journal.push(entry);
    }
    entry.saved ||= kinds.includes('saved');
    entry.activated ||= kinds.includes('activated');
    entry.at = now;
    return { ...note, journal };
}

/** The note's file name: every byte outside [A-Za-z0-9_-] percent-encoded, so no name reaches outside the folder. */
export function noteFileName(dbName: string): string {
    if (!dbName) {
        throw new Error('No database name.');
    }
    let name = '';
    for (const byte of Buffer.from(dbName, 'utf-8')) {
        const char = String.fromCharCode(byte);
        name += /[A-Za-z0-9_-]/.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
    return `${name}.json`;
}

export class ViewNoteStore {
    private readonly queue = new Map<string, Promise<unknown>>();

    constructor(private readonly dir: string) {}

    /** The database's note; empty when there is none or it cannot be read. */
    async load(dbName: string): Promise<ViewNote> {
        try {
            return normalizeNote(JSON.parse(await fs.readFile(path.join(this.dir, noteFileName(dbName)), 'utf-8')));
        } catch {
            return emptyNote();
        }
    }

    /** Written beside the target and renamed into place: a reader never sees half a note. */
    async save(dbName: string, note: ViewNote): Promise<void> {
        await fs.mkdir(this.dir, { recursive: true });
        const file = path.join(this.dir, noteFileName(dbName));
        const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
        try {
            await fs.writeFile(temp, JSON.stringify(note, null, 2));
            await fs.rename(temp, file);
        } catch (error) {
            await fs.rm(temp, { force: true });
            throw error;
        }
    }

    /** Read, change and maybe write one database's note, one change at a time. */
    update(dbName: string, change: (note: ViewNote) => Promise<{ note: ViewNote; write: boolean }>): Promise<ViewNote> {
        const previous = this.queue.get(dbName) ?? Promise.resolve();
        const next = previous.catch(() => undefined).then(async () => {
            const result = await change(await this.load(dbName));
            if (result.write) {
                await this.save(dbName, result.note);
            }
            return result.note;
        });
        this.queue.set(dbName, next);
        return next;
    }
}
