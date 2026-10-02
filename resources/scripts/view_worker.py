# Odoo DevTools - View Doctor worker.
#
# Loaded inside `odoo-bin shell` by the one-line bootstrap the extension pipes
# to stdin (the shell exec()s all of stdin at EOF, so requests cannot come that
# way). Requests arrive on fd 3 and replies leave on fd 4, one JSON object per
# line: {"id": n, "cmd": "...", "args": {...}} -> {"id": n, "ok": true,
# "result": ...} or {"id": n, "ok": false, "error": "...", "trace": "..."}.
# Runs on Odoo 15 to 19: every API that moved is looked up, not assumed.
import json
import os
import traceback

import odoo
import psycopg2

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
    return {'active': bool(view.active), 'activated': activated, 'activationError': activation_error}


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


COMMANDS = {
    'get_arch': cmd_get_arch,
    'save': cmd_save,
    'activate': cmd_activate,
    'deactivate': cmd_deactivate,
}


def main(env):
    requests = os.fdopen(3, 'r', encoding='utf-8')
    replies = os.fdopen(4, 'w', encoding='utf-8')

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
