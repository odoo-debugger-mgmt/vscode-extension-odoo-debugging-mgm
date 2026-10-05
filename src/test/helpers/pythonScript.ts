/**
 * Runs a generated upgrade script under python3 with stand-ins for
 * odoo.upgrade.util and lxml, and reports what it would do. Tests skip when
 * python3 is not installed.
 */
import { spawnSync } from 'node:child_process';

export interface ScriptRun {
    ACTIVATE: Array<string | number> | null;
    VIEWS: Array<Record<string, unknown>> | null;
    /** util.edit_view calls: [xmlid, view_id, kwargs, the arch it was given]. */
    edits: Array<[string | null, number | null, Record<string, unknown>, string | null]>;
    /** cr.execute calls: [sql, params]. */
    executed: Array<[string, unknown[]]>;
}

const HARNESS = String.raw`
import contextlib, json, sys, types
source = sys.stdin.read()
refs = json.loads(sys.argv[1])
missing = set(json.loads(sys.argv[2]))
edits, executed = [], []

class El:
    def __init__(self, text=None):
        self.tag, self.text, self.attrib, self.children = 'x', text, {}, []
    def __getitem__(self, key):
        return self.children[key]
    def __setitem__(self, key, value):
        self.children[key] = value

class Cr:
    def execute(self, sql, params=None):
        executed.append([sql, list(params or [])])

@contextlib.contextmanager
def edit_view(cr, xmlid=None, view_id=None, skip_if_not_noupdate=True, active='auto'):
    assert bool(xmlid) ^ bool(view_id), 'You Must specify either xmlid or view_id'
    if (xmlid or view_id) in missing:
        return
    el = El()
    yield el
    edits.append([xmlid, view_id, {'skip_if_not_noupdate': skip_if_not_noupdate, 'active': active}, el.text])

@contextlib.contextmanager
def skippable_cm():
    try:
        yield
    except RuntimeError as error:
        if "didn't yield" not in str(error):
            raise

util = types.ModuleType('odoo.upgrade.util')
util.edit_view, util.skippable_cm = edit_view, skippable_cm
util.ref = lambda cr, xmlid: refs.get(xmlid)
upgrade = types.ModuleType('odoo.upgrade'); upgrade.util = util
odoo = types.ModuleType('odoo'); odoo.upgrade = upgrade
etree = types.ModuleType('lxml.etree'); etree.fromstring = lambda text: El(text)
lxml = types.ModuleType('lxml'); lxml.etree = etree
sys.modules.update({'odoo': odoo, 'odoo.upgrade': upgrade, 'odoo.upgrade.util': util, 'lxml': lxml, 'lxml.etree': etree})
namespace = {}
exec(compile(source, 'end-update_views.py', 'exec'), namespace)
namespace['migrate'](Cr(), '1.0')
print(json.dumps({'ACTIVATE': namespace.get('ACTIVATE'), 'VIEWS': namespace.get('VIEWS'), 'edits': edits, 'executed': executed}))
`;

/** Whether python3 runs here. */
export function hasPython(): boolean {
    const result = spawnSync('python3', ['--version'], { encoding: 'utf-8' });
    return !result.error && result.status === 0;
}

/**
 * Compiles and runs `source`. `refs` is what util.ref answers per external
 * id; `missing` lists external ids or view ids edit_view does not find.
 */
export function runScript(source: string, refs: Record<string, number> = {}, missing: Array<string | number> = []): ScriptRun {
    const result = spawnSync('python3', ['-c', HARNESS, JSON.stringify(refs), JSON.stringify(missing)], { input: source, encoding: 'utf-8' });
    if (result.status !== 0) {
        throw new Error(`python3 failed:\n${result.stderr}`);
    }
    return JSON.parse(result.stdout) as ScriptRun;
}
