import GObject from 'gi://GObject';
import St from 'gi://St';
import Gvc from 'gi://Gvc';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';

// Icons that exist in the symbolic theme on GNOME.
const ICON_HEADSET = 'audio-headset-symbolic';      // has a mic (hands-free / headset profile)
const ICON_HEADPHONES = 'audio-headphones-symbolic'; // music-only headphones
const ICON_SPEAKERS = 'audio-speakers-symbolic';     // everything else

// Decide what kind of output the given Gvc.MixerStream is.
// Returns one of: 'headset' | 'headphones' | 'speakers'.
// Uses three independent signals so it works for Bluetooth, USB and the
// analog jack (where form_factor stays 'internal' but the active port flips
// to "Headphones"):
//   1. form factor reported by PipeWire/PulseAudio
//   2. the device icon name Gvc computed for the stream
//   3. the human-readable active port name
function classifyOutput(stream) {
    if (!stream)
        return 'speakers';

    const parts = [];

    try {
        const ff = stream.get_form_factor();
        if (ff)
            parts.push(ff);
    } catch (_e) { /* not all builds expose this */ }

    try {
        const icon = stream.get_icon_name();
        if (icon)
            parts.push(icon);
    } catch (_e) { /* ignore */ }

    try {
        const port = stream.get_port();
        if (port) {
            if (port.port)
                parts.push(port.port);
            if (port.human_port)
                parts.push(port.human_port);
        }
    } catch (_e) { /* ignore */ }

    const hay = parts.join(' ').toLowerCase();

    if (hay.includes('headset') ||
        hay.includes('hands-free') ||
        hay.includes('handsfree'))
        return 'headset';

    if (hay.includes('headphone'))
        return 'headphones';

    return 'speakers';
}

// Menu label for a Gvc.MixerUIDevice, same style as GNOME Quick Settings:
// "Headphones – Built-in Audio", "WH-1000XM4", ...
function deviceLabel(device) {
    const description = device.get_description() || 'Unknown device';
    const origin = device.get_origin();
    return origin ? `${description} – ${origin}` : description;
}

const HeadsetIndicator = GObject.registerClass(
class HeadsetIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'Headset Indicator', false);

        this._icon = new St.Icon({
            icon_name: ICON_SPEAKERS,
            style_class: 'system-status-icon',
        });
        this.add_child(this._icon);

        // One switchable menu item per output device (Gvc.MixerUIDevice,
        // i.e. per port: "Speakers" and "Headphones" on the same card are
        // separate entries, like in GNOME's own output chooser).
        this._deviceItems = new Map(); // Gvc device id -> PopupImageMenuItem
        this._activeId = 0;

        this._deviceSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._deviceSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('Sound Settings…',
            () => Util.spawn(['gnome-control-center', 'sound']));

        // Use our own mixer control so the extension is self-contained and
        // does not depend on private shell internals across versions.
        this._control = new Gvc.MixerControl({name: 'Headset Indicator'});

        this._control.connectObject(
            'state-changed', () => this._sync(),
            'default-sink-changed', () => this._sync(),
            'active-output-update', (_c, id) => {
                this._activeId = id;
                this._syncActive();
                this._sync();
            },
            'output-added', (_c, id) => this._addOutput(id),
            'output-removed', (_c, id) => this._removeOutput(id),
            this);

        this._control.open();
        this._sync();
    }

    _addOutput(id) {
        if (this._deviceItems.has(id))
            return;
        const device = this._control.lookup_output_id(id);
        if (!device)
            return;

        const item = new PopupMenu.PopupImageMenuItem(
            deviceLabel(device),
            device.get_icon_name() || ICON_SPEAKERS);
        item.connect('activate', () => {
            const dev = this._control.lookup_output_id(id);
            if (dev)
                this._control.change_output(dev);
        });
        this._deviceSection.addMenuItem(item);
        this._deviceItems.set(id, item);
        this._syncActive();
    }

    _removeOutput(id) {
        this._deviceItems.get(id)?.destroy();
        this._deviceItems.delete(id);
    }

    _syncActive() {
        for (const [id, item] of this._deviceItems) {
            item.setOrnament(id === this._activeId
                ? PopupMenu.Ornament.CHECK
                : PopupMenu.Ornament.NONE);
        }
    }

    _sync() {
        if (this._control.get_state() !== Gvc.MixerControlState.READY)
            return;

        const sink = this._control.get_default_sink();

        // Keep the checkmark right even if no active-output-update was
        // emitted (e.g. right after opening the control).
        if (sink) {
            const dev = this._control.lookup_device_from_stream(sink);
            if (dev)
                this._activeId = dev.get_id();
            this._syncActive();
        }

        switch (classifyOutput(sink)) {
        case 'headset':
            this._icon.icon_name = ICON_HEADSET;
            break;
        case 'headphones':
            this._icon.icon_name = ICON_HEADPHONES;
            break;
        default:
            this._icon.icon_name = ICON_SPEAKERS;
            break;
        }
    }

    destroy() {
        if (this._control) {
            this._control.disconnectObject(this);
            this._control.close();
            this._control = null;
        }
        this._deviceItems.clear();
        super.destroy();
    }
});

export default class HeadsetIndicatorExtension extends Extension {
    enable() {
        this._indicator = new HeadsetIndicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
