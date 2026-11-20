"use strict";
/* Electron main process for WinBolo Clips: a window around index.html and
 * nothing else. The page is the whole application (it opens replays by
 * drop or its own file picker, and saves a clip as a download, for which
 * Electron shows its save dialog), so there is no preload and no IPC.
 *
 *   npx electron .
 */
const { app, BrowserWindow, Menu } = require("electron");
const path = require("path");

app.whenReady().then(() => {
	/* No menu: the page handles every key itself, and a menu's accelerators
	 * (Ctrl+0, Ctrl+-, Ctrl+R) would take them first. */
	Menu.setApplicationMenu(null);
	let win = new BrowserWindow({
		width: 1280,
		height: 860,
		backgroundColor: "#10131a",
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
		},
	});
	/* the dev tools' own shortcut went with the menu */
	win.webContents.on("before-input-event", (e, input) => {
		if (input.type === "keyDown" && input.key === "F12") win.webContents.toggleDevTools();
	});
	win.loadFile(path.join(__dirname, "index.html"));
});

app.on("window-all-closed", () => app.quit());
