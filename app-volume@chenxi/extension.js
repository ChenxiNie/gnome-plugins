import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Gvc from 'gi://Gvc';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Button} from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {PopupBaseMenuItem, PopupMenuItem} from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {getMixerControl} from 'resource:///org/gnome/shell/ui/status/volume.js';

const AppVolumeRow = GObject.registerClass(
class AppVolumeRow extends St.BoxLayout {
    _init(normalVolume) {
        super._init({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'app-volume-row',
        });
        this._normalVolume = normalVolume;

        const heading = new St.BoxLayout({style_class: 'app-volume-line'});
        this._name = new St.Label({x_expand: true});
        this._name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        heading.add_child(this._name);
        this._percentage = new St.Label({style_class: 'app-volume-percentage'});
        heading.add_child(this._percentage);
        this.add_child(heading);

        const controls = new St.BoxLayout({style_class: 'app-volume-line'});
        this._muteIcon = new St.Icon({icon_size: 16});
        this._muteButton = new St.Button({
            child: this._muteIcon,
            style_class: 'button app-volume-mute',
            can_focus: true,
        });
        this._muteButton.connect('clicked', () => this._toggleMute());
        controls.add_child(this._muteButton);

        this._slider = new Slider(1);
        this._slider.y_align = Clutter.ActorAlign.CENTER;
        this._sliderChangedId = this._slider.connect('notify::value', () => this._setVolume());
        controls.add_child(this._slider);
        this.add_child(controls);
    }

    sync(name, streams) {
        this._streams = streams;
        this._name.text = name;
        this._slider.accessible_name = `${name} volume`;

        // Each stream can have a different level if another mixer adjusted it.
        const volume = Math.max(...streams.map(stream => stream.get_volume()));
        const level = volume / this._normalVolume;
        this._slider.block_signal_handler(this._sliderChangedId);
        this._slider.value = Math.min(level, 1);
        this._slider.unblock_signal_handler(this._sliderChangedId);
        this._percentage.text = `${Math.round(level * 100)}%`;

        const muted = streams.every(stream => stream.get_is_muted());
        this._muteIcon.icon_name = muted ? 'audio-volume-muted-symbolic' : 'audio-volume-high-symbolic';
        this._muteButton.accessible_name = muted ? `Unmute ${name}` : `Mute ${name}`;
    }

    _toggleMute() {
        const mute = this._streams.some(stream => !stream.get_is_muted());
        for (const stream of this._streams)
            stream.change_is_muted(mute);
    }

    _setVolume() {
        const level = this._slider.value;
        const volume = Math.round(level * this._normalVolume);
        for (const stream of this._streams) {
            if (stream.set_volume(volume))
                stream.push_volume();
        }
        this._percentage.text = `${Math.round(level * 100)}%`;
    }
});

const AppVolumeIndicator = GObject.registerClass(
class AppVolumeIndicator extends Button {
    _init() {
        super._init(0.5, 'App Volume');
        this.add_child(new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            style_class: 'system-status-icon',
        }));

        this._rows = new Map();
        this._emptyItem = new PopupMenuItem('Play audio in an app to show it here.', {
            reactive: false,
            can_focus: false,
        });
        this.menu.addMenuItem(this._emptyItem);

        this._list = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
        this._listItem = new PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        this._listItem.remove_style_class_name('popup-inactive-menu-item');
        this._listItem.add_child(new St.ScrollView({
            style_class: 'app-volume-list',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            child: this._list,
        }));
        this.menu.addMenuItem(this._listItem);

        this._control = getMixerControl();
        this._control.connectObject(
            'state-changed', () => this._sync(),
            'stream-added', () => this._sync(),
            'stream-removed', () => this._sync(),
            'stream-changed', () => this._sync(),
            this);
        this._sync();
    }

    _sync() {
        const ready = this._control.get_state() === Gvc.MixerControlState.READY;
        const streams = ready ? this._control.get_sink_inputs() : [];
        const apps = new Map();

        for (const stream of streams) {
            if (stream.is_event_stream || stream.is_virtual)
                continue;

            const appId = stream.get_application_id();
            const clientName = stream.get_name();
            const key = appId ? `app:${appId}` :
                clientName ? `client:${clientName}` : `stream:${stream.get_id()}`;

            if (!apps.has(key)) {
                const desktopId = appId?.endsWith('.desktop') ? appId : `${appId}.desktop`;
                const app = appId && Shell.AppSystem.get_default().lookup_app(desktopId);
                const name = app?.get_name() || clientName || appId ||
                    stream.get_description() || 'Unknown app';
                apps.set(key, {name, streams: []});
            }
            apps.get(key).streams.push(stream);
        }

        for (const [key, row] of this._rows) {
            if (!apps.has(key)) {
                row.destroy();
                this._rows.delete(key);
            }
        }

        for (const [key, app] of apps) {
            let row = this._rows.get(key);
            if (!row) {
                row = new AppVolumeRow(this._control.get_vol_max_norm());
                this._list.add_child(row);
                this._rows.set(key, row);
            }
            row.sync(app.name, app.streams);
        }

        this._listItem.visible = apps.size > 0;
        this._emptyItem.visible = apps.size === 0;
        this._emptyItem.label.text = ready
            ? 'Play audio in an app to show it here.'
            : 'Waiting for the sound server…';
    }

    destroy() {
        this._control.disconnectObject(this);
        this._rows.clear();
        super.destroy();
    }
});

export default class AppVolumeExtension extends Extension {
    enable() {
        this._indicator = new AppVolumeIndicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
