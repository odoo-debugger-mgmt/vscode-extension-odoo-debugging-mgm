/**
 * The command line of the View Doctor's Odoo shell. It shares the server's
 * addons path and database but none of what makes a launch *do* something:
 * no -i/-u (a shell that installs is not a reader), no test flags, no port.
 * extraParams is filtered too, since anything can be typed there.
 */

/** application_name the worker's connections carry, so probes can skip them. */
export const VIEW_WORKER_APP_NAME = 'odoo-devtools-view-worker';

const REFUSED_FLAGS = new Set([
    '-i', '--init', '-u', '--update',
    '--test-enable', '--test-file', '--test-tags', '--stop-after-init',
    '-p', '--http-port', '--xmlrpc-port', '--dev'
]);

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
        const name = arg.split(/[=\s]/, 1)[0];
        if (!REFUSED_FLAGS.has(name)) {
            kept.push(arg);
            continue;
        }
        // A bare flag ("-u") took its value as the next part ("sale").
        const next = extras[index + 1];
        if (arg === name && next !== undefined && !next.startsWith('-')) {
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
 */
export function viewWorkerEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return { ...base, PGAPPNAME: VIEW_WORKER_APP_NAME, ODOO_PGAPPNAME: VIEW_WORKER_APP_NAME };
}
