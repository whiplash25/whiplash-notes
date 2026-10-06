// ─────────────────────────────────────────────────────────────────────────────
//  main.js  –  Electron main process
// ─────────────────────────────────────────────────────────────────────────────

const { app, BrowserWindow, ipcMain, screen, nativeTheme, globalShortcut } = require('electron');
const path = require('path');
const fs   = require('fs');

// ── Startup speed optimizations ──────────────────────────────────────────────
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');  // avoid cache errors
app.commandLine.appendSwitch('disable-features', 'SpareRendererForSitePerProcess'); // skip spare renderer

// ── Notes directory ───────────────────────────────────────────────────────────
// Saved to the user's Documents folder so they're easy to find and open
// in any text editor: C:\Users\<you>\Documents\WhiplashNotes\
const NOTES_DIR      = path.join(app.getPath('documents'), 'WhiplashNotes');
const WIN_STATE_FILE = path.join(app.getPath('userData'),  'window-state.json');

function ensureNotesDir() {
  if (!fs.existsSync(NOTES_DIR)) fs.mkdirSync(NOTES_DIR, { recursive: true });
}

// ── Window state persistence ──────────────────────────────────────────────────
function loadWinState() {
  try {
    const state = JSON.parse(fs.readFileSync(WIN_STATE_FILE, 'utf8'));
    // Make sure the top-left corner is still on a connected display
    const onScreen = screen.getAllDisplays().some(({ workArea: a }) =>
      state.x >= a.x && state.x < a.x + a.width &&
      state.y >= a.y && state.y < a.y + a.height
    );
    if (onScreen) return state;          // { x, y, width, height }
  } catch { /* first run or corrupt file */ }
  return { width: 680, height: 420 };   // defaults — Electron centres automatically
}

function saveWinState(win) {
  if (win.isMinimized() || win.isMaximized()) return;
  try { fs.writeFileSync(WIN_STATE_FILE, JSON.stringify(win.getBounds()), 'utf8'); }
  catch { /* non-fatal */ }
}

// ── Window ────────────────────────────────────────────────────────────────────
let mainWindow;

function createWindow() {
  const winState = loadWinState();

  mainWindow = new BrowserWindow({
    ...winState,            // x, y, width, height (or just width/height on first run)
    minWidth:       340,
    minHeight:      200,
    frame:          false,
    transparent:    true,
    roundedCorners: true,
    alwaysOnTop:    true,
    resizable:      true,
    hasShadow:      true,
    show:           false,  // don't show until content is painted
    icon:           path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      devTools:         false,
    },
  });

  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.loadFile('index.html');

  // Show as soon as the renderer has painted — avoids white/blank flash
  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.on('close', () => saveWinState(mainWindow));
}

// ── IPC: File operations ──────────────────────────────────────────────────────

// Save note as plain text (.txt) — readable in any editor
ipcMain.handle('notes:save', (_event, { filename, content }) => {
  ensureNotesDir();
  fs.writeFileSync(path.join(NOTES_DIR, filename), content, 'utf8');
  return { ok: true };
});

// Delete a note file
ipcMain.handle('notes:delete', (_event, filename) => {
  const fp = path.join(NOTES_DIR, filename);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  return { ok: true };
});

// Return all notes sorted newest → oldest
ipcMain.handle('notes:loadAll', async () => {
  await fs.promises.mkdir(NOTES_DIR, { recursive: true });
  const files = (await fs.promises.readdir(NOTES_DIR)).filter(f => f.endsWith('.txt'));
  const notes = await Promise.all(files.map(async filename => {
    const fp = path.join(NOTES_DIR, filename);
    const [stat, content] = await Promise.all([
      fs.promises.stat(fp),
      fs.promises.readFile(fp, 'utf8'),
    ]);
    return { filename, content, mtime: stat.mtimeMs };
  }));
  return notes.sort((a, b) => b.mtime - a.mtime);
});

// ── IPC: Window controls ──────────────────────────────────────────────────────

// Toggle always-on-top, tell the renderer (so the status label follows), return the new state.
// Shared by the status-bar click and the global shortcut.
const AOT_SHORTCUT = 'CommandOrControl+Alt+T';

function toggleAlwaysOnTop() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const next = !mainWindow.isAlwaysOnTop();
  mainWindow.setAlwaysOnTop(next, 'screen-saver');
  mainWindow.webContents.send('window:aotChanged', next);
  return next;
}

ipcMain.handle('window:toggleAlwaysOnTop', toggleAlwaysOnTop);

// Close the window
ipcMain.handle('window:close', () => {
  mainWindow.close();
});

// Minimize the window
ipcMain.handle('window:minimize', () => {
  mainWindow.minimize();
});

// Toggle maximize / restore
ipcMain.handle('window:maximize', () => {
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
  return mainWindow.isMaximized();
});

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  ensureNotesDir();
  createWindow();
  // Works even when the window isn't focused (it usually floats over another app).
  if (!globalShortcut.register(AOT_SHORTCUT, toggleAlwaysOnTop)) {
    console.warn(`Could not register ${AOT_SHORTCUT} (already in use by another app)`);
  }
});

app.on('will-quit', () => globalShortcut.unregisterAll());

app.on('window-all-closed', () => app.quit());
