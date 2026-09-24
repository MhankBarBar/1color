<script lang="ts">
	/**
	 * The editor, laid out the way the iOS app is: the photo is the hero, a
	 * compact panel sits directly beneath it, and the mode switcher is a row of
	 * circular buttons at the bottom — the app's own navigation idiom.
	 *
	 * Only the active mode's controls are rendered. Showing every control at once
	 * is what produced a tall scrolling column where the important things (the
	 * photo, Save) scrolled out of view.
	 */
	import Stage from './Stage.svelte';
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

	/**
	 * Whether the brush size slider is being dragged.
	 *
	 * Drives the ring on the photo, so the size is shown while it is being chosen
	 * instead of only under the pointer. Cleared on release, and on a short timer so
	 * a keyboard user sees it too.
	 */
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
	let showCode = $state(true);
	let showMix = $state(false);

	let recent = $state<Rgb[]>([]);
	let busy = $state(false);
	let toast = $state('');
	/** Lets the photo take the full card when you just want to look at it. */
	let panelOpen = $state(true);
	/** Before/after split view over the photo. */
	let compare = $state(false);

	/**
	 * Whether this browser can actually share a file.
	 *
	 * Detected rather than assumed: on desktop browsers `navigator.share` does
	 * not accept files, so the Share button fell back to downloading — leaving
	 * two buttons that did exactly the same thing. It is only shown where it
	 * does something different from Save.
	 */
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
		['custom', 'out.frame.custom']
	];

	// Where the swatch / code / mix block sits across the band.
	const ALIGNS: Array<[Align, string]> = [
		['left', 'out.align.left'],
		['center', 'out.align.center'],
		['right', 'out.align.right']
	];

	// Four modes, mirroring the app's mode row plus its output screen.
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

	/** The active mode's entry. Falls back to the first, so the panel header always
	 *  has an icon and a label — the inline `find` returned a maybe-undefined and
	 *  the markup dereferenced it twice. */
	const activeMode = $derived(MODES.find((m) => m.id === mode) ?? MODES[0]);

	const palette = $derived(sampler ? sampler.palette : []);
	const ratioList = $derived([{ id: 'original' }, ...RATIOS.slice(1)]);

	/**
	 * Lowest margin that still leaves the overlay block legible.
	 *
	 * Below this the band would be too short for the code to be readable, so the
	 * slider starts here rather than offering a range that does nothing. The band
	 * used to be floored at the block's height instead, which made the whole slider
	 * inert — the floor was larger than anything the slider could request.
	 */
	const minMargin = $derived(
		frame === 'none' ? 0 : overlayMinMargin({ showSwatch, showCode, showMix })
	);

	// Keep the band legible when the overlays change under an already-low margin.
	// Only when there is a frame: without one the margin does nothing, and moving
	// the slider would look like a glitch.
	$effect(() => {
		const floor = minMargin;
		if (margin < floor) margin = floor;
	});

	// Tint the page to the sampled color.
	$effect(() => {
		if (!source) return;
		onaccent({ hex, coverage });
	});

	/**
	 * Seed the edit when a photo arrives.
	 *
	 * Guarded by sampler identity rather than running on every dependency change.
	 * It previously read `shapeKind`, so merely switching tool re-ran it — which
	 * rebuilt a shape for the new tool (making the lasso draw a circle, since the
	 * overlay renders any non-rect shape as an ellipse) and discarded the region
	 * you had just drawn.
	 */
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

	// Keep the shape's kind in step with the tool, but only for the two tools that
	// have one. Without the guard this would resurrect a shape for lasso/brush,
	// which the overlay renders as an ellipse.
	$effect(() => {
		if (!shape || !SHAPE_TOOLS.includes(shapeKind)) return;
		// `SHAPE_TOOLS` holds only the two parametric tools, so this narrowing is
		// real: lasso and brush never reach here, and a `Shape` can only be one of
		// these two kinds.
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
		showCode = true;
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
		<span class="editor__coverage">{(coverage * 100).toFixed(0)}%</span>

		<div class="editor__bar-actions">
			<button
				class="iconbtn tip tip--end"
				data-tip={t('out.save')}
				onclick={save}
				disabled={!source || busy}
			>
				{@html icon('save')}
				<span class="sr">{t('out.save')}</span>
			</button>
			{#if canShare}
				<button
					class="iconbtn tip tip--end"
					data-tip={t('out.share')}
					onclick={share}
					disabled={!source || busy}
				>
					{@html icon('share')}
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
				{@html icon('compare')}
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

	<!-- One panel, showing only the active mode's controls. -->

	{#if toast}
		<p class="toast" role="status">{toast}</p>
	{/if}

	<!-- Mode switcher, as circular buttons — the app's own navigation. -->
	<div class="modes">
		{#each MODES as m (m.id)}
			<button
				class="mode"
				class:is-on={mode === m.id}
				onclick={() => {
					mode = m.id;
					panelOpen = true;
				}}
			>
				<span class="mode__disc" aria-hidden="true">{@html icon(m.icon)}</span>
				{t(m.key)}
			</button>
		{/each}
	</div>

{#if panelOpen}
		<div class="panel">
			<button class="panel__head" onclick={() => (panelOpen = false)} aria-expanded="true">
				<span class="panel__icon" aria-hidden="true">{@html icon(activeMode.icon)}</span>
				<span class="panel__title">{t(activeMode.key)}</span>
				<span class="panel__chevron" aria-hidden="true">{@html icon('chevronDown')}</span>
			</button>

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
							<!-- The floor keeps the band tall enough to hold the overlay
							     block; below it the slider would move and nothing would
							     change, which reads as a broken control. -->
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
	{:else}
		<button class="panel__collapsed" onclick={() => (panelOpen = true)}>
			{t(activeMode.key)}
		</button>
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
		width: 34px;
		height: 34px;
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

	.panel__chevron {
		width: 15px;
		height: 15px;
		margin-left: auto;
		color: var(--text-faint);
		transform: rotate(180deg);
	}

	.panel__collapsed {
		width: 100%;
		padding: 11px 16px;
		border-top: 1px solid rgb(255 255 255 / 0.06);
		background: var(--ink-050);
		color: var(--text-dim);
		font-size: 0.82rem;
		text-align: left;
	}

	.panel__collapsed:hover {
		color: var(--text);
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
