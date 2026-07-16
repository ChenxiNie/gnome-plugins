import GObject from 'gi://GObject';
import St from 'gi://St';
import Gvc from 'gi://Gvc';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

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

const HeadsetIndicator = GObject.registerClass(
class HeadsetIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'Headset Indicator', false);

        this._icon = new St.Icon({
            icon_name: ICON_SPEAKERS,
            style_class: 'system-status-icon',
        });
        this.add_child(this._icon);

        // A small menu line showing the current output device.
        this._deviceItem = new PopupMenu.PopupMenuItem('', {
            reactive: false,
            can_focus: false,
        });
        this.menu.addMenuItem(this._deviceItem);

        // Use our own mixer control so the extension is self-contained and
        // does not depend on private shell internals across versions.
        this._control = new Gvc.MixerControl({name: 'Headset Indicator'});

        this._control.connectObject(
            'state-changed', () => this._sync(),
            'default-sink-changed', () => this._sync(),
            'active-output-update', () => this._sync(),
            this);

        this._control.open();
        this._sync();
    }

    _sync() {
        if (this._control.get_state() !== Gvc.MixerControlState.READY)
            return;

        const sink = this._control.get_default_sink();
        const kind = classifyOutput(sink);

        switch (kind) {
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

        const name = sink ? sink.get_description() : 'No output';
        this._deviceItem.label.text = `${name}`;
    }

    destroy() {
        if (this._control) {
            this._control.disconnectObject(this);
            this._control.close();
            this._control = null;
        }
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
