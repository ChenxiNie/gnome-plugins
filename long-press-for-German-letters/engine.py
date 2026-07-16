#!/usr/bin/python3
# System python3 required: python3-gi is an apt package, not available in
# conda/pyenv interpreters.
# ibus-longpress: macOS-style press-and-hold accent picker for the US layout.
#
# A pressed letter is committed to the app immediately, exactly like a
# normal keystroke (no preedit, no underline). Hold an accent-capable
# letter (a e i o u s n c y z l, or their capitals) for hold_ms and a
# numbered candidate popup appears at the caret, rendered by GNOME Shell.
# Picking a candidate (1-9, arrows + Enter, or mouse click) replaces the
# already-typed letter with the accented one — the macOS model. Esc or any
# other key keeps the plain letter; Backspace deletes it as usual. Key
# repeat is suppressed for covered letters while held (as on macOS).
#
# Optional config file: ~/.config/ibus-longpress.json
#   {
#     "hold_ms": 500,
#     "replace": "auto",        // "auto" | "surrounding" | "backspace"
#     "keys": {
#       "u": ["ü", "û", "ù"],   // override candidates for a letter
#       "e": null               // remove a letter (restores key repeat)
#     }
#   }

import json
import os
import sys
import traceback

import gi
gi.require_version('IBus', '1.0')
from gi.repository import GLib, GObject, IBus

BUS_NAME = 'org.freedesktop.IBus.LongPressUS'
ENGINE_NAME = 'longpress-us'
DEFAULT_HOLD_MS = 500

# macOS press-and-hold sets (US keyboard), with the German characters
# moved to slot 1 so ä/ö/ü/ß are always the "1" key.
DEFAULT_KEYS = {
    'a': ['ä', 'à', 'á', 'â', 'æ', 'ã', 'å', 'ā'],
    'e': ['è', 'é', 'ê', 'ë', 'ē', 'ė', 'ę'],
    'i': ['î', 'ï', 'í', 'ī', 'į', 'ì'],
    'o': ['ö', 'ô', 'ò', 'ó', 'œ', 'ø', 'ō', 'õ'],
    'u': ['ü', 'û', 'ù', 'ú', 'ū'],
    's': ['ß', 'ś', 'š'],
    'n': ['ñ', 'ń'],
    'c': ['ç', 'ć', 'č'],
    'y': ['ÿ'],
    'z': ['ž', 'ź', 'ż'],
    'l': ['ł'],
}

# Modifiers that make a key press "not typing" (shift/caps/numlock excluded).
BAD_MODS = (IBus.ModifierType.CONTROL_MASK | IBus.ModifierType.MOD1_MASK |
            IBus.ModifierType.MOD3_MASK | IBus.ModifierType.MOD4_MASK |
            IBus.ModifierType.MOD5_MASK | IBus.ModifierType.SUPER_MASK |
            IBus.ModifierType.HYPER_MASK | IBus.ModifierType.META_MASK)

MODIFIER_KEYVALS = {
    IBus.KEY_Shift_L, IBus.KEY_Shift_R, IBus.KEY_Control_L, IBus.KEY_Control_R,
    IBus.KEY_Alt_L, IBus.KEY_Alt_R, IBus.KEY_Meta_L, IBus.KEY_Meta_R,
    IBus.KEY_Super_L, IBus.KEY_Super_R, IBus.KEY_Hyper_L, IBus.KEY_Hyper_R,
    IBus.KEY_Caps_Lock, IBus.KEY_Num_Lock, IBus.KEY_ISO_Level3_Shift,
}

DIGIT_KEYVALS = {getattr(IBus, 'KEY_%d' % i): i for i in range(1, 10)}
DIGIT_KEYVALS.update({getattr(IBus, 'KEY_KP_%d' % i): i for i in range(1, 10)})

NEXT_KEYVALS = {IBus.KEY_Right, IBus.KEY_Down, IBus.KEY_Tab}
PREV_KEYVALS = {IBus.KEY_Left, IBus.KEY_Up, IBus.KEY_ISO_Left_Tab}
COMMIT_KEYVALS = {IBus.KEY_Return, IBus.KEY_KP_Enter}

BACKSPACE_KEYCODE = 14  # evdev KEY_BACKSPACE

IDLE, PENDING, POPUP = range(3)

DEBUG = bool(os.environ.get('IBUS_LONGPRESS_DEBUG'))


def debug(*args):
    if DEBUG:
        print('ibus-longpress:', *args, file=sys.stderr, flush=True)


def _uppercase(ch):
    return 'ẞ' if ch == 'ß' else ch.upper()


def load_config():
    keys = {k: list(v) for k, v in DEFAULT_KEYS.items()}
    hold_ms = DEFAULT_HOLD_MS
    replace = 'auto'
    path = os.path.join(GLib.get_user_config_dir(), 'ibus-longpress.json')
    try:
        with open(path) as f:
            cfg = json.load(f)
        hold_ms = int(cfg.get('hold_ms', hold_ms))
        if cfg.get('replace') in ('auto', 'surrounding', 'backspace'):
            replace = cfg['replace']
        for k, v in cfg.get('keys', {}).items():
            if v:
                keys[k] = [str(c) for c in v]
            else:
                keys.pop(k, None)
    except FileNotFoundError:
        pass
    except Exception:
        print('ibus-longpress: bad config %s, using defaults' % path,
              file=sys.stderr)
        traceback.print_exc()
    # Derive capitals for any letter that has no explicit capital entry.
    for k in list(keys):
        if len(k) == 1 and k.upper() != k and k.upper() not in keys:
            keys[k.upper()] = [_uppercase(c) for c in keys[k]]
    return keys, max(int(hold_ms), 100), replace


class LongPressEngine(IBus.Engine):
    __gtype_name__ = 'LongPressEngine'

    def __init__(self):
        super().__init__()
        debug('engine instance created')
        self._keys, self._hold_ms, self._replace = load_config()
        self._state = IDLE
        self._timer = 0
        self._keycode = None
        self._char = None
        self._candidates = []
        self._table = None
        self._swallow_release = None
        self._caps = 0
        self._purpose = 0

    # ---------- state helpers ----------

    def _cancel_timer(self):
        if self._timer:
            GLib.source_remove(self._timer)
            self._timer = 0

    def _to_idle(self):
        self._cancel_timer()
        if self._state == POPUP:
            self.hide_lookup_table()
        self._state = IDLE
        if self._keycode is not None:
            # We consumed this key's press; if its release arrives later,
            # swallow it so apps never see an orphaned release.
            self._swallow_release = self._keycode
        self._keycode = None
        self._char = None
        self._candidates = []
        self._table = None

    def _start_pending(self, keycode, ch):
        # Type the letter immediately — indistinguishable from a normal
        # keystroke. If the key is held long enough, the popup opens and a
        # selection replaces this character.
        self.commit_text(IBus.Text.new_from_string(ch))
        self._state = PENDING
        self._keycode = keycode
        self._char = ch
        self._candidates = self._keys[ch]
        self._timer = GLib.timeout_add(self._hold_ms, self._on_hold)

    def _on_hold(self):
        self._timer = 0
        if self._state == PENDING:
            table = IBus.LookupTable.new(9, 0, True, False)
            table.set_orientation(IBus.Orientation.HORIZONTAL)
            for c in self._candidates:
                table.append_candidate(IBus.Text.new_from_string(c))
            self._table = table
            self._state = POPUP
            self.update_lookup_table(table, True)
        return GLib.SOURCE_REMOVE

    def _move_cursor(self, delta):
        n = self._table.get_number_of_candidates()
        self._table.set_cursor_pos((self._table.get_cursor_pos() + delta) % n)
        self.update_lookup_table(self._table, True)

    def _use_surrounding(self):
        if self._replace == 'surrounding':
            return True
        if self._replace == 'backspace':
            return False
        terminal = getattr(IBus.InputPurpose, 'TERMINAL', None)
        if terminal is not None and self._purpose == terminal:
            return False  # terminals: a real Backspace is the safe way
        return bool(self._caps & IBus.Capabilite.SURROUNDING_TEXT)

    def _replace_with(self, s):
        self._to_idle()
        if self._use_surrounding():
            self.delete_surrounding_text(-1, 1)
        else:
            self.forward_key_event(IBus.KEY_BackSpace, BACKSPACE_KEYCODE, 0)
            self.forward_key_event(IBus.KEY_BackSpace, BACKSPACE_KEYCODE,
                                   IBus.ModifierType.RELEASE_MASK)
        self.commit_text(IBus.Text.new_from_string(s))

    # ---------- key handling ----------

    def do_process_key_event(self, keyval, keycode, state):
        debug('key event keyval=%#x keycode=%d state=%#x st=%d'
              % (keyval, keycode, state, self._state))
        try:
            if self._state == IDLE:
                return self._process_idle(keyval, keycode, state)
            if self._state == PENDING:
                return self._process_pending(keyval, keycode, state)
            return self._process_popup(keyval, keycode, state)
        except Exception:
            traceback.print_exc()
            try:
                self._to_idle()
            except Exception:
                pass
            return False

    def _swallow(self, keycode):
        if keycode == self._swallow_release:
            self._swallow_release = None
            return True
        return False

    def _process_idle(self, keyval, keycode, state):
        if state & IBus.ModifierType.RELEASE_MASK:
            return self._swallow(keycode)
        if state & BAD_MODS:
            return False
        # keyval_to_unicode returns str in current gi, int codepoint in older
        cp = IBus.keyval_to_unicode(keyval)
        ch = (chr(cp) if isinstance(cp, int) else cp) or None
        if ch == '\x00':
            ch = None
        if ch in self._keys:
            self._start_pending(keycode, ch)
            return True
        return False

    def _process_pending(self, keyval, keycode, state):
        if state & IBus.ModifierType.RELEASE_MASK:
            if keycode == self._keycode:
                # Quick tap: the letter is already typed; just disarm.
                self._to_idle()
                self._swallow_release = None
                return True
            return self._swallow(keycode)
        if keycode == self._keycode and not state & BAD_MODS:
            return True  # autorepeat before the popup opens
        if keyval in MODIFIER_KEYVALS:
            return False
        # Another key was pressed: the pending letter simply stays typed;
        # handle the new key from scratch (it may start a new pending).
        self._to_idle()
        return self._process_idle(keyval, keycode, state)

    def _process_popup(self, keyval, keycode, state):
        if state & IBus.ModifierType.RELEASE_MASK:
            if keycode == self._keycode:
                return True  # popup stays open after the key is released
            return self._swallow(keycode)
        if keycode == self._keycode and not state & BAD_MODS:
            return True  # autorepeat while the popup is open
        if state & BAD_MODS:
            self._to_idle()
            return False
        if keyval == IBus.KEY_Escape:
            self._to_idle()  # the plain letter stays typed
            return True
        if keyval == IBus.KEY_BackSpace:
            self._to_idle()
            return False  # passes through and deletes the plain letter
        if keyval in COMMIT_KEYVALS:
            self._replace_with(self._candidates[self._table.get_cursor_pos()])
            return True
        if keyval in NEXT_KEYVALS:
            self._move_cursor(1)
            return True
        if keyval in PREV_KEYVALS:
            self._move_cursor(-1)
            return True
        digit = DIGIT_KEYVALS.get(keyval)
        if digit and digit <= len(self._candidates):
            self._replace_with(self._candidates[digit - 1])
            return True
        if keyval in MODIFIER_KEYVALS:
            return False
        # Any other key: keep the plain letter, handle the key normally.
        self._to_idle()
        return self._process_idle(keyval, keycode, state)

    def do_candidate_clicked(self, index, button, state):
        if self._state != POPUP:
            return
        page_size = self._table.get_page_size()
        pos = (self._table.get_cursor_pos() // page_size) * page_size + index
        if pos < len(self._candidates):
            self._replace_with(self._candidates[pos])

    # ---------- lifecycle ----------

    def do_set_capabilities(self, caps):
        self._caps = caps

    def do_set_content_type(self, purpose, hints):
        self._purpose = purpose

    def do_focus_out(self):
        # Nothing is pending in the app (the letter was committed on press);
        # just drop the popup and internal state.
        self._to_idle()

    def do_reset(self):
        self._to_idle()

    def do_disable(self):
        self._to_idle()


def main():
    ibus_mode = '--ibus' in sys.argv
    IBus.init()
    bus = IBus.Bus()
    if not bus.is_connected():
        print('ibus-longpress: cannot connect to the ibus daemon',
              file=sys.stderr)
        sys.exit(1)
    loop = GLib.MainLoop()
    bus.connect('disconnected', lambda *a: loop.quit())
    factory = IBus.Factory.new(bus.get_connection())
    factory.add_engine(ENGINE_NAME, GObject.type_from_name('LongPressEngine'))
    if ibus_mode:
        # Spawned by the ibus daemon via the installed component XML.
        bus.request_name(BUS_NAME, 0)
    else:
        # Standalone mode for development: register with the running daemon
        # without installing anything (lasts until this process exits).
        component = IBus.Component.new(
            BUS_NAME, 'macOS-style long-press accent picker', '0.1', 'MIT',
            'chenxi', '', '', 'ibus-longpress')
        component.add_engine(IBus.EngineDesc.new(
            ENGINE_NAME, 'English (US, long-press accents)',
            'US keyboard with a macOS-style long-press accent picker',
            'en', 'MIT', 'chenxi', '', 'us'))
        if not bus.register_component(component):
            print('ibus-longpress: register_component failed (stale '
                  'registration? try: ibus restart)', file=sys.stderr)
            sys.exit(1)
        print('ibus-longpress: registered standalone; engine "%s" available '
              'until this process exits' % ENGINE_NAME, file=sys.stderr)
    loop.run()


if __name__ == '__main__':
    main()
