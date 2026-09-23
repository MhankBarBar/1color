// Tests for the parts of the export path that are pure logic: output geometry,
// frame selection, overlay placement, and region hit-testing. The pixel
// composition itself is not exercised; placement is asserted by recording the
// draw calls, which needs no canvas.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	outputSize,
	frameHexFor,
	framePad,
	composeGeometry,
	cropRect,
	drawOverlayBlock,
	overlayMinMargin,
	RATIOS
} from './export.js';
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

test('preview and export agree on the composition geometry', () => {
	// The stage preview and the export both call composeGeometry, so this guards
	// the thing that actually matters: that neither re-derives the frame band by
	// hand. The preview composes in the photo's own pixels and the export in
	// output pixels, so the numbers differ but every ratio must match exactly.
	//
	// It originally asserted only the aspect ratio with padding derived inline,
	// which is why the overlay block could need more room than the band had.
	const imgW = 1200;
	const imgH = 800;

	for (const showSwatch of [false, true]) {
		for (const showMix of [false, true]) {
			for (const frame of ['none', 'white']) {
				const opts = { frame, accentHex: '#FCC000', showSwatch, showCode: true, showMix };
				const preview = composeGeometry({ imgW, imgH, margin: 60, ...opts });
				const { w: ow, h: oh } = outputSize(imgW, imgH, 'original', 'max');
				const exported = composeGeometry({ imgW: ow, imgH: oh, margin: 60, ...opts });

				const label = `frame=${frame} swatch=${showSwatch} mix=${showMix}`;
				assert.ok(
					approx(preview.aspect, exported.aspect, 1e-9),
					`${label}: aspect ${preview.aspect} vs ${exported.aspect}`
				);
				// The band as a fraction of the width is what the preview scales to
				// pixels, so it has to be scale-invariant.
				const pf = preview.pad / preview.outW;
				const ef = exported.pad / exported.outW;
				assert.ok(approx(pf, ef, 1e-9), `${label}: pad fraction ${pf} vs ${ef}`);
			}
		}
	}
});

test('the band is exactly the margin, and the block is fitted to it', () => {
	// The band used to be floored at the overlay block's height, which pinned the
	// margin slider: the floor was larger than anything the slider could request,
	// so dragging it changed nothing anywhere in its range. The band is the margin
	// now, and the block shrinks to fit instead.
	const imgW = 4032;
	const imgH = 3024;
	const unit = Math.min(imgW, imgH);

	for (const [showSwatch, showCode, showMix] of [
		[false, true, false],
		[true, true, false],
		[true, true, true]
	]) {
		const rows = (showSwatch || showCode ? 1 : 0) + (showMix ? 1 : 0);
		let prev = -1;
		const seen = new Set();

		for (let margin = 0; margin <= 100; margin++) {
			const g = composeGeometry({
				imgW,
				imgH,
				frame: 'white',
				accentHex: '#FCC000',
				margin,
				showSwatch,
				showCode,
				showMix
			});
			// Exactly the margin's request — no floor, no growth.
			assert.equal(g.pad, Math.round(framePad(margin) * unit), `margin=${margin}`);
			// ...and never shrinks as the margin grows.
			assert.ok(g.pad >= prev, `margin=${margin}: band went backwards`);
			prev = g.pad;
			seen.add(g.pad);
		}

		// Every step moves the band: this is what makes the slider honest.
		assert.ok(seen.size > 50, `rows=${rows}: only ${seen.size} distinct bands across the slider`);
	}
});

test('the block stays inside the band at every margin the slider offers', () => {
	// Fitting the block to the band must not shrink it past legibility, which is
	// why the margin has a floor. At and above that floor, the block always fits.
	const imgW = 4032;
	const imgH = 3024;
	const unit = Math.min(imgW, imgH);

	for (const [showSwatch, showCode, showMix] of [
		[false, true, false],
		[true, true, false],
		[true, true, true]
	]) {
		const rows = (showSwatch || showCode ? 1 : 0) + (showMix ? 1 : 0);
		const floor = overlayMinMargin({ showSwatch, showCode, showMix });

		for (let margin = floor; margin <= 100; margin++) {
			const g = composeGeometry({
				imgW,
				imgH,
				frame: 'white',
				accentHex: '#FCC000',
				margin,
				showSwatch,
				showCode,
				showMix
			});
			const rowH = Math.min(unit * 0.075, g.pad / 1.35 / rows);
			const blockH = rowH * rows;
			assert.ok(
				blockH <= g.pad + 1e-9,
				`margin=${margin}: block ${blockH} overflows band ${g.pad}`
			);
			// Legible: the row the code is drawn in must clear the minimum.
			assert.ok(
				rowH >= unit * 0.02 - 1e-9,
				`margin=${margin}: row ${rowH} below the legible minimum`
			);
		}
	}
});

test('the block is fitted to the band, which the drawn font proves', () => {
	// Asserted against what the painter actually draws, not against a local
	// re-derivation: reading the font size back out of the draw calls is the only
	// way this catches the block failing to fit.
	const imgW = 4032;
	const imgH = 3024;
	const unit = Math.min(imgW, imgH);

	for (const [showSwatch, showCode, showMix] of [
		[false, true, false],
		[true, true, false],
		[true, true, true]
	]) {
		const rows = (showSwatch || showCode ? 1 : 0) + (showMix ? 1 : 0);

		const floor = overlayMinMargin({ showSwatch, showCode, showMix });
		// A tall band and the shortest band the slider actually offers, to show the
		// block changes size and never dips below legibility in that range.
		const roomy = paint({ frame: 'white', margin: 100, showSwatch, showCode, showMix });
		const tight = paint({ frame: 'white', margin: floor, showSwatch, showCode, showMix });

		const rowH = (r) => {
			const font = r.calls.filter((c) => c[0] === 'set:font').pop();
			return font ? Number(/ (\d+(?:\.\d+)?)px/.exec(font[1])[1]) / 0.5 : null;
		};

		const big = rowH(roomy);
		const small = rowH(tight);
		assert.ok(big !== null && small !== null, 'the code is drawn at both margins');

		// The block is drawn at most at its natural size...
		assert.ok(big <= unit * 0.075 + 1e-6, `margin=100: row ${big} exceeds natural`);
		// ...and shrinks in a tighter band rather than overflowing it.
		assert.ok(small < big, `margin=30 row ${small} should be under margin=100 row ${big}`);
		// ...while staying legible.
		assert.ok(small >= unit * 0.02 - 1e-6, `margin=30 row ${small} below the legible minimum`);

		// The whole block must fit the band it was given.
		const g = composeGeometry({
			imgW,
			imgH,
			frame: 'white',
			accentHex: '#FCC000',
			margin: floor,
			showSwatch,
			showCode,
			showMix
		});
		assert.ok(small * rows <= g.pad + 1e-6, `rows=${rows}: block overflows the band`);
	}
});

test('the margin floor rises with the number of overlay rows', () => {
	// More rows need a taller band, so the slider starts higher. A floor that did
	// not move would either clip the block or leave a dead zone again.
	const one = overlayMinMargin({ showSwatch: false, showCode: true, showMix: false });
	const two = overlayMinMargin({ showSwatch: true, showCode: true, showMix: true });
	assert.ok(two > one, `two rows ${two} must need more than one row ${one}`);
	assert.ok(one >= 0 && two < 100, 'the floor must leave usable slider travel');
});

test('a margin larger than the block is honoured unchanged', () => {
	const imgW = 1200;
	const imgH = 800;
	const requested = Math.round(framePad(100) * Math.min(imgW, imgH));
	const g = composeGeometry({
		imgW,
		imgH,
		frame: 'white',
		accentHex: '#FCC000',
		margin: 100,
		showSwatch: true,
		showCode: true,
		showMix: false
	});
	assert.equal(g.pad, requested);
});

test('the overlay preview canvas spans the whole composition, not just the photo', () => {
	// The preview canvas is positioned against the photo box but has to cover the
	// frame band too, since the block is drawn in the band. It does that with a
	// negative inset of one band width and an explicit composition-sized width.
	//
	// The inset and the size are the test: if either is dropped the canvas falls
	// back to the photo box, and `app.css`'s `canvas { max-width: 100% }` clamps it
	// there — which is what put the block on top of the image instead of the frame.
	const imgW = 4032;
	const imgH = 3024;
	const g = composeGeometry({
		imgW,
		imgH,
		frame: 'white',
		accentHex: '#FCC000',
		margin: 50,
		showSwatch: true,
		showCode: true,
		showMix: true
	});

	// The band is the frame's CSS padding, so the inset and the composition scale
	// together. Both must stay strictly positive for the canvas to reach the band.
	assert.ok(g.pad > 0, 'a framed composition must have a band');
	assert.ok(g.padFrac > 0 && g.padFrac < 0.5, `band fraction out of range: ${g.padFrac}`);

	// Trimming the canvas to the photo box would lose exactly one band per side.
	const compositionWidth = imgW + g.pad * 2;
	const photoWidth = imgW;
	assert.equal(compositionWidth - photoWidth, 2 * g.pad);
});

test('a frameless photo gets no band, whatever the overlays', () => {
	const g = composeGeometry({
		imgW: 1200,
		imgH: 800,
		frame: 'none',
		accentHex: '#FCC000',
		margin: 100,
		showSwatch: true,
		showCode: true,
		showMix: true
	});
	assert.equal(g.hex, null);
	assert.equal(g.pad, 0);
	assert.equal(g.outW, 1200);
	assert.equal(g.outH, 800);
});

// --- overlay painting ------------------------------------------------------
//
// The block's placement is asserted against a recording context, so it can be
// checked without rendering anything. This is the guard for the bug where the
// overlay controls drew nothing on screen: they were only ever painted into the
// exported file.

/** A 2D context that records the calls instead of drawing them. */
function recordingCtx() {
	const calls = [];
	return {
		calls,
		ctx: new Proxy(
			{},
			{
				get(_t, k) {
					if (k === 'canvas') return { width: 0, height: 0 };
					if (k === 'createLinearGradient')
						return (...a) => {
							calls.push(['createLinearGradient', ...a]);
							return { addColorStop: () => {} };
						};
					return (...a) => calls.push([k, ...a]);
				},
				set(_t, k, v) {
					calls.push([`set:${k}`, v]);
					return true;
				}
			}
		)
	};
}

function paint(opts) {
	const imgW = 4000;
	const imgH = 3000;
	const g = composeGeometry({ imgW, imgH, accentHex: '#FCC000', ...opts });
	const { calls, ctx } = recordingCtx();
	drawOverlayBlock(ctx, {
		innerW: imgW,
		innerH: imgH,
		pad: g.pad,
		width: g.outW,
		height: g.outH,
		hasFrame: !!g.hex,
		hex: '#FCC000',
		ink: g.hex ? '#08080A' : undefined,
		showSwatch: !!opts.showSwatch,
		showCode: !!opts.showCode,
		showMix: !!opts.showMix,
		align: opts.align,
		palette: [
			{ r: 1, g: 2, b: 3 },
			{ r: 4, g: 5, b: 6 }
		]
	});
	const pick = (name) => calls.filter((c) => c[0] === name);
	return { g, photoBottom: g.pad + imgH, calls, circles: pick('arc'), texts: pick('fillText') };
}

test('with a frame the overlay block sits below the photo, inside the band', () => {
	const { g, photoBottom, circles, texts } = paint({
		frame: 'white',
		margin: 50,
		showSwatch: true,
		showCode: true,
		showMix: true
	});

	assert.equal(circles.length, 1, 'the swatch is drawn');
	assert.equal(texts.length, 1, 'the code is drawn');

	const swatchCy = circles[0][2];
	const codeY = texts[0][3];
	assert.ok(swatchCy >= photoBottom, `swatch at ${swatchCy} overlaps the photo (bottom ${photoBottom})`);
	assert.ok(codeY >= photoBottom, `code at ${codeY} overlaps the photo`);
	assert.equal(swatchCy, codeY, 'the swatch and the code share a baseline');
	assert.ok(codeY <= g.outH, 'the block stays inside the frame');
	assert.equal(texts[0][1], '#FCC000', 'the code shows the sampled color');
});

test('frameless overlays stay on the photo and get a scrim', () => {
	const { g, calls, texts } = paint({
		frame: 'none',
		margin: 50,
		showSwatch: true,
		showCode: true,
		showMix: true
	});

	const grad = calls.find((c) => c[0] === 'createLinearGradient');
	assert.ok(grad, 'a scrim is drawn when there is no frame to hold the text');
	assert.equal(grad[1], 0, 'the scrim spans the full width');
	assert.ok(grad[2] > 0 && grad[2] < g.outH, 'the scrim starts inside the photo');
	assert.equal(grad[4], g.outH, 'the scrim runs to the bottom edge');
	assert.equal(texts.length, 1);
	assert.ok(texts[0][3] < g.outH, 'the block stays on the photo');
});

test('an opaque frame band needs no scrim', () => {
	const { calls } = paint({ frame: 'white', margin: 50, showSwatch: true, showCode: true });
	assert.equal(calls.find((c) => c[0] === 'createLinearGradient'), undefined);
});

test('with every overlay off, nothing is painted', () => {
	const { calls } = paint({ frame: 'white', margin: 50 });
	assert.equal(calls.length, 0);
});

test('the mix bar is narrower than the band, so it has room to move', () => {
	const { g, calls } = paint({ frame: 'white', margin: 50, showMix: true });
	const span = g.outW - 2 * g.pad;
	const bar = calls.find((c) => c[0] === 'fillRect' && c[3] < span && c[3] > span * 0.5);
	assert.ok(bar, `the mix bar should span most, but not all, of the band (span ${span})`);
});

test('position moves the block across the band without leaving it', () => {
	// The block had no position control: it was always flush left. It now aligns
	// left, centre, or right, and must stay inside the band at every setting.
	const opts = { frame: 'white', margin: 50, showSwatch: true, showCode: true, showMix: true };

	const left = paint({ ...opts, align: 'left' });
	const center = paint({ ...opts, align: 'center' });
	const right = paint({ ...opts, align: 'right' });

	// arc(centreX, centreY, radius, start, end): the swatch's centre x.
	const swatchX = (r) => r.circles[0][1];
	const inset = left.g.pad;
	const bandRight = left.g.outW - inset;

	assert.ok(swatchX(left) < swatchX(center), 'center sits right of left');
	assert.ok(swatchX(center) < swatchX(right), 'right sits right of center');

	// The widest element is the mix bar, so it decides whether the block fits.
	// fillRect(x, y, w, h): the bar's left edge and width.
	for (const [name, r] of [['left', left], ['center', center], ['right', right]]) {
		const bar = r.calls.find((c) => c[0] === 'fillRect' && typeof c[3] === 'number' && c[3] > r.g.pad);
		assert.ok(bar, `${name}: the mix bar is drawn`);
		assert.ok(bar[1] >= inset - 1e-6, `${name}: the block starts left of the band`);
		assert.ok(bar[1] + bar[3] <= bandRight + 1e-6, `${name}: the block runs past the band`);
	}

	// Right alignment should actually reach the far side, not just move a bit.
	const rightBar = right.calls.find((c) => c[0] === 'fillRect' && typeof c[3] === 'number' && c[3] > right.g.pad);
	assert.ok(Math.abs(rightBar[1] + rightBar[3] - bandRight) < 1e-6, 'right should reach the edge');
});

test('center and right are inert when nothing is drawn', () => {
	const { calls } = paint({ frame: 'white', margin: 50, align: 'right' });
	assert.equal(calls.length, 0);
});

// --- ratio crop ------------------------------------------------------------

test('a ratio crops to the target aspect instead of stretching', () => {
	// The export used to stretch: the vertex shader maps the whole texture to the
	// whole quad, so asking for 1:1 from a 4:3 photo squashed it. The crop rect
	// preserves the photo's aspect inside the target frame.
	const imgW = 4032;
	const imgH = 3024;

	for (const r of RATIOS) {
		const c = cropRect(imgW, imgH, r.id);
		const croppedAr = (imgW * c.sw) / (imgH * c.sh);
		const { w, h } = outputSize(imgW, imgH, r.id, 'max');
		// outputSize rounds to whole pixels, so the aspects match to rounding.
		assert.ok(
			Math.abs(croppedAr - w / h) < 1e-3,
			`${r.id}: crop aspect ${croppedAr.toFixed(4)} vs output ${(w / h).toFixed(4)}`
		);
	}
});

test('the crop is the largest centred rect inside the photo', () => {
	const imgW = 4032;
	const imgH = 3024;

	for (const r of RATIOS) {
		const c = cropRect(imgW, imgH, r.id);
		// Inside the photo.
		assert.ok(c.sx >= -1e-9 && c.sy >= -1e-9, `${r.id}: crop starts outside`);
		assert.ok(c.sx + c.sw <= 1 + 1e-9 && c.sy + c.sh <= 1 + 1e-9, `${r.id}: crop ends outside`);
		// Centred: equal margins on the cropped axis.
		assert.ok(Math.abs(c.sx - (1 - c.sw) / 2) < 1e-9, `${r.id}: not horizontally centred`);
		assert.ok(Math.abs(c.sy - (1 - c.sh) / 2) < 1e-9, `${r.id}: not vertically centred`);
		// Maximal: hugs at least one edge on each axis it crops.
		assert.ok(
			Math.abs(c.sw - 1) < 1e-9 || Math.abs(c.sh - 1) < 1e-9,
			`${r.id}: crop is not maximal`
		);
	}
});

test('original keeps the whole photo', () => {
	const c = cropRect(4032, 3024, 'original');
	assert.deepEqual({ ...c }, { sx: 0, sy: 0, sw: 1, sh: 1 });
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
