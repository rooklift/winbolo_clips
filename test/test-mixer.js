/* Tests: the embedded sound samples and the offline mixer the clip export
 * builds its soundtrack with (mixer.js). */
"use strict";
const path = require("path");

const root = path.join(__dirname, "..");
const BoloMixer = require(path.join(root, "mixer.js"));
const BoloSoundData = require(path.join(root, "engine", "sound_data.js"));
const WinBoloSound = require(path.join(root, "engine", "sound.js"));

let failures = 0;
function check(what, ok, detail = "") {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? ": " + detail : ""}`);
}

/* ---------- WAV decoding ---------- */
function wav(sample_rate, bits, channels, values) {
	let frame = channels * bits / 8;
	let bytes = new Uint8Array(44 + values.length * frame);
	let view = new DataView(bytes.buffer);
	let tag = (at, s) => { for (let i = 0; i < 4; i++) bytes[at + i] = s.charCodeAt(i); };
	tag(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); tag(8, "WAVE");
	tag(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
	view.setUint16(22, channels, true); view.setUint32(24, sample_rate, true);
	view.setUint32(28, sample_rate * frame, true); view.setUint16(32, frame, true); view.setUint16(34, bits, true);
	tag(36, "data"); view.setUint32(40, values.length * frame, true);
	values.forEach((v, i) => {
		for (let c = 0; c < channels; c++) {
			let at = 44 + i * frame + c * bits / 8;
			/* the first channel carries the value; the others a decoy */
			let value = c === 0 ? v : 0;
			if (bits === 16) view.setInt16(at, value, true);
			else bytes[at] = value + 128;
		}
	});
	return bytes;
}

{
	let d = BoloMixer.decode_wav(wav(22254, 16, 1, [0, 16384, -32768, 32767]));
	check("16-bit mono decodes to [-1, 1]", d.sample_rate === 22254 && Array.from(d.samples).join() === [0, 0.5, -1, 32767 / 32768].join(), Array.from(d.samples).join());
	d = BoloMixer.decode_wav(wav(8000, 8, 2, [0, 64, -128]));
	check("8-bit stereo decodes its first channel", d.sample_rate === 8000 && Array.from(d.samples).join() === [0, 0.5, -1].join(), Array.from(d.samples).join());
	let threw = false;
	try { BoloMixer.decode_wav(new Uint8Array(64)); } catch { threw = true; }
	check("something that is not a WAV is refused", threw);
}

/* ---------- the embedded samples ---------- */
const KINDS = ["shooting", "hit_tank", "shot_tree", "shot_building", "mine_explosion", "big_explosion",
	"tank_sinking", "farming_tree", "man_building", "man_dying", "man_lay_mine"];
let samples = BoloMixer.load_samples();
{
	check("every embedded sound decodes", samples.size === Object.keys(BoloSoundData).length && samples.size > 0, `${samples.size} sounds`);
	check("none is empty", [...samples.values()].every(s => s.samples.length > 0 && s.sample_rate > 0));
	/* every name the engine's variant rule can ask for has a sample */
	let near = { left: 0, top: 0, right: 10, bottom: 10 };
	let wanted = new Set();
	for (let kind of KINDS) {
		for (let [x, player] of [[5, -1], [50, -1], [5, 3]]) {
			let name = WinBoloSound.variant({ tick: 0, kind, player: 3, x, y: 5 }, near, player);
			if (name) wanted.add(name);
		}
	}
	let lacking = [...wanted].filter(name => !samples.has(name));
	check("every variant the engine can ask for is embedded", lacking.length === 0 && wanted.size > 20, lacking.join(", ") || `${wanted.size} variants`);
}

/* ---------- the mixer ---------- */
/* a made-up sample set: a ramp for the near shot, a constant for the far */
let ramp = { sample_rate: 48000, samples: Float32Array.from({ length: 100 }, (_, i) => (i + 1) / 100) };
let flat = { sample_rate: 48000, samples: new Float32Array(100).fill(0.25) };
let made_up = new Map([["shooting_near", ramp], ["shooting_far", flat], ["shooting_self", flat]]);
let steady = () => 0.5; /* the middle of the pitch variation: rate exactly 1 */
let here = { left: 0, top: 0, right: 10, bottom: 10 };
let shot = (tick, x = 5) => ({ tick, kind: "shooting", player: 2, x, y: 5 });

{
	let m = BoloMixer.create_mixer({ samples: made_up, start_tick: 100, random: steady });
	m.advance([shot(100), shot(102)], 99, 102, -1, () => here);
	let out = m.render(48000 * 4 / 50);
	check("an event on the start tick sounds from the first sample", Math.abs(out[0] - 0.01 * BoloMixer.BASE_VOLUME) < 1e-6 && Math.abs(out[99] - BoloMixer.BASE_VOLUME) < 1e-6, `${out[0]}, ${out[99]}`);
	check("and ends with its sample", out[100] === 0);
	/* two ticks at 50 a second are 1920 samples at 48 kHz */
	check("a later event sounds at its tick's place in the stream", out[1919] === 0 && Math.abs(out[1920] - 0.01 * BoloMixer.BASE_VOLUME) < 1e-6);
	check("rendered counts what has been handed out", m.rendered === 3840 && out.length === 3840);
}
{
	let m = BoloMixer.create_mixer({ samples: made_up, start_tick: 100, random: steady });
	m.advance([shot(100), shot(101, 50)], 99, 101, -1, () => here);
	let out = m.render(2000);
	check("an event outside the listener's area takes the far sample", Math.abs(out[960] - 0.25 * BoloMixer.BASE_VOLUME) < 1e-6);
	let self = BoloMixer.create_mixer({ samples: made_up, start_tick: 100, random: steady });
	self.advance([shot(100)], 99, 100, 2, () => here);
	check("the locked player's own shot takes the self sample", Math.abs(self.render(10)[0] - 0.25 * BoloMixer.BASE_VOLUME) < 1e-6);
}
{
	let m = BoloMixer.create_mixer({ samples: made_up, start_tick: 100, speed: 0.5, random: steady });
	m.advance([shot(101)], 99, 101, -1, () => here);
	let out = m.render(4000);
	check("at half speed a tick is twice as long", out[1919] === 0 && out[1920] > 0);
	check("and the sound itself is not slowed", out[1920 + 99] > 0 && out[1920 + 100] === 0);
}
{
	/* the same events rendered frame by frame, as the export does, and in one go */
	let events = [shot(100), shot(100, 50), shot(101), shot(103, 50), shot(104)];
	let whole = BoloMixer.create_mixer({ samples, start_tick: 100 });
	whole.advance(events, 99, 105, -1, () => here);
	let all = whole.render(48000);
	let pieces = BoloMixer.create_mixer({ samples, start_tick: 100 });
	let joined = new Float32Array(48000), at = 0;
	for (let i = 0; i < 50; i++) {
		pieces.advance(events, i === 0 ? 99 : 100 + i - 1, 100 + i, -1, () => here);
		let part = pieces.render(i * 960);
		joined.set(part, at);
		at += part.length;
	}
	let tail = pieces.render(48000);
	joined.set(tail, at);
	let worst = 0;
	for (let i = 0; i < all.length; i++) worst = Math.max(worst, Math.abs(all[i] - joined[i]));
	check("rendering frame by frame gives the same stream as rendering at once", at + tail.length === 48000 && worst < 1e-6, `worst difference ${worst}`);
	let peak = all.reduce((n, v) => Math.max(n, Math.abs(v)), 0);
	check("real samples make sound, within range", peak > 0.01 && peak <= 1, `peak ${peak}`);
	let again = BoloMixer.create_mixer({ samples, start_tick: 100 });
	again.advance(events, 99, 105, -1, () => here);
	let second = again.render(48000);
	check("an export is repeatable: the pitch variation is seeded", all.every((v, i) => v === second[i]));
}
{
	let loud = { sample_rate: 48000, samples: new Float32Array(10).fill(1) };
	let m = BoloMixer.create_mixer({ samples: new Map([["shooting_near", loud]]), start_tick: 0, random: steady });
	m.advance(Array.from({ length: 5 }, () => shot(0)), -1, 0, -1, () => here);
	check("the sum is clamped", m.render(5).every(v => v === 1));
}
{
	let a = BoloMixer.seeded_random(7), b = BoloMixer.seeded_random(7);
	let draws = Array.from({ length: 5 }, () => a());
	check("the generator repeats from its seed, within [0, 1)", draws.every((v, i) => v === b() && v >= 0 && v < 1), draws.join(", "));
}

process.exit(failures ? 1 : 0);
