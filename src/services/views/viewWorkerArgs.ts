/**
 * The command line of the View Doctor's Odoo shell. It shares the server's
 * addons path and database but none of what makes a launch *do* something:
 * no -i/-u (a shell that installs is not a reader), no test flags, no port.
 * extraParams is filtered too, since anything can be typed there.
 */

/** application_name the worker's connections carry, so probes can skip them. */
export const VIEW_WORKER_APP_NAME = 'odoo-devtools-view-worker';

/** Short flags that are refused, each of which takes a value. */
const REFUSED_SHORT = ['-i', '-u', '-p', '-d'];

/**
 * Long options that are refused, and whether they take a value (a bare flag
 * then owns the next extraParams part). The worker sets its own database and
 * addons path, and a later duplicate would win in optparse.
 */
const REFUSED_LONG = new Map<string, boolean>([
    ['--init', true], ['--update', true],
    ['--test-enable', false], ['--test-file', true], ['--test-tags', true],
    ['--stop-after-init', false],
    ['--http-port', true], ['--xmlrpc-port', true], ['--dev', true],
    ['--database', true], ['--addons-path', true]
]);

/**
 * Whether optparse would read `arg` as a refused option, in any spelling it
 * accepts (attached short values, unambiguous long prefixes), and if so
 * whether it takes the next part as its value.
 */
function refusal(arg: string): { takesValue: boolean } | undefined {
    const name = arg.split(/[=\s]/, 1)[0];
    if (name.startsWith('--')) {
        if (name.length < 3) {
            return undefined;
        }
        const matches = [...REFUSED_LONG].filter(([long]) => long.startsWith(name));
        return matches.length > 0 ? { takesValue: matches.some(([, takes]) => takes) } : undefined;
    }
    if (name.startsWith('-') && name.length > 1 && REFUSED_SHORT.includes(name.slice(0, 2))) {
        return { takesValue: true };
    }
    return undefined;
}

export interface ViewWorkerArgsInput {
    odooBinPath: string;
    addonsPaths: string[];
    dbName: string;
    /** The version's comma-separated extra parameters, as the server gets them. */
    extraParams?: string;
}

export function buildViewWorkerArgs(input: ViewWorkerArgsInput): string[] {
    const extras = (input.extraParams ?? '')
        .split(',')
        .map(part => part.trim())
        .filter(Boolean);

    const kept: string[] = [];
    for (let index = 0; index < extras.length; index++) {
        const arg = extras[index];
        const refused = refusal(arg);
        if (!refused) {
            kept.push(arg);
            continue;
        }
        // A bare value-taking flag ("-u") owned the next part ("sale") as its
        // value. Boolean flags and attached values ("-uall") own nothing.
        const name = arg.split(/[=\s]/, 1)[0];
        const next = extras[index + 1];
        const bare = arg === name && (name.startsWith('--') || name.length === 2);
        if (refused.takesValue && bare && next !== undefined && !next.startsWith('-')) {
            index++;
        }
    }

    return [
        input.odooBinPath,
        'shell',
        '--no-http',
        '--addons-path', input.addonsPaths.join(','),
        '-d', input.dbName,
        ...kept
    ];
}

/**
 * The worker's environment. Odoo 15 leaves application_name to libpq
 * (PGAPPNAME), 16-18 read ODOO_PGAPPNAME, 19 deprecates that for PGAPPNAME:
 * setting both names the connections on every version.
 *
 * PYTHONIOENCODING: on Windows, Python reads a piped stdin and writes its log
 * in the ANSI code page, so the bootstrap and the error tail would be decoded
 * wrongly - the extension writes and reads both as UTF-8.
 */
export function viewWorkerEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return { ...base, PGAPPNAME: VIEW_WORKER_APP_NAME, ODOO_PGAPPNAME: VIEW_WORKER_APP_NAME, PYTHONIOENCODING: 'utf-8' };
}
