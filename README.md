# gnome-plugins

Personal GNOME desktop plugins for Ubuntu (GNOME Shell 45–50, Wayland).

| Plugin | What it does |
|---|---|
| [`headset-indicator@chenxi`](headset-indicator@chenxi/) | GNOME Shell extension: shows a headphone icon in the top bar when the active audio output is a headset (Bluetooth, USB, or analog jack), a speaker icon otherwise; click for the device name. |
| [`three-finger-drag@chenxi`](three-finger-drag@chenxi/) | GNOME Shell extension: macOS-style trackpad gestures — three-finger drag acts as a held left mouse button (move windows, select text, drag icons); four-finger horizontal swipe opens a live window switcher, four-finger vertical toggles the overview. |
| [`long-press-for-German-letters`](long-press-for-German-letters/) | IBus input-method engine: macOS-style press-and-hold accent picker — hold `u` for `ü û ù ú ū`, hold `s` for `ß`, pick by number/arrows/click. Not a Shell extension (Wayland doesn't let extensions intercept typing); see its README for how it works. |

## Install on a new machine

```sh
git clone git@github.com:ChenxiNie/gnome-plugins.git
cd gnome-plugins

# The two GNOME Shell extensions:
./install.sh
# ... then log out and back in (Wayland only loads new extensions at login)
# and enable them:
gnome-extensions enable headset-indicator@chenxi
gnome-extensions enable three-finger-drag@chenxi

# The long-press accent engine (needs sudo for the IBus component file):
cd long-press-for-German-letters
./install.sh
```

## Development

The repo is the source of truth. For the Shell extensions, edit here, rerun
`./install.sh`, then log out/in (or `Alt+F2` `r` on X11). For the IBus
engine, edit and run `ibus restart` — it executes straight from its folder.
