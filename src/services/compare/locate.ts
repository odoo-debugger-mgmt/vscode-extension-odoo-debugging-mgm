/**
 * The decisions behind Compare This and the file commands, without vscode: which side a file is on,
 * where to look for a symbol's counterpart, and the qualified name a symbol provider reports.
 */
import * as path from 'node:path';
import { counterpartModuleDir, resolveCounterpart, rootOf, type Counterpart, type FsProbe, type SideRoots } from './counterpart';

export interface SidePair { left: SideRoots; right: SideRoots; thisSide: 'left' | 'right' }

/** Which side a file is on; this side wins when both match (the same checkout). At most one is set. */
export function matchSide(file: string, sides: SidePair) {
    const left = rootOf(file, sides.left);
    const right = rootOf(file, sides.right);
    const pickLeft = left && (!right || sides.thisSide === 'left');
    return { onLeft: pickLeft ? left : undefined, onRight: pickLeft ? undefined : right };
}

/** The (from, to) sides of a file, and whether it is on the left; undefined when on neither. */
export function orderSides(file: string, sides: SidePair): { from: SideRoots; to: SideRoots; fileOnLeft: boolean } | undefined {
    const { onLeft, onRight } = matchSide(file, sides);
    if (!onLeft && !onRight) {
        return undefined;
    }
    return onLeft ? { from: sides.left, to: sides.right, fileOnLeft: true } : { from: sides.right, to: sides.left, fileOnLeft: false };
}

/** [left, right] of this side's value and the other's. */
export function leftRight<T>(fileOnLeft: boolean, mine: T, other: T): [T, T] {
    return fileOnLeft ? [mine, other] : [other, mine];
}

/** `first` files, then `rest` (every file of the module), deduplicated and never `self`. */
export function candidatesOf(first: string[], rest: string[], self: string): string[] {
    return [...new Set([...first, ...rest])].filter(f => path.resolve(f) !== path.resolve(self));
}

export interface LocateDeps {
    fs: FsProbe;
    /** The module folder of a file on the other side, by walking up to its manifest. */
    moduleOf(file: string): Promise<string | undefined>;
    /** Which candidate is the counterpart; undefined when the user dismissed or there is none. */
    pick(found: Counterpart, what: string): Promise<string | undefined>;
    info(message: string): void;
    /** Runs a slow lookup under a progress indicator. */
    busy<T>(work: () => Promise<T>): Promise<T>;
    /** The other side's text for the symbol, searching `files` and the module. */
    search(files: string[], moduleDir: string | undefined): Promise<string | undefined>;
}

/**
 * Look for the symbol in the counterpart file and its module, then in the same-named module when no file
 * matched, and only then ask which file is the counterpart. Returns the other side's text, or undefined
 * after explaining why not.
 */
export async function locateCounterpart(
    file: string, from: SideRoots, to: SideRoots, sides: { left: SideRoots; right: SideRoots }, what: string, deps: LocateDeps
): Promise<string | undefined> {
    const same = () => deps.info(`${path.basename(file)} is the same file in ${sides.left.label} and ${sides.right.label}.`);
    const isSelf = (other: string) => path.resolve(other) === path.resolve(file);
    const found = await deps.busy(() => resolveCounterpart(file, from, to, deps.fs));
    if (found.kind === 'found') {
        if (isSelf(found.path)) {
            same();
            return undefined;
        }
        const hit = await deps.search([found.path], await deps.moduleOf(found.path));
        if (hit === undefined) {
            deps.info(`${what} has no counterpart in ${to.label}.`);
        }
        return hit;
    }
    const moduleDir = await deps.busy(() => counterpartModuleDir(file, from, to, deps.fs));
    if (moduleDir) {
        const hit = await deps.search([], moduleDir);
        if (hit !== undefined) {
            return hit;
        }
    }
    const picked = await deps.pick(found, what);
    if (!picked) {
        return undefined;
    }
    if (isSelf(picked)) {
        same();
        return undefined;
    }
    const hit = await deps.search([picked], await deps.moduleOf(picked));
    if (hit === undefined) {
        deps.info(`${what} has no counterpart in ${to.label}.`);
    }
    return hit;
}

export interface SymbolNode<P> { name: string; isScope: boolean; contains(position: P): boolean; children?: SymbolNode<P>[] }

/** The dotted name of the innermost class or function around `position`, from a symbol provider's tree. */
export function qualifiedAt<P>(symbols: SymbolNode<P>[], position: P): string | undefined {
    let best: string[] | undefined;
    const walk = (list: SymbolNode<P>[], parents: string[]): void => {
        for (const s of list) {
            if (!s.contains(position)) {
                continue;
            }
            const chain = s.isScope ? [...parents, s.name] : parents;
            if (s.isScope && (!best || chain.length >= best.length)) {
                best = chain;
            }
            walk(s.children ?? [], chain);
        }
    };
    walk(symbols, []);
    return best?.join('.');
}
