<script lang="ts">
	/** The stage: GL canvas plus an SVG overlay for range editing. Geometry lives in
	 *  normalised image coordinates (0..1, y down), so one shape drives both the preview
	 *  and the full-resolution export. */
	import { Renderer } from '../lib/gl.js';
	import { MaskLayer, shapeHitTest, makeShape, SHAPE_MIN } from '../lib/mask.js';
	import { rgbToHex, hexToRgb, inkOn } from '../lib/color.js';
	import { composeGeometry, cropRect, drawOverlayBlock } from '../lib/export.js';
	import { icon } from '../lib/icons.js';
	import type {
		Align,
		FrameId,
		Point,
		PixelSource,
		RenderParamsInput,
		Rgb,
		Shape,
		ShapeKind,
		Stroke
	} from '../lib/types.js';

	/** The two region scopes the stage can be in. */
	type Scope = 'all' | 'part';

	/** Which manipulation a pointer drag is performing. */
	type DragKind = 'pick' | 'brush' | 'lasso' | 'move' | 'resize' | 'rotate';

	interface Drag {
		kind: DragKind;
		/** Where the drag began, for the relative moves. Absent for pick/brush/lasso. */
		start?: Point;
		/** The shape as it was when the drag began, so moves are relative to it. */
		base?: Shape | null;
		/** Which corner a resize is dragging. */
		index?: number;
	}

	let {
		source = null,
		params,
		scope = 'all',
		shapeKind = 'circle',
		shape = null,
		lasso = [],
		strokes = [],
		brushSize = 0.08,
		brushHint = false,
		onpick = (_p: Point) => {},
		onshape = (_s: Shape | null) => {},
		onlasso = (_l: Point[]) => {},
		onstroke = (_s: Stroke[]) => {},
		ondropfile = (_file?: File) => {},
		onbrowse = () => {},
		t = (k: string) => k,
		frame = 'none',
		customFrame = '#F6F6F8',
		marginPct = 50,
		ratio = 'original',
		align = 'left',
		compare = false,
		loading = false,
		showSwatch = false,
		showCode = false,
		showMix = false,
		mixPalette = null
	}: {
		source?: PixelSource | null;
		params: RenderParamsInput & { target: Rgb };
		scope?: Scope;
		shapeKind?: ShapeKind;
		shape?: Shape | null;
		lasso?: Point[];
		strokes?: Stroke[];
		brushSize?: number;
		brushHint?: boolean;
		onpick?: (p: Point) => void;
		onshape?: (s: Shape | null) => void;
		onlasso?: (l: Point[]) => void;
		onstroke?: (s: Stroke[]) => void;
		ondropfile?: (file?: File) => void;
		onbrowse?: () => void;
		t?: (key: string) => string;
		frame?: FrameId;
		customFrame?: string;
		marginPct?: number;
		ratio?: string;
		align?: Align;
		compare?: boolean;
		loading?: boolean;
		showSwatch?: boolean;
		showCode?: boolean;
		showMix?: boolean;
		mixPalette?: Rgb[] | null;
	} = $props();

	let canvasEl = $state<HTMLCanvasElement | null>(null);
	let boxEl = $state<HTMLDivElement | null>(null);
	/** Overlay preview canvas, covering the photo box and the frame band. */
	let composeEl = $state<HTMLCanvasElement | null>(null);
	// $state, not a plain binding: every effect below depends on the renderer existing,
	// and a plain variable would not re-trigger them once assigned. That bug shows up as
	// a permanently blank canvas.
	let renderer = $state<Renderer | null>(null);
	let mask = $state<MaskLayer | null>(null);
	/** The source the current mask was built for; identity, not size. */
	let maskFor: PixelSource | null = null;
	let over = $state(false);
	let glError = $state('');

	/** Position of the before/after divider, 0..1 across the photo. */
	let split = $state(0.5);
	let beforeEl = $state<HTMLCanvasElement | null>(null);
	let draggingSplit = $state(false);

	// The "before" layer is a one-off 2D snapshot of the untouched source, clipped to the
	// divider. Reusing the GL canvas would mean a second WebGL context and a second render
	// per frame. It draws the cropped rect, so both sides are framed alike.
	$effect(() => {
		if (!beforeEl || !source) return;
		const w = Math.round(fit.w);
		const h = Math.round(fit.h);
		if (!w || !h) return;
		if (beforeEl.width !== w || beforeEl.height !== h) {
			beforeEl.width = w;
			beforeEl.height = h;
		}
		const ctx = beforeEl.getContext('2d');
		if (!ctx) return;
		ctx.clearRect(0, 0, w, h);
		const c = crop;
		ctx.drawImage(
			source,
			c.sx * source.width,
			c.sy * source.height,
			c.sw * source.width,
			c.sh * source.height,
			0,
			0,
			w,
			h
		);
	});

	function splitFromEvent(e: PointerEvent): void {
		if (!boxEl) return;
		const r = boxEl.getBoundingClientRect();
		split = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
	}
	// Cropped to the chosen ratio, so switching ratio reframes the photo on screen
	// exactly as it will be exported.
	const crop = $derived(source ? cropRect(source.width, source.height, ratio) : { sx: 0, sy: 0, sw: 1, sh: 1 });
	const aspect = $derived(
		source ? (source.width * crop.sw) / (source.height * crop.sh) : 1
	);

	/** Map a point in view space (0..1 across the cropped photo) to full-image space
	 *  (0..1 across the original). Region geometry is stored in image space, so a region
	 *  stays on the same part of the photo as the ratio changes — only this mapping moves. */
	const viewToImage = (p: Point): Point => ({
		x: crop.sx + p.x * crop.sw,
		y: crop.sy + p.y * crop.sh
	});

	const imageToView = (p: Point): Point => ({
		x: (p.x - crop.sx) / crop.sw,
		y: (p.y - crop.sy) / crop.sh
	});

	$effect(() => {
		if (!canvasEl) return;
		try {
			renderer = new Renderer(canvasEl);
		} catch (err) {
			console.error(err);
			glError =
				err instanceof Error && err.message.includes('cannot run WebGL')
					? 'nogl'
					: err instanceof Error
						? err.message
						: String(err);
			return;
		}
		return () => {
			renderer?.dispose();
			renderer = null;
		};
	});

	// --- render scheduling -------------------------------------------------
	// One frame for everything: three effects used to call resize() + render(), and a
	// brush drag repainted per pointermove — dozens of redraws plus a mask upload per drag.

	let pendingFrame = 0;

	function schedule(): void {
		if (pendingFrame) return;
		pendingFrame = requestAnimationFrame(() => {
			pendingFrame = 0;
			draw();
		});
	}

	/** Repaint the mask layer. Strokes only grow by appending, so a change adding one
	 *  point to the last stroke draws just that segment; a full `drawAll` clears the layer
	 *  and replays every point, which dominated a drag. */
	let maskState: { strokes: number; pts: number; shape: Shape | null | undefined; lasso: number } = {
		strokes: -1,
		pts: -1,
		shape: undefined,
		lasso: -1
	};

	function paintMask(): void {
		if (!mask) return;
		const totalPts = strokes.reduce((n, s) => n + s.pts.length, 0);
		const canAppend =
			maskState.shape === shape &&
			maskState.lasso === lasso.length &&
			maskState.strokes === strokes.length &&
			totalPts > maskState.pts;

		if (canAppend) {
			const s = strokes[strokes.length - 1];
			const a = s.pts[s.pts.length - 2];
			const b = s.pts[s.pts.length - 1];
			if (a && b) mask.strokeSegment(a, b, s.size);
		} else {
			mask.drawAll({ shape, lasso, strokes });
		}
		maskState = { strokes: strokes.length, pts: totalPts, shape, lasso: lasso.length };
	}

	function draw(): void {
		const r = renderer;
		if (!r || !source || !boxEl) return;
		const w = boxEl.clientWidth;
		const h = boxEl.clientHeight;
		if (!w || !h) return;
		r.resize(w, h);

		// Uploaded only when the shader will read it; the default whole-photo mode skips
		// it entirely, and that is the bulk of the upload cost.
		if (params.maskOn) {
			if (maskFor !== source) {
				mask = new MaskLayer(source.width, source.height);
				maskFor = source;
				maskState = { strokes: -1, pts: -1, shape: undefined, lasso: -1 };
			}
			paintMask();
			if (mask) r.setMask(mask.canvas);
		}

		r.setParams({ ...params, crop });
		r.render();
	}

	// Photo changed: upload it once, then paint.
	$effect(() => {
		if (!renderer || !source) return;
		renderer.setImage(source);
		schedule();
	});

	// Any parameter, region, or fit change: repaint on the next frame.
	$effect(() => {
		void params;
		void shape;
		void lasso;
		void strokes;
		void fit.w;
		void fit.h;
		if (!renderer) return;
		schedule();
	});

	// Height comes from the viewport, NOT the host element: the host's height is
	// determined by the frame we are about to size, so reading it is circular and
	// collapses the stage. The cap stops a tall portrait filling the screen.
	let hostEl = $state<HTMLDivElement | null>(null);
	let avail = $state({ w: 0, h: 0 });

	const MAX_STAGE_H = () => Math.min(globalThis.innerHeight * 0.68, 760);

	$effect(() => {
		if (!hostEl) return;
		const host = hostEl;
		const measure = () => {
			avail = { w: host.clientWidth, h: MAX_STAGE_H() };
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(host);
		addEventListener('resize', measure);
		return () => {
			ro.disconnect();
			removeEventListener('resize', measure);
		};
	});

	// Letterbox the framed composition into the available space.
	const fit = $derived.by(() => {
		if (!avail.w) return { w: 0, h: 0 };
		const ar = framed.aspect;
		let w = avail.w;
		let h = w / ar;
		if (h > avail.h) {
			h = avail.h;
			w = h * ar;
		}
		return { w: Math.round(w), h: Math.round(h) };
	});

	// Frame preview, from the export's own `composeGeometry`, so the band drawn into is by
	// construction the band the export writes into. The size passed in is the *cropped*
	// photo, matching `outputSize`, or preview and file disagree once a ratio is chosen.
	const framed = $derived.by(() =>
		composeGeometry({
			imgW: Math.max(2, Math.round((source?.width || 1) * crop.sw)),
			imgH: Math.max(2, Math.round((source?.height || 1) * crop.sh)),
			frame,
			accentHex: rgbToHex(params.target),
			customHex: customFrame,
			margin: marginPct,
			align,
			showSwatch,
			showCode,
			showMix
		})
	);

	// The drawing buffer follows the inner (photo) box, which changes when the
	// letterbox fit or the frame padding changes. `clientWidth` is not reactive,
	// so observe it.
	$effect(() => {
		if (!boxEl) return;
		const ro = new ResizeObserver(schedule);
		ro.observe(boxEl);
		return () => ro.disconnect();
	});

	// Cancel any pending frame when the component goes away.
	$effect(() => () => cancelAnimationFrame(pendingFrame));

	// --- pointer handling --------------------------------------------------

	/** Map a pointer event to normalised photo coordinates (full image space). */
	function toImage(e: { clientX: number; clientY: number }): Point {
		const box = boxEl;
		if (!box) return { x: 0, y: 0 };
		const r = box.getBoundingClientRect();
		// Through the crop: the stage shows the cropped rect, and region geometry
		// lives in full-image coordinates.
		return viewToImage({
			x: (e.clientX - r.left) / r.width,
			y: (e.clientY - r.top) / r.height
		});
	}

	let drag = $state<Drag | null>(null);

	// Overlay geometry in PIXELS with a 1:1 viewBox. As an SVG with viewBox="0 0 1 1" and
	// preserveAspectRatio="none", a stroke-width of 0.02 scaled differently on x and y,
	// so brush strokes came out elliptical instead of round.

	// Declared above its first reader: `const` is in the temporal dead zone until it
	// runs, and `$derived` only defers the expression.
	const px = $derived({
		w: fit.w || 1,
		h: fit.h || 1
	});

	/** Live pointer position in normalised image coordinates. Drives the two overlays
	 *  the iOS app has and this lacked: a ring showing the brush size before you commit
	 *  to a stroke, and a loupe for sampling on a small screen. */
	let pointer = $state<Point | null>(null);
	let loupeEl = $state<HTMLCanvasElement | null>(null);

	/** `pointer`, expressed in view space, for anything positioned with CSS. */
	const pointerView = $derived(pointer ? imageToView(pointer) : null);

	/** Brush diameter in stage pixels. The mask is built at full image resolution, so the
	 *  ring must convert back through the crop or it shows the wrong size once a ratio is
	 *  picked — and the ring exists to say how big the stroke will be. */
	const brushRingPx = $derived(
		Math.max(
			6,
			brushSize * Math.max(px.w / crop.sw, px.h / crop.sh)
		)
	);

	/** A brush that can be sized is only useful once a region is being painted. */
	const brushActive = $derived(shapeKind === 'brush' && scope === 'part');

	/** Where the brush ring sits: under the pointer, or the photo's centre when the
	 *  size slider is being dragged and there is no pointer to follow. */
	const brushAt = $derived(pointerView ?? { x: 0.5, y: 0.5 });

	/** Shown while hovering to paint and while the size slider is dragged. The slider
	 *  case matters: without it the ring only followed the pointer, so dragging the size
	 *  control changed a number with nothing on the photo to show what it meant. */
	const showBrushRing = $derived(brushActive && (pointer !== null || brushHint));

	/** Which side of the pointer the magnifier sits on. The framed box clips its
	 *  overflow, so above-the-pointer gets cut off near the top edge. */
	const loupeBelow = $derived((pointerView?.y ?? 0) < 0.42);

	/** While sampling or painting, show what sits under the pointer, magnified. */
	const showLoupe = $derived(
		pointer !== null &&
			!!source &&
			(drag?.kind === 'pick' || drag?.kind === 'brush')
	);

	// Nearest-neighbour on purpose: this is a colour-sampling aid, and smoothing would
	// blend neighbouring pixels into a colour not actually under the pointer.
	$effect(() => {
		const el = loupeEl;
		const pt = pointer;
		if (!el || !showLoupe || !pt || !source) return;
		const size = el.width;
		const zoom = 5;
		const span = size / zoom;
		const maxX = Math.max(0, source.width - span);
		const maxY = Math.max(0, source.height - span);
		const sx = Math.min(Math.max(0, pt.x * source.width - span / 2), maxX);
		const sy = Math.min(Math.max(0, pt.y * source.height - span / 2), maxY);
		const ctx = el.getContext('2d');
		if (!ctx) return;
		ctx.imageSmoothingEnabled = false;
		ctx.clearRect(0, 0, size, size);
		ctx.drawImage(source, sx, sy, span, span, 0, 0, size, size);
	});

	function onPointerDown(e: PointerEvent): void {
		const box = boxEl;
		if (!source || !box) return;
		box.setPointerCapture(e.pointerId);
		const p = toImage(e);

		// Region editing works in both accent and range mode: range shapes the region,
		// accent shows its effect.
		if (scope === 'all') {
			drag = { kind: 'pick' };
			onpick(p);
			return;
		}

		if (shapeKind === 'brush') {
			// A fresh stroke list: copying a few hundred points per pointermove is
			// negligible next to the mask redraw, and staying immutable keeps the
			// parent's reactivity unambiguous.
			const seg = { pts: [p], size: brushSize };
			onstroke([...strokes, seg]);
			drag = { kind: 'brush' };
			return;
		}

		if (shapeKind === 'lasso') {
			onlasso([p]);
			drag = { kind: 'lasso' };
			return;
		}

		// Shape manipulation: grab a corner, the rotate handle, or the body.
		const handle = shape ? hitHandle(p) : null;
		if (handle && shape) {
			drag = { kind: handle.type, start: p, base: { ...shape }, index: handle.index };
			return;
		}
		if (shape && shapeHitTest(shape, p.x, p.y) <= 1) {
			drag = { kind: 'move', start: p, base: { ...shape } };
			return;
		}
		// Nothing hit: start a fresh shape centred on the tap.
		onshape(makeShape(shapeKind, p.x, p.y));
		drag = { kind: 'move', start: p, base: null };
	}

	function onPointerMove(e: PointerEvent): void {
		if (!source) return;
		const p = toImage(e);
		pointer = p;
		if (!drag) return;

		if (drag.kind === 'pick') {
			onpick(p);
			return;
		}
		if (drag.kind === 'brush') {
			const next = strokes.slice();
			const last = { ...next[next.length - 1] };
			last.pts = [...last.pts, p];
			next[next.length - 1] = last;
			onstroke(next);
			return;
		}
		if (drag.kind === 'lasso') {
			onlasso([...lasso, p]);
			return;
		}

		const base = drag.base || shape;
		const start = drag.start;
		if (!base || !start) return;
		const dx = p.x - start.x;
		const dy = p.y - start.y;

		if (drag.kind === 'move') {
			onshape({
				...base,
				cx: Math.min(1, Math.max(0, base.cx + dx)),
				cy: Math.min(1, Math.max(0, base.cy + dy))
			});
		} else if (drag.kind === 'rotate') {
			const a = Math.atan2(p.y - base.cy, p.x - base.cx);
			onshape({ ...base, rot: a - Math.PI / 2 });
		} else {
			// Corner: resize in the shape's local frame.
			const cos = Math.cos(-base.rot);
			const sin = Math.sin(-base.rot);
			const lx = dx * cos - dy * sin;
			const ly = dx * sin + dy * cos;
			const index = drag.index ?? 0;
			const sign = index % 2 === 0 ? 1 : -1;
			const signY = index < 2 ? 1 : -1;
			onshape({
				...base,
				w: Math.max(SHAPE_MIN, base.w + lx * sign),
				h: Math.max(SHAPE_MIN, base.h + ly * signY)
			});
		}
	}

	function onPointerLeave(): void {
		if (!drag) pointer = null;
	}

	function onPointerUp(e: PointerEvent): void {
		if (drag) {
			if (drag.kind === 'lasso' && lasso.length < 3) onlasso([]);
			drag = null;
		}
		try {
			boxEl?.releasePointerCapture(e.pointerId);
		} catch {
			/* pointer already released */
		}
	}

	/** Which resize/rotate handle, if any, is under the pointer. */
	function hitHandle(p: Point): { type: 'resize' | 'rotate'; index?: number } | null {
		if (!shape || shapeKind === 'brush' || shapeKind === 'lasso') return null;
		const TOL = 0.035;
		const cos = Math.cos(shape.rot || 0);
		const sin = Math.sin(shape.rot || 0);
		const corners = [
			[-shape.w / 2, -shape.h / 2],
			[shape.w / 2, -shape.h / 2],
			[-shape.w / 2, shape.h / 2],
			[shape.w / 2, shape.h / 2]
		];
		for (let i = 0; i < corners.length; i++) {
			const [lx, ly] = corners[i];
			const x = shape.cx + lx * cos - ly * sin;
			const y = shape.cy + lx * sin + ly * cos;
			if (Math.hypot(p.x - x, p.y - y) < TOL) return { type: 'resize', index: i };
		}
		const rx = shape.cx + Math.sin(shape.rot || 0) * (-shape.h / 2 - 0.06);
		const ry = shape.cy + Math.cos(shape.rot || 0) * (shape.h / 2 + 0.06);
		if (Math.hypot(p.x - rx, p.y - ry) < TOL) return { type: 'rotate' };
		return null;
	}

	/** View-space pixels for a point stored in image space. Region geometry is in image
	 *  space and this SVG in view space, so every point goes through the crop mapping —
	 *  without it, cropping would slide the region off the pixels it was drawn over. */
	const toPx = (p: Point): Point => {
		const v = imageToView(p);
		return { x: v.x * px.w, y: v.y * px.h };
	};

	const overlay = $derived.by(() => {
		// Only circle and rect have geometry to draw. A stale kind would reach the
		// markup's `{:else}` ellipse branch, which is how a lasso could show a circle
		// over the photo.
		if (!shape || (shape.kind !== 'rect' && shape.kind !== 'circle')) return null;
		const W = px.w;
		const H = px.h;
		const c = toPx({ x: shape.cx, y: shape.cy });
		const hw = (shape.w * W) / 2;
		const hh = (shape.h * H) / 2;
		const rad = (shape.rot || 0) * (180 / Math.PI);
		const cos = Math.cos(shape.rot || 0);
		const sin = Math.sin(shape.rot || 0);
		const corners = [
			[-hw, -hh],
			[hw, -hh],
			[-hw, hh],
			[hw, hh]
		].map(([lx, ly]) => ({ x: c.x + lx * cos - ly * sin, y: c.y + lx * sin + ly * cos }));
		const rotate = {
			x: c.x + Math.sin(shape.rot || 0) * (-hh - 26),
			y: c.y + Math.cos(shape.rot || 0) * (hh + 26)
		};
		const anchor = {
			x: c.x + Math.sin(shape.rot || 0) * -hh,
			y: c.y + Math.cos(shape.rot || 0) * hh
		};
		return { rad, corners, rotate, anchor, cx: c.x, cy: c.y, hw, hh };
	});

	const lassoPath = $derived(
		lasso.length > 1
			? lasso
					.map((p, i) => {
						const v = toPx(p);
						return `${i ? 'L' : 'M'}${v.x} ${v.y}`;
					})
					.join(' ') + ' Z'
			: ''
	);

	const cursor = $derived(
		scope === 'all' || shapeKind === 'brush' || shapeKind === 'lasso' ? 'crosshair' : 'default'
	);

	/** Paint the overlay preview with the export's own painter at the export's own
	 *  geometry, so the block can only look like the saved file. The canvas covers the
	 *  frame's padding box — the whole composition — so the export's numbers go in as-is. */
	$effect(() => {
		if (!composeEl) return;
		// `clientWidth` is not reactive; read the fit so a resize repaints.
		void fit.w;
		void fit.h;
		const cssW = composeEl.clientWidth;
		const cssH = composeEl.clientHeight;
		if (!cssW || !cssH) return;

		const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
		const bw = Math.round(cssW * dpr);
		const bh = Math.round(cssH * dpr);
		if (composeEl.width !== bw || composeEl.height !== bh) {
			composeEl.width = bw;
			composeEl.height = bh;
		}

		const ctx = composeEl.getContext('2d');
		if (!ctx) return;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, bw, bh);

		// Output units -> device pixels.
		ctx.scale(bw / framed.outW, bh / framed.outH);
		drawOverlayBlock(ctx, {
			innerW: framed.innerW,
			innerH: framed.innerH,
			pad: framed.pad,
			padBottom: framed.padBottom,
			width: framed.outW,
			height: framed.outH,
			hasFrame: !!framed.hex,
			hex: rgbToHex(params.target),
			ink: framed.hex ? inkOn(hexToRgb(framed.hex)) : undefined,
			align,
			showSwatch,
			showCode,
			showMix,
			palette: mixPalette
		});
	});

	/** Whether the overlay preview has anything to draw. */
	const hasOverlays = $derived(showSwatch || showCode || showMix);

</script>

<div class="stage" bind:this={hostEl}>
	{#if source}
		<div
			class="stage__frame"
			style:width={`${fit.w}px`}
			style:height={`${fit.h}px`}
			style:background={framed.hex || 'transparent'}
			style:padding={framed.hex
				? `${Math.round(fit.w * framed.padFrac)}px ${Math.round(fit.w * framed.padFrac)}px ${Math.round(fit.h * framed.padBottomFrac)}px`
				: '0'}
		>
			<div
				class="stage__inner"
				bind:this={boxEl}
				style:aspect-ratio={aspect}
				style:cursor
				onpointerdown={onPointerDown}
				onpointermove={onPointerMove}
				onpointerup={onPointerUp}
				onpointercancel={onPointerUp}
				onpointerleave={onPointerLeave}
				role="application"
				aria-label={t('panel.accent')}
			>
				<canvas bind:this={canvasEl} class="stage__canvas"></canvas>

				{#if compare}
					<!-- Before layer: the untouched photo, clipped to the divider. -->
					<canvas
						class="stage__before"
						bind:this={beforeEl}
						style:clip-path={`inset(0 ${(1 - split) * 100}% 0 0)`}
					></canvas>

					<!--
						The grab area is a narrow strip centred on the divider, not a
						full-stage overlay: covering the whole photo meant every touch
						dragged the divider, fighting the drag-to-pick-color gesture.
					-->
					<div
						class="stage__split"
						style:left={`${split * 100}%`}
						role="slider"
						tabindex="0"
						aria-label={t('compare.handle')}
						aria-valuemin="0"
						aria-valuemax="100"
						aria-valuenow={Math.round(split * 100)}
						onpointerdown={(e) => {
							// Stop the stage handler: without this the same press would
							// also start picking a color.
							e.stopPropagation();
							draggingSplit = true;
							e.currentTarget.setPointerCapture(e.pointerId);
							splitFromEvent(e);
						}}
						onpointermove={(e) => {
							if (!draggingSplit) return;
							e.stopPropagation();
							splitFromEvent(e);
						}}
						onpointerup={(e) => {
							draggingSplit = false;
							try {
								e.currentTarget.releasePointerCapture(e.pointerId);
							} catch {
								/* already released */
							}
						}}
						onkeydown={(e) => {
							// Keyboard control, since this is a slider.
							const step = e.shiftKey ? 0.1 : 0.02;
							if (e.key === 'ArrowLeft') split = Math.max(0, split - step);
							else if (e.key === 'ArrowRight') split = Math.min(1, split + step);
							else if (e.key === 'Home') split = 0;
							else if (e.key === 'End') split = 1;
							else return;
							e.preventDefault();
						}}
					>
						<span class="stage__split-line" aria-hidden="true"></span>
						<span class="stage__split-grip" aria-hidden="true"></span>
					</div>
				{/if}

				{#if hasOverlays}
					<!--
						The swatch / code / mix block, painted as the export paints it. After the
						photo so it draws above it, before the brush ring, magnifier and handles so
						those stay grabbable. The negative inset stretches it to the frame's padding
						box, where `inset: 0` lands exactly where the export puts the block.
					-->
					<canvas
						class="stage__compose"
						bind:this={composeEl}
						style:inset={`-${Math.round(fit.w * framed.padFrac)}px -${Math.round(fit.w * framed.padFrac)}px -${Math.round(fit.h * framed.padBottomFrac)}px`}
						style:width={`${fit.w}px`}
						style:height={`${fit.h}px`}
						aria-hidden="true"
					></canvas>
				{/if}

				{#if showBrushRing}
					<!-- The brush's true size, shown before you commit to a stroke. -->
					<span
						class="stage__brush"
						style:left={`${brushAt.x * 100}%`}
						style:top={`${brushAt.y * 100}%`}
						style:width={`${brushRingPx}px`}
						style:height={`${brushRingPx}px`}
						aria-hidden="true"
					></span>
				{/if}

				{#if showLoupe && pointerView}
					<!-- Magnifier: nearest-neighbour, so the colour read is the colour under
					     the pointer. -->
					<span
						class="stage__loupe"
						class:is-below={loupeBelow}
						style:left={`${Math.min(0.9, Math.max(0.1, pointerView.x)) * 100}%`}
						style:top={`${pointerView.y * 100}%`}
						aria-hidden="true"
					>
						<canvas class="stage__loupe-view" bind:this={loupeEl} width="132" height="132"
						></canvas>
						<span class="stage__loupe-reticle"></span>
					</span>
				{/if}

				{#if glError}
					<p class="stage__error" role="alert">
						{glError === 'nogl' ? t('stage.nogl') : glError}
					</p>
				{/if}

				<svg
					class="stage__overlay"
					viewBox={`0 0 ${px.w} ${px.h}`}
					preserveAspectRatio="none"
				>
					{#if scope === 'part'}
						{#if lassoPath}
							<path class="stage__lasso" d={lassoPath} />
						{/if}
						{#if shape && overlay && (shape.kind === 'rect' || shape.kind === 'circle')}
							<g>
								{#if shape.kind === 'rect'}
									<rect
										class="stage__shape"
										x={-overlay.hw}
										y={-overlay.hh}
										width={overlay.hw * 2}
										height={overlay.hh * 2}
										transform="translate({overlay.cx} {overlay.cy}) rotate({overlay.rad})"
									/>
								{:else}
									<ellipse
										class="stage__shape"
										rx={overlay.hw}
										ry={overlay.hh}
										transform="translate({overlay.cx} {overlay.cy}) rotate({overlay.rad})"
									/>
								{/if}
								<line
									class="stage__link"
									x1={overlay.anchor.x}
									y1={overlay.anchor.y}
									x2={overlay.rotate.x}
									y2={overlay.rotate.y}
								/>
								{#each overlay.corners as c, i (i)}
									<circle class="stage__handle" cx={c.x} cy={c.y} r="7" />
								{/each}
								<circle class="stage__rotate" cx={overlay.rotate.x} cy={overlay.rotate.y} r="10" />
							</g>
						{/if}
					{/if}
				</svg>
			</div>
		</div>
	{:else if loading}
		<!-- Quiet placeholder while the photo decodes; without it the stage flashed the
		     drag-and-drop prompt the arriving photo then replaced, which read as a glitch. -->
		<div class="stage-skeleton" aria-hidden="true">
			<span class="stage-skeleton__dot"></span>
		</div>
	{:else}
		<div
			class="dropzone"
			class:is-over={over}
			role="region"
			aria-label={t('stage.drop')}
			ondragover={(e) => {
				e.preventDefault();
				over = true;
			}}
			ondragleave={() => (over = false)}
			ondrop={(e) => {
				e.preventDefault();
				over = false;
				ondropfile(e.dataTransfer?.files?.[0]);
			}}
		>
			<span style="color: var(--accent)" aria-hidden="true">
				{@html icon('photo')}
			</span>
			<p class="dropzone__text">{t('stage.drop')}</p>
			<button class="btn btn--ghost" onclick={onbrowse}>{t('stage.browse')}</button>
		</div>
	{/if}
</div>

<style>
	.stage {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 100%;
	}

	.stage__frame {
		position: relative;
		border-radius: 12px;
		overflow: hidden;
		line-height: 0;
	}

	.stage__inner {
		position: relative;
		width: 100%;
		touch-action: none;
		user-select: none;
		line-height: 0;
	}

	.stage__canvas {
		width: 100%;
		height: 100%;
		border-radius: 6px;
	}

	.stage__overlay {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		overflow: visible;
		pointer-events: none;
	}

	/* Overlay preview: the swatch / code / mix block at export geometry, spanning the
	   frame's padding box; pointer events stay off so the photo still picks colors.

	   `max-width: none` is load-bearing: `app.css` clamps every canvas to its containing
	   block (the photo box), which slid the block off the frame and onto the image. */
	.stage__compose {
		position: absolute;
		max-width: none;
		pointer-events: none;
	}

	/* Before/after: the original photo clipped to the divider. */
	.stage__before {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		pointer-events: none;
	}

	/* Before/after divider: a narrow strip centred on the split position. Wide enough
	   to grab comfortably, narrow enough that the rest of the photo still receives
	   drag-to-pick-color. */
	.stage__split {
		position: absolute;
		top: 0;
		bottom: 0;
		/* 44px: minimum comfortable touch target. */
		width: 44px;
		margin-left: -22px;
		cursor: ew-resize;
		touch-action: none;
		display: grid;
		place-items: center;
	}

	/* A mouse is precise, so the strip can be narrow and leave more of the photo
	   for picking colors. */
	@media (pointer: fine) {
		.stage__split {
			width: 24px;
			margin-left: -12px;
		}
	}

	.stage__split-line {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 2px;
		background: var(--text);
		box-shadow: 0 0 0 1px rgb(0 0 0 / 0.35);
	}

	.stage__split-grip {
		position: relative;
		width: 32px;
		height: 32px;
		border-radius: 50%;
		background: var(--text);
		box-shadow: 0 2px 10px rgb(0 0 0 / 0.55);
		display: grid;
		place-items: center;
	}

	/* Two small arrows, so the control reads as draggable. */
	.stage__split-grip::before,
	.stage__split-grip::after {
		content: '';
		position: absolute;
		width: 0;
		height: 0;
		border-block: 4px solid transparent;
	}

	.stage__split-grip::before {
		left: 6px;
		border-right: 5px solid var(--ink-000);
	}

	.stage__split-grip::after {
		right: 6px;
		border-left: 5px solid var(--ink-000);
	}

	.stage__split:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
		border-radius: 6px;
	}

	/* Quiet placeholder while a photo decodes, sized so the layout does not jump when
	   the real photo arrives. */
	.stage-skeleton {
		display: grid;
		place-items: center;
		width: 100%;
		min-height: 240px;
		border-radius: 12px;
		background: var(--ink-100);
		box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.05);
	}

	.stage-skeleton__dot {
		width: 26px;
		height: 26px;
		border-radius: 50%;
		border: 2px solid var(--ink-400);
		border-top-color: var(--accent);
		animation: stage-spin 0.7s linear infinite;
	}

	@keyframes stage-spin {
		to {
			transform: rotate(1turn);
		}
	}

	/* Brush size ring, at the pointer. */
	.stage__brush {
		position: absolute;
		transform: translate(-50%, -50%);
		border-radius: 50%;
		box-shadow:
			0 0 0 1.5px rgb(0 0 0 / 0.55),
			inset 0 0 0 1.5px rgb(255 255 255 / 0.9);
		pointer-events: none;
	}

	/* Magnifier. Offset above the pointer so it does not cover what you sample. */
	.stage__loupe {
		position: absolute;
		width: 108px;
		height: 108px;
		transform: translate(-50%, calc(-100% - 18px));
		border-radius: 50%;
		overflow: hidden;
		background: var(--ink-000);
		box-shadow:
			0 0 0 2px rgb(255 255 255 / 0.9),
			0 10px 26px -8px rgb(0 0 0 / 0.8);
		pointer-events: none;
	}

	.stage__loupe.is-below {
		transform: translate(-50%, 18px);
	}

	.stage__loupe-view {
		width: 100%;
		height: 100%;
		display: block;
	}

	/* Marks the exact sampled pixel at the centre. */
	.stage__loupe-reticle {
		position: absolute;
		top: 50%;
		left: 50%;
		width: 11px;
		height: 11px;
		transform: translate(-50%, -50%);
		border-radius: 50%;
		box-shadow:
			0 0 0 1.5px rgb(0 0 0 / 0.6),
			inset 0 0 0 1.5px rgb(255 255 255 / 0.95);
	}

	/* A GL failure must never present as an unexplained black box. */
	.stage__error {
		position: absolute;
		inset: auto 12px 12px 12px;
		padding: 10px 12px;
		border-radius: 10px;
		background: rgb(0 0 0 / 0.8);
		color: #f6f6f8;
		font-family: var(--font-body);
		font-size: var(--t-base);
		line-height: 1.5;
		text-align: left;
	}
</style>
