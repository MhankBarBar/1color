// CPU-side analysis of the loaded photo: color sampling for taps, the coverage
// readout, the photo's own palette, and the four showcase accents.
//
// Kept deliberately separate from gl.js — the shader is the source of truth for
// pixels, this module is the source of truth for numbers shown as text.

import type { Hsv, PixelSource, Rgb } from './types.js';
import {
	matchAlphaRgb,
	paletteFromImageData,
	rgbToHex,
	suggestedAccent,
	widthToDist,
	featherToDist
} from './color.js';

const SAMPLE_EDGE = 320;
const PICK_EDGE = 1024;
/** Side of the coverage grid. 80x80 = 6,400 samples across the whole photo. */
const COVER_GRID = 80;

/**
 * Sample pixels for the coverage readout, spread by a low-discrepancy sequence.
 *
 * Neither a linear stride nor a regular grid is safe here: both resonate with
 * repeating structure in the photo. Measured on a sunflower field, a stride of 3
 * reported 31.5% coverage against a true 10.7%; a plain grid hit the same
 * problem on synthetic stripes (0% against a true 33%), and staggering alternate
 * rows only moved it to 50%.
 *
 * A Kronecker sequence — x advancing by the golden ratio, y sweeping linearly —
 * has no period to resonate with, so the estimate stays accurate on any pattern
 * while remaining O(samples). Deterministic, so a given photo always reports the
 * same figure.
 */
const GOLDEN = 0.6180339887498949;

function coverGrid(data: Uint8ClampedArray, w: number, h: number, grid: number): Uint8Array {
	const n = grid * grid;
	const out = new Uint8Array(n * 3);
	for (let k = 0; k < n; k++) {
		// frac(k * golden) for x; a plain sweep for y.
		const fx = (k * GOLDEN) % 1;
		const fy = (k + 0.5) / n;
		const sx = Math.min(w - 1, (fx * w) | 0);
		const sy = Math.min(h - 1, (fy * h) | 0);
		const o = (sy * w + sx) * 4;
		const q = k * 3;
		out[q] = data[o];
		out[q + 1] = data[o + 1];
		out[q + 2] = data[o + 2];
	}
	return out;
}

export class Sampler {
	source: PixelSource;
	w: number;
	h: number;
	data: Uint8ClampedArray;
	pickW: number;
	pickH: number;
	pickCtx: CanvasRenderingContext2D;
	palette: Rgb[];
	cover: Uint8Array;

	/** @param {HTMLCanvasElement|ImageBitmap} source */
	constructor(source: PixelSource) {
		this.source = source;

		// Small copy: coverage math and palette extraction.
		const s = fit(source, SAMPLE_EDGE);
		this.w = s.w;
		this.h = s.h;
		this.data = s.ctx.getImageData(0, 0, s.w, s.h).data;

		// Larger copy: tap-to-pick accuracy.
		const p = fit(source, PICK_EDGE);
		this.pickW = p.w;
		this.pickH = p.h;
		this.pickCtx = p.ctx;
		this.palette = paletteFromImageData(this.data, 10);
		this.cover = coverGrid(this.data, this.w, this.h, COVER_GRID);
	}

	/** Average a 3x3 neighborhood so a single noisy pixel can't win a tap. */
	pickAt(nx: number, ny: number): Rgb {
		const x = Math.round(nx * (this.pickW - 1));
		const y = Math.round(ny * (this.pickH - 1));
		const x0 = Math.max(0, x - 1);
		const y0 = Math.max(0, y - 1);
		const x1 = Math.min(this.pickW - 1, x + 1);
		const y1 = Math.min(this.pickH - 1, y + 1);
		const d = this.pickCtx.getImageData(x0, y0, x1 - x0 + 1, y1 - y0 + 1).data;
		let r = 0;
		let g = 0;
		let b = 0;
		let n = 0;
		for (let i = 0; i < d.length; i += 4) {
			r += d[i];
			g += d[i + 1];
			b += d[i + 2];
			n++;
		}
		if (!n) return { r: 0, g: 0, b: 0 };
		return { r: r / n, g: g / n, b: b / n };
	}

	/** Share of the photo that keeps color at these settings, 0..1.
	 *
	 * Runs over a fixed 2D grid of the whole frame rather than a linear stride,
	 * so the figure is stable and cannot alias against repeating detail. See
	 * `coverGrid` for why a stride is wrong here. */
	coverage(target: Rgb, width: number, feather: number): number {
		const g = this.cover;
		const e0 = widthToDist(width);
		const fd = featherToDist(feather);
		// Two reusable records, created once per scan rather than per sample.
		const sA: Hsv = { h: 0, s: 0, v: 0, d: 0 };
		const sB: Hsv = { h: 0, s: 0, v: 0, d: 0 };
		let kept = 0;
		const n = g.length / 3;
		for (let i = 0; i < g.length; i += 3) {
			if (matchAlphaRgb(g[i], g[i + 1], g[i + 2], target, e0, fd, sA, sB) > 0.5) kept++;
		}
		return n ? kept / n : 0;
	}

	/** The color to open the editor with — prominent, colorful, and readable. */
	suggestedAccent(): Rgb {
		return suggestedAccent(this.palette);
	}
}

function fit(
	source: PixelSource,
	maxEdge: number
): { ctx: CanvasRenderingContext2D; w: number; h: number } {
	const long = Math.max(source.width, source.height);
	const scale = Math.min(1, maxEdge / long);
	const w = Math.max(2, Math.round(source.width * scale));
	const h = Math.max(2, Math.round(source.height * scale));
	const c = document.createElement('canvas');
	c.width = w;
	c.height = h;
	const ctx = c.getContext('2d', { willReadFrequently: true });
	if (!ctx) throw new Error('2D canvas unsupported');
	ctx.drawImage(source, 0, 0, w, h);
	return { ctx, w, h };
}

// --- showcase accents -----------------------------------------------------

const hueOf = ({ r, g, b }: Rgb): number => {
	const mx = Math.max(r, g, b);
	const mn = Math.min(r, g, b);
	if (mx === mn) return -1;
	const d = mx - mn;
	let h;
	if (mx === r) h = ((g - b) / d) % 6;
	else if (mx === g) h = (b - r) / d + 2;
	else h = (r - g) / d + 4;
	h *= 60;
	return h < 0 ? h + 360 : h;
};

const satOf = ({ r, g, b }: Rgb): number => {
	const mx = Math.max(r, g, b);
	const mn = Math.min(r, g, b);
	return mx === 0 ? 0 : (mx - mn) / mx;
};

/** One palette entry scored for the accent pick. */
interface Scored {
	c: Rgb;
	h: number;
	s: number;
	l: number;
}

/** The four showcase accents, keyed for the dictionary. */
export type AccentKey = 'petals' | 'leaves' | 'sky' | 'shade';

export interface ShowcaseAccent {
	key: AccentKey;
	rgb: Rgb;
}

/**
 * Four accents read out of the photo itself: the strongest warm hue, the
 * strongest green, the strongest cool, and the deepest shadow. Labels come
 * from the dictionary, so the keys are stable.
 */
export function showcaseAccents(palette: Rgb[]): ShowcaseAccent[] {
	const scored: Scored[] = palette.map((c) => ({ c, h: hueOf(c), s: satOf(c), l: (c.r + c.g + c.b) / 765 }));
	const best = (pred: (h: number) => boolean) =>
		scored
			.filter((e) => e.h >= 0 && pred(e.h))
			.sort((a, b) => b.s - a.s)[0];

	const warm = best((h) => h < 70 || h >= 320);
	const green = best((h) => h >= 70 && h < 170);
	const cool = best((h) => h >= 170 && h < 320);
	const shade = scored.filter((e) => e.l < 0.45).sort((a, b) => a.l - b.l)[0];

	const picks: { key: AccentKey; entry: Scored | undefined }[] = [
		{ key: 'petals', entry: warm || scored[0] },
		{ key: 'leaves', entry: green || scored[1] },
		{ key: 'sky', entry: cool || scored[2] },
		{ key: 'shade', entry: shade || scored[3] }
	];

	// Guarantee four distinct swatches even on a monochrome photo.
	const seen = new Set<string>();
	return picks.map((p, i) => {
		let rgb = p.entry?.c || palette[i] || { r: 252, g: 192, b: 0 };
		while (seen.has(rgbToHex(rgb)) && palette.length) {
			rgb = palette[(i + seen.size + 1) % palette.length];
		}
		seen.add(rgbToHex(rgb));
		return { key: p.key, rgb };
	});
}
