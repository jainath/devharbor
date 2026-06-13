import { Menu, shell, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import type { EventChannelName } from '@shared/ipc';

const APP_NAME = 'DevHarbor';
const WEBSITE = 'https://www.devharbor.app';

/**
 * Install the application menu.
 *
 * The default Electron menu ships developer affordances (Toggle DevTools, Force Reload)
 * and a "Learn More → electronjs.org" Help link - neither belongs in a shipped app. This
 * builds a clean, native macOS menu instead.
 *
 * Notes:
 * - **Reload (⌘R) is kept in every build** - the renderer relies on a hard reload to
 *   re-bootstrap onto the Dashboard (see App.tsx). Force Reload + Toggle DevTools are
 *   gated to dev only.
 * - The **Edit** submenu (undo/cut/copy/paste/select-all) is required: once a custom
 *   menu is set, macOS no longer supplies the implicit copy/paste accelerators, so text
 *   inputs would lose ⌘C/⌘V without these roles.
 */
export function installAppMenu(
  isDev: boolean,
  getOrCreateWindow: () => { win: BrowserWindow; created: boolean }
): void {
  // Send a menu action to the renderer. Menu items live in the main process, so app-level
  // actions (open Settings, Add App, Add Folder) are forwarded as typed events.
  //
  // On macOS the app keeps running with all windows closed; if there's no window we create
  // one and wait for the renderer to finish loading (+ a beat for React to subscribe)
  // before sending, so the shortcut isn't a dead key.
  const send = (channel: EventChannelName) => (): void => {
    const { win, created } = getOrCreateWindow();
    if (created) {
      win.webContents.once('did-finish-load', () => {
        setTimeout(() => win.webContents.send(channel, {}), 200);
      });
    } else {
      win.webContents.send(channel, {});
    }
  };

  const template: MenuItemConstructorOptions[] = [
    {
      label: APP_NAME,
      submenu: [
        { role: 'about', label: `About ${APP_NAME}` },
        { type: 'separator' },
        // macOS-standard preferences slot (⌘,). Opens the in-app Settings drawer.
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: send('menu:openSettings') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: `Hide ${APP_NAME}` },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: `Quit ${APP_NAME}` }
      ]
    },
    {
      label: 'File',
      submenu: [
        // Creation actions live in File (HIG). ⌘N = Add App, ⌘⇧N = Add Folder
        // (mirrors Finder's New Folder shortcut).
        { label: 'Add App…', accelerator: 'CmdOrCtrl+N', click: send('menu:addApp') },
        { label: 'Add Folder…', accelerator: 'CmdOrCtrl+Shift+N', click: send('menu:newFolder') },
        { type: 'separator' },
        { role: 'close' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        // Reload stays in prod (⌘R → re-bootstrap to Dashboard). Force-reload and
        // DevTools are dev-only.
        { role: 'reload' },
        ...(isDev
          ? ([
              { role: 'forceReload' },
              { role: 'toggleDevTools' }
            ] as MenuItemConstructorOptions[])
          : []),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' }
      ]
    },
    {
      role: 'help',
      submenu: [
        // Forwarded to the renderer so the result (toast / up-to-date / error) surfaces there.
        { label: 'Check for Updates…', click: send('menu:checkUpdates') },
        { label: 'Open Logs Folder', click: send('menu:openLogs') },
        { type: 'separator' },
        {
          label: `${APP_NAME} Website`,
          click: () => void shell.openExternal(WEBSITE)
        }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
