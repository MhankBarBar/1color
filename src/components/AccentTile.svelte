<script lang="ts">
	/** One tile in the comparison strip: the same photo, one accent. Renders through the
	 *  shared offscreen renderer in gl.ts, so it holds no GPU state and costs nothing idle.
	 *  Sized to the photo's aspect ratio — a fixed ratio stretched every photo. */
	import { renderThumbnail } from '../lib/gl.js';
	import { rgbToHex } from '../lib/color.js';
	import type { Rgb, TextureSource } from '../lib/types.js';

	let {
		source,
		target,
		label = '',
		width = 34,
		feather = 35,
		plain = false,
		bare = false
	}: {
		source: TextureSource;
		target: Rgb;
		label?: string;
		width?: number;
		feather?: number;
		/** Draw the photo untouched: the "original" tile, which makes the "one photo"
		 *  claim checkable. */
		plain?: boolean;
		/** Photo only, no caption row. The showcase draws its own caption; two of them put
		 *  a chip and hex code inside the frame's rounded corners, where they clipped. */
		bare?: boolean;
	} = $props();

	let canvasEl = $state<HTMLCanvasElement | null>(null);
	let lastKey = '';

	const hex = $derived(rgbToHex(target));
	const aspect = $derived(source ? `${source.width} / ${source.height}` : '3 / 4');

	$effect(() => {
		if (!canvasEl || !source) return;
		const canvas = canvasEl;

		const paint = (): void => {
			const w = canvas.clientWidth;
			const h = canvas.clientHeight;
			if (!w || !h) return;
			const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
			const pw = Math.round(w * dpr);
			const ph = Math.round(h * dpr);
			// Skip only when nothing affecting the pixels changed — the accent is part of
			// the key, so re-picking a color does repaint.
			const key = `${pw}x${ph}:${hex}:${width}:${feather}:${plain}`;
			if (key === lastKey) return;
			lastKey = key;
			canvas.width = pw;
			canvas.height = ph;
			const ctx = canvas.getContext('2d');
			if (!ctx) return;
			if (plain) {
				// Straight draw, no GL round-trip: the untouched photo has nothing to
				// compute and is only ever one tile.
				ctx.drawImage(source as CanvasImageSource, 0, 0, pw, ph);
				return;
			}
			const rendered = renderThumbnail(
				source,
				{ target, width, feather, tone: 0, contrast: 0, preset: 0 },
				pw,
				ph
			);
			ctx.drawImage(rendered, 0, 0);
		};

		paint();
		const ro = new ResizeObserver(paint);
		ro.observe(canvas);
		return () => {
			ro.disconnect();
			lastKey = '';
		};
	});
</script>

<figure class="compare__figure" style:aspect-ratio={aspect}>
	<canvas bind:this={canvasEl}></canvas>
</figure>
{#if !bare}
	{#if plain}
		<!-- The original is labelled but carries no chip or code: it has no accent to
		     report, and the label is what makes the comparison readable. -->
		<div class="compare__meta">
			<span class="compare__label">{label}</span>
		</div>
	{:else}
		<div class="compare__meta">
			<span class="compare__chip" style:background={hex} aria-hidden="true"></span>
			<span class="compare__label">{label}</span>
			<span class="compare__hex">{hex}</span>
		</div>
	{/if}
{/if}
