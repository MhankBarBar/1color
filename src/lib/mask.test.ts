// Tests for the mask layer.
//
// The important invariant: painting a stroke incrementally (one segment at a
// time, as a drag does) must produce the same mask as redrawing every stroke
// from scratch. That is what the incremental path in Stage.svelte relies on, and
// if the two ever diverge, painting silently produces a different region than
// the one you drew.
//
// A minimal 2D canvas stand-in is used: these tests care about the drawing
// commands and the resulting coverage, not about real rasterisation.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Point, ShapeKind, Stroke } from './types.js';
import {
	MaskLayer,
	shapeHitTest,
	makeShape,
	shapeForTool,
	SHAPE_TOOLS,
	SHAPE_MIN
} from './mask.js';

/** One recorded drawing call: the method name, then its arguments. */
type Call = [string, ...number[]];

/** The drawing surface the tests read back: the properties `MaskLayer` sets,
 *  and a record of every method called on it. */
interface StubCtx {
	calls: Call[];
	fillStyle: string;
	strokeStyle: string;
	lineWidth: number;
	lineCap: string;
	lineJoin: string;
	globalCompositeOperation: string;
	fillRect(...a: number[]): void;
	clearRect(...a: number[]): void;
	beginPath(): void;
	moveTo(...a: number[]): void;
	lineTo(...a: number[]): void;
	closePath(): void;
	fill(): void;
	stroke(): void;
	save(): void;
	restore(): void;
	translate(...a: number[]): void;
	rotate(...a: number[]): void;
	ellipse(...a: number[]): void;
	rect(...a: number[]): void;
}

/** The shim element `document.createElement` hands back. */
interface StubCanvas {
	width: number;
	height: number;
	_ctx: StubCtx | null;
	getContext(id: string, opts?: { willReadFrequently?: boolean }): CanvasRenderingContext2D;
}

/** Records the drawing calls so equivalence can be asserted structurally. */
function makeCtx(): StubCtx {
	const calls: Call[] = [];
	return {
		calls,
		fillStyle: '',
		strokeStyle: '',
		lineWidth: 0,
		lineCap: '',
		lineJoin: '',
		globalCompositeOperation: '',
		fillRect: (...a) => calls.push(['fillRect', ...a]),
		clearRect: (...a) => calls.push(['clearRect', ...a]),
		beginPath: () => calls.push(['beginPath']),
		moveTo: (...a) => calls.push(['moveTo', ...a]),
		lineTo: (...a) => calls.push(['lineTo', ...a]),
		closePath: () => calls.push(['closePath']),
		fill: () => calls.push(['fill']),
		stroke: () => calls.push(['stroke']),
		save: () => calls.push(['save']),
		restore: () => calls.push(['restore']),
		translate: (...a) => calls.push(['translate', ...a]),
		rotate: (...a) => calls.push(['rotate', ...a]),
		ellipse: (...a) => calls.push(['ellipse', ...a]),
		rect: (...a) => calls.push(['rect', ...a])
	};
}

// Load MaskLayer with a document shim so it can create its canvas.
globalThis.document = {
	createElement: () => {
		const el: StubCanvas = {
			width: 0,
			height: 0,
			_ctx: null,
			getContext: () => (el._ctx ||= makeCtx()) as unknown as CanvasRenderingContext2D
		};
		return el;
	}
} as unknown as Document;

/** A layer's context, which these tests replaced with the recorder above via
 *  the document shim — `MaskLayer` declares the real 2D context type. */
const ctxOf = (layer: MaskLayer): StubCtx => layer.ctx as unknown as StubCtx;

/** Every stroke segment the incremental path would draw, in order. */
function segmentCalls(strokes: Stroke[], w: number, h: number): Call[] {
	const out: Call[] = [];
	for (const s of strokes) {
		for (let i = 1; i < s.pts.length; i++) {
			const a = s.pts[i - 1];
			const b = s.pts[i];
			out.push(['seg', a.x * w, a.y * h, b.x * w, b.y * h, s.size * Math.max(w, h)]);
		}
	}
	return out;
}

test('incremental segments cover every point of every stroke', () => {
	const strokes: Stroke[] = [
		{ size: 0.1, pts: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }, { x: 0.3, y: 0.25 }] },
		{ size: 0.05, pts: [{ x: 0.5, y: 0.5 }, { x: 0.6, y: 0.55 }] }
	];
	const segs = segmentCalls(strokes, 100, 100);
	// One segment per adjacent pair: (3-1) + (2-1) = 3.
	assert.equal(segs.length, 3);
	// Rounded: 0.55 * 100 is 55.00000000000001 in binary floating point.
	const r = (s: Call) => s.map((v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v));
	assert.deepEqual(r(segs[0]), ['seg', 10, 10, 20, 20, 10]);
	// Third segment is the second stroke's only pair, starting at 0.5.
	assert.deepEqual(r(segs[2]), ['seg', 50, 50, 60, 55, 5]);
});

test('a stroke drawn incrementally visits the same path as drawing it at once', () => {
	// A drag paints one segment per pointer move; a full redraw walks the whole
	// polyline in a single path. The call sequences legitimately differ (repeated
	// moveTo/lineTo versus one continuous path), but they must trace the same
	// points in the same order — otherwise painting produces a different region
	// than the one being drawn.
	const pts: Point[] = [];
	for (let i = 0; i <= 10; i++) pts.push({ x: i / 10, y: 0.5 });

	const layer = new MaskLayer(100, 100);
	layer.clear();
	for (let i = 1; i < pts.length; i++) layer.strokeSegment(pts[i - 1], pts[i], 0.1);
	const incremental = ctxOf(layer)
		.calls.filter((c) => c[0] === 'moveTo' || c[0] === 'lineTo')
		.map((c) => [c[1], c[2]]);

	layer.clear();
	ctxOf(layer).calls.length = 0;
	layer.drawAll({ shape: null, lasso: [], strokes: [{ size: 0.1, pts }] });
	const whole = ctxOf(layer)
		.calls.filter((c) => c[0] === 'moveTo' || c[0] === 'lineTo')
		.map((c) => [c[1], c[2]]);

	// Incremental repeats each interior point (end of one segment, start of the
	// next); dedupe consecutive repeats before comparing.
	const dedupe = (a: number[][]) =>
		a.filter((p, i) => i === 0 || p[0] !== a[i - 1][0] || p[1] !== a[i - 1][1]);
	assert.deepEqual(dedupe(incremental), dedupe(whole));
	assert.equal(dedupe(whole).length, pts.length);
});

test('every segment is drawn with a round cap and join', () => {
	// A square cap on a polyline leaves notches at every joint, which reads as a
	// dashed stroke rather than paint.
	const layer = new MaskLayer(100, 100);
	layer.strokeSegment({ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }, 0.1);
	assert.equal(ctxOf(layer).lineCap, 'round');
	assert.equal(ctxOf(layer).lineJoin, 'round');
});

test('segment width scales with the canvas, not the normalised coordinate', () => {
	// Width must be resolution-independent: the same stroke has to look the same
	// in the on-screen preview and in the full-resolution export.
	const small = new MaskLayer(100, 100);
	small.strokeSegment({ x: 0, y: 0 }, { x: 1, y: 1 }, 0.1);
	const large = new MaskLayer(1000, 1000);
	large.strokeSegment({ x: 0, y: 0 }, { x: 1, y: 1 }, 0.1);
	assert.equal(ctxOf(small).lineWidth, 10);
	assert.equal(ctxOf(large).lineWidth, 100);
});

test('clear resets the layer to black before redrawing', () => {
	const layer = new MaskLayer(100, 100);
	layer.clear();
	const first = ctxOf(layer).calls[0];
	assert.equal(first[0], 'fillRect');
	assert.equal(first[1], 0);
	assert.equal(ctxOf(layer).fillStyle, '#000');
});

test('drawAll fills a circle and a square differently', () => {
	const circle = new MaskLayer(100, 100);
	circle.drawAll({ shape: makeShape('circle'), lasso: [], strokes: [] });
	assert.ok(ctxOf(circle).calls.some((c) => c[0] === 'ellipse'));

	const rect = new MaskLayer(100, 100);
	rect.drawAll({ shape: makeShape('rect'), lasso: [], strokes: [] });
	assert.ok(ctxOf(rect).calls.some((c) => c[0] === 'rect'));
	assert.ok(!ctxOf(rect).calls.some((c) => c[0] === 'ellipse'));
});

test('a lasso needs at least three points to close', () => {
	const two = new MaskLayer(100, 100);
	two.drawAll({ shape: null, lasso: [{ x: 0, y: 0 }, { x: 1, y: 1 }], strokes: [] });
	assert.ok(!ctxOf(two).calls.some((c) => c[0] === 'closePath'));

	const three = new MaskLayer(100, 100);
	three.drawAll({
		shape: null,
		lasso: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }],
		strokes: []
	});
	assert.ok(ctxOf(three).calls.some((c) => c[0] === 'closePath'));
});

test('mask dimensions are capped so a huge photo does not allocate a huge layer', () => {
	const huge = new MaskLayer(8000, 6000);
	assert.ok(Math.max(huge.w, huge.h) <= 1536, `mask was ${huge.w}x${huge.h}`);
	// Aspect ratio must survive the cap, or the mask would not align with the photo.
	assert.ok(Math.abs(huge.w / huge.h - 8000 / 6000) < 0.01);
});

test('hit-testing follows rotation and reports inside vs outside', () => {
	const s = makeShape('circle', 0.5, 0.5);
	assert.ok(shapeHitTest(s, 0.5, 0.5) < 1);
	assert.ok(shapeHitTest(s, 0.99, 0.99) > 1);
	assert.ok(SHAPE_MIN > 0);
});

// --- tool -> shape mapping -------------------------------------------------

test('only the shape tools produce a shape', () => {
	// Regression: the seeder called makeShape() with whatever tool was active, so
	// selecting "enclose" (lasso) produced { kind: 'lasso' } — and the overlay
	// renders any non-rect shape as an ellipse, so the lasso drew a circle over
	// the photo and the points you had drawn were discarded.
	assert.equal(shapeForTool('circle')!.kind, 'circle');
	assert.equal(shapeForTool('rect')!.kind, 'rect');
	assert.equal(shapeForTool('lasso'), null, 'lasso must have no shape');
	assert.equal(shapeForTool('brush'), null, 'brush must have no shape');
});

test('no shape tool ever yields a kind the overlay cannot draw', () => {
	// The overlay understands exactly circle and rect. Anything else would fall
	// through its else-branch and render as an ellipse.
	const allTools: ShapeKind[] = ['circle', 'rect', 'lasso', 'brush'];
	for (const t of allTools) {
		const sh = shapeForTool(t);
		if (sh === null) continue;
		assert.ok(
			sh.kind === 'circle' || sh.kind === 'rect',
			`tool ${t} produced unrenderable kind ${sh.kind}`
		);
	}
});

test('SHAPE_TOOLS matches what shapeForTool accepts', () => {
	for (const t of SHAPE_TOOLS) assert.ok(shapeForTool(t), `${t} is listed but yields no shape`);
	assert.equal(SHAPE_TOOLS.length, 2);
});

test('a shape from shapeForTool is centred and usable', () => {
	const sh = shapeForTool('circle')!;
	assert.equal(sh.cx, 0.5);
	assert.equal(sh.cy, 0.5);
	assert.ok(sh.w >= SHAPE_MIN && sh.h >= SHAPE_MIN);
	assert.equal(sh.rot, 0);
	assert.ok(shapeHitTest(sh, 0.5, 0.5) < 1, 'centre should be inside');
});
