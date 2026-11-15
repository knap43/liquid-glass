import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { WorkspaceSwitcherPopup } from 'resource:///org/gnome/shell/ui/workspaceSwitcherPopup.js';
import St from 'gi://St';
import { BackdropGlass } from './rendering/backdropGlass.js';
import { isActorValid, ensureGlassAllocated, setClipIfChanged } from './actors.js';
import { AdaptiveTextColor, sanitizeColorPreference } from './contrastSampler.js';
import { startSyncLoop, stopStageLoop, hexToColorArray } from './animation.js';
// Room around the glass rect for the shader's edge effects, and around that for its shadow.
const SHADER_PADDING = 20;
const CLIP_PADDING = 200;
// The theme's dots: the inactive ones are the active color at half strength.
const INACTIVE_DOT_ALPHA = 0.5;
const ENABLE_KEY = 'enable-workspace-switcher-glass';

/**
 * Glass behind the popup GNOME shows while switching workspaces. The popup is made anew for each burst of
 * switches and destroyed once it has faded, so the glass is made for each one too. It takes the OSD's look.
 */
export class WorkspaceSwitcherGlass {
    _extensionPath;
    _settings;
    _logger;
    _settingsId = 0;
    _childAddedId = 0;
    _popup = null;
    _popupDestroyId = 0;
    _glasses = [];
    _frameSignalId = 0;
    _frameId = 0;
    _text;

    constructor(_extensionPath, _settings, _logger) {
        this._extensionPath = _extensionPath;
        this._settings = _settings;
        this._logger = _logger;
        this._text = new AdaptiveTextColor(() => this._glasses.map(g => g.list), () => this._glasses.map(g => g.glass), _logger, 'workspace switcher', { ownColor: true });
    }

    setup() {
        this._settingsId = this._settings.connect(`changed::${ENABLE_KEY}`, () => this._sync());
        this._sync();
    }

    cleanup() {
        this._settings.disconnect(this._settingsId);
        this._settingsId = 0;
        this._disable();
    }

    _sync() {
        if (this._settings.get_boolean(ENABLE_KEY))
            this._enable();
        else
            this._disable();
    }

    _enable() {
        if (this._childAddedId)
            return;
        this._childAddedId = Main.uiGroup.connect('child-added', (_group, actor) => {
            if (actor instanceof WorkspaceSwitcherPopup)
                this._attach(actor);
        });
        const shown = Main.uiGroup.get_children().find(actor => actor instanceof WorkspaceSwitcherPopup);
        if (shown)
            this._attach(shown);
    }

    _disable() {
        if (this._childAddedId)
            Main.uiGroup.disconnect(this._childAddedId);
        this._childAddedId = 0;
        this._detach();
    }

    _attach(popup) {
        this._detach();
        this._popup = popup;
        this._popupDestroyId = popup.connect('destroy', () => this._detach());
        // The popup fills in its per-monitor boxes after it is added, so they get their glass in the frame loop.
        startSyncLoop(this._frameSignalSlot, this._frameSlot, { alive: () => this._popup !== null, step: () => this._step(), errorTag: 'WorkspaceSwitcherGlass' });
        if (this._settings.get_boolean('osd-enable-adaptive-text-color')) {
            this._text.start(this._settings.get_int('osd-sample-interval-ms'), sanitizeColorPreference(this._settings.get_string('osd-adaptive-text-preference')));
        }
    }

    _detach() {
        stopStageLoop(this._frameSignalSlot, this._frameSlot);
        this._text.clear();
        for (const { list, glass } of this._glasses) {
            glass.cleanup();
            // At shell shutdown the stage may have destroyed it already.
            if (isActorValid(glass))
                glass.destroy();
            if (isActorValid(list)) {
                list.remove_style_class_name('liquid-glass-transparent');
                for (const dot of list.get_children())
                    dot.set_style(null);
            }
        }
        this._glasses = [];
        if (this._popup && this._popupDestroyId)
            this._popup.disconnect(this._popupDestroyId);
        this._popupDestroyId = 0;
        this._popup = null;
    }

    get _frameSignalSlot() {
        return { get: () => this._frameSignalId, set: (id) => { this._frameSignalId = id; } };
    }

    get _frameSlot() {
        return { get: () => this._frameId, set: (id) => { this._frameId = id; } };
    }

    _newGlass(list) {
        list.add_style_class_name('liquid-glass-transparent');
        const glass = new BackdropGlass({
            extensionPath: this._extensionPath, settings: this._settings, logger: this._logger,
            owner: 'workspace-switcher', outline: 'osd',
        });
        glass.set_pivot_point(0, 0);
        glass.setPadding(SHADER_PADDING);
        glass.setTintColor(...hexToColorArray(this._settings.get_string('osd-tint-color')));
        glass.setTintStrength(this._settings.get_double('osd-tint-strength'));
        glass.setCornerRadius(this._settings.get_double('osd-corner-radius'));
        glass.setIsDock(false);
        glass.setBrightness(this._settings.get_double('osd-brightness'));
        glass.setSaturation(this._settings.get_double('osd-saturation'));
        glass.setContrast(this._settings.get_double('osd-contrast'));
        glass.setBlurRadius(this._settings.get_int('osd-blur-radius'));
        glass.setShadowMaxRadius(CLIP_PADDING - SHADER_PADDING);
        // Below the popup, so the glass reads the stage before the popup is drawn.
        Main.uiGroup.insert_child_below(glass, this._popup);
        return { list, glass, rect: '' };
    }

    _step() {
        const popup = this._popup;
        for (const list of findLists(popup)) {
            if (!this._glasses.some(g => g.list === list))
                this._glasses.push(this._newGlass(list));
        }
        const shown = popup.visible && popup.mapped && popup.opacity > 0;
        for (const entry of this._glasses) {
            const { list, glass } = entry;
            if (!shown || !list.mapped) {
                glass.hide();
                continue;
            }
            glass.opacity = popup.opacity;
            glass.show();
            ensureGlassAllocated(glass);
            this._place(entry);
            if (this._text.isAnimating() || list.get_style())
                colorDots(list);
            glass.syncSources();
        }
    }

    _place(entry) {
        const { list, glass } = entry;
        const [x, y] = list.get_transformed_position();
        const [w, h] = list.get_size();
        if (!Number.isFinite(x) || !Number.isFinite(y))
            return;
        let index = Main.layoutManager.findIndexForActor(list);
        if (index < 0)
            index = Main.layoutManager.primaryIndex;
        const monitor = Main.layoutManager.monitors[index];
        if (!monitor)
            return;
        const expand = this._settings.get_int('osd-glass-expand') + SHADER_PADDING;
        const rect = [x - expand - monitor.x, y - expand - monitor.y, w + expand * 2, h + expand * 2];
        const key = `${monitor.x},${monitor.y},${monitor.width},${monitor.height},${rect}`;
        if (key === entry.rect)
            return;
        entry.rect = key;
        // Monitor-sized, with the geometry in monitor coordinates as the shader takes it.
        glass.set_position(monitor.x, monitor.y);
        glass.set_size(monitor.width, monitor.height);
        setClipIfChanged(glass, rect[0] - CLIP_PADDING, rect[1] - CLIP_PADDING, rect[2] + CLIP_PADDING * 2, rect[3] + CLIP_PADDING * 2);
        glass.setResolution(monitor.width, monitor.height);
        glass.setGlassGeometry(rect[0], rect[1], rect[2], rect[3]);
    }
}

function findLists(actor, out = []) {
    for (const child of actor.get_children()) {
        if (child instanceof St.Widget && child.has_style_class_name('workspace-switcher'))
            out.push(child);
        else
            findLists(child, out);
    }
    return out;
}

// The dots are drawn in their background color, so they take the adaptive color the box was given as its text color.
function colorDots(list) {
    const { red, green, blue } = list.get_theme_node().get_foreground_color();
    for (const dot of list.get_children()) {
        const alpha = dot.has_style_pseudo_class('active') ? 1 : INACTIVE_DOT_ALPHA;
        const style = `background-color: rgba(${red}, ${green}, ${blue}, ${alpha});`;
        if (dot.get_style() !== style)
            dot.set_style(style);
    }
}
