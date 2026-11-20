"use strict";
/* Clip export: renders the clip offline into a WebM file (VP9 video, Opus
 * sound). Playback is a pure function of the clock, so instead of capturing
 * the live window the export steps the clock by exact per-frame increments
 * and draws each frame to a canvas the size of the clip's frame:
 * deterministic output at any speed, immune to window size and dropped
 * frames. Frames go through a WebCodecs encoder into the hand-rolled muxer
 * (webm.js). After the Ancient Bolo Log Viewer's video export, which
 * streams a whole game to disk through its desktop shell; a clip is short,
 * so this one is built in memory and needs nothing but the browser. When
 * it is done the clip is shown, playing, with a button to save it.
 *
 * The export reuses the live draw path by swapping the renderer's globals
 * (ctx, view, clock, cur) for its own for the duration; `exporting` blocks
 * every input route that could touch them (see renderer.js). Its view is
 * the clip's frame at the live zoom (clip.js's clip_frame), drawn at one
 * canvas pixel per CSS pixel, so the video is the region as the screen
 * shows it. A view locked to a player stays locked: draw() centres the
 * export's view on the player frame by frame, as it centres the live one.
 *
 * The game runs at 50 ticks a second and the log states every tick, so a
 * 50 fps clip at 1× is one frame a tick: every state the game was in, and
 * none shown twice. */

/* Constant-quality presets: VP9 quantizer, 0-63, lower = better + bigger. */
const EXPORT_QP = { standard: 34, high: 26, max: 16 };
/* Where the encoder has no quantizer mode, a bitrate instead: bits per
 * pixel per frame, for flat-coloured pixel art. */
const EXPORT_BITS_PER_PIXEL = { standard: 0.06, high: 0.1, max: 0.18 };
const EXPORT_MIN_BITRATE = 400_000;
const EXPORT_KEYFRAME_SECONDS = 2;                /* also the cluster/seek granularity */
const EXPORT_QUEUE_LIMIT = 8;                     /* encoder frames in flight */
const EXPORT_AUDIO_RATE = 48000;                  /* Opus's native rate */
const EXPORT_AUDIO_FRAME = 960;                   /* 20 ms Opus frames */
const EXPORT_AUDIO_BITRATE = 64000;               /* plenty for mono 22 kHz samples */

let export_overlay = document.getElementById("exportOverlay");
let export_label = document.getElementById("exportLabel");
let export_bar_fill = document.getElementById("exportBarFill");
let export_cancel_btn = document.getElementById("exportCancel");

let clip_result_el = document.getElementById("clipResult");
let clip_result_video = document.getElementById("clipResultVideo");
let clip_result_info = document.getElementById("clipResultInfo");
let clip_result_save = document.getElementById("clipResultSave");
let clip_result_close_btn = document.getElementById("clipResultClose");

let export_cancel_requested = false;
let export_error = null;
let ex_samples = null;      /* decoded game sounds, decoded once per session */
let clip_result_url = null; /* the blob URL of the clip on show */

export_cancel_btn.addEventListener("click", () => cancel_clip_export());
clip_result_close_btn.addEventListener("click", () => close_clip_result());

function cancel_clip_export() {
	if (exporting) export_cancel_requested = true;
}

/* ---------- the export itself ---------- */

/* Exports the clip as it stands and shows the result. Resolves to the
 * result ({ blob, name, w, h, frames, seconds }), or null when there was
 * nothing to export, the export failed (an error has been shown) or it was
 * cancelled. */
async function export_clip() {
	/* `loading`: a replay is being replaced under the button's feet; the
	 * export would otherwise start on the old game and have the new one
	 * swapped in beneath it when the load finished. */
	if (!game || exporting || loading || clip_result_open()) return null;
	let problem = clip_problem();
	if (problem) {
		show_error("Cannot export clip", problem);
		return null;
	}
	if (typeof VideoEncoder === "undefined" || typeof VideoFrame === "undefined") {
		show_error("Cannot export clip", "this browser has no WebCodecs video encoder");
		return null;
	}
	set_playing(false);

	/* Claim the export before the first await, so a second request bounces
	 * off the guard above rather than racing this one. Everything from here
	 * to the release is under one finally: a step that rejects must not
	 * leave the page inert for good. */
	set_exporting(true);
	let result = null;
	try {
		result = await ex_run();
	} catch (err) {
		show_error("Could not export clip", String((err && err.message) || err));
	} finally {
		set_exporting(false);
		request_draw(); /* the live canvas, dropped from every draw queued meanwhile */
	}
	if (result) show_clip_result(result);
	return result;
}

/* The export proper. Runs with `exporting` held by export_clip, which
 * also releases it whatever happens here; the viewer's own state is
 * restored in the finally below. Returns null if cancelled. */
async function ex_run() {
	let frame = clip_frame();
	let options = clip_options();
	let start = clip.start, end = clip.end;
	let fps = options.fps;

	let picked = await ex_pick_config(frame.w, frame.h, fps, options.quality);
	if (!picked) throw new Error(`no VP9 or VP8 encoder here takes a ${frame.w} × ${frame.h} video`);

	let audio = null;
	if (options.sound) {
		audio = await ex_pick_audio_config();
		if (!audio) throw new Error("this browser has no Opus audio encoder: untick \"Game sounds\"");
		if (!ex_samples) ex_samples = BoloMixer.load_samples();
	}

	/* Each output frame advances the clock by a fixed step, so the clip's
	 * speed is baked in as the video's time compression. */
	let step = TPS * options.speed / fps;
	let total = clip_length(options).frames;
	let duration_ms = total * 1000 / fps;
	let keyframe_every = fps * EXPORT_KEYFRAME_SECONDS;

	/* ---- take over the viewer until restored in the finally below ---- */
	export_cancel_requested = false;
	export_error = null;
	ex_progress(0, total);
	export_overlay.classList.remove("hidden");

	let saved = { clock, view, ctx };
	let encoder = null;
	let audio_encoder = null;
	let parts = []; /* the file, in order; parts[0] is the header, patched at the end */
	try {
		view = { zoom: saved.view.zoom, ox: frame.ox, oy: frame.oy };
		let export_canvas = document.createElement("canvas");
		export_canvas.width = frame.w;
		export_canvas.height = frame.h;
		ctx = export_canvas.getContext("2d", { alpha: false });
		export_target = { w: frame.w, h: frame.h };

		let at = WinBoloGame.state_at(game, start);
		cur = at.state;
		cursor = at.index;
		clock = start;
		effect_lo = lower_bound_effect(start - EFFECT_TICKS);
		off_version = -1;
		display_grid_version = -1;
		display_grid_cache = null;

		let muxer = BoloWebM.create_muxer({
			width: frame.w, height: frame.h, codec_id: picked.codec_id,
			audio: audio && {
				codec_private: audio.codec_private,
				codec_delay_ns: Math.round(audio.pre_skip * 1e9 / EXPORT_AUDIO_RATE),
				sample_rate: EXPORT_AUDIO_RATE, channels: 1,
			},
		});
		let push = bytes => { if (bytes.length) parts.push(bytes); };
		parts.push(muxer.header(duration_ms));

		/* The soundtrack: the same events the live player hears, mixed on
		 * the video's clock and fed to the Opus encoder in 20 ms frames as
		 * each video frame is drawn. The muxer interleaves the two. */
		let mixer = null;
		let audio_feed = null;
		if (audio) {
			mixer = BoloMixer.create_mixer({
				samples: ex_samples, sample_rate: EXPORT_AUDIO_RATE,
				start_tick: start, speed: options.speed, ticks_per_second: TPS,
			});
			audio_encoder = new AudioEncoder({
				output: chunk => {
					let data = new Uint8Array(chunk.byteLength);
					chunk.copyTo(data);
					push(muxer.add_block(data, Math.round(chunk.timestamp / 1000), true, BoloWebM.AUDIO_TRACK));
				},
				error: err => { if (!export_error) export_error = err; },
			});
			audio_encoder.configure(audio.config);
			audio_feed = ex_audio_feed(audio_encoder);
		}
		/* The ear is the frame, and a view locked to a player hears that
		 * player's own gunfire and hits as the player would, as in live
		 * play. centre_locked_player also re-centres the view, as draw()
		 * has just done or is about to. */
		let mix = (from, to) => {
			let self_player = centre_locked_player() ? viewpoint : -1;
			let listener = sound_listener();
			mixer.advance(game.sounds, from, to, self_player, () => listener);
		};

		encoder = new VideoEncoder({
			output: chunk => {
				let data = new Uint8Array(chunk.byteLength);
				chunk.copyTo(data);
				push(muxer.add_block(data, Math.round(chunk.timestamp / 1000), chunk.type === "key"));
			},
			error: err => { if (!export_error) export_error = err; },
		});
		encoder.configure(picked.config);

		for (let i = 0; i < total; i++) {
			if (export_cancel_requested) return null;
			if (export_error) throw export_error;
			clock = Math.min(game.t1, start + i * step);
			cursor = WinBoloGame.advance(game, cur, cursor, clock);
			draw();
			if (mixer) {
				/* The frame covers the clock advance that led to it (the
				 * first one takes the events on the start tick as well), and
				 * the audio rendered here ends at this frame's time: every
				 * event up to that time is queued before its samples are
				 * rendered, so no sound loses its start to a later frame. */
				mix(i === 0 ? start - step : Math.min(game.t1, start + (i - 1) * step), clock);
				audio_feed(mixer.render(i * EXPORT_AUDIO_RATE / fps), false);
			}
			let video_frame = new VideoFrame(export_canvas, {
				timestamp: Math.round(i * 1e6 / fps),
				duration: Math.round(1e6 / fps),
			});
			let encode_options = { keyFrame: i % keyframe_every === 0 };
			if (picked.quantizer !== null) encode_options.vp9 = { quantizer: picked.quantizer };
			encoder.encode(video_frame, encode_options);
			video_frame.close();
			await ex_backpressure(encoder);
			if (i % 10 === 0) {
				ex_progress(i, total);
				await ex_yield();
			}
		}
		ex_progress(total, total);
		if (mixer) {
			/* the last frame's own duration: the events it would have led
			 * to, then the samples up to the end of the video */
			mix(clock, clock + step);
			audio_feed(mixer.render(total * EXPORT_AUDIO_RATE / fps), true);
			await audio_encoder.flush();
		}
		await encoder.flush();
		if (export_error) throw export_error;
		if (export_cancel_requested) return null;

		/* the two values a streamed file cannot know upfront, both in the header */
		let fin = muxer.finalize(duration_ms);
		push(fin.tail);
		for (let patch of fin.patches) parts[0].set(patch.bytes, patch.offset);
	} finally {
		if (encoder) {
			try { encoder.close(); } catch { /* already closed */ }
		}
		if (audio_encoder) {
			try { audio_encoder.close(); } catch { /* already closed */ }
		}
		export_target = null;
		ctx = saved.ctx;
		view = saved.view;
		export_overlay.classList.add("hidden");
		set_clock(saved.clock, true); /* hard seek restores state and caches */
	}

	return {
		blob: new Blob(parts, { type: "video/webm" }),
		name: ex_file_name(start, end),
		w: frame.w, h: frame.h, frames: total, seconds: total / fps, fps,
		codec: picked.codec_id.slice(2), constant_quality: picked.quantizer !== null, sound: Boolean(audio),
	};
}

/* "Smol War 3-21 to 3-35.webm": the map, and where in the game the clip is. */
function ex_file_name(start, end) {
	let map = (map_name_el.textContent || "clip").replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_").trim() || "clip";
	let at = tick => fmt_time(tick).replace(/:/g, "-");
	return `${map} ${at(start)} to ${at(end)}.webm`;
}

/* VP9 with a VP8 fallback: both are WebM-native and need no codec private
 * data, which is what keeps the muxer small. The software encoder is asked
 * for: a clip's frame can be any size, down to a few dozen pixels, and
 * hardware encoders are particular about sizes and rougher on pixel art.
 *
 * Constant-quality (quantizer) VP9 is tried first: an offline export has
 * no realtime bandwidth budget, and a rate controller given a fixed
 * bitrate starves the forced keyframes, encoding one visibly blurry frame
 * at every keyframe interval. A fixed per-frame quantizer encodes key and
 * delta frames at the same quality, at a file size that floats with the
 * on-screen action instead. Bitrate mode is the fallback (always for VP8,
 * whose WebCodecs registration has no per-frame quantizer option). */
async function ex_pick_config(w, h, fps, quality) {
	let base = { width: w, height: h, framerate: fps };
	let bitrate = Math.max(EXPORT_MIN_BITRATE, Math.round(w * h * fps * EXPORT_BITS_PER_PIXEL[quality]));
	const VP9 = "vp09.00.10.08";
	let choices = [];
	for (let acceleration of ["prefer-software", "no-preference"]) {
		choices.push({ config: { ...base, codec: VP9, bitrateMode: "quantizer", hardwareAcceleration: acceleration },
			codec_id: "V_VP9", quantizer: EXPORT_QP[quality] });
	}
	choices.push({ config: { ...base, codec: VP9, bitrate }, codec_id: "V_VP9", quantizer: null });
	choices.push({ config: { ...base, codec: "vp8", bitrate }, codec_id: "V_VP8", quantizer: null });
	for (let choice of choices) {
		try {
			let support = await VideoEncoder.isConfigSupported(choice.config);
			if (support.supported) return choice;
		} catch { /* config not recognised: try the next */ }
	}
	return null;
}

/* Opus through WebCodecs, mono at 48 kHz. The muxer's track header needs
 * the OpusHead the encoder emits with its first chunk, so a throwaway
 * encoder is run over one silent frame to learn it (and the pre-skip it
 * declares) before the file is started. null when there is no Opus
 * encoder. */
async function ex_pick_audio_config() {
	if (typeof AudioEncoder === "undefined" || typeof AudioData === "undefined") return null;
	let config = { codec: "opus", sampleRate: EXPORT_AUDIO_RATE, numberOfChannels: 1,
		bitrate: EXPORT_AUDIO_BITRATE };
	try {
		let support = await AudioEncoder.isConfigSupported(config);
		if (!support.supported) return null;
	} catch { return null; }
	let description = null;
	let probe = new AudioEncoder({
		output: (chunk, meta) => {
			let d = meta && meta.decoderConfig && meta.decoderConfig.description;
			if (d && !description) {
				description = ArrayBuffer.isView(d)
					? new Uint8Array(d.buffer, d.byteOffset, d.byteLength).slice()
					: new Uint8Array(d.slice(0));
			}
		},
		error: () => {},
	});
	try {
		probe.configure(config);
		let silence = new AudioData({ format: "f32", sampleRate: EXPORT_AUDIO_RATE,
			numberOfFrames: EXPORT_AUDIO_FRAME, numberOfChannels: 1, timestamp: 0,
			data: new Float32Array(EXPORT_AUDIO_FRAME) });
		probe.encode(silence);
		silence.close();
		await probe.flush();
	} catch {
		return null;
	} finally {
		try { probe.close(); } catch { /* already closed */ }
	}
	/* OpusHead: magic, version, channels, then the pre-skip as a
	 * little-endian 16-bit count of 48 kHz samples */
	if (!description || description.length < 19 ||
		String.fromCharCode(...description.slice(0, 8)) !== "OpusHead") return null;
	let pre_skip = description[10] | (description[11] << 8);
	return { config, codec_private: description, pre_skip };
}

/* Feeds mixed samples to the audio encoder in whole Opus frames, carrying
 * the remainder to the next call; `last` pads the final partial frame
 * with silence so the track runs to the end of the video. */
function ex_audio_feed(audio_encoder) {
	let carry = new Float32Array(EXPORT_AUDIO_FRAME);
	let carried = 0;
	let frames = 0;
	function encode(data) {
		let audio = new AudioData({ format: "f32", sampleRate: EXPORT_AUDIO_RATE,
			numberOfFrames: EXPORT_AUDIO_FRAME, numberOfChannels: 1,
			timestamp: Math.round(frames * EXPORT_AUDIO_FRAME * 1e6 / EXPORT_AUDIO_RATE), data });
		audio_encoder.encode(audio);
		audio.close();
		frames++;
	}
	return (samples, last) => {
		let at = 0;
		while (at < samples.length) {
			let take = Math.min(EXPORT_AUDIO_FRAME - carried, samples.length - at);
			carry.set(samples.subarray(at, at + take), carried);
			carried += take;
			at += take;
			if (carried === EXPORT_AUDIO_FRAME) {
				encode(carry.slice());
				carried = 0;
			}
		}
		if (last && carried > 0) {
			carry.fill(0, carried);
			encode(carry.slice());
			carried = 0;
		}
	};
}

function ex_progress(done, total) {
	export_bar_fill.style.width = `${Math.floor((done / total) * 100)}%`;
	export_label.textContent = done >= total ? "Finishing…"
		: `Frame ${done.toLocaleString()} of ${total.toLocaleString()}`;
}

function ex_fmt_size(bytes) {
	if (bytes < 1e6) return `${Math.max(1, Math.round(bytes / 1e3))} kB`;
	let mb = bytes / 1e6;
	if (mb >= 1000) return `${(mb / 1000).toFixed(1)} GB`;
	if (mb >= 10) return `${Math.round(mb)} MB`;
	return `${mb.toFixed(1)} MB`;
}

/* A task break that lets the overlay repaint without using a timer:
 * backgrounded windows throttle setTimeout to a second or worse, which
 * would slow the export to a crawl the moment the page loses focus, but
 * MessageChannel tasks are never throttled. One channel serves every
 * call: a started, entangled port is never collected, so a channel per
 * call would leak two ports per yield for the life of the page. */
let ex_yield_channel = null;
let ex_yield_waiters = [];

function ex_yield() {
	if (ex_yield_channel === null) {
		ex_yield_channel = new MessageChannel();
		ex_yield_channel.port1.onmessage = () => ex_yield_waiters.shift()();
	}
	return new Promise(resolve => {
		ex_yield_waiters.push(resolve);
		ex_yield_channel.port2.postMessage(null);
	});
}

/* Wait for the encoder to drain below the queue limit. Driven by the
 * encoder's own dequeue events for the same reason as ex_yield (a timer
 * here would throttle the whole export in a backgrounded window), with a
 * slow timer as the safety net (and the whole mechanism, for encoders
 * predating the dequeue event). */
function ex_backpressure(encoder) {
	if (encoder.encodeQueueSize <= EXPORT_QUEUE_LIMIT) return Promise.resolve();
	return new Promise(resolve => {
		let timer = null;
		let check = () => {
			if (encoder.encodeQueueSize <= EXPORT_QUEUE_LIMIT ||
				export_error || export_cancel_requested) {
				encoder.removeEventListener("dequeue", check);
				clearTimeout(timer);
				resolve();
			} else {
				clearTimeout(timer);
				timer = setTimeout(check, 250);
			}
		};
		encoder.addEventListener("dequeue", check);
		timer = setTimeout(check, 250);
	});
}

/* ---------- the result ---------- */

/* The finished clip, playing in a loop over the page, with its size and a
 * link that saves it: the clip can be judged before it is kept, and one
 * that is not wanted costs nothing to throw away. The page behind is out
 * of reach until the dialog is closed (renderer.js sends Escape here). */
function show_clip_result(result) {
	clip_result_url = URL.createObjectURL(result.blob);
	clip_result_video.src = clip_result_url;
	clip_result_info.textContent = [
		`${result.w} × ${result.h}`,
		`${Number(result.seconds.toFixed(2))} s at ${result.fps} fps`,
		result.codec + (result.sound ? " + Opus" : ", no sound"),
		ex_fmt_size(result.blob.size),
	].join(" · ");
	clip_result_save.href = clip_result_url;
	clip_result_save.download = result.name;
	clip_result_el.classList.remove("hidden");
	set_layout_inert(true);
	clip_result_save.focus();
	/* a browser may refuse to start a video with sound by itself; the
	 * controls are there to start it by hand */
	let started = clip_result_video.play();
	if (started) started.catch(() => {});
}

function clip_result_open() {
	return clip_result_url !== null;
}

function close_clip_result() {
	if (!clip_result_open()) return;
	clip_result_el.classList.add("hidden");
	clip_result_video.pause();
	clip_result_video.removeAttribute("src");
	clip_result_video.load();
	clip_result_save.removeAttribute("href");
	URL.revokeObjectURL(clip_result_url);
	clip_result_url = null;
	set_layout_inert(false);
}
