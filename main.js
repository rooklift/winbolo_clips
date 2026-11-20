"use strict";
/* Electron main process for WinBolo Clips: a window around index.html and
 * little else. The page is the whole application (it opens replays by
 * drop or its own file picker, and saves a clip as a download, for which
 * Electron shows its save dialog). The one thing the page can't do for
 * itself is read a replay named on the command line, so preload.js gives
 * it a single call to ask for that file's bytes, answered here.
 *
 *   npx electron . [replay]
 */
const { app, BrowserWindow, Menu, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");

/* The replay named on the command line, or null: the first argument that
 * is not a switch. Run as "electron . replay" the app's own path comes
 * first among them; a packaged app has no such argument. This is also how
 * Windows hands over a file opened with the app. */
function argv_file() {
	let args = process.argv.slice(1).filter(a => !a.startsWith("-"));
	if (!app.isPackaged) args.shift();
	return args.length ? path.resolve(args[0]) : null;
}

/* The page asks once it is ready, so there is no race with its loading.
 * A failure is answered rather than thrown, for the page to show in its
 * own words; max_bytes is the page's limit on a replay, checked before
 * the read so that a huge file named by mistake is never read at all. */
ipcMain.handle("initial_file", async (e, max_bytes) => {
	let file = argv_file();
	if (!file) return null;
	let name = path.basename(file);
	try {
		let { size } = await fs.promises.stat(file);
		if (size > max_bytes) return { name, error: `${name} is ${size} bytes; not a WinBolo replay` };
		return { name, bytes: await fs.promises.readFile(file) };
	} catch (err) {
		return { name, error: err.message };
	}
});

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
			preload: path.join(__dirname, "preload.js"),
		},
	});
	/* the dev tools' own shortcut went with the menu */
	win.webContents.on("before-input-event", (e, input) => {
		if (input.type === "keyDown" && input.key === "F12") win.webContents.toggleDevTools();
	});
	win.loadFile(path.join(__dirname, "index.html"));
});

app.on("window-all-closed", () => app.quit());
