"use strict";
/* Electron preload for WinBolo Clips: the page's one way to reach main.js.
 * wbv_host.initial_file(max_bytes) resolves to the replay named on the
 * command line, as { name, bytes } or { name, error }, or to null when
 * none was named. In a browser there is no wbv_host and the page does
 * without. */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("wbv_host", {
	initial_file: max_bytes => ipcRenderer.invoke("initial_file", max_bytes),
});
