import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as ShellEntry from 'resource:///org/gnome/shell/ui/shellEntry.js';

import { UIManager } from './uiManager.js';
import { Logger } from './logger.js';
import { CONTEXT_MENUS, menuOf, PANEL_MENU_PREFIX } from './panelMenuManager.js';

type ContextMenu = typeof CONTEXT_MENUS[number];

const WATCHED_KEYS = ['enable-extra-menu-glass', 'disabled-extra-menus', 'dock-menus-grow'];

function kindOf(actor: Clutter.Actor, menu: PopupMenu.PopupMenu): ContextMenu | 'dockMenu' | null {
  if (menu instanceof ShellEntry.EntryMenu) return 'textFieldMenu';
  if (!(actor instanceof St.Widget)) return null;
  if (actor.has_style_class_name('dock-app-menu')) return 'dockMenu';
  if (actor.has_style_class_name('app-menu')) return 'appIconMenu';
  if (actor.has_style_class_name('window-menu')) return 'windowMenu';
  if (actor.has_style_class_name('background-menu')) return 'backgroundMenu';
  return null;
}

/**
 * Glass behind the shell's right-click menus: app icons' (the overview's and Dash to Dock's, its show-apps button's
 * included), a window's title bar menu, the desktop background's and the text fields'. They follow the other panel
 * menus' switch and settings.
 */
export class ContextMenuManager {
  private _signals: { target: Clutter.Actor; id: number }[] = [];
  private _settingsIds: number[] = [];
  private _menus = new Map<PopupMenu.PopupMenu, { manager: UIManager, actor: Clutter.Actor, destroyId: number }>();
  private _attached = 0;

  constructor(private _path: string, private _settings: Gio.Settings, private _logger: Logger) {}

  setup() {
    const uiGroup = Main.layoutManager.uiGroup;
    // The title bar menu is built and opened at once, and the app icon menus on their first popup: they are
    // attached as they are added to uiGroup, before they open.
    this._signals.push({ target: uiGroup, id: uiGroup.connect('child-added', (_group, actor) => this._attach(actor)) });
    this._settingsIds = WATCHED_KEYS.map(key => this._settings.connect(`changed::${key}`, () => this._rescan()));
    this._rescan();
  }

  private _wanted(actor: Clutter.Actor): PopupMenu.PopupMenu | null {
    const menu = menuOf(actor);
    if (!menu?.box || !this._settings.get_boolean('enable-extra-menu-glass')) return null;
    const kind = kindOf(actor, menu);
    if (!kind) return null;
    // Grown out of the dock, its menus are part of the dock's glass whatever the app icon menus' switch says. The
    // same glass serves both ways, so the dock's menus keep it when dock-menus-grow changes.
    if (kind === 'dockMenu' && this._settings.get_boolean('dock-menus-grow')) return menu;
    const listed = kind === 'dockMenu' ? 'appIconMenu' : kind;
    return this._settings.get_strv('disabled-extra-menus').includes(listed) ? null : menu;
  }

  // Menus still wanted keep their glass, so an open menu is not closed by an unrelated change.
  private _rescan() {
    const children = Main.layoutManager.uiGroup.get_children();
    const wanted = new Set(children.map(child => this._wanted(child)).filter(menu => menu));
    for (const [menu, entry] of this._menus) {
      if (!wanted.has(menu)) this._detach(menu, entry);
    }
    for (const child of children) this._attach(child);
  }

  private _attach(actor: Clutter.Actor) {
    const menu = this._wanted(actor);
    if (!menu || this._menus.has(menu)) return;
    const manager = new UIManager(this._path, this._settings, this._logger, { menu }, false,
      'enable-extra-menu-glass', PANEL_MENU_PREFIX, `menu:context${++this._attached}`, false);
    manager.setup();
    const destroyId = actor.connect('destroy', () => {
      this._menus.delete(menu);
      manager.cleanup();
    });
    this._menus.set(menu, { manager, actor, destroyId });
  }

  private _detach(menu: PopupMenu.PopupMenu, { manager, actor, destroyId }: { manager: UIManager, actor: Clutter.Actor, destroyId: number }) {
    actor.disconnect(destroyId);
    manager.cleanup();
    this._menus.delete(menu);
  }

  cleanup() {
    for (const { target, id } of this._signals)
      target.disconnect(id);
    this._signals = [];
    for (const id of this._settingsIds) this._settings.disconnect(id);
    this._settingsIds = [];
    for (const [menu, entry] of this._menus) this._detach(menu, entry);
  }
}
