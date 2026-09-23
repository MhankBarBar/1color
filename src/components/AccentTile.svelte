<script>
	/**
	 * One tile in the comparison strip: the same photo, one accent.
	 *
	 * Renders through the shared offscreen renderer in gl.js rather than owning a
	 * WebGL context, and paints the result into a plain 2D canvas — so the tile
	 * holds no GPU state and costs nothing while idle.
	 *
	 * The canvas is sized to the photo's own aspect ratio. A fixed ratio here
	 * stretched every photo to fit the tile, which is exactly wrong for a
	 * showcase whose whole point is the photograph.
	 */
	import { renderThumbnail } from '../lib/gl.js';
	import { rgbToHex } from '../lib/color.js';

	let { source, target, label = '', width = 34, feather = 35 } = $props();

	let canvasEl = $state(null);
	let lastKey = '';

	const hex = $derived(rgbToHex(target));
	const aspect = $derived(source ? `${source.width} / ${source.height}` : '3 / 4');

	$effect(() => {
		if (!canvasEl || !source) return;

		const paint = () => {
			const w = canvasEl.clientWidth;
			const h = canvasEl.clientHeight;
			if (!w || !h) return;
			const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
			const pw = Math.round(w * dpr);
			const ph = Math.round(h * dpr);
			// Skip only when nothing that affects the pixels has changed — the
			// accent is part of the key, so re-picking a color does repaint.
			const key = `${pw}x${ph}:${hex}:${width}:${feather}`;
			if (key === lastKey) return;
			lastKey = key;
			canvasEl.width = pw;
			canvasEl.height = ph;
			const rendered = renderThumbnail(
				source,
				{ target, width, feather, tone: 0, contrast: 0, preset: 0 },
				pw,
				ph
			);
			canvasEl.getContext('2d').drawImage(rendered, 0, 0);
		};

		paint();
		const ro = new ResizeObserver(paint);
		ro.observe(canvasEl);
		return () => {
			ro.disconnect();
			lastKey = '';
		};
	});
</script>

<figure class="compare__figure" style:aspect-ratio={aspect}>
	<canvas bind:this={canvasEl}></canvas>
</figure>
<div class="compare__meta">
	<span class="compare__chip" style:background={hex} aria-hidden="true"></span>
	<span class="compare__label">{label}</span>
	<span class="compare__hex">{hex}</span>
</div>
