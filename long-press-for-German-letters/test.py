#!/usr/bin/python3
# End-to-end test of the longpress-us engine.
#
# Spawns a PRIVATE ibus-daemon (own socket via IBUS_ADDRESS_FILE) so the
# test is fully isolated from the desktop's input method — nothing you type
# or click during the test can interfere, and the test cannot disturb your
# real input state. The engine is spawned standalone against that daemon.

import os
import subprocess
import sys
import tempfile
import time

# Must be set before the IBus library connects to any bus.
_scratch = tempfile.mkdtemp(prefix='ibus-longpress-test-')
os.environ['IBUS_ADDRESS_FILE'] = os.path.join(_scratch, 'address')
os.environ.pop('IBUS_ADDRESS', None)

import gi
gi.require_version('IBus', '1.0')
from gi.repository import GLib, IBus

RELEASE = IBus.ModifierType.RELEASE_MASK
CONTROL = IBus.ModifierType.CONTROL_MASK

failures = []


def check(name, cond, detail=''):
    status = 'PASS' if cond else 'FAIL'
    print(f'  [{status}] {name}' + (f'  ({detail})' if detail and not cond else ''))
    if not cond:
        failures.append(name)


def pump(ms):
    loop = GLib.MainLoop()
    GLib.timeout_add(ms, loop.quit)
    loop.run()


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    print('starting private ibus-daemon ...')
    daemon = subprocess.Popen(
        ['ibus-daemon', '--panel', 'disable', '--daemonize', 'false'])
    for _ in range(50):
        if os.path.exists(os.environ['IBUS_ADDRESS_FILE']):
            break
        time.sleep(0.1)
    else:
        daemon.terminate()
        sys.exit('private ibus-daemon never wrote its address file')

    IBus.init()
    bus = IBus.Bus()
    for _ in range(50):
        if bus.is_connected():
            break
        pump(100)
    else:
        daemon.terminate()
        sys.exit('cannot connect to the private ibus daemon')

    print('spawning standalone engine.py ...')
    engine_proc = subprocess.Popen([sys.executable,
                                    os.path.join(here, 'engine.py')])
    pump(1500)  # runtime-registered engines don't show in list_engines

    ctx = bus.create_input_context('longpress-test')
    ctx.set_capabilities(IBus.Capabilite.PREEDIT_TEXT |
                         IBus.Capabilite.LOOKUP_TABLE |
                         IBus.Capabilite.SURROUNDING_TEXT |
                         IBus.Capabilite.FOCUS)

    events = []
    ctx.connect('commit-text',
                lambda c, t: events.append(('commit', t.get_text())))
    ctx.connect('delete-surrounding-text',
                lambda c, off, n: events.append(('delete', off, n)))
    ctx.connect('forward-key-event',
                lambda c, kv, kc, st: events.append(('forward', kv, st)))
    ctx.connect('update-preedit-text',
                lambda c, t, pos, vis: events.append(('preedit', t.get_text(), vis)))
    ctx.connect(
        'update-lookup-table',
        lambda c, tbl, vis: events.append(
            ('table',
             [tbl.get_candidate(i).get_text()
              for i in range(tbl.get_number_of_candidates())],
             vis)))
    ctx.connect('hide-lookup-table', lambda c: events.append(('table-hidden',)))

    # The daemon may run in global-engine mode (GNOME config), where
    # per-context set_engine is ignored; set the global engine instead.
    for _ in range(20):
        bus.set_global_engine('longpress-us')
        pump(200)
        cur = bus.get_global_engine()
        if cur and cur.get_name() == 'longpress-us':
            break
    else:
        sys.exit('could not activate the longpress-us engine')
    ctx.focus_in()
    pump(300)

    def key(kv, kc, st=0, wait=120):
        handled = ctx.process_key_event(kv, kc, st)
        pump(wait)
        return handled

    def commits():
        return [e[1] for e in events if e[0] == 'commit']

    def deletes():
        return [e for e in events if e[0] == 'delete']

    def forwards():
        return [e for e in events if e[0] == 'forward']

    def preedits():
        return [e for e in events if e[0] == 'preedit' and e[2]]

    def tables():
        return [e for e in events if e[0] == 'table' and e[2]]

    KC_U, KC_H, KC_S, KC_A, KC_C = 30, 43, 39, 38, 54

    print('quick tap: letter committed instantly, no preedit:')
    events.clear()
    h1 = key(IBus.KEY_u, KC_U)
    check('press consumed', h1 is True)
    check("committed 'u' immediately on press", commits() == ['u'], repr(events))
    check('no preedit shown (no underline)', preedits() == [], repr(events))
    h2 = key(IBus.KEY_u, KC_U, RELEASE)
    check('release consumed', h2 is True)
    check('no extra commit on release', commits() == ['u'], repr(events))

    print('non-accent key passes through:')
    events.clear()
    h = key(IBus.KEY_h, KC_H)
    check('press not consumed', h is False)
    check('nothing committed', commits() == [], repr(events))

    print('ctrl shortcut passes through:')
    events.clear()
    h = key(IBus.KEY_c, KC_C, CONTROL)
    check('ctrl+c not consumed', h is False)
    check('nothing committed', commits() == [], repr(events))

    print('hold u -> popup -> number 1 replaces the letter:')
    events.clear()
    key(IBus.KEY_u, KC_U, wait=800)          # hold past the 500 ms threshold
    check("plain 'u' typed on press", commits() == ['u'], repr(events))
    tab = tables()
    check('popup appeared', len(tab) > 0, repr(events))
    if tab:
        check('ü is candidate 1', tab[0][1][0] == 'ü', repr(tab))
    h = key(IBus.KEY_1, 2)
    check('digit consumed', h is True)
    check('deleted the plain letter', deletes() == [('delete', -1, 1)], repr(events))
    check("committed 'ü'", commits() == ['u', 'ü'], repr(events))
    h = key(IBus.KEY_u, KC_U, RELEASE)
    check('held-key release still consumed', h is True)

    print('hold s -> Escape keeps the plain letter:')
    events.clear()
    key(IBus.KEY_s, KC_S, wait=800)
    tab = tables()
    check('popup appeared', len(tab) > 0, repr(events))
    if tab:
        check('ß is candidate 1', tab[0][1][0] == 'ß', repr(tab))
    h = key(IBus.KEY_Escape, 1)
    check('escape consumed', h is True)
    check("only the plain 's' was typed", commits() == ['s'], repr(events))
    check('nothing deleted', deletes() == [], repr(events))
    key(IBus.KEY_s, KC_S, RELEASE)

    print('hold a -> arrow right + Enter selects candidate 2:')
    events.clear()
    key(IBus.KEY_a, KC_A, wait=800)
    check('popup appeared', len(tables()) > 0, repr(events))
    key(IBus.KEY_Right, 106)
    key(IBus.KEY_Return, 28)
    check("replaced with 'à'", commits() == ['a', 'à'] and
          len(deletes()) == 1, repr(events))
    key(IBus.KEY_a, KC_A, RELEASE)

    print('fast overlapped typing (press h before releasing u):')
    events.clear()
    key(IBus.KEY_u, KC_U)
    h = key(IBus.KEY_h, KC_H)
    check("'u' stays typed, no popup later", commits() == ['u'], repr(events))
    check("'h' passes through to the app", h is False)
    key(IBus.KEY_u, KC_U, RELEASE)
    key(IBus.KEY_h, KC_H, RELEASE)
    pump(700)
    check('no popup after the timer would have fired', tables() == [],
          repr(events))

    print('backspace while popup is open passes through:')
    events.clear()
    key(IBus.KEY_o, 32, wait=800)
    check('popup appeared', len(tables()) > 0, repr(events))
    h = key(IBus.KEY_BackSpace, 14)
    check('backspace passes through (deletes the letter)', h is False)
    check('popup closed', any(e[0] == 'table-hidden' for e in events) or
          not tables()[-1][2], repr(events[-3:]))
    check("only the plain 'o' was committed", commits() == ['o'], repr(events))
    key(IBus.KEY_o, 32, RELEASE)
    key(IBus.KEY_BackSpace, 14, RELEASE)

    print('terminal purpose uses a synthetic Backspace, not surrounding text:')
    terminal = getattr(IBus.InputPurpose, 'TERMINAL', None)
    if terminal is None:
        print('  [SKIP] IBus.InputPurpose.TERMINAL not available')
    else:
        events.clear()
        ctx.set_content_type(terminal, 0)
        pump(200)
        key(IBus.KEY_u, KC_U, wait=800)
        check('popup appeared', len(tables()) > 0, repr(events))
        key(IBus.KEY_1, 2)
        check('no delete-surrounding used', deletes() == [], repr(events))
        check('Backspace forwarded',
              [f[1] for f in forwards()] == [IBus.KEY_BackSpace,
                                             IBus.KEY_BackSpace],
              repr(events))
        check("committed 'ü'", commits() == ['u', 'ü'], repr(events))
        key(IBus.KEY_u, KC_U, RELEASE)
        ctx.set_content_type(0, 0)
        pump(200)

    for p in (engine_proc, daemon):
        p.terminate()
        try:
            p.wait(timeout=3)
        except subprocess.TimeoutExpired:
            p.kill()

    print()
    if failures:
        print('FAILED:', ', '.join(failures))
        sys.exit(1)
    print('all tests passed')


if __name__ == '__main__':
    main()
