<script>
	/**
	 * The stage: GL canvas plus an SVG overlay for range editing.
	 *
	 * Geometry lives in normalised image coordinates (0..1, y down), so the same
	 * shape drives the on-screen preview and the full-resolution export.
	 */
	import { Renderer } from '../lib/gl.js';
	import { MaskLayer, shapeHitTest, makeShape, SHAPE_MIN } from '../lib/mask.js';
	import { rgbToHex } from '../lib/color.js';
	import { frameHexFor, framePad } from '../lib/export.js';
	import { icon } from '../lib/icons.js';

	let {
		source = null,
		params,
		scope = 'all',
		shapeKind = 'circle',
		shape = null,
		lasso = [],
		strokes = [],
		brushSize = 0.08,
		onpick = () => {},
		onshape = () => {},
		onlasso = () => {},
		onstroke = () => {},
		ondropfile = () => {},
		onbrowse = () => {},
		t = (k) => k,
		frame = 'none',
		customFrame = '#F6F6F8',
		marginPct = 50,
		compare = false,
		loading = false
	} = $props();

	let canvasEl = $state(null);
	let boxEl = $state(null);
	// $state, not a plain binding: every effect below depends on the renderer
	// existing, and a plain variable would not re-trigger them once it is
	// assigned. That bug shows up as a permanently blank canvas.
	let renderer = $state(null);
	let mask = $state(null);
	/** The source the current mask was built for; identity, not size. */
	let maskFor = null;
	let over = $state(false);
	let glError = $state('');

	/** Position of the before/after divider, 0..1 across the photo. */
	let split = $state(0.5);
	let beforeEl = $state(null);
	let draggingSplit = $state(false);

	// The "before" layer is a one-off 2D snapshot of the untouched source, clipped
	// to the left of the divider. Reusing the GL canvas for it would mean a second
	// WebGL context and a second render per frame; a snapshot costs one drawImage
	// per photo and is exactly the original pixels.
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
		ctx.clearRect(0, 0, w, h);
		ctx.drawImage(source, 0, 0, w, h);
	});

	function splitFromEvent(e) {
		if (!boxEl) return;
		const r = boxEl.getBoundingClientRect();
		split = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
	}
	// Aspect ratio of the loaded photo, in image space.
	const aspect = $derived(source ? source.width / source.height : 1);

	$effect(() => {
		if (!canvasEl) return;
		try {
			renderer = new Renderer(canvasEl);
		} catch (err) {
			console.error(err);
			glError = err?.message?.includes('cannot run WebGL') ? 'nogl' : err?.message || String(err);
			return;
		}
		return () => {
			renderer?.dispose();
			renderer = null;
		};
	});

	// --- render scheduling -------------------------------------------------
	//
	// Everything funnels through one animation frame. Previously three separate
	// effects each called resize() + render(), and a brush drag triggered a
	// repaint per pointermove — so a single drag could push dozens of full
	// redraws plus a multi-megabyte mask upload per event. Coalescing means at
	// most one frame of work per repaint, and pointermove never outpaces it.

	let pendingFrame = 0;

	function schedule() {
		if (pendingFrame) return;
		pendingFrame = requestAnimationFrame(() => {
			pendingFrame = 0;
			draw();
		});
	}

	/**
	 * Repaint the mask layer.
	 *
	 * Strokes only ever grow by appending, so when the change is one more point
	 * on the last stroke, only that segment is drawn. A full `drawAll` clears the
	 * layer and replays every point — during a drag that was the dominant cost,
	 * growing with the length of the stroke.
	 */
	let maskState = { strokes: -1, pts: -1, shape: undefined, lasso: -1 };

	function paintMask() {
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

	function draw() {
		const r = renderer;
		if (!r || !source || !boxEl) return;
		const w = boxEl.clientWidth;
		const h = boxEl.clientHeight;
		if (!w || !h) return;
		r.resize(w, h);

		// The mask is only uploaded when the shader will actually read it. In the
		// default whole-photo mode it is skipped entirely, which is the common case
		// and the bulk of the upload cost.
		if (params.maskOn) {
			if (maskFor !== source) {
				mask = new MaskLayer(source.width, source.height);
				maskFor = source;
				maskState = { strokes: -1, pts: -1, shape: undefined, lasso: -1 };
			}
			paintMask();
			r.setMask(mask.canvas);
		}

		r.setParams(params);
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

	// Track the available width for the stage.
	//
	// Height comes from the viewport, NOT from the host element: the host's height
	// is itself determined by the frame we are about to size, so reading it would
	// be circular and collapse the stage to nothing. The page scrolls, and this
	// cap just stops a tall portrait photo from filling the whole screen.
	let hostEl = $state(null);
	let avail = $state({ w: 0, h: 0 });

	const MAX_STAGE_H = () => Math.min(globalThis.innerHeight * 0.68, 760);

	$effect(() => {
		if (!hostEl) return;
		const measure = () => {
			avail = { w: hostEl.clientWidth, h: MAX_STAGE_H() };
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(hostEl);
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

	/** Map a pointer event to normalised image coordinates. */
	function toImage(e) {
		const r = boxEl.getBoundingClientRect();
		return {
			x: (e.clientX - r.left) / r.width,
			y: (e.clientY - r.top) / r.height
		};
	}

	let drag = $state(null);

	/**
	 * Live pointer position, in normalised image coordinates.
	 *
	 * Drives two overlays the iOS app has and this was missing: a ring showing
	 * the actual brush size before you commit to a stroke, and a loupe so you can
	 * see what you are sampling on a small screen.
	 */
	let pointer = $state(null);
	let loupeEl = $state(null);

	/** Brush diameter in stage pixels, matching how the mask draws it. */
	const brushRingPx = $derived(Math.max(6, brushSize * Math.max(px.w, px.h)));

	/** A brush that can be sized is only useful once a region is being painted. */
	const showBrushRing = $derived(
		pointer !== null && shapeKind === 'brush' && scope === 'part'
	);

	/**
	 * Which side of the pointer the magnifier sits on.
	 *
	 * The framed box clips its overflow, so above-the-pointer would be cut off near
	 * the top edge. Flipping below keeps it whole wherever you touch.
	 */
	const loupeBelow = $derived((pointer?.y ?? 0) < 0.42);

	/** While sampling or painting, show what sits under the pointer, magnified. */
	const showLoupe = $derived(
		pointer !== null &&
			!!source &&
			(drag?.kind === 'pick' || drag?.kind === 'brush')
	);

	// Nearest-neighbour magnification on purpose: this is a colour-sampling aid,
	// and smoothing would blend neighbouring pixels into a colour that is not
	// actually under the pointer.
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
		ctx.imageSmoothingEnabled = false;
		ctx.clearRect(0, 0, size, size);
		ctx.drawImage(source, sx, sy, span, span, 0, 0, size, size);
	});

	function onPointerDown(e) {
		if (!source) return;
		boxEl.setPointerCapture(e.pointerId);
		const p = toImage(e);

		// Region editing is available in both accent and range mode — range is
		// where you shape the region, and accent is where you see its effect.
		if (scope === 'all') {
			drag = { kind: 'pick' };
			onpick(p);
			return;
		}

		if (shapeKind === 'brush') {
			// Emit a fresh stroke list. Copying a few hundred points per pointer
			// move is negligible next to the mask redraw, and keeping this
			// immutable is what makes the parent's reactivity unambiguous.
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
		const handle = hitHandle(p);
		if (handle) {
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

	function onPointerMove(e) {
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
		if (!base) return;
		const dx = p.x - drag.start.x;
		const dy = p.y - drag.start.y;

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
			const sign = drag.index % 2 === 0 ? 1 : -1;
			const signY = drag.index < 2 ? 1 : -1;
			onshape({
				...base,
				w: Math.max(SHAPE_MIN, base.w + lx * sign),
				h: Math.max(SHAPE_MIN, base.h + ly * signY)
			});
		}
	}

	function onPointerLeave() {
		if (!drag) pointer = null;
	}

	function onPointerUp(e) {
		if (drag) {
			if (drag.kind === 'lasso' && lasso.length < 3) onlasso([]);
			drag = null;
		}
		try {
			boxEl.releasePointerCapture(e.pointerId);
		} catch {
			/* pointer already released */
		}
	}

	/** Which resize/rotate handle, if any, is under the pointer. */
	function hitHandle(p) {
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

	// Overlay geometry in PIXELS, not normalised units.
	//
	// The overlay used to be an SVG with viewBox="0 0 1 1" and
	// preserveAspectRatio="none", so a stroke-width of 0.02 scaled differently
	// on x and y — brush strokes came out elliptical instead of round. Emitting
	// pixel coordinates with a 1:1 viewBox makes stroke widths uniform.
	const px = $derived({
		w: fit.w || 1,
		h: fit.h || 1
	});

	const overlay = $derived.by(() => {
		// Only circle and rect have geometry to draw. A stale kind here would be
		// rendered as an ellipse by the JSX fallback below, which is how a lasso
		// could show a circle over the photo.
		if (!shape || (shape.kind !== 'rect' && shape.kind !== 'circle')) return null;
		const W = px.w;
		const H = px.h;
		const cx = shape.cx * W;
		const cy = shape.cy * H;
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
		].map(([lx, ly]) => ({ x: cx + lx * cos - ly * sin, y: cy + lx * sin + ly * cos }));
		const rotate = {
			x: cx + Math.sin(shape.rot || 0) * (-hh - 26),
			y: cy + Math.cos(shape.rot || 0) * (hh + 26)
		};
		const anchor = { x: cx + Math.sin(shape.rot || 0) * -hh, y: cy + Math.cos(shape.rot || 0) * hh };
		return { rad, corners, rotate, anchor, cx, cy, hw, hh };
	});

	const lassoPath = $derived(
		lasso.length > 1
			? lasso.map((p, i) => `${i ? 'L' : 'M'}${p.x * px.w} ${p.y * px.h}`).join(' ') + ' Z'
			: ''
	);

	// Brush strokes: emitted in pixel space with a round cap and a uniform width,
	// which is what makes a paint stroke look like paint.
	const strokePaths = $derived(
		strokes.map((s) => ({
			d: s.pts
				.map((p, i) => `${i ? 'L' : 'M'}${(p.x * px.w).toFixed(1)} ${(p.y * px.h).toFixed(1)}`)
				.join(' '),
			w: Math.max(1, s.size * Math.max(px.w, px.h))
		}))
	);

	const cursor = $derived(
		scope === 'all' || shapeKind === 'brush' || shapeKind === 'lasso' ? 'crosshair' : 'default'
	);

	// Frame preview. Mirrors the export math exactly — same helper, same padding
	// formula — so the framed preview matches the file you get.
	const framed = $derived.by(() => {
		const w = source?.width || 1;
		const h = source?.height || 1;
		const fh = frameHexFor(frame, rgbToHex(params.target), customFrame);
		const pad = fh ? framePad(marginPct) * Math.min(w, h) : 0;
		const outW = w + pad * 2;
		const outH = h + pad * 2;
		// Padding as a fraction of the framed width; scaled to pixels after the
		// letterbox fit, because CSS percentage padding resolves against the
		// containing block's width and would not match this box.
		return { hex: fh, aspect: outW / outH, padFrac: pad / outW };
	});
</script>

<div class="stage" bind:this={hostEl}>
	{#if source}
		<div
			class="stage__frame"
			style:width={`${fit.w}px`}
			style:height={`${fit.h}px`}
			style:background={framed.hex || 'transparent'}
			style:padding={framed.hex ? `${Math.round(fit.w * framed.padFrac)}px` : '0'}
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
						full-stage overlay. Covering the whole photo meant every touch
						dragged the divider, which fought the drag-to-pick-color gesture.
						Only this strip takes pointer events; the rest of the photo is
						still the color picker.
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

			{#if showBrushRing && pointer}
				<!-- The brush's true size, shown before you commit to a stroke. -->
				<span
					class="stage__brush"
					style:left={`${pointer.x * 100}%`}
					style:top={`${pointer.y * 100}%`}
					style:width={`${brushRingPx}px`}
					style:height={`${brushRingPx}px`}
					aria-hidden="true"
				></span>
			{/if}

			{#if showLoupe && pointer}
				<!-- Magnifier: nearest-neighbour, so the colour you read is the colour
				     actually under the pointer. -->
				<span
					class="stage__loupe"
					class:is-below={loupeBelow}
					style:left={`${Math.min(0.9, Math.max(0.1, pointer.x)) * 100}%`}
					style:top={`${pointer.y * 100}%`}
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
						{#if strokePaths.length}
							{#each strokePaths as s, i (i)}
								<path
									class="stage__path"
									d={s.d}
									stroke-width={s.w}
									stroke-linecap="round"
									stroke-linejoin="round"
									fill="none"
								/>
							{/each}
						{/if}
						{#if lassoPath}
							<path class="stage__path" d={lassoPath} />
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
		<!-- A quiet placeholder while the photo decodes. Without this the stage
		     flashed the drag-and-drop prompt, which the arriving photo then
		     replaced — it read as a glitch, and it certainly was one. -->
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

	/* Before/after: the original photo clipped to the divider. */
	.stage__before {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		pointer-events: none;
	}

	/* Before/after divider. The element is a narrow strip centred on the split
	   position: wide enough to grab comfortably (44px on touch, per the minimum
	   target size), narrow enough that the rest of the photo still receives
	   drag-to-pick-color. */
	.stage__split {
		position: absolute;
		top: 0;
		bottom: 0;
		/* 44px is the minimum comfortable touch target. */
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

	/* Quiet placeholder while a photo decodes. Sized to the stage so the layout
	   does not jump when the real photo arrives. */
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
		font-size: 0.8rem;
		line-height: 1.5;
		text-align: left;
	}
</style>
