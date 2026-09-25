<script lang="ts">
	/**
	 * Live camera: the same shader driven by the video feed.
	 *
	 * The video never leaves the device — it is uploaded straight to a GL texture
	 * and drawn locally. Capture renders one frame at the camera's own resolution
	 * and hands it to the editor.
	 */
	import { Renderer } from '../lib/gl.js';
	import { rgbToHex } from '../lib/color.js';
	import { icon } from '../lib/icons.js';
	import type { Rgb } from '../lib/types.js';

	let {
		t = (k: string) => k,
		oncapture = (_blob: Blob) => {}
	}: {
		t?: (key: string) => string;
		oncapture?: (blob: Blob) => void;
	} = $props();

	// The markup branches on these exact strings, so they are a union rather
	// than a bare `string`.
	type Status = 'idle' | 'starting' | 'live' | 'denied' | 'unsupported';
	type ErrorKind = Exclude<Status, 'idle' | 'starting' | 'live'>;

	let videoEl = $state<HTMLVideoElement | null>(null);
	let canvasEl = $state<HTMLCanvasElement | null>(null);
	let wrapEl = $state<HTMLElement | null>(null);

	let status = $state<Status>('idle'); // idle | starting | live | denied | unsupported
	let errorKind = $state<ErrorKind | null>(null);
	let target = $state<Rgb>({ r: 252, g: 192, b: 0 });
	let width = $state(30);
	let feather = $state(40);
	let preset = $state(0);

	let renderer: Renderer | null = null;
	let stream: MediaStream | null = null;
	let raf = 0;
	let probe: HTMLCanvasElement | null = null;

	const PRESETS = [
		{ id: 0, key: 'mono.standard' },
		{ id: 1, key: 'mono.soft' },
		{ id: 2, key: 'mono.deep' },
		{ id: 3, key: 'mono.high' }
	];

	$effect(() => {
		if (!canvasEl) return;
		try {
			renderer = new Renderer(canvasEl);
		} catch (err) {
			console.error(err);
			status = 'unsupported';
			errorKind = 'unsupported';
		}
		return () => {
			renderer?.dispose();
			renderer = null;
		};
	});

	$effect(() => {
		if (!wrapEl) return;
		const wrap = wrapEl;
		// Read through a local so the renderer is captured once: it is a plain
		// variable, and the callback runs long after this effect's setup.
		const r = renderer;
		if (!r) return;
		const ro = new ResizeObserver(([entry]) => {
			const box = entry.contentRect;
			r.resize(box.width, box.height);
			r.render();
		});
		ro.observe(wrap);
		return () => ro.disconnect();
	});

	$effect(() => {
		if (!renderer) return;
		renderer.setParams({ target, width, feather, preset, tone: 0, contrast: 0, maskOn: 0 });
		renderer.render();
	});

	// Stop the camera if the component goes away.
	$effect(() => () => stopCamera());

	async function startCamera(): Promise<void> {
		if (!navigator.mediaDevices?.getUserMedia) {
			status = 'unsupported';
			errorKind = 'unsupported';
			return;
		}
		const video = videoEl;
		if (!video) return;
		status = 'starting';
		try {
			stream = await navigator.mediaDevices.getUserMedia({
				video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1440 } },
				audio: false
			});
		} catch (err) {
			const denied = err instanceof DOMException && err.name === 'NotAllowedError';
			status = denied ? 'denied' : 'unsupported';
			errorKind = status;
			return;
		}

		video.srcObject = stream;
		await video.play();
		status = 'live';
		pump();
	}

	/**
	 * Live preview loop.
	 *
	 * Two things keep this from being a battery drain: it uploads at most
	 * `LIVE_FPS` frames per second rather than on every vsync, and it stops
	 * entirely when the section is scrolled out of view — a camera running at
	 * full rate for a preview nobody is looking at is pure waste.
	 */
	const LIVE_FPS = 30;
	const FRAME_MS = 1000 / LIVE_FPS;

	let lastFrame = 0;
	let visible = true;

	function pump(now = 0): void {
		const video = videoEl;
		if (status !== 'live' || !renderer || !video) return;
		if (visible && now - lastFrame >= FRAME_MS && video.readyState >= 2) {
			lastFrame = now;
			renderer.upload(video);
			renderer.render();
		}
		raf = requestAnimationFrame(pump);
	}

	// Only run the loop while the preview is on screen.
	$effect(() => {
		if (!wrapEl) return;
		const wrap = wrapEl;
		const io = new IntersectionObserver(
			([entry]) => {
				visible = entry.isIntersecting;
			},
			{ threshold: 0.01 }
		);
		io.observe(wrap);
		return () => io.disconnect();
	});

	function stopCamera(): void {
		cancelAnimationFrame(raf);
		raf = 0;
		lastFrame = 0;
		for (const track of stream?.getTracks() ?? []) track.stop();
		stream = null;
		if (videoEl) videoEl.srcObject = null;
		if (status === 'live') status = 'idle';
	}

	/** Sample the video at a normalized point. Small 1:1 probe canvas, so the
	 *  readback is exact rather than scaled. */
	function pickColor(e: MouseEvent): void {
		const video = videoEl;
		const canvas = canvasEl;
		if (status !== 'live' || !video?.videoWidth || !canvas) return;
		const r = canvas.getBoundingClientRect();
		const nx = (e.clientX - r.left) / r.width;
		const ny = (e.clientY - r.top) / r.height;

		// object-fit: cover crops the feed; reproduce that mapping.
		const scale = Math.max(r.width / video.videoWidth, r.height / video.videoHeight);
		const drawW = video.videoWidth * scale;
		const drawH = video.videoHeight * scale;
		const offX = (drawW - r.width) / 2;
		const offY = (drawH - r.height) / 2;
		const px = Math.round((nx * r.width + offX) / scale);
		const py = Math.round((ny * r.height + offY) / scale);
		if (px < 0 || py < 0 || px >= video.videoWidth || py >= video.videoHeight) return;

		if (!probe) {
			probe = document.createElement('canvas');
			probe.width = 1;
			probe.height = 1;
		}
		const ctx = probe.getContext('2d', { willReadFrequently: true });
		if (!ctx) return;
		ctx.drawImage(video, px, py, 1, 1, 0, 0, 1, 1);
		const d = ctx.getImageData(0, 0, 1, 1).data;
		target = { r: d[0], g: d[1], b: d[2] };
	}

	async function capture(): Promise<void> {
		const video = videoEl;
		if (status !== 'live' || !video?.videoWidth) return;
		const w = video.videoWidth;
		const h = video.videoHeight;
		const off = document.createElement('canvas');
		off.width = w;
		off.height = h;
		const r = new Renderer(off);
		r.setImage(video);
		r.setParams({ target, width, feather, preset, tone: 0, contrast: 0, maskOn: 0 });
		r.resize(w, h, 1);
		r.render();
		const blob = await new Promise<Blob | null>((res) => off.toBlob(res, 'image/png'));
		r.dispose();
		if (blob) oncapture(blob);
	}
</script>

<div class="live">
	<!-- The camera leads in the DOM because on a phone it is the point of the
	     section: the heading and its paragraph used to come first, which pushed the
	     viewfinder below the fold on the one device this feature is for. Desktop
	     puts the copy back on the left with `order`. -->
	<div class="live__camera">
		<div class="live__frame" class:is-live={status === 'live'} bind:this={wrapEl}>
			<!-- svelte-ignore a11y_media_has_caption -->
			<video class="live__video" bind:this={videoEl} playsinline muted></video>
			<canvas
				class="live__canvas"
				bind:this={canvasEl}
				onclick={pickColor}
				aria-label={t('live.title')}
			></canvas>

			{#if status !== 'live'}
				<div class="live__idle">
					<span class="live__idle-mark" aria-hidden="true">{@html icon('camera')}</span>
					{#if status === 'starting'}
						<p>{t('live.waiting')}</p>
					{:else}
						<button class="btn btn--primary" onclick={startCamera}>{t('live.start')}</button>
						<p class="live__idle-note">{t('live.privacy')}</p>
					{/if}
				</div>
			{/if}
		</div>

		<!-- The camera's own control bar, under the viewfinder where a shutter
		     belongs. It was in the text column, so on a phone the shutter sat above
		     the preview it fires. -->
		{#if status === 'live'}
			<div class="live__controls">
				<button class="btn btn--ghost" onclick={stopCamera}>{t('live.stop')}</button>
				<button
					class="live__shutter tip"
					data-tip={t('live.capture')}
					onclick={capture}
					aria-label={t('live.capture')}
				></button>
			</div>
		{/if}

		{#if status === 'live'}
			<div class="live__panel">
				<div class="slider__row" style="margin-bottom: 10px">
					<span>{t('panel.accent')}</span>
					<span class="mono">{rgbToHex(target)}</span>
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
				<div class="seg" style="margin-top: 14px">
					{#each PRESETS as p (p.id)}
						<button class="seg__opt" class:is-on={preset === p.id} onclick={() => (preset = p.id)}>
							{t(p.key)}
						</button>
					{/each}
				</div>
			</div>
		{/if}
	</div>

	<div class="live__copy">
		<h2 class="section-title">{t('live.title')}</h2>
		<p class="lede" style="margin-top: 14px">{t('live.sub')}</p>

		{#if errorKind === 'denied'}
			<p class="notice" style="margin-top: 16px">
				<span aria-hidden="true">{@html icon('info')}</span>
				{t('live.denied')}
			</p>
		{:else if errorKind === 'unsupported'}
			<p class="notice" style="margin-top: 16px">
				<span aria-hidden="true">{@html icon('info')}</span>
				{t('live.unsupported')}
			</p>
		{/if}
	</div>
</div>

<style>
	.live__canvas {
		cursor: crosshair;
	}

	.live__panel {
		margin-top: 22px;
		padding: 16px;
		border-radius: var(--radius-panel);
		background: var(--ink-100);
		box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.06);
		max-width: 420px;
	}
</style>
