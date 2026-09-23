<script>
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

	let { t = (k) => k, oncapture = () => {} } = $props();

	let videoEl = $state(null);
	let canvasEl = $state(null);
	let wrapEl = $state(null);

	let status = $state('idle'); // idle | starting | live | denied | unsupported
	let errorKind = $state(null);
	let target = $state({ r: 252, g: 192, b: 0 });
	let width = $state(30);
	let feather = $state(40);
	let preset = $state(0);
	let picked = $state(false);

	let renderer = null;
	let stream = null;
	let raf = 0;
	let probe = null;

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
		if (!wrapEl || !renderer) return;
		const ro = new ResizeObserver(([entry]) => {
			const r = entry.contentRect;
			renderer.resize(r.width, r.height);
			renderer.render();
		});
		ro.observe(wrapEl);
		return () => ro.disconnect();
	});

	$effect(() => {
		if (!renderer) return;
		renderer.setParams({ target, width, feather, preset, tone: 0, contrast: 0, maskOn: 0 });
		renderer.render();
	});

	// Stop the camera if the component goes away.
	$effect(() => () => stopCamera());

	async function startCamera() {
		if (!navigator.mediaDevices?.getUserMedia) {
			status = 'unsupported';
			errorKind = 'unsupported';
			return;
		}
		status = 'starting';
		try {
			stream = await navigator.mediaDevices.getUserMedia({
				video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1440 } },
				audio: false
			});
		} catch (err) {
			status = err?.name === 'NotAllowedError' ? 'denied' : 'unsupported';
			errorKind = status;
			return;
		}

		videoEl.srcObject = stream;
		await videoEl.play();
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

	function pump(now = 0) {
		if (status !== 'live' || !renderer) return;
		if (visible && now - lastFrame >= FRAME_MS && videoEl.readyState >= 2) {
			lastFrame = now;
			renderer.upload(videoEl);
			renderer.render();
		}
		raf = requestAnimationFrame(pump);
	}

	// Only run the loop while the preview is on screen.
	$effect(() => {
		if (!wrapEl) return;
		const io = new IntersectionObserver(
			([entry]) => {
				visible = entry.isIntersecting;
			},
			{ threshold: 0.01 }
		);
		io.observe(wrapEl);
		return () => io.disconnect();
	});

	function stopCamera() {
		cancelAnimationFrame(raf);
		raf = 0;
		lastFrame = 0;
		for (const track of stream?.getTracks?.() || []) track.stop();
		stream = null;
		if (videoEl) videoEl.srcObject = null;
		if (status === 'live') status = 'idle';
	}

	/** Sample the video at a normalized point. Small 1:1 probe canvas, so the
	 *  readback is exact rather than scaled. */
	function pickColor(e) {
		if (status !== 'live' || !videoEl?.videoWidth) return;
		const r = canvasEl.getBoundingClientRect();
		const nx = (e.clientX - r.left) / r.width;
		const ny = (e.clientY - r.top) / r.height;

		// object-fit: cover crops the feed; reproduce that mapping.
		const scale = Math.max(r.width / videoEl.videoWidth, r.height / videoEl.videoHeight);
		const drawW = videoEl.videoWidth * scale;
		const drawH = videoEl.videoHeight * scale;
		const offX = (drawW - r.width) / 2;
		const offY = (drawH - r.height) / 2;
		const px = Math.round((nx * r.width + offX) / scale);
		const py = Math.round((ny * r.height + offY) / scale);
		if (px < 0 || py < 0 || px >= videoEl.videoWidth || py >= videoEl.videoHeight) return;

		if (!probe) {
			probe = document.createElement('canvas');
			probe.width = 1;
			probe.height = 1;
		}
		const ctx = probe.getContext('2d', { willReadFrequently: true });
		ctx.drawImage(videoEl, px, py, 1, 1, 0, 0, 1, 1);
		const d = ctx.getImageData(0, 0, 1, 1).data;
		target = { r: d[0], g: d[1], b: d[2] };
		picked = true;
	}

	async function capture() {
		if (status !== 'live' || !videoEl?.videoWidth) return;
		const w = videoEl.videoWidth;
		const h = videoEl.videoHeight;
		const off = document.createElement('canvas');
		off.width = w;
		off.height = h;
		const r = new Renderer(off);
		r.setImage(videoEl);
		r.setParams({ target, width, feather, preset, tone: 0, contrast: 0, maskOn: 0 });
		r.resize(w, h, 1);
		r.render();
		const blob = await new Promise((res) => off.toBlob(res, 'image/png'));
		r.dispose();
		if (blob) oncapture(blob);
	}
</script>

<div class="live">
	<div>
		<h2 class="section-title">{t('live.title')}</h2>
		<p class="lede" style="margin-top: 14px">{t('live.sub')}</p>

		<div class="live__controls">
			{#if status === 'live'}
				<button class="btn btn--ghost" onclick={stopCamera}>{t('live.stop')}</button>
				<button
					class="live__shutter tip"
					data-tip={t('live.capture')}
					onclick={capture}
					aria-label={t('live.capture')}
				></button>
			{:else}
				<button class="btn btn--primary" onclick={startCamera} disabled={status === 'starting'}>
					{status === 'starting' ? t('live.waiting') : t('live.start')}
				</button>
			{/if}
		</div>

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
		{:else}
			<p class="notice" style="margin-top: 16px">
				<span aria-hidden="true">{@html icon('info')}</span>
				{t('live.privacy')}
			</p>
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

	<div class="live__frame" bind:this={wrapEl}>
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
				<span style="color: var(--accent); width: 34px" aria-hidden="true">
					{@html icon('camera')}
				</span>
				<p>{status === 'starting' ? t('live.waiting') : t('live.privacy')}</p>
			</div>
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
