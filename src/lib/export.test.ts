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
	exportComposite,
	MAX_EXPORT_EDGE,
	MAX_EXPORT_AREA,
	cropRect,
	drawOverlayBlock,
	overlayMinMargin,
	RATIOS,
	type ComposeInput
} from './export.js';
import { makeShape, shapeHitTest, SHAPE_MIN } from './mask.js';
import { dict, locales } from './i18n.js';
import type { Align, FrameId, Geometry, PixelSource, QualityId, Size } from './types.js';

const approx = (a: number, b: number, tol = 0.01): boolean => Math.abs(a - b) <= tol;

// --- a DOM just real enough to run the export ------------------------------

/** A canvas the export can draw on; only its size is meaningful. */
interface StubCanvas {
	width: number;
	height: number;
	getContext(id: string): unknown;
	toBlob(cb: (b: Blob | null) => void, type?: string): void;
}

const noop = (): void => {};

/** A 2D context that accepts every call and draws nothing. */
function stub2d(): unknown {
	return {
		fillStyle: '',
		strokeStyle: '',
		lineJoin: '',
		lineCap: '',
		lineWidth: 1,
		font: '',
		textBaseline: '',
		textAlign: '',
		globalAlpha: 1,
		globalCompositeOperation: 'source-over',
		imageSmoothingEnabled: true,
		fillRect: noop,
		clearRect: noop,
		drawImage: noop,
		createLinearGradient: () => ({ addColorStop: noop }),
		arc: noop,
		beginPath: noop,
		fill: noop,
		stroke: noop,
		save: noop,
		restore: noop,
		translate: noop,
		rotate: noop,
		rect: noop,
		ellipse: noop,
		moveTo: noop,
		lineTo: noop,
		closePath: noop,
		fillText: noop,
		setTransform: noop,
		scale: noop,
		getImageData: (_x: number, _y: number, w: number, h: number) => ({
			data: new Uint8ClampedArray(w * h * 4)
		})
	};
}

/** A GL context that compiles nothing and reports success. */
function stubGl(): unknown {
	return {
		VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, ARRAY_BUFFER: 3, STATIC_DRAW: 4, FLOAT: 5,
		TEXTURE_2D: 6, TEXTURE0: 7, TEXTURE1: 8, RGBA: 9, UNSIGNED_BYTE: 10,
		TEXTURE_WRAP_S: 11, TEXTURE_WRAP_T: 12, CLAMP_TO_EDGE: 13,
		TEXTURE_MIN_FILTER: 14, TEXTURE_MAG_FILTER: 15, LINEAR: 16,
		LINK_STATUS: 17, COMPILE_STATUS: 18, COLOR_BUFFER_BIT: 19, TRIANGLE_STRIP: 20,
		createShader: () => ({}), shaderSource: noop, compileShader: noop,
		getShaderParameter: () => true, getShaderInfoLog: () => '', deleteShader: noop,
		createProgram: () => ({}), attachShader: noop, bindAttribLocation: noop,
		linkProgram: noop, getProgramParameter: () => true, getProgramInfoLog: () => '',
		useProgram: noop, createBuffer: () => ({}), bindBuffer: noop, bufferData: noop,
		getAttribLocation: () => 0, enableVertexAttribArray: noop, vertexAttribPointer: noop,
		getUniformLocation: (_p: unknown, n: string) => ({ name: n }),
		createTexture: () => ({}), bindTexture: noop, texParameteri: noop,
		uniform1i: noop, uniform1f: noop, uniform3f: noop, uniform4f: noop,
		activeTexture: noop, pixelStorei: noop, texImage2D: noop, viewport: noop,
		clearColor: noop, clear: noop, drawArrays: noop, deleteTexture: noop,
		deleteProgram: noop,
		getExtension: () => null
	};
}

/**
 * Install a stub `document` and `URL`, recording every canvas the export builds.
 *
 * `toBlob` reproduces the failure that matters: past the ceiling a real browser
 * hands back `null` rather than throwing. The export has to keep every canvas it
 * creates under that limit, and the only honest way to check is to let the same
 * refusal happen here.
 */
function stubDom(sizes: Array<{ w: number; h: number }>): () => void {
	const previousDocument = (globalThis as Record<string, unknown>).document;
	const previousUrl = (globalThis as Record<string, unknown>).URL;

	(globalThis as Record<string, unknown>).document = {
		createElement: (tag: string): StubCanvas => {
			if (tag !== 'canvas') throw new Error(`unexpected createElement(${tag})`);
			const el: StubCanvas = {
				width: 300,
				height: 150,
				getContext: (id: string) => (id === '2d' ? stub2d() : stubGl()),
				toBlob: (cb: (b: Blob | null) => void) => {
					sizes.push({ w: el.width, h: el.height });
					const over =
						el.width > MAX_EXPORT_EDGE ||
						el.height > MAX_EXPORT_EDGE ||
						el.width * el.height > MAX_EXPORT_AREA;
					cb(over ? null : new Blob([new Uint8Array([1])], { type: 'image/png' }));
				}
			};
			return el;
		}
	};
	(globalThis as Record<string, unknown>).URL = {
		createObjectURL: () => 'blob:stub',
		revokeObjectURL: noop
	};

	return () => {
		(globalThis as Record<string, unknown>).document = previousDocument;
		(globalThis as Record<string, unknown>).URL = previousUrl;
	};
}

/** A decoded photo stand-in: the export only reads `width` and `height`. */
const fakePhoto = (w: number, h: number): PixelSource & Size =>
	({ width: w, height: h }) as unknown as PixelSource & Size;

// --- output geometry -------------------------------------------------------

test('output keeps the requested aspect ratio', () => {
	for (const r of RATIOS) {
		const { w, h } = outputSize(4000, 3000, r.id, 'max');
		const want = r.w && r.h ? r.w / r.h : 4000 / 3000;
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

test('an instant-print frame deepens only its foot', () => {
	const base = { imgW: 1200, imgH: 900, accentHex: '#FCC000', margin: 50 };
	const plain = composeGeometry({ ...base, frame: 'white' });
	const cheki = composeGeometry({ ...base, frame: 'cheki' });

	// The three other sides are untouched, so only the foot is what makes it read
	// as a print rather than a white border.
	assert.equal(cheki.pad, plain.pad, 'sides and top must match a plain frame');
	assert.ok(
		cheki.padBottom > cheki.pad * 2,
		'the foot must be markedly deeper than the sides'
	);
	assert.equal(cheki.outW, plain.outW, 'width must not change');
	assert.equal(cheki.outH, plain.outH + cheki.padBottom - cheki.pad);
	// The preview scales these fractions against different axes, so a foot measured
	// against the width would land in the wrong place on screen.
	assert.ok(Math.abs(cheki.padFrac - cheki.pad / cheki.outW) < 1e-12);
	assert.ok(Math.abs(cheki.padBottomFrac - cheki.padBottom / cheki.outH) < 1e-12);
});

test('the overlay block sits inside the instant-print foot', () => {
	// The band the block is fitted to has to be the deepest one. Fitting to the
	// sides would shrink the code to fit a band it is not drawn in.
	const geo = composeGeometry({
		imgW: 1200,
		imgH: 900,
		frame: 'cheki',
		accentHex: '#FCC000',
		margin: 50,
		showSwatch: true,
		showCode: true
	});
	const calls: Array<{ x: number; y: number }> = [];
	const ctx = {
		fillStyle: '',
		strokeStyle: '',
		globalAlpha: 1,
		lineWidth: 1,
		textBaseline: '',
		textAlign: '',
		font: '',
		beginPath: () => {},
		arc: () => {},
		fill: () => {},
		stroke: () => {},
		fillRect: () => {},
		createLinearGradient: () => ({ addColorStop: () => {} }),
		fillText: (_t: string, x: number, y: number) => calls.push({ x, y })
	};
	drawOverlayBlock(ctx as unknown as CanvasRenderingContext2D, {
		innerW: geo.innerW,
		innerH: geo.innerH,
		pad: geo.pad,
		padBottom: geo.padBottom,
		width: geo.outW,
		height: geo.outH,
		hasFrame: true,
		hex: '#FCC000',
		ink: '#000000',
		align: 'left',
		showSwatch: true,
		showCode: true,
		showMix: false
	});

	assert.equal(calls.length, 1, 'the code is drawn once');
	// The foot runs from the photo's bottom edge to the canvas bottom; the code
	// must be inside it, and clear of the photo above.
	const footTop = geo.innerH + geo.pad;
	assert.ok(calls[0].y > footTop, 'code must sit below the photo');
	assert.ok(calls[0].y < geo.outH, 'code must sit inside the canvas');
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
			for (const frame of ['none', 'white'] as FrameId[]) {
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

test('the export canvas never exceeds what a browser will allocate', async () => {
	// A canvas past the ceiling does not throw: the 2D context silently stops
	// drawing and `toBlob` calls back with `null`, so the export failed with a
	// generic message on every browser at `max` quality with a frame.
	//
	// This drives `exportComposite` itself, with a stubbed DOM that records every
	// canvas it asks for and refuses to encode one past the ceiling — the way a
	// real browser behaves. Asserting the fitting helper alone would have passed
	// while the export ignored it.
	const canvases: Array<{ w: number; h: number }> = [];
	const restore = stubDom(canvases);

	try {
		const cases: Array<[number, number, QualityId, FrameId, number]> = [
			[4032, 3024, 'max', 'white', 50],   // 4097 px before the fix
			[4032, 3024, 'max', 'white', 100],  // 5120x4112 before the fix
			[4032, 3024, 'max', 'accent', 100],
			[4032, 3024, 'max', 'none', 0],
			[4032, 3024, 'std', 'white', 100],
			[8000, 6000, 'max', 'custom', 100],
			[6000, 8000, 'max', 'white', 75]
		];

		for (const [imgW, imgH, quality, frame, margin] of cases) {
			canvases.length = 0;
			const label = `${imgW}x${imgH} ${quality} ${frame} margin=${margin}`;
			const source = fakePhoto(imgW, imgH);

			const result = await exportComposite({
				source,
				params: {
					target: { r: 252, g: 192, b: 0 },
					width: 30,
					feather: 40,
					tone: 0,
					contrast: 0,
					preset: 0,
					maskOn: 0,
					bypass: 0,
					crop: { sx: 0, sy: 0, sw: 1, sh: 1 }
				},
				maskSpec: { shape: null, lasso: [], strokes: [] },
				frame,
				customFrame: '#101010',
				margin,
				ratio: 'original',
				quality,
				align: 'left',
				showSwatch: true,
				showCode: true,
				showMix: true,
				mixPalette: null
			});

			// The observable contract: an image comes back at all.
			assert.ok(result.blob.size > 0, `${label}: empty blob`);
			assert.ok(result.width > 0 && result.height > 0, `${label}: no size`);

			for (const c of canvases) {
				assert.ok(
					c.w <= MAX_EXPORT_EDGE && c.h <= MAX_EXPORT_EDGE,
					`${label}: a ${c.w}x${c.h} canvas was requested, over ${MAX_EXPORT_EDGE}`
				);
				assert.ok(
					c.w * c.h <= MAX_EXPORT_AREA,
					`${label}: a ${c.w}x${c.h} canvas exceeds the area ceiling`
				);
			}
		}

		// A photo that already fits is left exactly alone.
		canvases.length = 0;
		const small = await exportComposite({
			source: fakePhoto(1200, 800),
			params: {
				target: { r: 252, g: 192, b: 0 },
				width: 30,
				feather: 40,
				tone: 0,
				contrast: 0,
				preset: 0,
				maskOn: 0,
				bypass: 0,
				crop: { sx: 0, sy: 0, sw: 1, sh: 1 }
			},
			maskSpec: { shape: null, lasso: [], strokes: [] },
			frame: 'none',
			margin: 0,
			ratio: 'original',
			quality: 'max',
			align: 'left',
			showSwatch: false,
			showCode: false,
			showMix: false,
			mixPalette: null
		});
		assert.equal(small.width, 1200);
		assert.equal(small.height, 800);
	} finally {
		restore();
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
	] as const) {
		const rows = (showSwatch || showCode ? 1 : 0) + (showMix ? 1 : 0);
		let prev = -1;
		const seen = new Set<number>();

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
	] as const) {
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
	] as const) {
		const rows = (showSwatch || showCode ? 1 : 0) + (showMix ? 1 : 0);

		const floor = overlayMinMargin({ showSwatch, showCode, showMix });
		// A tall band and the shortest band the slider actually offers, to show the
		// block changes size and never dips below legibility in that range.
		const roomy = paint({ frame: 'white', margin: 100, showSwatch, showCode, showMix });
		const tight = paint({ frame: 'white', margin: floor, showSwatch, showCode, showMix });

		const rowH = (r: PaintResult): number | null => {
			const font = r.calls.filter((c) => c[0] === 'set:font').pop();
			if (!font) return null;
			const m = / (\d+(?:\.\d+)?)px/.exec(strArg(font, 0));
			return m ? Number(m[1]) / 0.5 : null;
		};

		const big = rowH(roomy);
		const small = rowH(tight);
		assert.ok(big !== null && small !== null, 'the code is drawn at both margins');

		// The block is drawn at most at its natural size...
		assert.ok(big <= unit * 0.075 + 1e-6, `margin=100: row ${big} exceeds natural`);
		// ...and shrinks in a tighter band rather than overflowing it.
		assert.ok(small < big, `margin=floor row ${small} should be under margin=100 row ${big}`);
		// ...while staying legible.
		assert.ok(small >= unit * 0.02 - 1e-6, `margin=floor row ${small} below the legible minimum`);

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

/** One recorded canvas call: the method name, then its arguments. The arguments
 *  are genuinely dynamic — a recording proxy has no idea what it will be asked
 *  for — so they stay `unknown` and are read through the narrow helpers below
 *  rather than asserted into place at every call site. */
type Call = [name: string, ...args: unknown[]];

/** Read a numeric argument of a recorded call, naming the call on failure. */
function numArg(c: Call, i: number): number {
	const v = c[i + 1];
	assert.equal(typeof v, 'number', `arg ${i} of ${c[0]} should be a number, got ${typeof v}`);
	return v as number;
}

/** Read a string argument of a recorded call. */
function strArg(c: Call, i: number): string {
	const v = c[i + 1];
	assert.equal(typeof v, 'string', `arg ${i} of ${c[0]} should be a string, got ${typeof v}`);
	return v as string;
}

/** A 2D context that records the calls instead of drawing them. */
function recordingCtx(): { calls: Call[]; ctx: CanvasRenderingContext2D } {
	const calls: Call[] = [];
	const proxy = new Proxy(
		{},
		{
			get(_t, k) {
				const name = String(k);
				if (name === 'canvas') return { width: 0, height: 0 };
				if (name === 'createLinearGradient')
					return (...a: number[]) => {
						calls.push(['createLinearGradient', ...a]);
						return { addColorStop: () => {} };
					};
				return (...a: unknown[]) => {
					calls.push([name, ...a]);
				};
			},
			set(_t, k, v) {
				calls.push([`set:${String(k)}`, v]);
				return true;
			}
		}
	) as CanvasRenderingContext2D;
	return { calls, ctx: proxy };
}

/** What `paint` hands back: the geometry, the draw calls, and the two calls most
 *  tests inspect. */
interface PaintResult {
	g: Geometry;
	photoBottom: number;
	calls: Call[];
	circles: Call[];
	texts: Call[];
}

/** The overlay toggles, all optional, as the tests pass them. */
type PaintOpts = Partial<Omit<ComposeInput, 'imgW' | 'imgH' | 'accentHex'>> & {
	align?: Align;
	showSwatch?: boolean;
	showCode?: boolean;
	showMix?: boolean;
};

/** Compose and paint once, recording what the painter did. */
function paint(opts: PaintOpts): PaintResult {
	const imgW = 4000;
	const imgH = 3000;
	// Defaults come last: `opts` supplies only what a given test varies.
	const g = composeGeometry({
		imgW,
		imgH,
		accentHex: '#FCC000',
		...opts
	});
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
	const pick = (name: string): Call[] => calls.filter((c) => c[0] === name);
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

	const swatchCy = numArg(circles[0], 1); // arc(x, y, r, ...)
	const codeY = numArg(texts[0], 2); // fillText(text, x, y)
	assert.ok(swatchCy >= photoBottom, `swatch at ${swatchCy} overlaps the photo (bottom ${photoBottom})`);
	assert.ok(codeY >= photoBottom, `code at ${codeY} overlaps the photo`);
	assert.equal(swatchCy, codeY, 'the swatch and the code share a baseline');
	assert.ok(codeY <= g.outH, 'the block stays inside the frame');
	assert.equal(strArg(texts[0], 0), '#FCC000', 'the code shows the sampled color');
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
	assert.equal(numArg(grad, 0), 0, 'the scrim spans the full width');
	const y0 = numArg(grad, 1);
	assert.ok(y0 > 0 && y0 < g.outH, 'the scrim starts inside the photo');
	assert.equal(numArg(grad, 3), g.outH, 'the scrim runs to the bottom edge');
	assert.equal(texts.length, 1);
	assert.ok(numArg(texts[0], 2) < g.outH, 'the block stays on the photo');
});

test('an opaque frame band needs no scrim', () => {
	const { calls } = paint({ frame: 'white', margin: 50, showSwatch: true, showCode: true });
	assert.equal(calls.find((c) => c[0] === 'createLinearGradient'), undefined);
});

test('with every overlay off, nothing is painted', () => {
	const { calls } = paint({ frame: 'white', margin: 50 });
	assert.equal(calls.length, 0);
});

/** The mix bar among the recorded rects: the only one narrower than the band. */
const mixBar = (r: PaintResult): Call | undefined =>
	r.calls.find((c) => c[0] === 'fillRect' && numArg(c, 2) > r.g.pad);

test('the mix bar is narrower than the band, so it has room to move', () => {
	const r = paint({ frame: 'white', margin: 50, showMix: true });
	const span = r.g.outW - 2 * r.g.pad;
	const bar = r.calls.find(
		(c) => c[0] === 'fillRect' && numArg(c, 2) < span && numArg(c, 2) > span * 0.5
	);
	assert.ok(bar, `the mix bar should span most, but not all, of the band (span ${span})`);
});

test('position moves the block across the band without leaving it', () => {
	// The block had no position control: it was always flush left. It now aligns
	// left, centre, or right, and must stay inside the band at every setting.
	const opts = { frame: 'white' as FrameId, margin: 50, showSwatch: true, showCode: true, showMix: true };

	const left = paint({ ...opts, align: 'left' });
	const center = paint({ ...opts, align: 'center' });
	const right = paint({ ...opts, align: 'right' });

	// arc(centreX, centreY, radius, start, end): the swatch's centre x.
	const swatchX = (r: PaintResult): number => numArg(r.circles[0], 0);
	const inset = left.g.pad;
	const bandRight = left.g.outW - inset;

	assert.ok(swatchX(left) < swatchX(center), 'center sits right of left');
	assert.ok(swatchX(center) < swatchX(right), 'right sits right of center');

	// The widest element is the mix bar, so it decides whether the block fits.
	// fillRect(x, y, w, h): the bar's left edge and width.
	for (const [name, r] of [
		['left', left],
		['center', center],
		['right', right]
	] as const) {
		const bar = mixBar(r);
		assert.ok(bar, `${name}: the mix bar is drawn`);
		const x = numArg(bar, 0);
		const w = numArg(bar, 2);
		assert.ok(x >= inset - 1e-6, `${name}: the block starts left of the band`);
		assert.ok(x + w <= bandRight + 1e-6, `${name}: the block runs past the band`);
	}

	// Right alignment should actually reach the far side, not just move a bit.
	const rightBar = mixBar(right);
	assert.ok(rightBar, 'right: the mix bar is drawn');
	assert.ok(
		Math.abs(numArg(rightBar, 0) + numArg(rightBar, 2) - bandRight) < 1e-6,
		'right should reach the edge'
	);
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
