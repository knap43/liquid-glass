import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Gio from 'gi://Gio';

import type { Logger } from './logger.js';
import { ToggleBackdropGlass } from './quickSettingsToggles.js';
import { MAX_GLASS_REGIONS, type GlassRegion } from './rendering/glassRenderer.js';
import {
  LayoutOpaqueActor, ensureGlassAllocated, getTransformedRect, isActorValid, placeScreenGlass, setPositionIfChanged,
  setScaleIfChanged
} from './actors.js';
import { startSyncLoop, stopStageLoop } from './animation.js';

// Room around each region for the shader's edge effects.
const SHADER_PADDING = 20;
// How much of a button's own color its glass takes, scaled by how opaque the theme paints it.
const BASE_STRENGTH = 0.85;
const PAINTED_ALPHA = 0.02;
const MIN_GLASS_SIZE = 12;
const STATES = ['checked', 'hover', 'active', 'insensitive', 'focus', 'selected'];
const OVERRIDE = 'background-color: transparent !important; background-image: none !important; box-shadow: none !important;';

export type ButtonColor = { readonly baseColor: readonly number[], readonly baseAlpha: number, readonly radius?: number };

/** Finds a menu's buttons, gives each glass's color, and hides their own backgrounds over it. */
export interface ButtonSource {
  sync(root: Clutter.Actor, limit: number): Clutter.Actor[];
  colorFor(actor: Clutter.Actor): ButtonColor | undefined;
  // Called as the menu opens and closes, for a source that keeps sampling while the menu is open.
  start?(): void;
  stop?(): void;
  clear(): void;
}

type Entry = { key: string, color: number[], alpha: number, radius: number, destroyId: number };

/**
 * The buttons, rows and cards of an ordinary menu. Whatever paints a background in its current state (a hovered
 * row, today in the calendar, a card, an open submenu) gets glass in its place; its color is read with the
 * override lifted whenever its state changes. Nothing inside a piece of glass gets glass of its own: the
 * container's background would be drawn over it.
 */
export class ButtonStyles implements ButtonSource {
  private _entries = new Map<St.Widget, Entry>();

  sync(root: Clutter.Actor, limit: number): Clutter.Actor[] {
    const glassed: Clutter.Actor[] = [];
    const walk = (actor: Clutter.Actor) => {
      for (const child of actor.get_children()) {
        if (!child.visible || child instanceof LayoutOpaqueActor || child instanceof St.ScrollBar) continue;
        if (!(child instanceof St.Widget)) {
          walk(child);
          continue;
        }
        const painted = this._refresh(child).alpha > PAINTED_ALPHA;
        const wanted = painted && glassed.length < limit && child.mapped && bigEnough(child) && fullyShown(child, root);
        setOverride(child, wanted);
        if (wanted) glassed.push(child);
        else if (!painted) walk(child);
      }
    };
    walk(root);
    return glassed;
  }

  colorFor(actor: Clutter.Actor): ButtonColor | undefined {
    const entry = this._entries.get(actor as St.Widget);
    return entry && { baseColor: entry.color, baseAlpha: entry.alpha, radius: entry.radius };
  }

  clear(): void {
    for (const [widget, entry] of this._entries) {
      widget.disconnect(entry.destroyId);
      setOverride(widget, false);
    }
    this._entries.clear();
  }

  private _refresh(widget: St.Widget): Entry {
    const key = STATES.map(state => (widget.has_style_pseudo_class(state) ? '1' : '0')).join('');
    let entry = this._entries.get(widget);
    if (entry && entry.key === key) return entry;
    if (!entry) {
      entry = { key, color: [1, 1, 1], alpha: 0, radius: 0, destroyId: 0 };
      entry.destroyId = widget.connect('destroy', () => this._entries.delete(widget));
      this._entries.set(widget, entry);
    }
    entry.key = key;
    const overridden = setOverride(widget, false);
    widget.ensure_style();
    const node = widget.get_theme_node();
    const bg = node.get_background_color();
    entry.alpha = bg.alpha / 255;
    if (entry.alpha > PAINTED_ALPHA) entry.color = [bg.red / 255, bg.green / 255, bg.blue / 255];
    entry.radius = node.get_border_radius(St.Corner.TOPLEFT);
    setOverride(widget, overridden);
    return entry;
  }
}

// Separators and other thin lines are drawn as backgrounds too; they stay as they are.
function bigEnough(actor: Clutter.Actor): boolean {
  const [w, h] = actor.get_size();
  return Math.min(w, h) >= MIN_GLASS_SIZE;
}

// Adds or removes the override, leaving whatever else the style holds (adaptive text colors) alone. Returns
// whether it was there.
function setOverride(actor: St.Widget, on: boolean): boolean {
  const style = actor.get_style() ?? '';
  const had = style.includes(OVERRIDE);
  if (on === had) return had;
  const rest = style.replace(OVERRIDE, '').trim();
  actor.set_style(on ? `${rest} ${OVERRIDE}`.trim() : rest || null);
  return had;
}

// A widget scrolled partly out of view keeps its own background: its glass would spill out of the scroll view.
function fullyShown(widget: Clutter.Actor, root: Clutter.Actor): boolean {
  const [x, y, w, h] = getTransformedRect(widget);
  for (let a = widget.get_parent(); a && a !== root; a = a.get_parent()) {
    if (!a.clip_to_allocation && !a.has_clip) continue;
    const [cx, cy, cw, ch] = getTransformedRect(a);
    if (x < cx - 0.5 || y < cy - 0.5 || x + w > cx + cw + 0.5 || y + h > cy + ch + 0.5) return false;
  }
  return true;
}

export interface MenuButtonGlassParams {
  extensionPath: string;
  settings: Gio.Settings;
  logger: Logger;
  // Names the glass in dumps.
  owner: string;
  // The settings namespace whose look the glass takes, e.g. `menu`.
  keyPrefix: string;
  menu: any;
  styles: ButtonSource;
  // The corner radius of buttons that do not report their own.
  radius?: () => number;
}

/**
 * A piece of glass under each button of a menu that has glass of its own, drawn as the regions of one glass
 * inside the menu box, under the buttons' labels. Its reader sits just below the menu, over the menu's glass,
 * so the buttons' glass bends the menu's glass and what is behind it.
 */
export class MenuButtonGlass {
  private _glass: ToggleBackdropGlass;
  private _host: Clutter.Actor;
  private _signals: { target: any, id: number }[] = [];
  private _frameSignalId = 0;
  private _frameId = 0;
  private _boundsKey = '';

  constructor(private _p: MenuButtonGlassParams) {
    this._glass = new ToggleBackdropGlass({
      extensionPath: _p.extensionPath, settings: _p.settings, logger: _p.logger, owner: _p.owner,
    } as any);
    this._glass.set_size(1, 1);
    this._glass.set_pivot_point(0, 0);
    this._glass.setPadding(SHADER_PADDING);
    this._glass.setIsDock(false);
    this._glass.setMultiRegionMode(true);
    this._glass.hide();

    // A zero-size host keeps the menu box from growing to the glass's monitor size.
    this._host = new LayoutOpaqueActor();
    this._host.set_name('liquid-glass-button-host');
    this._host.add_child(this._glass);
    _p.menu.box.insert_child_at_index(this._host, 0);
    Main.layoutManager.uiGroup.add_child(this._glass.reader);

    const open = (isOpen: boolean) => {
      if (!isOpen) {
        _p.styles.stop?.();
        return;
      }
      this._applyLook();
      _p.styles.start?.();
      startSyncLoop(this._frameSignalSlot, this._frameSlot, {
        alive: () => _p.menu.actor.mapped || _p.menu.isOpen,
        errorTag: `MenuButtonGlass(${_p.owner})`,
        step: () => this._step(),
      });
    };
    this._signals.push({ target: _p.menu, id: _p.menu.connect('open-state-changed', (_m: any, isOpen: boolean) => open(isOpen)) });
    if (_p.menu.isOpen) open(true);
  }

  destroy(): void {
    stopStageLoop(this._frameSignalSlot, this._frameSlot);
    for (const { target, id } of this._signals) target.disconnect(id);
    this._signals = [];
    this._p.styles.clear();
    this._glass.cleanup();
    // At shell shutdown the stage may have destroyed them already.
    if (isActorValid(this._host)) this._host.destroy();
  }

  private get _frameSignalSlot() {
    return { get: () => this._frameSignalId, set: (id: number) => { this._frameSignalId = id; } };
  }

  private get _frameSlot() {
    return { get: () => this._frameId, set: (id: number) => { this._frameId = id; } };
  }

  private _applyLook(): void {
    const key = (suffix: string) => `${this._p.keyPrefix}-${suffix}`;
    const settings = this._p.settings;
    // The menu's glass under the buttons already carries the tint; a second layer would wash out their colors.
    this._glass.setTintStrength(0);
    this._glass.setBlurRadius(settings.get_int(key('blur-radius')));
    this._glass.setBrightness(settings.get_double(key('brightness')));
    this._glass.setContrast(settings.get_double(key('contrast')));
    this._glass.setSaturation(settings.get_double(key('saturation')));
    this._glass.setCornerRadius(this._p.radius?.() ?? 12);
  }

  private _step(): void {
    const menu = this._p.menu;
    if (!menu.actor.mapped) {
      this._glass.hide();
      return;
    }
    this._restack();

    const monitor = Main.layoutManager.monitors[Main.layoutManager.findIndexForActor(menu.actor)] ??
      Main.layoutManager.primaryMonitor;
    if (!monitor) return;
    this._placeHost(monitor.x, monitor.y);

    const buttons = this._p.styles.sync(menu.box, MAX_GLASS_REGIONS);
    const regions: GlassRegion[] = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const button of buttons) {
      const [x, y, w, h] = getTransformedRect(button);
      if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) continue;
      const color = this._p.styles.colorFor(button);
      const rx = x - monitor.x - SHADER_PADDING, ry = y - monitor.y - SHADER_PADDING;
      const rw = w + SHADER_PADDING * 2, rh = h + SHADER_PADDING * 2;
      const hasColor = !!color && color.baseAlpha > PAINTED_ALPHA;
      regions.push({
        x: rx, y: ry, w: rw, h: rh,
        tintR: color?.baseColor[0] ?? 1, tintG: color?.baseColor[1] ?? 1, tintB: color?.baseColor[2] ?? 1,
        baseStrength: hasColor ? BASE_STRENGTH * Math.min(1, color!.baseAlpha) : 0,
        // The theme's radius may be a "pill" value far larger than the button.
        radius: color?.radius !== undefined ? Math.min(color.radius, w / 2, h / 2) : undefined,
      });
      minX = Math.min(minX, rx); minY = Math.min(minY, ry);
      maxX = Math.max(maxX, rx + rw); maxY = Math.max(maxY, ry + rh);
    }
    if (regions.length === 0) {
      this._glass.hide();
      return;
    }

    this._glass.setGlassRegions(regions);
    const [hostX, hostY] = [this._glass.x, this._glass.y];
    const key = `${monitor.x},${monitor.y},${monitor.width},${monitor.height},${hostX},${hostY},${minX},${minY},${maxX},${maxY}`;
    if (key !== this._boundsKey) {
      this._boundsKey = key;
      placeScreenGlass(this._glass, hostX, hostY, monitor.width, monitor.height,
        { x: minX, y: minY, w: maxX - minX, h: maxY - minY });
      this._glass.setResolution(monitor.width, monitor.height);
    }
    if (!this._glass.visible) this._glass.show();
    ensureGlassAllocated(this._glass);
    this._glass.syncSources();
  }

  // The reader copies the stage just before the menu is drawn, after the menu's own glass, which other code
  // restacks directly under the menu.
  private _restack(): void {
    const uiGroup = Main.layoutManager.uiGroup;
    let root: Clutter.Actor = this._p.menu.actor;
    while (root.get_parent() && root.get_parent() !== uiGroup) root = root.get_parent()!;
    if (root.get_parent() !== uiGroup) return;
    if (root.get_previous_sibling() !== this._glass.reader) uiGroup.set_child_below_sibling(this._glass.reader, root);
  }

  // Keeps the host first in the menu box (the shell reorders its children) and puts the glass's origin on the
  // monitor's despite the box's position and the scale an open animation gives an ancestor.
  private _placeHost(monitorX: number, monitorY: number): void {
    const box = this._p.menu.box;
    if (box.get_first_child() !== this._host) box.set_child_below_sibling(this._host, null);
    const [hostX, hostY] = this._host.get_transformed_position();
    if (!Number.isFinite(hostX) || !Number.isFinite(hostY)) return;
    let sx = 1, sy = 1;
    for (let a: Clutter.Actor | null = this._host; a; a = a.get_parent()) {
      const [ax, ay] = a.get_scale();
      if (Number.isFinite(ax) && ax !== 0) sx *= ax;
      if (Number.isFinite(ay) && ay !== 0) sy *= ay;
    }
    setScaleIfChanged(this._glass, 1 / sx, 1 / sy);
    setPositionIfChanged(this._glass, (monitorX - hostX) / sx, (monitorY - hostY) / sy);
  }
}
