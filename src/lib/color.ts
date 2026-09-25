// CPU mirror of the GLSL in gl.js: the "kept" readout and the live match preview must agree with the pixels.

import type { Hsv, Rgb } from './types.js';

export const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);

export function hexToRgb(hex: string): Rgb {
	let h = String(hex).trim().replace(/^#/, '');
	if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
	const n = Number.parseInt(h, 16);
	if (!Number.isFinite(n)) return { r: 0, g: 0, b: 0 };
	return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHex({ r, g, b }: Rgb): string {
	return (
		'#' +
		[r, g, b]
			.map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0'))
			.join('')
			.toUpperCase()
	);
}

// --- perceptual helpers ---------------------------------------------------

const toLinear = (c: number): number => {
	c /= 255;
	return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

export const relativeLuminance = ({ r, g, b }: Rgb): number =>
	0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);

export function contrastRatio(a: Rgb, b: Rgb): number {
	const la = relativeLuminance(a);
	const lb = relativeLuminance(b);
	const hi = Math.max(la, lb);
	const lo = Math.min(la, lb);
	return (hi + 0.05) / (lo + 0.05);
}

const INK_DARK: Rgb = { r: 8, g: 8, b: 10 };
const INK_LIGHT: Rgb = { r: 246, g: 246, b: 248 };

/** Black or white, whichever reads better on `rgb`. */
export const inkOn = (rgb: Rgb): string =>
	contrastRatio(rgb, INK_DARK) >= contrastRatio(rgb, INK_LIGHT)
		? rgbToHex(INK_DARK)
		: rgbToHex(INK_LIGHT);

const smoothstep = (e0: number, e1: number, x: number): number => {
	const t = clamp((x - e0) / (e1 - e0), 0, 1);
	return t * t * (3 - 2 * t);
};

/** Numeric core of the HSV conversion, writing into `out` instead of allocating: the
 *  coverage scan calls this per pixel per slider frame, and allocating made dragging
 *  stutter. */
function hsvInto(r: number, g: number, b: number, out: Hsv): Hsv {
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

/** Below this *absolute* chroma a color has no hue, whatever its ratio says:
 *  rgb(4,2,1) reports 75% saturation while visually black, so a near-black target
 *  kept the sunflower yellow. Leaf green at 0.041 correctly stays a hue carrier. */
const NEUTRAL_CHROMA = 0.012;

/** The gate ramps over this saturation-ratio band, kept low on purpose: the ratio
 *  is scale-invariant, so it works for a pale petal (~0.2) and a petal in deep
 *  shadow (~0.9) alike. A steeper ramp silently drops the brightest highlights. */
const SAT_LO = 0.04;
const SAT_HI = 0.25;

/** How far apart two colors are, 0..1 where 1 means "unrelated". Primarily a *hue*
 *  distance gated by saturation, so a pale and a deep petal both survive while a
 *  same-brightness gray is rejected. A neutral target degrades to a brightness match. */
export function accentDistance(a: Rgb, b: Rgb): number {
	const A: Hsv = { h: 0, s: 0, v: 0, d: 0 };
	const B: Hsv = { h: 0, s: 0, v: 0, d: 0 };
	return distRgb(a.r, a.g, a.b, b, A, B);
}

/** Numeric core of `accentDistance`. `scratchA`/`scratchB` are caller-owned records
 *  reused so the coverage scan runs allocation-free; omitting them allocates, fine
 *  outside the hot loop. */
function distRgb(
	r: number,
	g: number,
	b: number,
	target: Rgb,
	scratchA?: Hsv,
	scratchB?: Hsv
): number {
	const A = hsvInto(r, g, b, scratchA || { h: 0, s: 0, v: 0, d: 0 });
	const B = hsvInto(target.r, target.g, target.b, scratchB || { h: 0, s: 0, v: 0, d: 0 });

	// Either test alone is insufficient: the ratio catches a washed-out mid grey,
	// the absolute chroma catches a near-black whose ratio is meaningless.
	if (B.s < NEUTRAL_SAT || B.d < NEUTRAL_CHROMA) {
		// Compared through sqrt: `v` is linear light, which compresses dark tones into a
		// narrow band (leaf green sits 0.04 above a near-black, under the tolerance, so a
		// black target kept the leaves). Cheap enough for the inner loop, unlike pow.
		const dl = Math.sqrt(A.v) - Math.sqrt(B.v);
		const bright = Math.min(1, (dl < 0 ? -dl : dl) * 1.6);
		// A colored pixel is not a neutral one, however close its brightness: without this
		// a near-black target kept the dark green leaves (chroma 0.0118, just under the
		// floor above). Judged absolute — the ratio reports 0.31 for neutral rgb(14,12,10).
		const gate = smoothstep(0.002, 0.008, A.d - B.d);
		return bright > gate ? bright : gate;
	}

	const gate = smoothstep(SAT_LO, SAT_HI, A.s < B.s ? A.s : B.s);
	let dh = A.h - B.h;
	if (dh < 0) dh = -dh;
	if (dh > 0.5) dh = 1 - dh;
	const hueTerm = dh * 2;
	const gateTerm = 1 - gate;
	return hueTerm > gateTerm ? hueTerm : gateTerm;
}

// Slider 0–100 -> distance. Distance is normalised hue (180 degrees = 1), so width
// 30 is about +/-20 degrees and width 100 about +/-57 — as far as a single-hue
// selector should reasonably go.
export const widthToDist = (w: number): number => 0.015 + (w / 100) * 0.3;
export const featherToDist = (f: number): number => (f / 100) * 0.16;

/** Fraction of this pixel that keeps its color. 1 = full color, 0 = monochrome. */
export function matchAlpha(px: Rgb, target: Rgb, width: number, feather: number): number {
	return matchAlphaRgb(px.r, px.g, px.b, target, widthToDist(width), featherToDist(feather));
}

/** Numeric core of `matchAlpha`, sliders already converted. The coverage scan's
 *  innermost loop, over tens of thousands of pixels per frame; plain numbers and
 *  precomputed thresholds keep it allocation-free. */
export function matchAlphaRgb(
	r: number,
	g: number,
	b: number,
	target: Rgb,
	e0: number,
	featherDist: number,
	scratchA?: Hsv,
	scratchB?: Hsv
): number {
	const d = distRgb(r, g, b, target, scratchA, scratchB);
	const e1 = e0 + (featherDist > 1e-4 ? featherDist : 1e-4);
	if (d <= e0) return 1;
	if (d >= e1) return 0;
	const t = (d - e0) / (e1 - e0);
	return 1 - t * t * (3 - 2 * t);
}

// --- palettes -------------------------------------------------------------

/** One quantisation bucket while it is being accumulated. */
interface Bucket {
	n: number;
	r: number;
	g: number;
	b: number;
}

/** Quantize to 5 bits/channel, average each bucket, then rank by *absolute chroma*,
 *  not saturation ratio: rgb(4,2,1) reports 83% saturation while being visually
 *  black, and those shadow buckets would take the top slot on a real photo. */
export function paletteFromImageData(data: Uint8ClampedArray, count = 8): Rgb[] {
	const buckets = new Map<number, Bucket>();
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
	const ranked: { c: Rgb; score: number; chroma: number }[] = [];
	for (const e of buckets.values()) {
		const c = { r: e.r / e.n, g: e.g / e.n, b: e.b / e.n };
		const chroma = (Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b)) / 255;
		ranked.push({ c, score: e.n * (chroma + NEUTRAL_FLOOR), chroma });
	}
	ranked.sort((a, b) => b.score - a.score);

	const out: Rgb[] = [];
	for (const e of ranked) {
		if (out.length >= count) break;
		if (out.some((o) => Math.hypot(o.r - e.c.r, o.g - e.c.g, o.b - e.c.b) < 44)) continue;
		out.push({ r: Math.round(e.c.r), g: Math.round(e.c.g), b: Math.round(e.c.b) });
	}
	return out;
}

/** The color to open the editor with: the most prominent one that is actually a
 *  color and bright enough to read as a swatch. Falls back to the top entry when
 *  the photo is genuinely monochrome. */
export function suggestedAccent(palette: Rgb[]): Rgb {
	const usable = palette.filter((c) => {
		const chroma = (Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b)) / 255;
		const l = (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
		return chroma > 0.25 && l > 0.15 && l < 0.92;
	});
	return usable[0] || palette[0] || { r: 252, g: 192, b: 0 };
}

export function pushRecent(list: Rgb[], rgb: Rgb, max = 8): Rgb[] {
	const hex = rgbToHex(rgb);
	const next = [rgb, ...list.filter((c) => rgbToHex(c) !== hex)];
	return next.slice(0, max);
}
