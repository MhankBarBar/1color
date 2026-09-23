// Color math. Everything here mirrors the GLSL in gl.js exactly — the CPU copy is
// used for the "kept" readout and the live match preview, so the two must agree.

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function hexToRgb(hex) {
	let h = String(hex).trim().replace(/^#/, '');
	if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
	const n = Number.parseInt(h, 16);
	if (!Number.isFinite(n)) return { r: 0, g: 0, b: 0 };
	return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHex({ r, g, b }) {
	return (
		'#' +
		[r, g, b]
			.map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0'))
			.join('')
			.toUpperCase()
	);
}

// --- perceptual helpers ---------------------------------------------------

const toLinear = (c) => {
	c /= 255;
	return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

export const relativeLuminance = ({ r, g, b }) =>
	0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);

export function contrastRatio(a, b) {
	const la = relativeLuminance(a);
	const lb = relativeLuminance(b);
	const hi = Math.max(la, lb);
	const lo = Math.min(la, lb);
	return (hi + 0.05) / (lo + 0.05);
}

const INK_DARK = { r: 8, g: 8, b: 10 };
const INK_LIGHT = { r: 246, g: 246, b: 248 };

/** Black or white, whichever reads better on `rgb`. */
export const inkOn = (rgb) =>
	contrastRatio(rgb, INK_DARK) >= contrastRatio(rgb, INK_LIGHT)
		? rgbToHex(INK_DARK)
		: rgbToHex(INK_LIGHT);

const luma = ({ r, g, b }) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

const smoothstep = (e0, e1, x) => {
	const t = clamp((x - e0) / (e1 - e0), 0, 1);
	return t * t * (3 - 2 * t);
};

/** HSV computed in linear light. `h` is a fraction of the circle; `s`, `v`, and
 *  `d` (the raw mx-mn spread) are 0..1. Linear light keeps the hue of a shadowed
 *  color identical to the hue of its highlight, which is the whole point:
 *  gamma-encoded hue shifts as a color darkens, so a sunflower's shaded petals
 *  would drift away from its lit ones. */
function hsv({ r, g, b }) {
	const t = hsvInto(r, g, b, {});
	return { h: t.h, s: t.s, v: t.v, d: t.d };
}

/**
 * Numeric core of `hsv`, writing into `out` instead of allocating.
 *
 * The coverage scan calls this per pixel on every slider frame. Returning an
 * array or object here would churn tens of thousands of short-lived values per
 * frame, which is exactly the garbage that made dragging a slider stutter — so
 * this fills a caller-provided record instead.
 */
function hsvInto(r, g, b, out) {
	const R = toLinear(r);
	const G = toLinear(g);
	const B = toLinear(b);
	const mx = R > G ? (R > B ? R : B) : G > B ? G : B;
	const mn = R < G ? (R < B ? R : B) : G < B ? G : B;
	const d = mx - mn;
	out.s = mx <= 0 ? 0 : d / mx;
	out.v = mx;
	out.d = d;
	let h = 0;
	if (d > 0) {
		if (mx === R) h = ((G - B) / d) % 6;
		else if (mx === G) h = (B - R) / d + 2;
		else h = (R - G) / d + 4;
		h /= 6;
		if (h < 0) h += 1;
	}
	out.h = h;
	return out;
}

/** Below this saturation ratio a color has no hue to speak of — a gray. */
const NEUTRAL_SAT = 0.15;

/** The gate ramps over this saturation-ratio band. Kept low on purpose: the
 *  ratio is scale-invariant, so it stays meaningful for a pale petal (ratio
 *  ~0.2) and for a petal in deep shadow (ratio ~0.9) alike. A steeper ramp here
 *  silently drops the brightest highlights on a subject, which reads as the
 *  photo having holes in it. */
const SAT_LO = 0.04;
const SAT_HI = 0.25;

/**
 * How far apart two colors are, on a 0..1 scale where 1 means "unrelated".
 *
 * Primarily a *hue* distance, gated by whether either color is saturated enough
 * to carry a hue. That is what makes this a "keep this color family" control
 * rather than a "keep this exact RGB" one: a pale petal and a deep petal share a
 * hue and both survive, while a gray of the same brightness has no hue at all
 * and is rejected.
 *
 * When the target itself is near-neutral there is no hue to match, so this
 * degrades to a brightness match — tapping a gray sky keeps the grays.
 */
export function accentDistance(a, b) {
	const A = {};
	const B = {};
	return distRgb(a.r, a.g, a.b, b, A, B);
}

/**
 * Numeric core of `accentDistance`.
 *
 * `scratchA`/`scratchB` are caller-owned records reused across calls so the
 * coverage scan can run without allocating. They are optional: omit them and
 * this allocates, which is fine for the one-off calls outside the hot loop.
 */
function distRgb(r, g, b, target, scratchA, scratchB) {
	const A = hsvInto(r, g, b, scratchA || {});
	const B = hsvInto(target.r, target.g, target.b, scratchB || {});

	if (B.s < NEUTRAL_SAT) {
		const dl = A.v - B.v;
		return Math.min(1, (dl < 0 ? -dl : dl) * 1.6);
	}

	const gate = smoothstep(SAT_LO, SAT_HI, A.s < B.s ? A.s : B.s);
	let dh = A.h - B.h;
	if (dh < 0) dh = -dh;
	if (dh > 0.5) dh = 1 - dh;
	const hueTerm = dh * 2;
	const gateTerm = 1 - gate;
	return hueTerm > gateTerm ? hueTerm : gateTerm;
}

// Slider 0–100 -> distance. Distance is normalised hue (180 degrees apart = 1),
// so width 30 holds a window of about +/-20 degrees and width 100 opens to
// roughly +/-57, which is as far as a single-hue selector should reasonably go.
export const widthToDist = (w) => 0.015 + (w / 100) * 0.3;
export const featherToDist = (f) => (f / 100) * 0.16;

/** Fraction of this pixel that keeps its color. 1 = full color, 0 = monochrome. */
export function matchAlpha(px, target, width, feather) {
	return matchAlphaRgb(px.r, px.g, px.b, target, widthToDist(width), featherToDist(feather));
}

/**
 * Numeric core of `matchAlpha`, with the slider values already converted.
 *
 * This is the innermost loop of the coverage scan, which runs on every slider
 * frame over tens of thousands of pixels. Taking plain numbers and precomputed
 * thresholds keeps it allocation-free — the object-per-pixel version churned
 * through roughly 66,000 short-lived objects per frame.
 */
export function matchAlphaRgb(r, g, b, target, e0, featherDist, scratchA, scratchB) {
	const d = distRgb(r, g, b, target, scratchA, scratchB);
	const e1 = e0 + (featherDist > 1e-4 ? featherDist : 1e-4);
	if (d <= e0) return 1;
	if (d >= e1) return 0;
	const t = (d - e0) / (e1 - e0);
	return 1 - t * t * (3 - 2 * t);
}

// --- palettes -------------------------------------------------------------

/**
 * Quantize to 5 bits/channel, average each bucket, then rank.
 *
 * Ranking is by *absolute chroma*, not saturation ratio. A ratio is meaningless
 * near black: rgb(4,2,1) reports 83% saturation while being visually black, and
 * on a real photo those shadow buckets outnumber everything else and would take
 * the top slot. Absolute chroma keeps vivid colors on top and lets a large
 * neutral region still appear, ranked below them.
 */
export function paletteFromImageData(data, count = 8) {
	const buckets = new Map();
	for (let i = 0; i < data.length; i += 4) {
		if (data[i + 3] < 128) continue;
		const r = data[i];
		const g = data[i + 1];
		const b = data[i + 2];
		const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
		let e = buckets.get(key);
		if (!e) buckets.set(key, (e = { n: 0, r: 0, g: 0, b: 0 }));
		e.n++;
		e.r += r;
		e.g += g;
		e.b += b;
	}

	const NEUTRAL_FLOOR = 0.06;
	const ranked = [];
	for (const e of buckets.values()) {
		const c = { r: e.r / e.n, g: e.g / e.n, b: e.b / e.n };
		const chroma = (Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b)) / 255;
		ranked.push({ c, score: e.n * (chroma + NEUTRAL_FLOOR), chroma });
	}
	ranked.sort((a, b) => b.score - a.score);

	const out = [];
	for (const e of ranked) {
		if (out.length >= count) break;
		if (out.some((o) => Math.hypot(o.r - e.c.r, o.g - e.c.g, o.b - e.c.b) < 44)) continue;
		out.push({ r: Math.round(e.c.r), g: Math.round(e.c.g), b: Math.round(e.c.b) });
	}
	return out;
}

/**
 * The color to open the editor with: the most prominent color that is actually
 * a color, and bright enough to read as a swatch. Falls back to the top entry
 * when the photo is genuinely monochrome.
 */
export function suggestedAccent(palette) {
	const usable = palette.filter((c) => {
		const chroma = (Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b)) / 255;
		const luma = (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
		return chroma > 0.25 && luma > 0.15 && luma < 0.92;
	});
	return usable[0] || palette[0] || { r: 252, g: 192, b: 0 };
}

export function pushRecent(list, rgb, max = 8) {
	const hex = rgbToHex(rgb);
	const next = [rgb, ...list.filter((c) => rgbToHex(c) !== hex)];
	return next.slice(0, max);
}
