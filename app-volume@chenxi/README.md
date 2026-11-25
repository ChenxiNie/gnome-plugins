# App Volume

App Volume adds a music-note icon to the GNOME 50 top bar. Start audio in the game
or app you want to control, open the mixer, and click the speaker beside that
app to mute it. Click it again to restore sound at the same volume. The slider
adjusts that app's level, with 100% following the system output volume.

The mixer starts with the volume and mute state reported by GNOME's sound
server. Apps appear when they have a playback stream. On Steam with Proton,
Master Duel may appear as `masterduel.exe`.

## Install

From the directory containing `app-volume@chenxi`, run these commands to
build and install the bundle.

```sh
gnome-extensions pack --force app-volume@chenxi
gnome-extensions install app-volume@chenxi.shell-extension.zip
```

Log out and back in so GNOME discovers the extension, then enable it.

```sh
gnome-extensions enable app-volume@chenxi
```
