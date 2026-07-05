// Electron shell: starts the Express server in-process on a random free port,
// then opens a BrowserWindow pointed at it. All app logic stays in the web
// app; this file is deliberately a thin wrapper.

import { app, BrowserWindow, shell } from "electron";
import * as path from "path";
import { startServer } from "../server/index";

let mainWindow: BrowserWindow | null = null;

async function createWindow(): Promise<void> {
  // The packaged asar is read-only, so persist data under the OS-specific
  // userData dir (e.g. %APPDATA%/BoozeTracker/data on Windows). Storage reads
  // this lazily, so setting it before startServer() is sufficient.
  process.env.BOOZETRACKER_DATA_DIR = path.join(app.getPath("userData"), "data");

  // Port 0 = OS-assigned free port, so we never collide with a dev server or
  // PM2 instance already running on 3000.
  const port = await startServer(0);

  mainWindow = new BrowserWindow({
    width: 900,
    height: 1000,
    backgroundColor: "#0f172a", // matches bg-slate-900 to avoid a white flash
    autoHideMenuBar: true,
    webPreferences: {
      // The renderer is our own static site talking to our own local API;
      // no Node integration needed in the page.
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  // Open external links (if any ever appear) in the system browser, not in
  // the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  await mainWindow.loadURL(`http://localhost:${port}/`);
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  // Standard behaviour: quit on Windows/Linux, stay alive on macOS.
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  // macOS: re-create the window when the dock icon is clicked.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
