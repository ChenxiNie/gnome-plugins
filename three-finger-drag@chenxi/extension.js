import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {WindowSwitcherPopup} from 'resource:///org/gnome/shell/ui/altTab.js';

// ---- Tunables -------------------------------------------------------------
const DRAG_FINGERS = 3;       // 3-finger gesture: window move on a titlebar,
                              // otherwise a held left-button drag (text select)
const WORKSPACE_FINGERS = 4;  // 4 fingers: switch workspace / toggle overview
const SPEED = 1.0;            // 1.0 = tracks the trackpad 1:1
const TITLEBAR_HEIGHT = 50;   // px from a window's top counted as "titlebar"
const WS_THRESHOLD = 70;      // px of net travel before a 4-finger vertical
                               // swipe toggles the overview
// A horizontal 4-finger swipe opens the alt-tab style window switcher. Once
// the swipe has moved DIRECTION_LOCK_PX in one axis, that axis is locked in
// (horizontal = window switcher, vertical = overview) for the rest of the
// gesture. While locked horizontal, the highlighted window tracks swipe
// distance directly: PX_PER_STEP of travel moves the selection by one window.
const DIRECTION_LOCK_PX = 15;
const PX_PER_STEP = 160;
// Pure safety backstop for the synthetic button. END events are reliable, so
// this only matters if one is ever lost; keep it long enough not to interrupt
// a paused text selection.
const WATCHDOG_MS = 3000;
const DEBUG = true;           // journalctl --user -b | grep TFD
// ---------------------------------------------------------------------------

const PRIMARY = Clutter.BUTTON_PRIMARY;

function log_(msg) {
    if (DEBUG)
        console.log(`TFD: ${msg}`);
}

function now() {
    return GLib.get_monotonic_time();
}

export default class ThreeFingerDragExtension extends Extension {
    enable() {
        this._seat = Clutter.get_default_backend().get_default_seat();
        this._pointer = this._seat.create_virtual_device(
            Clutter.InputDeviceType.POINTER_DEVICE);

        // 3-finger op state. _mode is null | 'move' | 'button'.
        this._mode = null;
        this._window = null;
        this._accX = 0;   // window frame position (move mode)
        this._accY = 0;
        this._ptrX = 0;   // pointer position (both modes)
        this._ptrY = 0;
        this._pressed = false;
        this._watchdogId = 0;

        // 4-finger swipe state (horizontal = window switcher, vertical = overview)
        this._wsActive = false;
        this._wsX = 0;
        this._wsY = 0;
        this._wsDir = null;        // null | 'h' | 'v', locked in once the swipe
                                    // has moved far enough to tell direction
        this._switcher = null;     // live WindowSwitcherPopup, while 'h'-locked
        this._switcherBaseX = 0;   // wsX at the moment the switcher opened

        this._suppressBuiltinSwipe();

        this._capturedId = global.stage.connect(
            'captured-event', this._onCapturedEvent.bind(this));

        log_(`enabled: drag=${DRAG_FINGERS}f workspace=${WORKSPACE_FINGERS}f`);
    }

    disable() {
        if (this._capturedId) {
            global.stage.disconnect(this._capturedId);
            this._capturedId = 0;
        }
        this._endDrag();
        this._restoreBuiltinSwipe();
        this._wsActive = false;
        this._wsDir = null;
        this._destroySwitcher();
        this._pointer = null;
        this._seat = null;
    }

    // ---- built-in gesture suppression / discovery -------------------------

    _suppressBuiltinSwipe() {
        this._restore = [];
        const candidates = [
            'wm._workspaceAnimation._swipeTracker',
            'overview._swipeTracker',
            'overview._overview.controls._swipeTracker',
            'overview._overview.controls._workspacesDisplay._swipeTracker',
        ];
        for (const path of candidates) {
            let obj = Main;
            for (const key of path.split('.')) {
                obj = obj?.[key];
                if (obj === undefined)
                    break;
            }
            if (obj && 'enabled' in obj && path === 'wm._workspaceAnimation._swipeTracker') {
                const prev = obj.enabled;
                obj.enabled = false;
                this._restore.push(() => { obj.enabled = prev; });
                log_(`disabled built-in tracker: ${path}`);
            }
        }
    }

    _restoreBuiltinSwipe() {
        for (const fn of this._restore ?? []) {
            try { fn(); } catch (e) { log_(`restore error: ${e}`); }
        }
        this._restore = [];
    }

    // ---- event dispatch ----------------------------------------------------

    _onCapturedEvent(_actor, event) {
        if (event.type() !== Clutter.EventType.TOUCHPAD_SWIPE)
            return Clutter.EVENT_PROPAGATE;

        const fingers = event.get_touchpad_gesture_finger_count();
        const phase = event.get_gesture_phase();
        const isEnd = phase === Clutter.TouchpadGesturePhase.END ||
                      phase === Clutter.TouchpadGesturePhase.CANCEL;

        // An in-progress 3-finger op owns the gesture until it ends, whatever
        // finger count the lift reports.
        if (this._mode) {
            if (phase === Clutter.TouchpadGesturePhase.UPDATE)
                return this._updateDrag(event);
            if (isEnd) {
                this._endDrag();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_STOP;
        }

        if (phase === Clutter.TouchpadGesturePhase.BEGIN && fingers === DRAG_FINGERS)
            return this._beginDrag();

        if (fingers === WORKSPACE_FINGERS)
            return this._handleWorkspace(event, phase);

        return Clutter.EVENT_PROPAGATE;
    }

    // ---- 3-finger drag (hybrid: window move vs synthetic button) ----------

    _beginDrag() {
        if (Main.overview.visible)
            return Clutter.EVENT_PROPAGATE;

        const [px, py] = global.get_pointer();
        this._ptrX = px;
        this._ptrY = py;

        const win = this._windowAtPointer(px, py);
        if (win && this._inTitlebar(win, px, py)) {
            // WINDOW MOVE: move the frame directly. We never trigger the app's
            // own move grab (which would end the gesture), so it stays smooth.
            if (win.is_maximized())
                win.unmaximize(Meta.MaximizeFlags.BOTH);
            const r = win.get_frame_rect();
            this._window = win;
            this._accX = r.x;
            this._accY = r.y;
            win.raise();
            win.focus(global.get_current_time());
            this._mode = 'move';
            log_(`mode=move titlebar at ${Math.round(px)},${Math.round(py)}`);
        } else {
            // SYNTHETIC BUTTON: position first, then press (text select, etc.).
            this._pointer.notify_absolute_motion(now(), px, py);
            this._pointer.notify_button(now(), PRIMARY, Clutter.ButtonState.PRESSED);
            this._pressed = true;
            this._mode = 'button';
            this._armWatchdog();
            log_(`mode=button press at ${Math.round(px)},${Math.round(py)}`);
        }
        return Clutter.EVENT_STOP;
    }

    _updateDrag(event) {
        const [dx, dy] = event.get_gesture_motion_delta();
        const mdx = dx * SPEED;
        const mdy = dy * SPEED;
        this._ptrX += mdx;
        this._ptrY += mdy;

        if (this._mode === 'move') {
            if (!this._window || this._window.get_workspace() === null) {
                this._endDrag();
                return Clutter.EVENT_STOP;
            }
            this._accX += mdx;
            this._accY += mdy;
            // Keep the titlebar reachable: don't let the window's top edge go
            // above the work area (behind the top panel) or so low that the
            // titlebar drops off the bottom of the screen.
            const wa = this._window.get_work_area_current_monitor();
            const minY = wa.y;
            const maxY = wa.y + wa.height - TITLEBAR_HEIGHT;
            if (this._accY < minY)
                this._accY = minY;
            else if (this._accY > maxY)
                this._accY = maxY;
            this._window.move_frame(true, Math.round(this._accX), Math.round(this._accY));
            this._seat.warp_pointer(Math.round(this._ptrX), Math.round(this._ptrY));
        } else {
            this._pointer.notify_absolute_motion(now(), this._ptrX, this._ptrY);
            this._armWatchdog();
        }
        return Clutter.EVENT_STOP;
    }

    _endDrag() {
        this._clearWatchdog();
        if (this._mode === 'button' && this._pressed) {
            this._pointer?.notify_button(now(), PRIMARY, Clutter.ButtonState.RELEASED);
            log_('release');
        }
        this._pressed = false;
        this._mode = null;
        this._window = null;
    }

    _armWatchdog() {
        this._clearWatchdog();
        this._watchdogId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, WATCHDOG_MS, () => {
            this._watchdogId = 0;
            log_('watchdog fired -> force release');
            this._endDrag();
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearWatchdog() {
        if (this._watchdogId) {
            GLib.Source.remove(this._watchdogId);
            this._watchdogId = 0;
        }
    }

    _inTitlebar(win, px, py) {
        const r = win.get_frame_rect();
        return px >= r.x && px <= r.x + r.width &&
               py >= r.y && py - r.y < TITLEBAR_HEIGHT;
    }

    _windowAtPointer(x, y) {
        const actors = global.get_window_actors();
        for (let i = actors.length - 1; i >= 0; i--) {
            const win = actors[i].meta_window;
            if (!win || win.minimized)
                continue;
            if (win.get_window_type() !== Meta.WindowType.NORMAL)
                continue;
            if (!win.allows_move())
                continue;
            const r = win.get_frame_rect();
            if (x >= r.x && x < r.x + r.width &&
                y >= r.y && y < r.y + r.height)
                return win;
        }
        return null;
    }

    // ---- 4-finger workspace / overview / window switcher -------------------

    _handleWorkspace(event, phase) {
        switch (phase) {
        case Clutter.TouchpadGesturePhase.BEGIN:
            this._wsActive = true;
            this._wsX = 0;
            this._wsY = 0;
            this._wsDir = null;
            return Clutter.EVENT_STOP;
        case Clutter.TouchpadGesturePhase.UPDATE: {
            if (!this._wsActive)
                return Clutter.EVENT_STOP;
            const [dx, dy] = event.get_gesture_motion_delta();
            this._wsX += dx;
            this._wsY += dy;

            if (!this._wsDir) {
                const ax = Math.abs(this._wsX);
                const ay = Math.abs(this._wsY);
                if (Math.max(ax, ay) >= DIRECTION_LOCK_PX) {
                    this._wsDir = ax >= ay ? 'h' : 'v';
                    log_(`4-finger direction locked: ${this._wsDir}`);
                    if (this._wsDir === 'h')
                        this._beginSwitcher();
                }
            }

            if (this._wsDir === 'h' && this._switcher)
                this._updateSwitcher();

            return Clutter.EVENT_STOP;
        }
        case Clutter.TouchpadGesturePhase.END:
            if (this._wsDir === 'h')
                this._endSwitcher();
            else if (this._wsDir === 'v')
                this._commitOverview();
            this._wsActive = false;
            this._wsDir = null;
            return Clutter.EVENT_STOP;
        case Clutter.TouchpadGesturePhase.CANCEL:
            this._destroySwitcher();
            this._wsActive = false;
            this._wsDir = null;
            return Clutter.EVENT_STOP;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }

    _commitOverview() {
        if (Math.abs(this._wsY) < WS_THRESHOLD)
            return;
        if (this._wsY < 0)
            Main.overview.show();
        else
            Main.overview.hide();
        log_(`overview ${this._wsY < 0 ? 'show' : 'hide'}`);
    }

    // ---- alt-tab style window switcher, driven live by swipe distance -----

    _beginSwitcher() {
        if (Main.overview.visible)
            return;

        const switcher = new WindowSwitcherPopup();
        switcher.connect('destroy', () => {
            if (this._switcher === switcher)
                this._switcher = null;
        });
        // There's no modifier key to "hold" here, so disable the popup's
        // built-in "no mods held" auto-close timeout entirely.
        switcher._resetNoModsTimeout = () => {};

        const shown = switcher.show(false, 'switch-windows', 0);
        if (!shown || switcher._items.length < 2) {
            switcher.destroy();
            return;
        }

        // We're driving selection from swipe events, not a keybinding grab;
        // drop the modal grab so the swipe's own event handling keeps working.
        switcher._popModal();

        // Show immediately instead of GNOME's normal appear-after-a-beat delay
        // -- the swipe itself is already the "I'm choosing" signal.
        if (switcher._initialDelayTimeoutId) {
            GLib.source_remove(switcher._initialDelayTimeoutId);
            switcher._initialDelayTimeoutId = 0;
        }
        switcher.opacity = 255;

        this._switcher = switcher;
        this._switcherBaseX = this._wsX;
        switcher._select(0);
        log_(`switcher open: ${switcher._items.length} windows`);
    }

    _updateSwitcher() {
        const n = this._switcher._items.length;
        const progress = this._wsX - this._switcherBaseX;
        let index = Math.round(progress / PX_PER_STEP);
        index = Math.min(Math.max(index, 0), n - 1);
        if (index !== this._switcher._selectedIndex)
            this._switcher._select(index);
    }

    _endSwitcher() {
        if (!this._switcher)
            return;
        const item = this._switcher._items[this._switcher._selectedIndex];
        this._destroySwitcher();
        if (item) {
            item.window.activate(global.get_current_time());
            log_(`window switch -> ${item.window.get_title?.() ?? '?'}`);
        }
    }

    _destroySwitcher() {
        if (this._switcher) {
            this._switcher.destroy();
            this._switcher = null;
        }
    }
}
