/**
 * Three-way merge of stored documents, for when two windows changed the same
 * one between reading and writing it.
 *
 * `base` is what this window read, `mine` what it is writing, `theirs` what
 * the store holds now. Whatever only one side changed is kept; only a value
 * both sides changed differently is a real conflict, and there `mine` wins -
 * the last writer, the same answer the JSON file always gave, but now for one
 * field instead of the whole file.
 *
 * Arrays of records merge by identity (`id`, then `uid`, then `name`), because
 * that is what makes two windows' edits to different databases of one project
 * both survive: `dbs` changed on both sides, but not the same database.
 *
 * Pure, and tested as data.
 */

type Json = unknown;

const IDENTITY_KEYS = ['id', 'uid', 'name'] as const;

function isRecord(value: Json): value is Record<string, Json> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Deep equality for JSON values, insensitive to key order. */
export function jsonEqual(a: Json, b: Json): boolean {
    if (a === b) {
        return true;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((item, index) => jsonEqual(item, b[index]));
    }
    if (isRecord(a) && isRecord(b)) {
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        for (const key of keys) {
            if (!jsonEqual(a[key], b[key])) {
                return false;
            }
        }
        return true;
    }
    return false;
}

/** JSON with sorted keys, so equal documents serialize identically. */
export function stableStringify(value: Json): string {
    return JSON.stringify(value, (_key, item: Json) => {
        if (isRecord(item)) {
            return Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]));
        }
        return item;
    });
}

/** The identity key every element of every array carries, if any. */
function identityKey(...arrays: Json[][]): (typeof IDENTITY_KEYS)[number] | undefined {
    const elements = arrays.flat();
    if (elements.length === 0) {
        return undefined;
    }
    return IDENTITY_KEYS.find(key => elements.every(element =>
        isRecord(element) && (typeof element[key] === 'string' || typeof element[key] === 'number')));
}

function mergeArrays(base: Json[], mine: Json[], theirs: Json[], key: string): Json[] {
    const index = (list: Json[]) => new Map(list.map(item => [String((item as Record<string, Json>)[key]), item]));
    const baseById = index(base);
    const mineById = index(mine);
    const theirsById = index(theirs);

    // My order first, then whatever they added, in their order.
    const order = [...mineById.keys()];
    for (const id of theirsById.keys()) {
        if (!mineById.has(id)) {
            order.push(id);
        }
    }

    const result: Json[] = [];
    for (const id of order) {
        const b = baseById.get(id);
        const m = mineById.get(id);
        const t = theirsById.get(id);

        if (m === undefined) {
            // I removed it, or never had it. Their untouched copy goes with
            // my removal; an edit they made to it outlives the removal.
            if (b !== undefined && jsonEqual(t, b)) {
                continue;
            }
            if (t !== undefined) {
                result.push(t);
            }
            continue;
        }
        if (t === undefined) {
            // They removed it: gone, unless I changed it since.
            if (b !== undefined && jsonEqual(m, b)) {
                continue;
            }
            result.push(m);
            continue;
        }
        result.push(merge3(b, m, t));
    }
    return result;
}

export function merge3(base: Json, mine: Json, theirs: Json): Json {
    if (jsonEqual(mine, theirs) || jsonEqual(theirs, base)) {
        return mine;
    }
    if (jsonEqual(mine, base)) {
        return theirs;
    }

    if (isRecord(mine) && isRecord(theirs)) {
        const baseRecord = isRecord(base) ? base : {};
        const result: Record<string, Json> = {};
        const keys = new Set([...Object.keys(mine), ...Object.keys(theirs)]);
        for (const key of keys) {
            const merged = merge3(baseRecord[key], mine[key], theirs[key]);
            if (merged !== undefined) {
                result[key] = merged;
            }
        }
        return result;
    }

    if (Array.isArray(mine) && Array.isArray(theirs)) {
        const baseArray = Array.isArray(base) ? base : [];
        const key = identityKey(baseArray, mine, theirs);
        if (key) {
            return mergeArrays(baseArray, mine, theirs, key);
        }
    }

    // I removed something they changed: their edit outlives the removal, the
    // same rule as for array elements.
    if (mine === undefined && base !== undefined) {
        return theirs;
    }

    // Both changed the same value differently: the last writer wins.
    return mine;
}
