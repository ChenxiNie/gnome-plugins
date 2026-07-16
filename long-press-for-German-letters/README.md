# ibus-longpress — macOS-style press-and-hold accents for GNOME Wayland

Hold `u` and a numbered popup appears at the text caret: `ü û ù ú ū`.
Type the number, use arrow keys + Enter, or click a candidate. Hold `s`
for `ß`. Works exactly like the macOS accent menu, in every app.

```
        ┌───────────────────────┐
 hold u │ ü   û   ù   ú   ū     │
        │ 1   2   3   4   5     │
        └───────────────────────┘
```

## Why an IBus engine (and not a GNOME extension)

On Wayland, GNOME Shell extensions cannot see — let alone block — normal
letter keys typed into other applications; that is by design of Wayland's
security model. Projects like [accent-hold](https://github.com/d101c/accent-hold)
work around this with a trigger shortcut (Super+E, then the letter) or a
privileged evdev daemon.

An input method engine, however, legitimately sits in the keyboard path of
every application (Wayland-native, XWayland, and terminals alike), can
consume a key press before the app sees it — which is what suppresses key
repeat while you hold — and gets its candidate popup rendered natively by
GNOME Shell at the caret, the same popup rime/pinyin users see. No root, no
raw input access, no hacks.

## Behavior (matches macOS)

- **Every press types the plain letter instantly** — a normal keystroke,
  no preedit/underline. Quick taps are completely untouched.
- **Hold ~0.5 s** — key repeat is suppressed and the popup opens; the
  plain letter stays visible in the text.
- **Pick a candidate** — number keys `1–9`, `←`/`→` (or Tab) + `Enter`,
  or mouse click. The already-typed letter is replaced by the accented one
  (via IM delete-surrounding-text, or a synthetic Backspace in terminals).
- **Esc** or any other key — keeps the plain letter (the other key is then
  typed normally).
- **Backspace** — deletes the letter as usual and closes the popup.
- Works with Shift/Caps for capitals: hold `Shift+U` → `Ü Û Ù Ú Ū`.
- Keyboard shortcuts (`Ctrl+…`, `Alt+…`, `Super+…`) are never touched.

Covered letters (German first, then the full macOS sets):
`a o u` (umlauts first), `s` (ß first), `e i n c y z l`.

Like on macOS, holding a covered letter no longer auto-repeats it
(`aaaa…`). Letters you remove from the map (see below) keep normal repeat.

## Install

```sh
./install.sh
```

This installs `python3-gi`/`gir1.2-ibus-1.0`, registers the engine with
IBus (the only step needing sudo), restarts the ibus daemon, and swaps the
plain `English (US)` input source for `English (US, long-press accents)`.
Your Chinese (rime) input source is left untouched — switch between them
with `Super+Space` as usual.

Uninstall with `./uninstall.sh`.

## Test

```sh
python3 test.py
```

Drives the engine end-to-end through a private IBus input context (no GUI
needed). If the engine isn't installed yet it is spawned temporarily in
standalone mode.

## Configuration

Optional file `~/.config/ibus-longpress.json`:

```json
{
  "hold_ms": 500,
  "replace": "auto",
  "keys": {
    "u": ["ü", "û", "ù", "ú", "ū"],
    "e": null
  }
}
```

- `hold_ms` — how long to hold before the popup opens.
- `replace` — how the plain letter is replaced on selection: `"auto"`
  (delete-surrounding-text where supported, synthetic Backspace for
  terminal-purpose inputs), `"surrounding"`, or `"backspace"`.
- `keys` — override the candidate list for a letter, or set a letter to
  `null` to disable it (restores normal key repeat for it). Capitals are
  derived automatically unless you define them explicitly.

German-only minimal setup (only `a o u s` are intercepted, every other
letter behaves 100 % stock):

```json
{ "keys": { "e": null, "i": null, "n": null, "c": null,
            "y": null, "z": null, "l": null } }
```

After changing the config or `engine.py`, run `ibus restart`.

## Files

- `engine.py` — the IBus engine (also runs standalone for development:
  `python3 engine.py` registers it with the running daemon until killed).
- `longpress.xml.in` — component template; `install.sh` fills in the
  absolute path and installs it to `/usr/share/ibus/component/`.
- `install.sh` / `uninstall.sh`
- `test.py` — headless end-to-end tests.

## Limitations

- Apps that bypass input methods entirely (rare; some games, some
  Flatpak apps with broken IM portals) see a plain US layout.
- The rare app that supports neither delete-surrounding-text nor synthetic
  keys would fail to erase the plain letter on selection (you'd get e.g.
  `uü`); set `"replace": "backspace"` if you ever see that.
- The popup is drawn by GNOME Shell, so its look follows your Shell theme,
  not macOS.
