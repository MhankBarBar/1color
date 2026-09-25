<script lang="ts">
	/** The editor: photo as hero, a compact panel beneath it, circular mode buttons at
	 *  the bottom. Only the active mode's controls render — showing them all pushed the
	 *  photo and Save out of view. */
	import Stage from './Stage.svelte';
	import { tick } from 'svelte';
	import { icon } from '../lib/icons.js';
	import { rgbToHex, pushRecent } from '../lib/color.js';
	import { shapeForTool, SHAPE_TOOLS } from '../lib/mask.js';
	import { exportComposite, downloadBlob, shareBlob, RATIOS, overlayMinMargin } from '../lib/export.js';
	import type { ExportResult } from '../lib/export.js';
	import type { Sampler } from '../lib/analysis.js';
	import type {
		Align,
		FrameId,
		PixelSource,
		Point,
		QualityId,
		Rgb,
		Size,
		Shape,
		ShapeKind,
		Stroke
	} from '../lib/types.js';

	/** The four control panels, mirroring the app's mode row plus its output screen. */
	type Mode = 'accent' | 'range' | 'mono' | 'output';

	/** Whether the region tools apply to the whole photo or a drawn part of it. */
	type Scope = 'all' | 'part';

	let {
		source = null,
		sampler = null,
		loading = false,
		t = (k: string) => k,
		onopen = () => {},
		onaccent = (_a: { hex: string; coverage: number }) => {}
	}: {
		source?: PixelSource | null;
		sampler?: Sampler | null;
		loading?: boolean;
		t?: (key: string) => string;
		onopen?: () => void;
		onaccent?: (accent: { hex: string; coverage: number }) => void;
	} = $props();

	// --- edit state --------------------------------------------------------

	let mode = $state<Mode>('accent');
	let scope = $state<Scope>('all');
	let shapeKind = $state<ShapeKind>('circle');
	let shape = $state<Shape | null>(null);
	let lasso = $state<Point[]>([]);
	let strokes = $state<Stroke[]>([]);
	let brushSize = $state(0.08);

	/** Whether the brush size slider is being dragged: drives the ring on the photo so
	 *  the size shows while it is chosen, and on a short timer so keyboard users see it. */
	let brushHint = $state(false);
	let brushHintTimer = 0;

	function showBrushHint(): void {
		brushHint = true;
		clearTimeout(brushHintTimer);
		brushHintTimer = setTimeout(() => (brushHint = false), 900);
	}

	function hideBrushHint(): void {
		clearTimeout(brushHintTimer);
		brushHint = false;
	}

	$effect(() => () => clearTimeout(brushHintTimer));

	let target = $state<Rgb>({ r: 252, g: 192, b: 0 });
	let width = $state(30);
	let feather = $state(40);

	let preset = $state(0);
	let tone = $state(0);
	let contrast = $state(0);

	let frame = $state<FrameId>('none');
	let customFrame = $state('#F6F6F8');
	let margin = $state(50);
	let ratio = $state('original');
	let quality = $state<QualityId>('std');
	let align = $state<Align>('left');
	let showSwatch = $state(false);
	// Off by default: it used to start on, so every export carried a hex string nobody
	// asked for. An overlay is a choice, not a default.
	let showCode = $state(false);
	let showMix = $state(false);

	let recent = $state<Rgb[]>([]);
	let busy = $state(false);
	let toast = $state('');
	/** Lets the photo take the full card when you just want to look at it. */
	let panelOpen = $state(true);
	/** Before/after split view over the photo. */
	let compare = $state(false);

	/** Whether this browser can actually share a file. Detected, not assumed: desktop
	 *  `navigator.share` rejects files, leaving Share identical to Save. */
	let canShare = $state(false);

	$effect(() => {
		try {
			const probe = new File([new Uint8Array(1)], 'probe.png', { type: 'image/png' });
			canShare = !!navigator.canShare?.({ files: [probe] });
		} catch {
			canShare = false;
		}
	});

	const PRESETS: Array<{ id: number; key: string }> = [
		{ id: 0, key: 'mono.standard' },
		{ id: 1, key: 'mono.soft' },
		{ id: 2, key: 'mono.deep' },
		{ id: 3, key: 'mono.high' }
	];

	const SHAPES: Array<{ id: ShapeKind; key: string; icon: 'circle' | 'square' | 'lasso' | 'brush' }> = [
		{ id: 'circle', key: 'range.circle', icon: 'circle' },
		{ id: 'rect', key: 'range.square', icon: 'square' },
		{ id: 'lasso', key: 'range.lasso', icon: 'lasso' },
		{ id: 'brush', key: 'range.brush', icon: 'brush' }
	];

	const FRAMES: Array<[FrameId, string]> = [
		['none', 'out.frame.none'],
		['white', 'out.frame.white'],
		['black', 'out.frame.black'],
		['accent', 'out.frame.accent'],
		['custom', 'out.frame.custom'],
		['cheki', 'out.frame.cheki']
	];

	// Where the swatch / code / mix block sits across the band.
	const ALIGNS: Array<[Align, string]> = [
		['left', 'out.align.left'],
		['center', 'out.align.center'],
		['right', 'out.align.right']
	];

	const MODES: Array<{ id: Mode; key: string; icon: 'accent' | 'range' | 'mono' | 'output' }> = [
		{ id: 'accent', key: 'panel.accent', icon: 'accent' },
		{ id: 'range', key: 'panel.range', icon: 'range' },
		{ id: 'mono', key: 'panel.mono', icon: 'mono' },
		{ id: 'output', key: 'panel.output', icon: 'output' }
	];

	// --- derived -----------------------------------------------------------

	const params = $derived({
		target,
		width,
		feather,
		tone,
		contrast,
		preset,
		maskOn: scope === 'part' ? 1 : 0
	});

	const hex = $derived(rgbToHex(target));

	const coverage = $derived.by(() => (sampler ? sampler.coverage(target, width, feather) : 0));

	const palette = $derived(sampler ? sampler.palette : []);
	const ratioList = $derived([{ id: 'original' }, ...RATIOS.slice(1)]);

	/** Lowest margin that still leaves the overlay block legible. The band used to be
	 *  floored at the block's height instead — larger than anything the slider could
	 *  request, which made the whole slider inert. */
	const minMargin = $derived(
		frame === 'none' ? 0 : overlayMinMargin({ showSwatch, showCode, showMix })
	);

	// Keep the band legible when the overlays change under an already-low margin. Only
	// with a frame: without one the margin does nothing, so moving the slider would look
	// like a glitch.
	$effect(() => {
		const floor = minMargin;
		if (margin < floor) margin = floor;
	});

	// Tint the page to the sampled color.
	$effect(() => {
		if (!source) return;
		onaccent({ hex, coverage });
	});

	/** Seed the edit when a photo arrives, guarded by sampler identity. Reading
	 *  `shapeKind` re-ran it on every tool switch, rebuilding a shape for the new tool (a
	 *  circle for the lasso, since the overlay draws non-rect shapes as ellipses). */
	let seededFor: Sampler | null = null;
	$effect(() => {
		const s = sampler;
		if (!s || seededFor === s) return;
		seededFor = s;
		target = s.suggestedAccent();
		shape = shapeForTool(shapeKind);
		lasso = [];
		strokes = [];
		recent = [];
	});

	// Keep the shape's kind in step with the tool, only for the two tools that have one.
	// Without the guard this would resurrect a shape for lasso/brush, which the overlay
	// renders as an ellipse.
	$effect(() => {
		if (!shape || !SHAPE_TOOLS.includes(shapeKind)) return;
		// SHAPE_TOOLS holds only the two parametric tools, so this narrowing is real.
		if (shapeKind !== 'circle' && shapeKind !== 'rect') return;
		if ((shapeKind === 'rect') !== (shape.kind === 'rect')) shape = { ...shape, kind: shapeKind };
	});

	// --- actions -----------------------------------------------------------

	function pick(p: Point): void {
		if (!sampler) return;
		const rgb = sampler.pickAt(p.x, p.y);
		target = rgb;
		recent = pushRecent(recent, rgb, 8);
	}

	function setAccent(rgb: Rgb): void {
		target = rgb;
		recent = pushRecent(recent, rgb, 8);
	}

	function chooseShape(id: ShapeKind): void {
		shapeKind = id;
		lasso = [];
		strokes = [];
		// Null for lasso and brush: they mask from points, not from a shape.
		shape = shapeForTool(id);
	}

	function clearRegion(): void {
		shape = null;
		lasso = [];
		strokes = [];
	}

	function reset(): void {
		width = 30;
		feather = 40;
		tone = 0;
		contrast = 0;
		preset = 0;
		scope = 'all';
		frame = 'none';
		margin = 50;
		ratio = 'original';
		quality = 'std';
		align = 'left';
		showSwatch = false;
		showCode = false;
		showMix = false;
		chooseShape('circle');
		if (sampler) target = sampler.suggestedAccent();
		recent = [];
		toast = '';
	}

	function flash(message: string): void {
		toast = message;
		setTimeout(() => {
			if (toast === message) toast = '';
		}, 2200);
	}

	async function build(): Promise<ExportResult> {
		if (!source) throw new Error('Nothing to export.');
		return exportComposite({
			source: source as PixelSource & Size,
			params,
			maskSpec: { shape, lasso, strokes },
			frame,
			customFrame,
			margin,
			ratio,
			quality,
			align,
			showSwatch,
			showCode,
			showMix,
			mixPalette: palette.slice(0, 6)
		});
	}

	async function save(): Promise<void> {
		if (!source || busy) return;
		busy = true;
		try {
			const { blob } = await build();
			downloadBlob(blob, `1color-${hex.replace('#', '').toLowerCase()}.png`);
			flash(t('out.saved'));
		} catch (err) {
			console.error(err);
			flash(t('out.failed'));
		} finally {
			busy = false;
		}
	}

	async function share(): Promise<void> {
		if (!source || busy) return;
		busy = true;
		try {
			const { blob } = await build();
			const how = await shareBlob(blob, `1color-${hex.replace('#', '').toLowerCase()}.png`, '1color');
			if (how !== 'cancelled') flash(t('out.shared'));
		} catch (err) {
			console.error(err);
			flash(t('out.failed'));
		} finally {
			busy = false;
		}
	}
</script>

<div class="editor">
	<!-- Top bar: the sampled color, how much survives, and the two exits. -->
	<div class="editor__bar">
		<span class="editor__swatch" style:background={hex} aria-hidden="true"></span>
		<span class="editor__hex">{hex}</span>
		<!-- The gesture instruction belongs beside the surface it describes. In the hero
		     copy it sat four rows from the photo as the faintest text on the page. -->
		<span class="editor__hint">
			<span class="editor__hint-icon" aria-hidden="true">{@html icon('hand')}</span>
			{t('stage.hint')}
		</span>

		<div class="editor__bar-actions">
			<button
				class="iconbtn tip tip--end"
				data-tip={t('out.save')}
				onclick={save}
				disabled={!source || busy}
			>
				<span aria-hidden="true">{@html icon('save')}</span>
				<span class="sr">{t('out.save')}</span>
			</button>
			{#if canShare}
				<button
					class="iconbtn tip tip--end"
					data-tip={t('out.share')}
					onclick={share}
					disabled={!source || busy}
				>
					<span aria-hidden="true">{@html icon('share')}</span>
					<span class="sr">{t('out.share')}</span>
				</button>
			{/if}
			<button
				class="iconbtn tip tip--end"
				class:is-on={compare}
				data-tip={t('compare.toggle')}
				onclick={() => (compare = !compare)}
				aria-pressed={compare}
			>
				<span aria-hidden="true">{@html icon('compare')}</span>
				<span class="sr">{t('compare.toggle')}</span>
			</button>
		</div>
	</div>

	<div class="editor__stage">
		<Stage
			{source}
			{params}
			{scope}
			{shapeKind}
			{shape}
			{lasso}
			{strokes}
			{brushSize}
			{brushHint}
			{t}
			{frame}
			{customFrame}
			marginPct={margin}
			{ratio}
			{align}
			{showSwatch}
			{showCode}
			{showMix}
			mixPalette={palette.slice(0, 6)}
			{loading}
			{compare}
			onpick={pick}
			onshape={(s) => (shape = s)}
			onlasso={(l) => (lasso = l)}
			onstroke={(s) => (strokes = s)}
			ondropfile={onopen}
			onbrowse={onopen}
		/>
	</div>

	{#if toast}
		<p class="toast" role="status">{toast}</p>
	{/if}

	<div class="modes">
		{#each MODES as m (m.id)}
			<button
				class="mode"
				class:is-on={mode === m.id}
				aria-expanded={mode === m.id ? panelOpen : undefined}
				onclick={(e) => {
					// Switching mode must also show the controls: folding is the grip's
					// job, and when this was the only way back, closing the panel left no
					// visible affordance to reopen it.
					const row = e.currentTarget.parentElement;
					const before = row ? row.getBoundingClientRect().top : 0;
					mode = m.id;
					panelOpen = true;
					if (row) {
						void tick().then(() => {
							const after = row.getBoundingClientRect().top;
							if (after !== before) scrollBy(0, after - before);
						});
					}
				}}
			>
				<span class="mode__disc" aria-hidden="true">{@html icon(m.icon)}</span>
				{t(m.key)}
			</button>
		{/each}
	</div>

	<!--
		The fold handle. It sits outside the panel's `{#if}` deliberately: inside it,
		closing the panel removed the control that reopens it. A grab bar, not a title
		bar — the mode row above already names the active mode.
	-->
	<button
		class="panel__grip"
		class:is-open={panelOpen}
		onclick={() => (panelOpen = !panelOpen)}
		aria-expanded={panelOpen}
		aria-controls="editor-panel"
	>
		<span class="panel__grip-chevron" aria-hidden="true">{@html icon('chevronDown')}</span>
		<span class="panel__grip-label">{panelOpen ? t('panel.hide') : t('panel.show')}</span>
	</button>

	{#if panelOpen}
		<div class="panel" id="editor-panel">
			<div class="panel__body">
				{#if mode === 'accent'}
					{#if recent.length}
						<p class="panel__label">{t('accent.recent')}</p>
						<div class="swatches">
							{#each recent as c, i (i)}
								<button
									class="swatch"
									class:is-on={rgbToHex(c) === hex}
									style:background={rgbToHex(c)}
									onclick={() => setAccent(c)}
									aria-label={rgbToHex(c)}
								></button>
							{/each}
						</div>
					{/if}

					<p class="panel__label">{t('accent.palette')}</p>
					<div class="swatches">
						{#each palette as c, i (i)}
							<button
								class="swatch"
								class:is-on={rgbToHex(c) === hex}
								style:background={rgbToHex(c)}
								onclick={() => setAccent(c)}
								aria-label={rgbToHex(c)}
							></button>
						{/each}
					</div>

					<label class="slider">
						<span class="slider__row">
							<span>{t('accent.width')}</span>
							<span class="mono">{width}</span>
						</span>
						<input type="range" min="0" max="100" bind:value={width} />
					</label>

					<label class="slider">
						<span class="slider__row">
							<span>{t('accent.feather')}</span>
							<span class="mono">{feather}</span>
						</span>
						<input type="range" min="0" max="100" bind:value={feather} />
					</label>

					<!-- Coverage, next to the two controls that set it. In the top bar it
					     was an unlabelled number. -->
					<p class="panel__readout">
						<span>{t('editor.coverage')}</span>
						<span class="mono">{(coverage * 100).toFixed(0)}%</span>
					</p>
				{/if}

				{#if mode === 'range'}
					<div class="seg">
						<button class="seg__opt" class:is-on={scope === 'all'} onclick={() => (scope = 'all')}>
							{t('range.all')}
						</button>
						<button class="seg__opt" class:is-on={scope === 'part'} onclick={() => (scope = 'part')}>
							{t('range.part')}
						</button>
					</div>

					{#if scope === 'part'}
						<div class="shapes">
							{#each SHAPES as s (s.id)}
								<button class="shape" class:is-on={shapeKind === s.id} onclick={() => chooseShape(s.id)}>
									<span class="shape__disc" aria-hidden="true">{@html icon(s.icon)}</span>
									{t(s.key)}
								</button>
							{/each}
						</div>

						{#if shapeKind === 'brush'}
							<label class="slider">
								<span class="slider__row">
									<span>{t('range.brushSize')}</span>
									<span class="mono">{Math.round(brushSize * 100)}</span>
								</span>
								<input
									type="range"
									min="2"
									max="30"
									value={Math.round(brushSize * 100)}
									oninput={(e) => {
										brushSize = Number(e.currentTarget.value) / 100;
										showBrushHint();
									}}
									onchange={hideBrushHint}
								/>
							</label>
						{/if}

						<button class="btn btn--quiet" onclick={clearRegion}>{t('range.clear')}</button>
					{/if}
				{/if}

				{#if mode === 'mono'}
					<div class="seg">
						{#each PRESETS as p (p.id)}
							<button class="seg__opt" class:is-on={preset === p.id} onclick={() => (preset = p.id)}>
								{t(p.key)}
							</button>
						{/each}
					</div>

					<label class="slider">
						<span class="slider__row">
							<span>{t('mono.tone')}</span>
							<span class="mono">{tone > 0 ? `+${tone}` : tone}</span>
						</span>
						<input type="range" min="-50" max="50" bind:value={tone} />
					</label>

					<label class="slider">
						<span class="slider__row">
							<span>{t('mono.contrast')}</span>
							<span class="mono">{contrast > 0 ? `+${contrast}` : contrast}</span>
						</span>
						<input type="range" min="-100" max="100" bind:value={contrast} />
					</label>
				{/if}

				{#if mode === 'output'}
					<p class="panel__label">{t('out.frame')}</p>
					<div class="seg">
						{#each FRAMES as [id, key] (id)}
							<button class="seg__opt" class:is-on={frame === id} onclick={() => (frame = id)}>
								{t(key)}
							</button>
						{/each}
					</div>

					{#if frame === 'custom'}
						<label class="frame-pick">
							<input type="color" bind:value={customFrame} />
							<span class="mono">{customFrame.toUpperCase()}</span>
						</label>
					{/if}

					{#if frame !== 'none'}
						<label class="slider">
							<span class="slider__row">
								<span>{t('out.margin')}</span>
								<span class="mono">{margin}</span>
							</span>
							<!-- min={minMargin} keeps the band tall enough for the overlay
							     block; below the floor the slider would move and nothing
							     would change. -->
							<input type="range" min={minMargin} max="100" bind:value={margin} />
						</label>
					{/if}

					<p class="panel__label">{t('out.overlays')}</p>
					<div class="chips">
						<button class="chip" class:is-on={showSwatch} onclick={() => (showSwatch = !showSwatch)}>
							{t('out.swatch')}
						</button>
						<button class="chip" class:is-on={showCode} onclick={() => (showCode = !showCode)}>
							{t('out.code')}
						</button>
						<button class="chip" class:is-on={showMix} onclick={() => (showMix = !showMix)}>
							{t('out.comp')}
						</button>
					</div>

					{#if showSwatch || showCode || showMix}
						<p class="panel__label">{t('out.align')}</p>
						<div class="seg">
							{#each ALIGNS as [id, key] (id)}
								<button class="seg__opt" class:is-on={align === id} onclick={() => (align = id)}>
									{t(key)}
								</button>
							{/each}
						</div>
					{/if}

					<p class="panel__label">{t('out.ratio')}</p>
					<div class="ratios">
						{#each ratioList as r (r.id)}
							<button class="ratio" class:is-on={ratio === r.id} onclick={() => (ratio = r.id)}>
								{r.id === 'original' ? t('out.ratio.original') : r.id}
							</button>
						{/each}
					</div>

					<p class="panel__label">{t('out.quality')}</p>
					<div class="seg">
						<button class="seg__opt" class:is-on={quality === 'std'} onclick={() => (quality = 'std')}>
							{t('out.quality.std')}
						</button>
						<button class="seg__opt" class:is-on={quality === 'max'} onclick={() => (quality = 'max')}>
							{t('out.quality.max')}
						</button>
					</div>

					<button class="btn btn--quiet" onclick={reset}>{t('out.reset')}</button>
				{/if}

			</div>
		</div>
	{/if}
</div>

<style>
	.editor__bar-actions {
		margin-left: auto;
		display: flex;
		gap: 6px;
	}

	/* Icon-only button with an accessible name; matches the app's round controls. */
	.iconbtn {
		/* From the shared variable so the touch breakpoint in app.css can grow it.
		   `padding: 0` and `flex: none` are load-bearing: browser default padding made
		   the circle an oval, and the flex row could shrink it. */
		width: var(--iconbtn-size);
		height: var(--iconbtn-size);
		flex: none;
		padding: 0;
		border-radius: 50%;
		background: var(--ink-200);
		display: grid;
		place-items: center;
		color: var(--text);
		transition: background 0.2s;
	}

	.iconbtn:hover {
		background: var(--ink-300);
	}

	.iconbtn.is-on {
		background: var(--accent);
		color: var(--accent-ink);
	}

	.iconbtn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}

	.frame-pick {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-top: 10px;
	}

	.frame-pick input {
		width: 36px;
		height: 28px;
		padding: 0;
		border: 0;
		border-radius: 8px;
		background: none;
		cursor: pointer;
		box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.25);
	}

	.frame-pick input::-webkit-color-swatch-wrapper {
		padding: 2px;
	}

	.frame-pick input::-webkit-color-swatch {
		border: 0;
		border-radius: 6px;
	}
</style>
