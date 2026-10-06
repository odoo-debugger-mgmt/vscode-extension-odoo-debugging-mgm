# Odoo DevTools - View Doctor worker.
#
# Loaded inside `odoo-bin shell` by the one-line bootstrap the extension pipes
# to stdin (the shell exec()s all of stdin at EOF, so requests cannot come that
# way). The worker connects to the socket in ODT_VIEW_ADDRESS - "unix:<path>",
# or "tcp:127.0.0.1:<port>" on Windows - sends ODT_VIEW_TOKEN, then reads
# requests and writes replies there, one JSON object per line:
# {"id": n, "cmd": "...", "args": {...}} -> {"id": n, "ok": true,
# "result": ...} or {"id": n, "ok": false, "error": "...", "trace": "..."}.
# Runs on Odoo 15 to 19: every API that moved is looked up, not assumed.
import json
import os
import socket
import traceback
import types

import odoo
import psycopg2
from lxml import etree

# `odoo-bin shell` gives OdooBot's language. The arch is read and written as
# its en_US source instead: in another language Odoo shows the translation
# and turns what is typed into source terms (15 even rewrites the source).
ENV = env(context=dict(env.context, lang='en_US'))  # noqa: F821 - provided by `odoo-bin shell`

LOST_CONNECTION = 'The Odoo shell lost its database connection.'


class Refused(Exception):
    """An error whose message is already what the user should read."""


class Restart(Exception):
    """The shell is out of date and must be replaced."""


def _invalidate(env):
    if hasattr(env, 'invalidate_all'):
        env.invalidate_all()
    else:
        env.cache.invalidate()


def _fresh(env):
    # A new transaction per request: Odoo cursors are REPEATABLE READ, so the
    # worker would otherwise keep seeing the database as it was at startup
    # rather than what the running server has written since.
    env.cr.rollback()
    _invalidate(env)
    _check_registry(env)


def _registry_sequence(env):
    # Odoo 17 and later read it themselves (a sequence on 17 and 18, an
    # insert-only table on 19); 15 and 16 only have the sequence.
    get_sequences = getattr(env.registry, 'get_sequences', None)
    if get_sequences is not None:
        return get_sequences(env.cr)[0]
    env.cr.execute('SELECT last_value FROM base_registry_signaling')
    return env.cr.fetchone()[0]


def _check_registry(env):
    """Raises Restart when the running server reloaded the registry (a module
    install or update) since this shell loaded it: its models are stale."""
    known = getattr(env.registry, 'registry_sequence', None)
    if known is None:
        return
    try:
        current = _registry_sequence(env)
    except Exception as error:  # noqa: BLE001 - no signaling tables: nothing to compare
        if _connection_lost(env, error):
            raise
        env.cr.rollback()
        return
    env.cr.rollback()
    if current != known:
        raise Restart("The database's modules changed since this Odoo shell started.")


def _connection_lost(env, error):
    """The backend is gone (Postgres restarted, the session was terminated, the
    database dropped): every later request would fail the same way. A server
    error with a SQLSTATE outside the connection classes - a lock timeout, a
    serialization failure - is an ordinary failure, not a lost connection."""
    if getattr(getattr(env.cr, '_cnx', None), 'closed', False):
        return True
    if isinstance(error, psycopg2.InterfaceError):
        return True
    if isinstance(error, psycopg2.OperationalError):
        code = getattr(error, 'pgcode', None)
        # 08: connection exception; 57P: operator intervention (terminated, shut down, dropped).
        return not code or code.startswith(('08', '57P'))
    return False


def _flush(env):
    if hasattr(env, 'flush_all'):
        env.flush_all()
    else:
        env['base'].flush()


def _signal(env):
    # A running server only drops its view caches when told through the
    # registry sequences; the shell has no request lifecycle doing it.
    registry = env.registry
    if hasattr(registry, 'signal_changes'):
        registry.signal_changes()


def _view(env, view_id):
    view = env['ir.ui.view'].browse(int(view_id)).exists()
    if not view:
        raise Refused('View %s no longer exists.' % view_id)
    return view


def _root(view):
    root = view
    seen = set()
    while root.inherit_id and root.mode != 'primary' and root.id not in seen:
        seen.add(root.id)
        root = root.inherit_id
    return root


def _top(view):
    """The top of the view's inherit_id chain, whatever the modes: what the
    Views tree's isReport looks at, and odoo-manager's find_report_for_view."""
    top = view
    seen = set()
    while top.inherit_id and top.id not in seen:
        seen.add(top.id)
        top = top.inherit_id
    return top


def _compose(env, view):
    """Composes the view's root the way opening it does, raising when the
    combined arch is broken. A saved arch is not checked against its parent's
    current structure until then."""
    root = _root(view)
    if root.type == 'qweb' or not root.model or root.model not in env:
        root._get_combined_arch()
        return
    target = env[root.model]
    if hasattr(target, 'get_view'):
        target.get_view(view_id=root.id, view_type=root.type)
    else:
        target.fields_view_get(view_id=root.id, view_type=root.type)


def _message(error):
    text = str(error).strip()
    if isinstance(error, (Refused, odoo.exceptions.UserError)) and text:
        return text
    return '%s: %s' % (type(error).__name__, text) if text else type(error).__name__


def cmd_get_arch(env, view_id):
    view = _view(env, view_id)
    return {'arch': view.arch or '', 'active': view.active}


def cmd_save(env, view_id, arch, activate=True):
    """Writes the arch; when the view is off, also tries to turn it on. A
    failed activation keeps the new arch - fixing it takes several saves -
    and reports why the view stays off."""
    view = _view(env, view_id)
    view.write({'arch': arch})
    _flush(env)
    activated = False
    activation_error = None
    if activate and not view.active:
        try:
            with env.cr.savepoint():
                view.write({'active': True})
                _flush(env)
                _compose(env, view)
            activated = True
        except Exception as error:  # noqa: BLE001 - reported to the user
            activation_error = _message(error)
            _invalidate(env)
    env.cr.commit()
    _signal(env)
    return {'active': bool(view.active), 'activated': activated, 'activationError': activation_error,
            'inheriting': bool(view.inherit_id)}


def cmd_activate(env, view_id):
    view = _view(env, view_id)
    view.write({'active': True})
    _flush(env)
    _compose(env, view)
    env.cr.commit()
    _signal(env)
    return {'active': True}


def cmd_deactivate(env, view_id):
    view = _view(env, view_id)
    view.write({'active': False})
    _flush(env)
    env.cr.commit()
    _signal(env)
    return {'active': False}


_XPATH_CHECK = []


def _xpath_check():
    """xpath_check.py, from the folder this file is in: compile() gave this
    code the script's path, which is how the worker finds what lies next to
    it. Loaded on first use, so a problem in it cannot stop the worker.
    Compiled in memory rather than imported: an import would write a
    __pycache__ into the extension's own folder."""
    if not _XPATH_CHECK:
        folder = os.path.dirname(os.path.abspath(_xpath_check.__code__.co_filename))
        path = os.path.join(folder, 'xpath_check.py')
        with open(path, encoding='utf-8') as source:
            code = compile(source.read(), path, 'exec')
        module = types.ModuleType('odt_xpath_check')
        module.__file__ = path
        exec(code, module.__dict__)  # noqa: S102 - our own script, shipped next to this one
        _XPATH_CHECK.append(module)
    return _XPATH_CHECK[0]


def cmd_check_xpaths(env, view_id, arch):
    """Resolves every locator of `arch` - the editor's text for this view -
    against its parent's combined arch: the raw tree Odoo applies inheritance
    specs to, before get_view drops nodes by groups. Inside this request's
    transaction, which the worker always rolls back, the parent and every view
    it inherits from are switched on - Odoo leaves an inactive view out of its
    own composition, and a chain disabled by an upgrade is fixed child first -
    and then the view and every view inheriting from it are switched off: the
    baseline is the parent as it will be once its chain is on, without this
    view, whether this view is on or off. Later siblings stay in - the same
    approximation odoo-manager makes. Nothing is committed or signalled.
    A server holding a write on these rows makes this fail after five seconds
    instead of hanging the shell."""
    view = _view(env, view_id)
    parent = view.inherit_id
    if not parent:
        raise Refused('Not an inheriting view: it has no locators to check.')
    env.cr.execute("SET LOCAL lock_timeout = '5s'")
    env.cr.execute("""
        WITH RECURSIVE chain AS (
            SELECT id, inherit_id, 0 AS depth FROM ir_ui_view WHERE id = %s
            UNION ALL
            SELECT v.id, v.inherit_id, c.depth + 1 FROM ir_ui_view v JOIN chain c ON v.id = c.inherit_id WHERE c.depth < 50
        )
        UPDATE ir_ui_view SET active = true WHERE id IN (SELECT id FROM chain) AND NOT active
    """, [parent.id])
    env.cr.execute("""
        WITH RECURSIVE tree AS (
            SELECT id, 0 AS depth FROM ir_ui_view WHERE id = %s
            UNION ALL
            SELECT v.id, t.depth + 1 FROM ir_ui_view v JOIN tree t ON v.inherit_id = t.id WHERE t.depth < 50
        )
        UPDATE ir_ui_view SET active = false WHERE id IN (SELECT id FROM tree)
    """, [view.id])
    _invalidate(env)
    parent_arch = etree.tostring(parent._get_combined_arch(), encoding='unicode')
    return _xpath_check().check(arch, parent_arch)


def _render_user(env):
    """The user the render frames act as: the first active internal user
    with Settings access, lowest id first - `admin` on most databases. The
    group field moved: all_group_ids on 19, groups_id before."""
    users = env['res.users']
    field = next((name for name in ('all_group_ids', 'groups_id', 'group_ids') if name in users._fields), None)
    user = users.browse()
    if field:
        group = env.ref('base.group_system')
        user = users.search([(field, 'in', group.ids), ('share', '=', False)], order='id', limit=1)
    if not user:
        raise Refused('No active user of this database has the Settings access a render needs.')
    return user


def cmd_new_session(env):
    """An admin session saved in the session store the database's server
    reads (both use the version's data dir), as odoo-manager's connect_as
    mints one. context_get() reads env.user, which here is OdooBot: it runs
    as the user, so the session gets the user's own language."""
    from odoo.http import root
    user = _render_user(env)
    store = root.session_store
    session = store.new()
    session.db = env.cr.dbname
    session.uid = user.id
    session.login = user.login
    session.session_token = user._compute_session_token(session.sid)
    session.context = dict(user.with_user(user).context_get() or {})
    store.save(session)
    return {'sid': session.sid}


def _list_type(env):
    # 18.0 renamed the list view type from 'tree' to 'list'.
    types = dict(env['ir.ui.view']._fields['type'].selection)
    return 'list' if 'list' in types else 'tree'


def cmd_make_action(env, view_id):
    """A window action opening the view's root, made once per (model, view)
    and reused; never deleted. The record goes in the URL, never on the
    action: the web client caches actions by id, so a res_id written onto a
    reused action can show a stale record."""
    root = _root(_view(env, view_id))
    if root.type == 'qweb':
        raise Refused('QWeb templates render inside the page that uses them; open it from Odoo.')
    if not root.model:
        raise Refused('This view has no model to render.')
    if root.model not in env:
        raise Refused('Model %s is not installed in this database.' % root.model)
    name = '[View Doctor] %s #%d' % (root.model, root.id)
    vals = {'name': name, 'res_model': root.model, 'res_id': False, 'target': 'current'}
    if root.type == 'search':
        view_type = _list_type(env)
        vals.update(view_mode=view_type, view_id=False, search_view_id=root.id)
    else:
        view_type = root.type
        vals.update(view_mode=view_type, view_id=root.id, search_view_id=False)
    actions = env['ir.actions.act_window']
    action = actions.search([('name', '=', name), ('res_model', '=', root.model)], limit=1)
    if not action:
        action = actions.create(vals)
    elif any(action._fields[key].convert_to_write(action[key], action) != value for key, value in vals.items()):
        action.write(vals)
    else:
        # Nothing to change: the original database is left as it is.
        return {'action_id': action.id, 'model': root.model, 'view_type': view_type, 'root_id': root.id,
                'series': odoo.release.serie}
    env.cr.commit()
    _signal(env)
    return {'action_id': action.id, 'model': root.model, 'view_type': view_type, 'root_id': root.id,
            'series': odoo.release.serie}


def cmd_recent_ids(env, model, limit=200, domain=None):
    """The newest records of a model that the render user can open, newest
    first; none for a model this database does not have. `domain` narrows
    them (a report's records)."""
    if model not in env or env[model]._abstract:
        return {'ids': []}
    user = _render_user(env)
    try:
        # The default company, as the frame opens it, decides what is visible.
        records = env[model].with_user(user).with_context(allowed_company_ids=[user.company_id.id]).search(
            list(domain or []), order='id desc', limit=int(limit))
    except Exception as error:
        if _connection_lost(env, error):
            raise
        env.cr.rollback()
        return {'ids': []}
    return {'ids': records.ids}


def cmd_report_target(env, view_id):
    """The report a QWeb view's template renders, or None: the first report
    whose report_name is an external id of the view's root - the template
    Odoo renders under that key (_root stops at a primary view), else the top
    of its chain. account.move also holds plain journal entries, which render
    an empty invoice, so its records are the other move types only."""
    view = _view(env, view_id)
    data = env['ir.model.data']
    reports = env['ir.actions.report']
    for root in dict.fromkeys([_root(view), _top(view)]):
        names = ['%s.%s' % (row.module, row.name)
                 for row in data.search([('model', '=', 'ir.ui.view'), ('res_id', '=', root.id)], order='module, name')]
        # Only QWeb reports have a /report/html route; a py3o or other kind does not.
        report = reports.search([('report_name', 'in', names), ('report_type', 'in', ('qweb-html', 'qweb-pdf', 'qweb-text'))],
                                order='id', limit=1) if names else reports
        if report:
            domain = [['move_type', '!=', 'entry']] if report.model == 'account.move' else []
            return {'report_name': report.report_name, 'name': report.name, 'model': report.model,
                    'domain': domain, 'series': odoo.release.serie, 'report_type': report.report_type}
    return None


COMMANDS = {
    'get_arch': cmd_get_arch,
    'save': cmd_save,
    'activate': cmd_activate,
    'deactivate': cmd_deactivate,
    'check_xpaths': cmd_check_xpaths,
    'new_session': cmd_new_session,
    'make_action': cmd_make_action,
    'recent_ids': cmd_recent_ids,
    'report_target': cmd_report_target,
}


def _open_channel():
    """Connects to the extension and proves who it is. Both values then leave
    the environment, so processes Odoo starts from here on (wkhtmltopdf, ...)
    do not inherit them; the token is single-use either way, as the extension
    stops listening once the shell is in."""
    address = os.environ.pop('ODT_VIEW_ADDRESS')
    token = os.environ.pop('ODT_VIEW_TOKEN')
    kind, _, where = address.partition(':')
    if kind == 'unix':
        channel = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        channel.connect(where)
    else:
        host, _, port = where.rpartition(':')
        channel = socket.create_connection((host, int(port)))
    # Waiting for the next request can take minutes: never time out, whatever
    # an addon set as the process-wide default.
    channel.settimeout(None)
    # newline='\n': on Windows text mode would otherwise write '\r\n'.
    requests = channel.makefile('r', encoding='utf-8', newline='\n')
    replies = channel.makefile('w', encoding='utf-8', newline='\n')
    replies.write(token + '\n')
    replies.flush()
    return requests, replies


def main(env):
    requests, replies = _open_channel()

    def reply(payload):
        replies.write(json.dumps(payload) + '\n')
        replies.flush()

    reply({'id': 0, 'ok': True, 'result': {'series': odoo.release.serie}})
    # Never sit idle in transaction: it would hold locks that block a -u.
    env.cr.rollback()
    for line in requests:
        line = line.strip()
        if not line:
            continue
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get('id')
            handler = COMMANDS.get(request.get('cmd'))
            if handler is None:
                raise Refused('Unknown command: %s' % request.get('cmd'))
            _fresh(env)
            result = handler(env, **(request.get('args') or {}))
            reply_payload = {'id': request_id, 'ok': True, 'result': result}
        except Restart as error:
            _end_transaction(env)
            reply({'id': request_id, 'ok': False, 'error': str(error), 'restart': True})
            return
        except Exception as error:  # noqa: BLE001 - every failure is a reply
            if _connection_lost(env, error):
                # Exiting is the cure: the pool retries once on a fresh shell.
                reply({'id': request_id, 'ok': False, 'error': LOST_CONNECTION, 'restart': True})
                return
            reply_payload = {'id': request_id, 'ok': False, 'error': _message(error), 'trace': traceback.format_exc()[-4000:]}
        # Results are plain dicts: the transaction can end before the reply.
        connected = _end_transaction(env)
        reply(reply_payload)
        if not connected:
            return


def _end_transaction(env):
    """Rolls back; False when the connection turned out to be gone."""
    try:
        env.cr.rollback()
    except Exception as error:  # noqa: BLE001
        return not _connection_lost(env, error)
    return True


main(ENV)
