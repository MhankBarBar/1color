// Tests for the parts of the export path that are pure logic: output geometry,
// frame selection, and region hit-testing. The pixel composition itself needs a
// canvas and is verified by running the app.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { outputSize, frameHexFor, framePad, RATIOS } from './export.js';
import { makeShape, shapeHitTest, SHAPE_MIN } from './mask.js';
import { dict, locales } from './i18n.js';

const approx = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;

// --- output geometry -------------------------------------------------------

test('output keeps the requested aspect ratio', () => {
	for (const r of RATIOS) {
		const { w, h } = outputSize(4000, 3000, r.id, 'max');
		const want = r.w ? r.w / r.h : 4000 / 3000;
		assert.ok(
			approx(w / h, want, 0.02),
			`${r.id}: got ${w}x${h} (${(w / h).toFixed(3)}), want ${want.toFixed(3)}`
		);
	}
});

test('output never exceeds the source framing', () => {
	// A 16:9 request on a portrait source must letterbox inside it, not stretch.
	const { w, h } = outputSize(1000, 2000, '16:9', 'max');
	assert.ok(w <= 1000 && h <= 2000, `got ${w}x${h}`);
	assert.ok(approx(w / h, 16 / 9, 0.02));
});

test('quality caps the long edge, and max does not', () => {
	const std = outputSize(6000, 4000, 'original', 'std');
	assert.equal(Math.max(std.w, std.h), 2048);

	const max = outputSize(6000, 4000, 'original', 'max');
	assert.equal(max.w, 6000);
	assert.ok(Math.max(max.w, max.h) > 2048);
});

test('standard quality never upscales a small photo', () => {
	const { w, h } = outputSize(800, 600, 'original', 'std');
	assert.equal(w, 800);
	assert.equal(h, 600);
});

test('degenerate dimensions still produce a drawable size', () => {
	const { w, h } = outputSize(1, 1, 'original', 'std');
	assert.ok(w >= 2 && h >= 2, `got ${w}x${h}`);
});

// --- frame -----------------------------------------------------------------

test('each frame mode resolves to its fill, and none resolves to null', () => {
	assert.equal(frameHexFor('none', '#FCC000'), null);
	assert.equal(frameHexFor('white', '#FCC000'), '#F6F6F8');
	assert.equal(frameHexFor('black', '#FCC000'), '#08080A');
	assert.equal(frameHexFor('accent', '#FCC000'), '#FCC000');
	assert.equal(frameHexFor('custom', '#FCC000', '#123456'), '#123456');
	// Custom without a color falls back to the accent rather than rendering nothing.
	assert.equal(frameHexFor('custom', '#FCC000', null), '#FCC000');
});

test('frame padding grows with the margin and stays within the frame', () => {
	assert.equal(framePad(0), 0);
	assert.ok(framePad(50) > framePad(10));
	assert.ok(framePad(100) < 0.5, 'padding must leave the photo the majority of the frame');
});

test('preview and export agree on the framed aspect ratio', () => {
	// The stage preview and the export derive padding from the same helper; if
	// they drifted, the preview would not match the saved file.
	const w = 1200;
	const h = 800;
	const pad = framePad(60) * Math.min(w, h);
	const preview = (w + pad * 2) / (h + pad * 2);

	const { w: ow, h: oh } = outputSize(w, h, 'original', 'max');
	const outPad = framePad(60) * Math.min(ow, oh);
	const exported = (ow + outPad * 2) / (oh + outPad * 2);

	assert.ok(approx(preview, exported, 1e-9), `${preview} vs ${exported}`);
});

// --- region shapes ---------------------------------------------------------

test('a shape contains its centre and excludes the far corner', () => {
	const s = makeShape('circle', 0.5, 0.5);
	assert.ok(shapeHitTest(s, 0.5, 0.5) < 1, 'centre should be inside');
	assert.ok(shapeHitTest(s, 0.99, 0.99) > 1, 'far corner should be outside');
});

test('circle and square differ where they should', () => {
	const c = makeShape('circle', 0.5, 0.5);
	const r = makeShape('rect', 0.5, 0.5);
	// The diagonal corner region of the bounding box: inside a square, outside a
	// circle. (A point on the box edge at the centre axis is on the circle, so it
	// would not distinguish them.)
	const x = 0.5 + 0.75 * (c.w / 2);
	const y = 0.5 - 0.75 * (c.h / 2);
	assert.ok(shapeHitTest(c, x, y) > 1, 'circle should exclude its bounding corner');
	assert.ok(shapeHitTest(r, x, y) < 1, 'square should include that point');
});

test('hit-testing follows rotation', () => {
	const s = { ...makeShape('rect', 0.5, 0.5), w: 0.6, h: 0.1, rot: Math.PI / 2 };
	// Rotated 90 degrees, the shape is now tall: a point above the centre is in.
	assert.ok(shapeHitTest(s, 0.5, 0.5 - 0.2) < 1, 'point along the rotated long axis');
	assert.ok(shapeHitTest(s, 0.5 + 0.2, 0.5) > 1, 'point along the rotated short axis');
});

test('a shape never shrinks below the minimum size', () => {
	assert.ok(SHAPE_MIN > 0);
	const s = makeShape('circle');
	assert.ok(s.w >= SHAPE_MIN && s.h >= SHAPE_MIN);
});

// --- localization ----------------------------------------------------------

test('every locale defines every key, and no locale has stray keys', () => {
	const base = Object.keys(dict.en).sort();
	assert.ok(base.length > 50, 'dictionary looks truncated');

	for (const l of locales) {
		const keys = Object.keys(dict[l.id] || {}).sort();
		const missing = base.filter((k) => !keys.includes(k));
		const extra = keys.filter((k) => !base.includes(k));
		assert.deepEqual(missing, [], `${l.id} is missing keys`);
		assert.deepEqual(extra, [], `${l.id} has keys English does not`);
	}
});

test('no string is left as a raw key or empty', () => {
	for (const l of locales) {
		for (const [k, v] of Object.entries(dict[l.id])) {
			assert.equal(typeof v, 'string', `${l.id}.${k} is not a string`);
			assert.ok(v.trim().length > 0, `${l.id}.${k} is empty`);
			assert.notEqual(v, k, `${l.id}.${k} was never translated`);
		}
	}
});

test('Japanese strings are actually Japanese where prose is expected', () => {
	// Labels like "EN" or "1:1" are fine untranslated; sentences must not be.
	const proseKeys = ['hero.sub', 'stage.drop', 'live.privacy', 'out.reset'];
	for (const k of proseKeys) {
		assert.ok(/[\u3040-\u30ff\u4e00-\u9faf]/.test(dict.ja[k]), `ja.${k} has no Japanese`);
	}
});
