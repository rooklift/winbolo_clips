/* Refreshes engine/ from the WinBolo Replay Viewer, which this tool is
 * built on: the replay engine and its art are that repository's, copied
 * here unchanged, so a fix made there is one command away from here.
 *
 *   node tools/sync.js [path to winbolo_parser]      (default ../winbolo_parser)
 *
 * Copies the files in COPIED from its viewer/ directory, and packs the WAVs
 * in its viewer/sounds/ into engine/sound_data.js, base64 under each
 * sound's name: the clip export mixes the samples itself, and a page opened
 * straight from disk cannot fetch() the files to read them.
 *
 * test/test-engine.js checks engine/ is what this tool would write when the
 * viewer's repository is there to compare against. */
"use strict";
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const DEFAULT_SOURCE = path.join(root, "..", "winbolo_parser");
const COPIED = ["format.js", "sprite_data.js", "sprites.js", "logparse.js", "sound.js", "game.js"];

/* CRLF from a Windows checkout would make the copy differ by platform. */
function copied_file(source, name) {
	return fs.readFileSync(path.join(source, "viewer", name), "utf8").replace(/\r\n/g, "\n");
}

function sound_data(source) {
	let dir = path.join(source, "viewer", "sounds");
	/* Sorted by code unit, not locale, so every platform writes the same file. */
	let names = fs.readdirSync(dir).filter(f => f.endsWith(".wav")).map(f => f.slice(0, -4))
		.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
	let lines = names.map(name => {
		let b64 = fs.readFileSync(path.join(dir, name + ".wav")).toString("base64");
		return `\t${JSON.stringify(name)}: "${b64}",`;
	});
	return `/* GENERATED FILE - do not edit. Built from the WAVs in the WinBolo Replay
 * Viewer's viewer/sounds/ by tools/sync.js: each sound's file, base64,
 * under its name without ".wav". */
"use strict";
(function () {

const BoloSoundData = {
${lines.join("\n")}
};

if (typeof module !== "undefined" && module.exports) {
	module.exports = BoloSoundData;
} else {
	window.BoloSoundData = BoloSoundData;
}

})();
`;
}

/* Every file of engine/ as this tool would write it: { name: text }. */
function build(source = DEFAULT_SOURCE) {
	let files = {};
	for (let name of COPIED) files[name] = copied_file(source, name);
	files["sound_data.js"] = sound_data(source);
	return files;
}

if (require.main === module) {
	let source = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_SOURCE;
	if (!fs.existsSync(path.join(source, "viewer", "game.js"))) {
		console.error(`no WinBolo Replay Viewer at ${source}`);
		process.exit(1);
	}
	let files = build(source);
	fs.mkdirSync(path.join(root, "engine"), { recursive: true });
	for (let [name, text] of Object.entries(files)) {
		fs.writeFileSync(path.join(root, "engine", name), text);
	}
	console.log(`wrote ${Object.keys(files).length} files to engine/ from ${source}`);
}

module.exports = { build, DEFAULT_SOURCE };
