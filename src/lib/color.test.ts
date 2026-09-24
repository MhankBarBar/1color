// Regression tests for the color matcher.
//
// The invariant that matters: color.ts is the CPU mirror of the fragment shader
// in gl.ts, and the two are edited independently. If they drift, the coverage
// readout and the pixels disagree — a real bug this file exists to catch.
//
//   npm test
//
// The shader functions are transcribed here rather than imported (GLSL is not
// TS), so when you change gl.ts, change the transcription too.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	hexToRgb,
	rgbToHex,
	inkOn,
	contrastRatio,
	matchAlpha,
	matchAlphaRgb,
	accentDistance,
	widthToDist,
	featherToDist,
	paletteFromImageData,
	suggestedAccent
} from './color.js';
import type { Hsv, Rgb } from './types.js';

// --- transcription of the fragment shader ---------------------------------

const toLin = (v: number): number => {
	v /= 255;
	return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

function shaderHsv(c: Rgb): Hsv {
	const R = toLin(c.r);
	const G = toLin(c.g);
	const B = toLin(c.b);
	const mx = Math.max(R, G, B);
	const mn = Math.min(R, G, B);
	const d = mx - mn;
	const s = mx <= 0 ? 0 : d / mx;
	let h = 0;
	if (d > 0) {
		if (mx === R) h = ((G - B) / d) % 6;
		else if (mx === G) h = (B - R) / d + 2;
		else h = (R - G) / d + 4;
		h /= 6;
		if (h < 0) h += 1;
	}
	return { h, s, v: mx, d };
}

const sstep = (e0: number, e1: number, x: number): number => {
	const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
	return t * t * (3 - 2 * t);
};

function shaderDist(a: Rgb, b: Rgb): number {
	const A = shaderHsv(a);
	const B = shaderHsv(b);
	if (B.s < 0.15) return Math.min(1, Math.abs(A.v - B.v) * 1.6);
	const gate = sstep(0.04, 0.25, Math.min(A.s, B.s));
	let dh = Math.abs(A.h - B.h);
	if (dh > 0.5) dh = 1 - dh;
	return Math.max(dh * 2, 1 - gate);
}

function shaderKeep(px: Rgb, target: Rgb, width: number, feather: number): number {
	const dist = shaderDist(px, target);
	const e0 = 0.015 + (width / 100) * 0.3;
	const e1 = e0 + Math.max((feather / 100) * 0.16, 0.0001);
	return 1 - sstep(e0, e1, dist);
}

const GOLD: Rgb = { r: 255, g: 192, b: 0 };

/** HSL-style wheel sample, so tests can sweep real hues rather than guess RGB. */
function hsl(h: number, s: number, l: number): Rgb {
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
	const m = l - c / 2;
	const t: [number, number, number] =
		h < 60
			? [c, x, 0]
			: h < 120
				? [x, c, 0]
				: h < 180
					? [0, c, x]
					: h < 240
						? [0, x, c]
						: h < 300
							? [x, 0, c]
							: [c, 0, x];
	return {
		r: Math.round((t[0] + m) * 255),
		g: Math.round((t[1] + m) * 255),
		b: Math.round((t[2] + m) * 255)
	};
}

// --- CPU / GPU lockstep ----------------------------------------------------

test('matchAlpha agrees with the shader keep value', () => {
	const cases: [Rgb, Rgb, number, number][] = [
		[GOLD, GOLD, 30, 40],
		[{ r: 120, g: 95, b: 12 }, GOLD, 30, 40],
		[{ r: 255, g: 230, b: 120 }, GOLD, 30, 40],
		[{ r: 20, g: 20, b: 25 }, GOLD, 30, 40],
		[{ r: 30, g: 120, b: 60 }, GOLD, 80, 70],
		[{ r: 0, g: 0, b: 0 }, GOLD, 50, 50],
		[{ r: 255, g: 255, b: 255 }, GOLD, 50, 50],
		[{ r: 200, g: 40, b: 160 }, GOLD, 100, 0]
	];
	for (const [px, target, w, f] of cases) {
		assert.ok(
			Math.abs(shaderKeep(px, target, w, f) - matchAlpha(px, target, w, f)) < 1e-12,
			`keep mismatch for rgb(${px.r},${px.g},${px.b}) at width ${w}`
		);
	}
});

test('accentDistance agrees with the shader distance', () => {
	for (const c of [
		{ r: 120, g: 95, b: 12 },
		{ r: 255, g: 230, b: 120 },
		{ r: 40, g: 90, b: 200 },
		{ r: 150, g: 150, b: 155 },
		{ r: 0, g: 0, b: 0 },
		{ r: 255, g: 255, b: 255 },
		{ r: 200, g: 40, b: 160 }
	]) {
		assert.ok(
			Math.abs(shaderDist(c, GOLD) - accentDistance(c, GOLD)) < 1e-12,
			`distance mismatch for rgb(${c.r},${c.g},${c.b})`
		);
	}
});

// --- the behavior the app is named for -------------------------------------

test('one hue family survives across the whole exposure range', () => {
	// A sunflower lit, mid, and in shadow must all keep their color. This is the
	// reason the matcher works in linear-light hue rather than RGB distance.
	const exposure = [0.95, 0.8, 0.6, 0.4, 0.25, 0.12, 0.05];
	for (const l of exposure) {
		const c = hsl(43, 0.95, l);
		assert.ok(
			matchAlpha(c, GOLD, 30, 40) > 0.5,
			`rgb(${c.r},${c.g},${c.b}) at lightness ${l} was dropped`
		);
	}
});

test('unrelated hues and neutrals drop at the default width', () => {
	const rejects = [
		hsl(140, 0.6, 0.4), // green
		hsl(210, 0.7, 0.5), // blue
		hsl(180, 0.8, 0.4), // cyan
		hsl(280, 0.6, 0.5), // violet
		{ r: 150, g: 150, b: 155 }, // gray
		{ r: 250, g: 250, b: 250 }, // white
		{ r: 12, g: 12, b: 14 } // black
	];
	for (const c of rejects) {
		assert.ok(
			matchAlpha(c, GOLD, 30, 40) < 0.5,
			`rgb(${c.r},${c.g},${c.b}) should not have been kept`
		);
	}
});

test('widening the range admits neighbouring hues', () => {
	const red = hsl(0, 0.85, 0.5);
	assert.ok(matchAlpha(red, GOLD, 30, 40) < 0.5, 'red kept at the narrow default');
	assert.ok(matchAlpha(red, GOLD, 100, 40) > 0.5, 'red not admitted at width 100');
});

test('a neutral target matches brightness instead of hue', () => {
	const sky = { r: 150, g: 150, b: 155 };
	assert.ok(matchAlpha({ r: 140, g: 140, b: 145 }, sky, 30, 40) > 0.5, 'nearby gray dropped');
	assert.ok(matchAlpha({ r: 250, g: 250, b: 250 }, sky, 30, 40) < 0.5, 'white kept');
	assert.ok(matchAlpha({ r: 12, g: 12, b: 14 }, sky, 30, 40) < 0.5, 'black kept');
	assert.ok(matchAlpha(GOLD, sky, 30, 40) < 0.5, 'saturated color kept by a gray target');
});

// --- control response ------------------------------------------------------

test('kept coverage rises monotonically with the range slider', () => {
	const scene: Rgb[] = [];
	for (let h = 0; h < 360; h += 6) scene.push(hsl(h, 0.7, 0.5));
	scene.push({ r: 128, g: 128, b: 128 });

	const coverage = (w: number): number =>
		scene.filter((c) => matchAlpha(c, GOLD, w, 40) > 0.5).length / scene.length;

	const narrow = coverage(20);
	const mid = coverage(50);
	const wide = coverage(100);
	assert.ok(narrow < mid && mid < wide, `not increasing: ${narrow} ${mid} ${wide}`);
	assert.ok(narrow > 0.02 && wide < 0.95, `window is degenerate: ${narrow} .. ${wide}`);
});

test('feather softens the edge without touching the core', () => {
	assert.equal(matchAlpha(GOLD, GOLD, 40, 0), 1);
	assert.equal(matchAlpha(GOLD, GOLD, 40, 100), 1);
	assert.ok(featherToDist(60) > featherToDist(10));
	assert.ok(widthToDist(0) < widthToDist(100));
});

// --- utility ---------------------------------------------------------------

test('hex parsing round-trips, including the short form', () => {
	assert.equal(rgbToHex(hexToRgb('#FCC000')), '#FCC000');
	assert.equal(rgbToHex(hexToRgb('#0AF')), '#00AAFF');
	assert.equal(rgbToHex(hexToRgb('fcc000')), '#FCC000');
});

test('inkOn picks the readable ink for a background', () => {
	assert.equal(inkOn({ r: 252, g: 192, b: 0 }), '#08080A');
	assert.equal(inkOn({ r: 10, g: 20, b: 60 }), '#F6F6F8');
	// The UI leans on this for accent-colored buttons, so it has to clear AA.
	assert.ok(contrastRatio({ r: 252, g: 192, b: 0 }, { r: 8, g: 8, b: 10 }) >= 4.5);
});

test('palette ranks the dominant color first and stays distinct', () => {
	const n = 64;
	const data = new Uint8ClampedArray(n * n * 4);
	for (let i = 0; i < n * n; i++) {
		const majority = i < n * n * 0.6;
		data[i * 4] = majority ? 250 : 20;
		data[i * 4 + 1] = majority ? 200 : 30;
		data[i * 4 + 2] = majority ? 30 : 180;
		data[i * 4 + 3] = 255;
	}
	const pal = paletteFromImageData(data, 6);
	assert.ok(pal.length >= 2, 'expected two distinct colors');
	assert.ok(pal[0].r > 200 && pal[0].g > 150, 'majority color was not ranked first');
});

test('near-black shadows do not outrank real color', () => {
	// Regression: rgb(4,2,1) reports ~83% saturation while being visually black.
	// Scoring on saturation ratio let shadow buckets dominate any real photo.
	const n = 64;
	const data = new Uint8ClampedArray(n * n * 4);
	for (let i = 0; i < n * n; i++) {
		const shadow = i < n * n * 0.55; // the shadows are the single largest region
		data[i * 4] = shadow ? 4 : 252;
		data[i * 4 + 1] = shadow ? 2 : 204;
		data[i * 4 + 2] = shadow ? 1 : 3;
		data[i * 4 + 3] = 255;
	}
	const pal = paletteFromImageData(data, 6);
	assert.ok(
		pal[0].r > 200 && pal[0].g > 150,
		`shadow outranked the yellow: got ${JSON.stringify(pal[0])}`
	);
});

test('suggestedAccent skips near-black and washed-out colors', () => {
	const palette: Rgb[] = [
		{ r: 4, g: 2, b: 1 }, // shadow, most common
		{ r: 250, g: 250, b: 248 }, // blown highlight
		{ r: 240, g: 186, b: 20 } // the actual subject
	];
	const pick = suggestedAccent(palette);
	assert.deepEqual(pick, { r: 240, g: 186, b: 20 });

	// A genuinely monochrome photo still needs something to open with.
	const mono: Rgb[] = [
		{ r: 4, g: 2, b: 1 },
		{ r: 128, g: 128, b: 130 }
	];
	assert.deepEqual(suggestedAccent(mono), { r: 4, g: 2, b: 1 });
});

test('matchAlphaRgb agrees with matchAlpha', () => {
	// The numeric path exists for speed; it must not drift from the readable one.
	const cases: [Rgb, Rgb, number, number][] = [
		[{ r: 252, g: 192, b: 0 }, { r: 252, g: 192, b: 0 }, 30, 40],
		[{ r: 120, g: 95, b: 12 }, { r: 252, g: 192, b: 0 }, 30, 40],
		[{ r: 30, g: 120, b: 60 }, { r: 252, g: 192, b: 0 }, 80, 10],
		[{ r: 150, g: 150, b: 155 }, { r: 150, g: 150, b: 155 }, 30, 40],
		[{ r: 250, g: 250, b: 250 }, { r: 150, g: 150, b: 155 }, 0, 0]
	];
	for (const [px, target, w, f] of cases) {
		const a = matchAlpha(px, target, w, f);
		const b = matchAlphaRgb(px.r, px.g, px.b, target, widthToDist(w), featherToDist(f));
		assert.ok(Math.abs(a - b) < 1e-12, `drift at width ${w} feather ${f}: ${a} vs ${b}`);
	}
});

test('reused scratch records do not leak state between samples', () => {
	// The coverage scan passes two records that are written on every iteration.
	// If a field were left stale, one pixel's result would depend on the previous.
	const sA: Hsv = { h: 0, s: 0, v: 0, d: 0 };
	const sB: Hsv = { h: 0, s: 0, v: 0, d: 0 };
	const target = { r: 252, g: 192, b: 0 };
	const e0 = widthToDist(30);
	const fd = featherToDist(40);

	const px: [number, number, number][] = [
		[252, 192, 0],
		[30, 120, 60],
		[120, 95, 12],
		[30, 120, 60]
	];

	const withScratch = px.map((p) => matchAlphaRgb(p[0], p[1], p[2], target, e0, fd, sA, sB));
	const fresh = px.map((p) => matchAlphaRgb(p[0], p[1], p[2], target, e0, fd));
	assert.deepEqual(withScratch, fresh);

	// Re-running the same sequence must give identical output.
	const again = px.map((p) => matchAlphaRgb(p[0], p[1], p[2], target, e0, fd, sA, sB));
	assert.deepEqual(again, withScratch);
});

test('coverage from a 2D grid tracks the true figure', () => {
	// Regression: a linear stride aliased against repeating detail. On a synthetic
	// field of vertical stripes a stride of 3 reported ~3x the true coverage,
	// because every third pixel landed on the same phase.
	const W = 240;
	const H = 240;
	const data = new Uint8ClampedArray(W * H * 4);
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			const o = (y * W + x) * 4;
			// Vertical stripes of the kept hue against an unrelated hue.
			const kept = x % 3 === 0;
			data[o] = kept ? 252 : 30;
			data[o + 1] = kept ? 192 : 120;
			data[o + 2] = kept ? 0 : 60;
			data[o + 3] = 255;
		}
	}

	const target = { r: 252, g: 192, b: 0 };
	const e0 = widthToDist(30);
	const fd = featherToDist(40);
	const sA: Hsv = { h: 0, s: 0, v: 0, d: 0 };
	const sB: Hsv = { h: 0, s: 0, v: 0, d: 0 };

	let kept = 0;
	for (let i = 0; i < W * H; i++) {
		const o = i * 4;
		if (matchAlphaRgb(data[o], data[o + 1], data[o + 2], target, e0, fd, sA, sB) > 0.5) kept++;
	}
	const truth = kept / (W * H);

	// The low-discrepancy sampler the app uses (mirrors coverGrid in analysis.ts).
	const grid = 80;
	const n = grid * grid;
	const GOLDEN = 0.6180339887498949;
	let gKept = 0;
	for (let k = 0; k < n; k++) {
		const fx = (k * GOLDEN) % 1;
		const fy = (k + 0.5) / n;
		const sx = Math.min(W - 1, (fx * W) | 0);
		const sy = Math.min(H - 1, (fy * H) | 0);
		const o = (sy * W + sx) * 4;
		if (matchAlphaRgb(data[o], data[o + 1], data[o + 2], target, e0, fd, sA, sB) > 0.5) gKept++;
	}
	const est = gKept / (grid * grid);

	assert.ok(
		Math.abs(est - truth) < 0.05,
		`grid coverage ${est.toFixed(3)} drifted from truth ${truth.toFixed(3)}`
	);

	// And demonstrate the aliasing the grid avoids: a linear stride lands on one
	// stripe phase and reports far too much.
	let strideKept = 0;
	let strideN = 0;
	for (let i = 0; i < W * H; i += 3) {
		const o = i * 4;
		strideN++;
		if (matchAlphaRgb(data[o], data[o + 1], data[o + 2], target, e0, fd, sA, sB) > 0.5) strideKept++;
	}
	const strideEst = strideKept / strideN;
	assert.ok(
		Math.abs(strideEst - truth) > 0.2,
		'expected the stride sampler to alias badly on this pattern'
	);
});
