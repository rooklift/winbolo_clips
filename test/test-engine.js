/* Tests: the page's files are all there, and engine/ is what tools/sync.js
 * would write from the WinBolo Replay Viewer's repository. That repository
 * is not part of this one, so the second half runs only where it sits
 * beside this one (or where WINBOLO_PARSER names it). */
"use strict";
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const sync = require(path.join(root, "tools", "sync.js"));

let failures = 0;
function check(what, ok, detail = "") {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? ": " + detail : ""}`);
}

/* ---------- the page ---------- */
let html = fs.readFileSync(path.join(root, "index.html"), "utf8");
let referenced = [...html.matchAll(/<(?:script src|link rel="stylesheet" href)="([^"]+)"/g)].map(m => m[1]);
check("index.html references scripts and a stylesheet", referenced.length > 5, `${referenced.length} files`);
let missing = referenced.filter(f => !fs.existsSync(path.join(root, f)));
check("every file index.html loads exists", missing.length === 0, missing.join(", "));

/* every element the scripts look up by id is in the page */
let ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
let wanted = new Set();
for (let f of ["renderer.js", "clip.js", "video.js"]) {
	let source = fs.readFileSync(path.join(root, f), "utf8");
	for (let m of source.matchAll(/getElementById\("([^"]+)"\)/g)) wanted.add(m[1]);
}
let absent = [...wanted].filter(id => !ids.has(id));
check("every element the scripts look up is in index.html", absent.length === 0, absent.join(", "));

/* ---------- engine/ against its source ---------- */
let source = process.env.WINBOLO_PARSER || sync.DEFAULT_SOURCE;
if (!fs.existsSync(path.join(source, "viewer", "game.js"))) {
	console.log(`skip engine/ comparison: no WinBolo Replay Viewer at ${source}`);
} else {
	/* a Windows checkout may hold either copy with CRLF line ends */
	let text = file => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
	let built = sync.build(source);
	for (let [name, want] of Object.entries(built)) {
		let file = path.join(root, "engine", name);
		check(`engine/${name} is current`, fs.existsSync(file) && text(file) === want,
			"run node tools/sync.js");
	}
	let extra = fs.readdirSync(path.join(root, "engine")).filter(name => !(name in built));
	check("engine/ holds nothing else", extra.length === 0, extra.join(", "));
}

process.exit(failures ? 1 : 0);
