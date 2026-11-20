"use strict";
/* The clip being made: which part of the map the video shows (the region)
 * and which part of the game (the start and the end), with the sidebar's
 * Clip panel, the region's overlay on the canvas and the pointer gestures
 * that shape it. video.js turns the clip into a file.
 *
 * The video is what the screen shows, at the scale it shows it: a tile
 * that is `zoom` pixels wide in the view is `zoom` pixels wide in the
 * video. So the region is kept in tiles, where it stays put on the map
 * while the view pans and zooms around it, and the size of the video is
 * the region's size at the zoom of the moment: zooming in makes the same
 * piece of map a larger video. clip_frame() is the one place that turns
 * the region into pixels, and the overlay and the export both use it, so
 * the box drawn is the frame encoded. With no region marked, the clip is
 * the whole view.
 *
 * Loaded after renderer.js, whose globals (view, clock, game, canvas, ctx)
 * it shares. */

const CLIP_ASPECTS = { "free": null, "16:9": 16 / 9, "4:3": 4 / 3, "1:1": 1, "9:16": 9 / 16 };
const CLIP_QUALITIES = ["standard", "high", "max"];
/* The video's size in pixels each way. The floor keeps a slip of the hand
 * from making a postage stamp; the ceiling is past anything the encoders
 * are sure to take. */
const CLIP_MIN_PX = 32;
const CLIP_MAX_PX = 4096;
const CLIP_GRIP_PX = 7;      /* how near a handle's centre the pointer takes hold of it */
const CLIP_MIN_DRAG_PX = 8;  /* a region dragged out smaller than this each way is a slip, not a region */
const CLIP_OPTIONS_KEY = "winbolo_clips_options";
const CLIP_DEFAULTS = { aspect: "free", speed: 1, fps: 50, quality: "high", sound: true };

/* region: { x, y, w, h } in tiles, or null for the whole view.
 * start, end: ticks, or null until set. */
let clip = { region: null, start: null, end: null };

/* The region drag in progress: { kind, before, ... }. kind is "new" (being
 * marked out from an anchor point), "move", or the handle held ("nw", "n",
 * ...). before is the region as the drag found it, for Escape. */
let clip_drag = null;
let clip_label_rect = null; /* where the overlay last drew the size label, in CSS pixels */

let clip_region_el = document.getElementById("clipRegion");
let clip_aspect_el = document.getElementById("clipAspect");
let clip_fit_btn = document.getElementById("clipFit");
let clip_clear_btn = document.getElementById("clipClear");
let clip_start_el = document.getElementById("clipStart");
let clip_end_el = document.getElementById("clipEnd");
let clip_set_start_btn = document.getElementById("clipSetStart");
let clip_set_end_btn = document.getElementById("clipSetEnd");
let clip_go_start_btn = document.getElementById("clipGoStart");
let clip_go_end_btn = document.getElementById("clipGoEnd");
let clip_length_el = document.getElementById("clipLength");
let clip_speed_el = document.getElementById("clipSpeed");
let clip_fps_el = document.getElementById("clipFps");
let clip_quality_el = document.getElementById("clipQuality");
let clip_sound_el = document.getElementById("clipSound");
let clip_sound_note_el = document.getElementById("clipSoundNote");
let clip_play_btn = document.getElementById("clipPlay");
let clip_export_btn = document.getElementById("clipExport");
let clip_problem_el = document.getElementById("clipProblem");
let seek_wrap_el = document.getElementById("seekWrap");

/* ---------- the frame ---------- */

function clip_aspect() {
	return CLIP_ASPECTS[clip_aspect_el.value] || null;
}

/* Video dimensions are even: the encoders work in 4:2:0, where an odd
 * width has half a chroma sample left over. */
function even_px(px) {
	return Math.max(2, 2 * Math.round(px / 2));
}

/* The frame of the video at the live zoom: its top-left corner in tiles,
 * on a whole pixel, and its size in pixels. */
function clip_frame() {
	let z = view.zoom;
	let r = clip.region || { x: view.ox, y: view.oy, w: canvas.clientWidth / z, h: canvas.clientHeight / z };
	return {
		ox: Math.round(r.x * z) / z,
		oy: Math.round(r.y * z) / z,
		w: even_px(r.w * z),
		h: even_px(r.h * z),
	};
}

/* The largest rectangle of the aspect that fits centred in w by h. */
function fit_aspect(w, h, aspect) {
	if (!aspect) return { w, h };
	return w / h > aspect ? { w: h * aspect, h } : { w, h: w / aspect };
}

/* A region from two opposite corners, the first held and the second
 * dragged; with an aspect, the longer reach sets the size. */
function region_from_corners(ax, ay, px, py, aspect) {
	let w = Math.abs(px - ax), h = Math.abs(py - ay);
	if (aspect) {
		w = Math.max(w, h * aspect);
		h = w / aspect;
	}
	return { x: px < ax ? ax - w : ax, y: py < ay ? ay - h : ay, w, h };
}

function set_clip_region(region) {
	clip.region = region ? { x: region.x, y: region.y, w: region.w, h: region.h } : null;
	request_draw();
}

/* A view locked to a player is centred on the player; keep the region
 * centred in the view, so the clip follows the player too. The export's
 * view is the region, and centre_locked_player centres that the same way. */
function clip_follow_view() {
	let r = clip.region;
	if (!r) return;
	r.x = view.ox + (canvas.clientWidth / view.zoom - r.w) / 2;
	r.y = view.oy + (canvas.clientHeight / view.zoom - r.h) / 2;
}

/* ---------- the overlay ---------- */

/* The region's grips, in CSS pixels: its corners, and with a free aspect
 * the middles of its sides (a side dragged alone would break a fixed one). */
function clip_handles(x, y, w, h) {
	let handles = [
		{ name: "nw", x, y }, { name: "ne", x: x + w, y },
		{ name: "sw", x, y: y + h }, { name: "se", x: x + w, y: y + h },
	];
	if (!clip_aspect()) {
		handles.push({ name: "n", x: x + w / 2, y }, { name: "s", x: x + w / 2, y: y + h },
			{ name: "w", x, y: y + h / 2 }, { name: "e", x: x + w, y: y + h / 2 });
	}
	return handles;
}

/* Where the region's frame sits on the canvas, in CSS pixels. */
function clip_frame_on_screen() {
	let f = clip_frame();
	return { x: (f.ox - view.ox) * view.zoom, y: (f.oy - view.oy) * view.zoom, w: f.w, h: f.h };
}

/* Drawn over the world on the live canvas: everything outside the frame
 * dimmed, a border just outside the frame's edge (what is inside the line
 * is the video, to the pixel), the grips, and a label with the video's
 * size, which is also the grip that moves the region. */
function draw_clip_overlay() {
	clip_label_rect = null;
	if (!clip.region) return;
	let { x, y, w, h } = clip_frame_on_screen();
	let cw = canvas.clientWidth, ch = canvas.clientHeight;
	ctx.save();
	ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);

	ctx.fillStyle = "rgba(6, 9, 15, 0.6)";
	ctx.beginPath();
	ctx.rect(0, 0, cw, ch);
	ctx.rect(x, y, w, h);
	ctx.fill("evenodd");

	ctx.strokeStyle = "#fff";
	ctx.lineWidth = 1;
	ctx.strokeRect(x - 0.5, y - 0.5, w + 1, h + 1);

	ctx.fillStyle = "#fff";
	ctx.strokeStyle = "#10131a";
	for (let handle of clip_handles(x, y, w, h)) {
		ctx.fillRect(handle.x - 4, handle.y - 4, 8, 8);
		ctx.strokeRect(handle.x - 3.5, handle.y - 3.5, 7, 7);
	}

	/* the label rides above the top edge, clear of the corner grip, and
	 * comes inside when the edge is at the top of the view */
	let text = `${w} × ${h}`;
	ctx.font = "600 12px system-ui, sans-serif";
	let lw = Math.ceil(ctx.measureText(text).width) + 14, lh = 20;
	let lx = Math.max(2, Math.min(cw - lw - 2, x + 10));
	let ly = y - lh - 3 >= 2 ? y - lh - 3 : Math.max(2, y + 8);
	ctx.fillStyle = clip_size_problem() ? "#f0b429" : "#fff";
	ctx.beginPath();
	ctx.roundRect(lx, ly, lw, lh, 3);
	ctx.fill();
	ctx.fillStyle = "#10131a";
	ctx.textAlign = "left";
	ctx.textBaseline = "middle";
	ctx.fillText(text, lx + 7, ly + lh / 2 + 0.5);
	clip_label_rect = { x: lx, y: ly, w: lw, h: lh };

	ctx.restore();
}

/* What of the region is under a point of the canvas: a handle's name,
 * "move" for the label, or null. */
function clip_hit(px, py) {
	if (!clip.region) return null;
	let { x, y, w, h } = clip_frame_on_screen();
	for (let handle of clip_handles(x, y, w, h)) {
		if (Math.abs(px - handle.x) <= CLIP_GRIP_PX && Math.abs(py - handle.y) <= CLIP_GRIP_PX) return handle.name;
	}
	let l = clip_label_rect;
	if (l && px >= l.x && px < l.x + l.w && py >= l.y && py < l.y + l.h) return "move";
	return null;
}

const CLIP_CURSORS = {
	nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize",
	n: "ns-resize", s: "ns-resize", w: "ew-resize", e: "ew-resize", move: "move",
};

function clip_cursor(px, py, shift) {
	if (!game) return "grab";
	if (shift) return "crosshair";
	return CLIP_CURSORS[clip_hit(px, py)] || "grab";
}

/* Shift pressed or let go over the canvas changes what a drag would do,
 * with no pointer event to say so. */
function clip_shift_changed(e) {
	if (e.key !== "Shift" || !hover_point || pointer_buttons !== 0 || exporting) return;
	canvas.style.cursor = clip_cursor(hover_point.x, hover_point.y, e.type === "keydown");
}
window.addEventListener("keydown", clip_shift_changed);
window.addEventListener("keyup", clip_shift_changed);

/* ---------- the pointer ---------- */

/* A point of the canvas in tiles, on a whole pixel of the video. */
function clip_tile(px, py) {
	let z = view.zoom;
	return { x: Math.round(view.ox * z + px) / z, y: Math.round(view.oy * z + py) / z };
}

/* Each returns whether the region took the event; renderer.js pans with
 * what is left. */
function clip_pointer_down(e) {
	if (!game || e.button !== 0) return false;
	let at = clip_tile(e.offsetX, e.offsetY);
	let before = clip.region && { ...clip.region };
	if (e.shiftKey) {
		clip_drag = { kind: "new", before, ax: at.x, ay: at.y };
		canvas.style.cursor = "crosshair";
		return true;
	}
	let hit = clip_hit(e.offsetX, e.offsetY);
	if (!hit) return false;
	clip_drag = hit === "move"
		? { kind: "move", before, dx: at.x - before.x, dy: at.y - before.y }
		: { kind: hit, before };
	return true;
}

function clip_pointer_move(e) {
	if (!clip_drag) return false;
	let at = clip_tile(e.offsetX, e.offsetY);
	let d = clip_drag, b = d.before;
	let next;
	if (d.kind === "new") {
		next = region_from_corners(d.ax, d.ay, at.x, at.y, clip_aspect());
	} else if (d.kind === "move") {
		/* the region goes where it is put: a view locked to a player would
		 * only carry it back, so moving it lets go of the lock, as a pan does */
		if (player_locked) {
			player_locked = false;
			update_lock_indicator();
		}
		next = { x: at.x - d.dx, y: at.y - d.dy, w: b.w, h: b.h };
	} else if (d.kind.length === 2) {
		/* a corner: the opposite corner stays where it was */
		let ax = d.kind[1] === "w" ? b.x + b.w : b.x;
		let ay = d.kind[0] === "n" ? b.y + b.h : b.y;
		next = region_from_corners(ax, ay, at.x, at.y, clip_aspect());
	} else {
		/* a side: it follows the pointer, the other three stay */
		let left = b.x, top = b.y, right = b.x + b.w, bottom = b.y + b.h;
		if (d.kind === "w") left = at.x;
		else if (d.kind === "e") right = at.x;
		else if (d.kind === "n") top = at.y;
		else bottom = at.y;
		next = { x: Math.min(left, right), y: Math.min(top, bottom), w: Math.abs(right - left), h: Math.abs(bottom - top) };
	}
	if (next.w * view.zoom >= CLIP_MIN_DRAG_PX && next.h * view.zoom >= CLIP_MIN_DRAG_PX) {
		clip.region = next;
		request_draw();
	}
	return true;
}

function clip_pointer_up() {
	if (!clip_drag) return;
	clip_drag = null;
	request_draw();
}

/* Escape mid-drag puts the region back as the drag found it. */
function clip_cancel_drag() {
	if (!clip_drag) return;
	clip.region = clip_drag.before;
	clip_drag = null;
	request_draw();
}

/* ---------- the start and the end ---------- */

/* Sets the clip's start or end ("start" / "end") to the tick the clock is
 * in. An end at or before the start is no clip: setting one end past the
 * other unsets the other. */
function set_clip_end(which) {
	if (!game || exporting) return;
	let tick = Math.floor(clock);
	if (which === "start") {
		clip.start = tick;
		if (clip.end !== null && clip.end <= tick) clip.end = null;
	} else {
		clip.end = tick;
		if (clip.start !== null && clip.start >= tick) clip.start = null;
	}
	update_clip_panel();
}

function set_clip_range(start, end) {
	clip.start = start;
	clip.end = end;
	update_clip_panel();
}

function go_to_clip_end(which) {
	if (!game || exporting || clip[which] === null) return;
	set_playing(false);
	set_clock(clip[which], true);
}

/* Plays the clip's span of the game once, at the transport's speed, and
 * stops at its end. */
function preview_clip() {
	if (!game || exporting || clip.start === null || clip.end === null) return;
	set_playing(false);
	set_clock(clip.start, true);
	preview_end = clip.end; /* after set_clock, which ends any preview */
	set_playing(true);
}

/* A new game: nothing marked on the last one applies. */
function reset_clip() {
	clip = { region: null, start: null, end: null };
	clip_drag = null;
	update_clip_panel();
}

/* ---------- the options ---------- */

function clip_options() {
	let speed = parseFloat(clip_speed_el.value);
	return {
		aspect: clip_aspect_el.value,
		speed,
		fps: parseInt(clip_fps_el.value, 10),
		quality: clip_quality_el.value,
		/* the live player is silent above 1× too: sped up, the sounds
		 * pile into a roar */
		sound: clip_sound_el.checked && speed <= 1,
		sound_wanted: clip_sound_el.checked,
	};
}

function store_clip_options() {
	let o = clip_options();
	try {
		localStorage.setItem(CLIP_OPTIONS_KEY, JSON.stringify({
			aspect: o.aspect, speed: o.speed, fps: o.fps, quality: o.quality, sound: o.sound_wanted,
		}));
	} catch { /* a full or blocked store just loses the memory */ }
}

function restore_clip_options() {
	let stored = {};
	try {
		stored = JSON.parse(localStorage.getItem(CLIP_OPTIONS_KEY)) || {};
	} catch { /* absent or corrupt: defaults */ }
	let o = { ...CLIP_DEFAULTS, ...stored };
	/* a select given a value it has no option for shows nothing at all */
	let choose = (el, value, fallback) => {
		el.value = String(value);
		if (el.selectedIndex < 0) el.value = String(fallback);
	};
	choose(clip_aspect_el, o.aspect, CLIP_DEFAULTS.aspect);
	choose(clip_speed_el, o.speed, CLIP_DEFAULTS.speed);
	choose(clip_fps_el, o.fps, CLIP_DEFAULTS.fps);
	choose(clip_quality_el, o.quality, CLIP_DEFAULTS.quality);
	clip_sound_el.checked = Boolean(o.sound);
}

/* ---------- the panel ---------- */

/* The number of frames the export will make, and the seconds they run for. */
function clip_length(options = clip_options()) {
	if (clip.start === null || clip.end === null) return null;
	let frames = Math.max(1, Math.round((clip.end - clip.start) * options.fps / (TPS * options.speed)));
	return { frames, seconds: frames / options.fps, game_seconds: (clip.end - clip.start) / TPS };
}

function clip_size_problem() {
	let f = clip_frame();
	if (f.w < CLIP_MIN_PX || f.h < CLIP_MIN_PX) return `the video would be ${f.w} × ${f.h}: zoom in, or make the region larger`;
	if (f.w > CLIP_MAX_PX || f.h > CLIP_MAX_PX) return `the video would be ${f.w} × ${f.h}: zoom out, or make the region smaller`;
	return null;
}

/* Why the clip cannot be exported as it stands, or null when it can. */
function clip_problem() {
	if (!game) return "no replay is loaded";
	if (clip.start === null && clip.end === null) return "set the clip's start and end";
	if (clip.start === null) return "set the clip's start";
	if (clip.end === null) return "set the clip's end";
	return clip_size_problem();
}

function set_text(el, text) {
	if (el.textContent !== text) el.textContent = text;
}

/* Everything the panel and the seek bar say about the clip. The size of
 * the video moves with the zoom, and with the window when no region is
 * marked, so draw() calls this on every frame it paints; each element is
 * only touched when what it says changes. */
function update_clip_panel() {
	/* with no replay there is nothing to mark, and nothing here to say */
	for (let el of [clip_fit_btn, clip_set_start_btn, clip_set_end_btn]) el.disabled = !game;
	if (!game) return;
	let f = clip_frame();
	let r = clip.region;
	let tiles = n => String(Number(n.toFixed(2)));
	set_text(clip_region_el, r ? `${f.w} × ${f.h} px` : `whole view, ${f.w} × ${f.h} px`);
	let tip = r
		? `${tiles(r.w)} × ${tiles(r.h)} tiles from ${tiles(r.x)}, ${tiles(r.y)}, at zoom ${view.zoom}×`
		: "Shift + drag on the map to mark a region";
	if (clip_region_el.title !== tip) clip_region_el.title = tip;
	clip_clear_btn.disabled = !r;

	set_text(clip_start_el, clip.start === null ? "not set" : fmt_tick(clip.start));
	set_text(clip_end_el, clip.end === null ? "not set" : fmt_tick(clip.end));
	clip_go_start_btn.disabled = clip.start === null;
	clip_go_end_btn.disabled = clip.end === null;

	let options = clip_options();
	let length = clip_length(options);
	let seconds = s => `${Number(s.toFixed(2))} s`;
	set_text(clip_length_el, !length ? "–"
		: (options.speed === 1 ? seconds(length.seconds) : `${seconds(length.game_seconds)} of game in ${seconds(length.seconds)}`)
			+ `, ${length.frames.toLocaleString()} frames`);

	clip_sound_el.disabled = options.speed > 1;
	set_text(clip_sound_note_el, options.speed > 1 ? "(silent above 1×)" : "");

	let problem = clip_problem();
	set_text(clip_problem_el, problem ? problem[0].toUpperCase() + problem.slice(1) + "." : "");
	clip_export_btn.disabled = problem !== null;
	clip_play_btn.disabled = !length;

	/* the clip's span on the seek bar, as fractions of the game */
	let span = Math.max(1, game.t1 - game.t0);
	let a = clip.start === null ? null : (clip.start - game.t0) / span;
	let b = clip.end === null ? null : (clip.end - game.t0) / span;
	seek_wrap_el.classList.toggle("has-clip", a !== null || b !== null);
	seek_wrap_el.style.setProperty("--clip_a", String(a !== null ? a : b));
	seek_wrap_el.style.setProperty("--clip_b", String(b !== null ? b : a));
}

/* ---------- the panel's controls ---------- */

/* Like the transport's, these give focus back once used, so they don't
 * keep the global keys (space on a focused button would press it again). */
function clip_control(el, event, action) {
	el.addEventListener(event, () => {
		el.blur();
		if (exporting) return;
		action();
	});
}

clip_control(clip_set_start_btn, "click", () => set_clip_end("start"));
clip_control(clip_set_end_btn, "click", () => set_clip_end("end"));
clip_control(clip_go_start_btn, "click", () => go_to_clip_end("start"));
clip_control(clip_go_end_btn, "click", () => go_to_clip_end("end"));
clip_control(clip_play_btn, "click", preview_clip);
clip_control(clip_export_btn, "click", () => export_clip());
clip_control(clip_clear_btn, "click", () => set_clip_region(null));

/* The region becomes the view as it stands (the largest piece of it the
 * aspect allows): a way to frame the clip by panning and zooming alone. */
clip_control(clip_fit_btn, "click", () => {
	if (!game) return;
	let z = view.zoom;
	let w = canvas.clientWidth / z, h = canvas.clientHeight / z;
	let size = fit_aspect(w, h, clip_aspect());
	set_clip_region({ x: view.ox + (w - size.w) / 2, y: view.oy + (h - size.h) / 2, w: size.w, h: size.h });
});

/* A new aspect reshapes the region about its centre, keeping its width. */
clip_control(clip_aspect_el, "change", () => {
	store_clip_options();
	let r = clip.region, aspect = clip_aspect();
	if (r && aspect) {
		let h = r.w / aspect;
		r.y += (r.h - h) / 2;
		r.h = h;
	}
	request_draw();
	update_clip_panel();
});

for (let el of [clip_speed_el, clip_fps_el, clip_quality_el, clip_sound_el]) {
	clip_control(el, "change", () => {
		store_clip_options();
		update_clip_panel();
	});
}

restore_clip_options();
update_clip_panel();
