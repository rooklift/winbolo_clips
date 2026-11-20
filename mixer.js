/* The game's sound samples, and an offline mixer for the clip export.
 *
 * The samples are engine/sound_data.js's: the WAVs of the WinBolo Replay
 * Viewer, base64, so a page opened straight from disk can read them (it
 * could not fetch() the files). The live player's audio elements are fed
 * from the same data, through sample_url().
 *
 * The export steps its clock deterministically and cannot use audio
 * elements, so it mixes the same sound events into a sample stream: the
 * live player's variant rule (engine/sound.js), its base volume, and its
 * pitch variation drawn from a seeded generator so an export is repeatable.
 * After the Ancient Bolo Log Viewer's mixer. No DOM use but sample_url, so
 * node tests can load it too. */
"use strict";
(function () {

const NODE = typeof module !== "undefined" && module.exports;
const WinBoloSound = NODE ? require("./engine/sound.js") : window.WinBoloSound;
const BoloSoundData = NODE ? require("./engine/sound_data.js") : window.BoloSoundData;

const BASE_VOLUME = 0.5; /* the live player's audio.volume */

function base64_bytes(text) {
	let binary = atob(text);
	let bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/* A RIFF WAVE with 8- or 16-bit integer PCM (WinBolo's are 16-bit mono at
 * the old Mac rate of 22254 Hz) to { sample_rate, samples } with samples a
 * Float32Array in [-1, 1] of the first channel. */
function decode_wav(bytes) {
	let view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let tag = at => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
	if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a WAV file");
	let format = null, data = null;
	for (let at = 12; at + 8 <= bytes.length;) {
		let id = tag(at), size = view.getUint32(at + 4, true);
		let body = at + 8;
		if (id === "fmt ") {
			format = { code: view.getUint16(body, true), channels: view.getUint16(body + 2, true),
				sample_rate: view.getUint32(body + 4, true), bits: view.getUint16(body + 14, true) };
		} else if (id === "data") {
			data = { start: body, end: Math.min(bytes.length, body + size) };
		}
		at = body + size + (size & 1); /* chunks are word-aligned */
	}
	if (!format || !data) throw new Error("WAV without fmt or data chunk");
	if (format.code !== 1 || (format.bits !== 8 && format.bits !== 16)) {
		throw new Error("WAV is not 8- or 16-bit PCM");
	}
	let frame_bytes = format.channels * format.bits / 8;
	let count = Math.floor((data.end - data.start) / frame_bytes);
	let samples = new Float32Array(count);
	for (let i = 0; i < count; i++) {
		let at = data.start + i * frame_bytes;
		samples[i] = format.bits === 8 ? (bytes[at] - 128) / 128 : view.getInt16(at, true) / 32768;
	}
	return { sample_rate: format.sample_rate, samples };
}

/* Every sample, decoded: a Map of name -> { sample_rate, samples }. */
function load_samples(data = BoloSoundData) {
	let samples = new Map();
	for (let name of Object.keys(data)) samples.set(name, decode_wav(base64_bytes(data[name])));
	return samples;
}

/* The live player asks for "sounds/<name>.wav" (and "...?retry=n" after a
 * failed load); give it a blob URL of the embedded file instead, made once
 * per sound. A name the data lacks keeps its URL, and fails as a missing
 * file would. */
let sample_urls = new Map();

function sample_url(url) {
	let match = /^sounds\/([^.?]+)\.wav/.exec(url);
	let name = match && match[1];
	if (!name || !BoloSoundData[name]) return url;
	if (!sample_urls.has(name)) {
		sample_urls.set(name, URL.createObjectURL(new Blob([base64_bytes(BoloSoundData[name])], { type: "audio/wav" })));
	}
	return sample_urls.get(name);
}

/* A small deterministic generator (Park-Miller), so the pitch variation of
 * an export is the same every time it is run. */
function seeded_random(seed = 1) {
	let state = seed % 2147483647 || 1;
	return () => {
		state = state * 48271 % 2147483647;
		return (state - 1) / 2147483646;
	};
}

/* Mixes sound events ({ tick, kind, player, x, y }, as WinBoloGame lists
 * them) into an output stream of `sample_rate` mono samples, where output
 * time is replay time from `start_tick` compressed by `speed`, as the
 * video's is. Feed events with advance(), as the live player is fed per
 * frame, then take the output with render(): each call returns the mix
 * from the previous call's end up to `until` output samples in total, so a
 * caller can pull the audio frame by frame alongside the video. Voices
 * past their end are dropped; the sum is clamped to [-1, 1]. */
function create_mixer({ samples, sample_rate = 48000, start_tick, speed = 1, ticks_per_second = 50, random = seeded_random() }) {
	let voices = [];
	let rendered = 0; /* output samples handed out so far */
	let output_samples_per_tick = sample_rate / (ticks_per_second * speed);
	function advance(events, from, to, player, listener_at) {
		if (to <= from) return;
		for (let event of WinBoloSound.between(events, from, to)) {
			let name = WinBoloSound.variant(event, listener_at(event.tick), player);
			if (!name) continue;
			let sample = samples.get(name);
			if (!sample) continue;
			/* source samples per output sample, with the live player's
			 * +/-3% rate variation baked in */
			let rate = (0.97 + random() * 0.06) * sample.sample_rate / sample_rate;
			voices.push({ sample, rate, start: (event.tick - start_tick) * output_samples_per_tick });
		}
	}
	function render(until) {
		let count = Math.max(0, Math.floor(until) - rendered);
		let out = new Float32Array(count);
		let live = [];
		for (let voice of voices) {
			let data = voice.sample.samples, rate = voice.rate, start = voice.start;
			let first = Math.max(rendered, Math.ceil(start));
			let last_source = (data.length - 1) / rate; /* output offset of the final sample */
			let end = Math.min(rendered + count, Math.floor(start + last_source) + 1);
			for (let i = first; i < end; i++) {
				let position = (i - start) * rate;
				let index = Math.floor(position);
				let fraction = position - index;
				let value = data[index] + (index + 1 < data.length ? (data[index + 1] - data[index]) * fraction : 0);
				out[i - rendered] += value * BASE_VOLUME;
			}
			if (start + last_source > rendered + count) live.push(voice);
		}
		voices = live;
		for (let i = 0; i < count; i++) out[i] = Math.max(-1, Math.min(1, out[i]));
		rendered += count;
		return out;
	}
	return { advance, render, get rendered() { return rendered; } };
}

const BoloMixer = { BASE_VOLUME, decode_wav, load_samples, sample_url, seeded_random, create_mixer };

if (NODE) {
	module.exports = BoloMixer;
} else {
	window.BoloMixer = BoloMixer;
}

})();
