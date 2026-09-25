<script lang="ts">
	/** 1color — keep one color in a photo, lose the rest. The tint follows whichever
	 *  color is sampled from the photo; English is the default locale, Japanese second. */
	import Editor from './components/Editor.svelte';
	import Live from './components/Live.svelte';
	import AccentTile from './components/AccentTile.svelte';
	import { dict, locales } from './lib/i18n.js';
	import { icon } from './lib/icons.js';
	import { hexToRgb, inkOn, rgbToHex } from './lib/color.js';
	import { loadPhoto, isAccepted } from './lib/image.js';
	import { Sampler, showcaseAccents } from './lib/analysis.js';
	import { createLoadGate } from './lib/loadGate.js';
	import type { LoadedPhoto, LocaleId, PixelSource, Rgb } from './lib/types.js';

	/** A bundled landing-page photo, with the accent to showcase it. */
	interface Sample {
		src: string;
		label: Record<LocaleId, string>;
		accent: Rgb;
	}

	/** A showcase accent sampled from the photo, with its label. */
	type Showcase = { key: string; rgb: Rgb; label: string };

	/** Load lifecycle. The stage offers its drop target only once loading settles, so
	 *  the first paint does not flash a prompt the boot sample replaces. */
	type LoadState = 'idle' | 'loading' | 'ready' | 'error';


	const SAMPLES: Sample[] = [
		{
			src: '/samples/sunflowers.jpg',
			label: { en: 'Sunflower field', ja: 'ひまわり畑' },
			accent: { r: 240, g: 186, b: 20 }
		},
		{
			src: '/samples/blue-door.jpg',
			label: { en: 'Blue door', ja: '青い扉' },
			accent: { r: 30, g: 108, b: 178 }
		},
		{
			src: '/samples/lanterns.jpg',
			label: { en: 'Red lanterns', ja: '赤い提灯' },
			accent: { r: 210, g: 40, b: 30 }
		}
	];

	// --- locale ------------------------------------------------------------

	const LOCALE_KEY = '1color:locale';
	const VALID_LOCALES: LocaleId[] = locales.map((l) => l.id);

	/** Restore the saved language, falling back to English. try/catch because storage
	 *  access throws in private mode and sandboxed iframes, and an unreadable preference
	 *  must not stop the app from booting. */
	function savedLocale(): LocaleId {
		try {
			const v = localStorage.getItem(LOCALE_KEY);
			return v !== null && VALID_LOCALES.includes(v as LocaleId) ? (v as LocaleId) : 'en';
		} catch {
			return 'en';
		}
	}

	let locale = $state(savedLocale());
	const t = $derived((key: string): string => dict[locale][key] ?? dict.en[key] ?? key);

	$effect(() => {
		document.documentElement.lang = locale;
		try {
			localStorage.setItem(LOCALE_KEY, locale);
		} catch {
			// Storage unavailable — the choice simply will not persist.
		}
	});

	// --- photo state -------------------------------------------------------

	let source = $state<PixelSource | null>(null);
	let sampler = $state<Sampler | null>(null);
	let fileInput = $state<HTMLInputElement | null>(null);

	// Starts 'loading', not 'idle': the boot sample always loads on mount, so the
	// first paint shows the placeholder instead of flashing a drop target.
	let loadState = $state<LoadState>('loading');
	let loadError = $state('');

	/** Guards against an older load landing after a newer one. */
	const loadGate = createLoadGate();

	// --- accent state ------------------------------------------------------

	let accentInk = $state('#09090A');


	function applyAccent({ hex }: { hex: string; coverage: number }): void {
		accentInk = inkOn(hexToRgb(hex));
		const root = document.documentElement;
		root.style.setProperty('--accent', hex);
		root.style.setProperty('--accent-ink', accentInk);
		const rgb = hexToRgb(hex);
		root.style.setProperty('--accent-glow', `rgb(${rgb.r} ${rgb.g} ${rgb.b} / 0.16)`);
	}

	/** Adopt a decoded blob, but only if `token` is still the newest load. */
	async function adopt(
		blob: Blob,
		token: number,
		{ scroll = true }: { scroll?: boolean } = {}
	): Promise<void> {
		loadState = 'loading';
		loadError = '';
		try {
			const photo: LoadedPhoto = await loadPhoto(blob);
			if (!loadGate.isCurrent(token)) {
				// Superseded while decoding: close the ImageBitmap rather than leave
				// its pixels for the GC — only an ImageBitmap owns pixels off-heap.
				if (photo.source instanceof ImageBitmap) photo.source.close();
				return;
			}
			source = photo.source;
			sampler = new Sampler(photo.source);
			loadState = 'ready';
			if (scroll) {
				requestAnimationFrame(() => {
					document.getElementById('editor')?.scrollIntoView({ block: 'start' });
				});
			}
		} catch (err) {
			if (!loadGate.isCurrent(token)) return;
			console.error(err);
			loadState = 'error';
			loadError = t('stage.error');
		}
	}

	async function openBlob(
		blob: Blob | null | undefined,
		opts?: { scroll?: boolean }
	): Promise<void> {
		if (!blob) return;
		if (!isAccepted(blob)) {
			loadState = 'error';
			loadError = t('stage.error');
			return;
		}
		return adopt(blob, loadGate.begin(), opts);
	}

	async function openSample(sample: { src: string }): Promise<void> {
		const token = loadGate.begin();
		loadState = 'loading';
		loadError = '';
		try {
			const res = await fetch(sample.src);
			const blob = await res.blob();
			if (!loadGate.isCurrent(token)) return;
			await adopt(blob, token, { scroll: true });
		} catch (err) {
			if (!loadGate.isCurrent(token)) return;
			console.error(err);
			loadState = 'error';
			loadError = t('stage.error');
		}
	}

	/** Open the first sample automatically so the hero is never an empty shell. */
	let booted = $state(false);
	$effect(() => {
		if (booted) return;
		booted = true;
		openSample(SAMPLES[0]);
	});

	// Clipboard paste, anywhere on the page.
	function onPaste(e: ClipboardEvent): void {
		const items = e.clipboardData?.items;
		if (!items) return;
		const item = [...items].find((i) => i.type.startsWith('image/'));
		if (item) openBlob(item.getAsFile());
	}

	// --- showcase ----------------------------------------------------------

	const showcase = $derived.by((): Showcase[] => {
		if (!sampler) return [];
		return showcaseAccents(sampler.palette).map((a) => ({
			...a,
			label: t(`accents.${a.key}`)
		}));
	});

	const samples = $derived(SAMPLES.map((s) => ({ src: s.src, label: s.label[locale] })));

	/** Which accent the showcase is showing; `null` is the untouched photo. One large
	 *  photo that swaps its kept color, not a row of tiles: the old grid read as a filter
	 *  picker and buried the transition from color to monochrome. */
	let showcasePick = $state<number | null>(0);

	// Reset on a new photo, so the picker cannot point past a shorter palette.
	$effect(() => {
		void source;
		showcasePick = 0;
	});

	const showcaseHex = $derived(
		showcasePick === null || !showcase[showcasePick]
			? null
			: rgbToHex(showcase[showcasePick].rgb)
	);

	function scrollTo(id: string): void {
		document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
	}

	/** Which section the reader is in. An IntersectionObserver, not scroll offsets:
	 *  sections differ in height, so an offset comparison gets the boundary wrong on the
	 *  short one. The nav used to hardcode Editor as current. */
	let currentSection = $state('editor');

	$effect(() => {
		const els = ['editor', 'accents', 'live']
			.map((id) => document.getElementById(id))
			.filter((el): el is HTMLElement => el !== null);
		if (!els.length) return;

		const io = new IntersectionObserver(
			(entries) => {
				// The band crossing the upper third wins, so the marker moves once
				// the new section is genuinely the one being read.
				for (const entry of entries) {
					if (entry.isIntersecting) currentSection = entry.target.id;
				}
			},
			{ rootMargin: '-25% 0px -65% 0px' }
		);
		els.forEach((el) => io.observe(el));
		return () => io.disconnect();
	});
</script>

<svelte:window onpaste={onPaste} />

<header class="nav">
	<div class="shell nav__inner">
		<div class="brand">
			<span class="brand__dot" aria-hidden="true"></span>
			1color
		</div>
		<nav class="nav__links">
			{#each [{ id: 'editor', key: 'nav.editor' }, { id: 'accents', key: 'nav.accents' }, { id: 'live', key: 'nav.live' }] as link (link.id)}
				<button
					class="nav__link"
					class:is-current={currentSection === link.id}
					aria-current={currentSection === link.id ? 'true' : undefined}
					onclick={() => scrollTo(link.id)}
				>{t(link.key)}</button>
			{/each}
		</nav>
		<div class="lang" role="group" aria-label={t('lang.switch')}>
			{#each locales as l (l.id)}
				<button
					class="lang__opt"
					class:is-on={locale === l.id}
					onclick={() => (locale = l.id)}
					aria-pressed={locale === l.id}
				>{l.label}</button>
			{/each}
		</div>
	</div>
</header>

<main>
	<section class="hero">
		<div class="shell hero__grid">
			<div class="hero__copy">
				<h1 class="display">
					{t('hero.title.pre')}<span class="tint">{t('hero.title.accent')}</span>{t('hero.title.post')}
				</h1>
				<p class="lede">{t('hero.sub')}</p>

				<div class="hero__actions">
					<button class="btn btn--primary" onclick={() => fileInput?.click()}>
						{t('hero.open')}
					</button>
					<div class="hero__samples">
						<span class="hero__samples-label">{t('hero.samples')}</span>
						<div class="samples">
							{#each samples as s (s.src)}
								<button
									class="samples__btn tip"
									data-tip={s.label}
									onclick={() => openSample(s)}
									aria-label={s.label}
								>
									<img src={s.src} alt="" loading="lazy" />
								</button>
							{/each}
						</div>
					</div>
				</div>

				{#if loadError}
					<p class="notice" role="alert">
						<span aria-hidden="true">{@html icon('info')}</span>
						{loadError}
					</p>
				{/if}

			<!--
				Hero art: 3D planes, nearest carrying the live accent and the rest stepping
				down a neutral ramp. Re-tints for free; --accent is a :root variable.

				Anchored to the copy block, not the grid — on the grid it centred on the copy
				and the card together and landed behind the opaque card. CSS 3D, not WebGL:
				the app keeps one live GL context for thumbnails and browsers cap how many a
				page may hold.
			-->
			<div class="hero__art" aria-hidden="true">
				<div class="hero__fan">
					{#each [0, 1, 2, 3, 4] as i (i)}
						<span class="hero__plane" style="--i:{i}"></span>
					{/each}
				</div>
			</div>
			</div>

			<div id="editor">
				<Editor
					{source}
					{sampler}
					loading={loadState === 'loading'}
					{t}
					onopen={() => fileInput?.click()}
					onaccent={applyAccent}
				/>
			</div>
		</div>
	</section>

	<section class="band" id="accents">
		<div class="shell">
			<div class="band__head">
				<h2 class="section-title">{t('accents.title')}</h2>
			</div>

			{#if source && showcase.length}
				<!-- One large frame that swaps its kept color, palette as the control:
				     the old five-tile grid showed every result but none of the
				     transition, and at thumbnail size the edits looked identical. -->
				<div class="showcase">
					<div class="showcase__frame">
						<AccentTile
							{source}
							target={showcasePick === null ? showcase[0].rgb : showcase[showcasePick].rgb}
							plain={showcasePick === null}
							bare
						/>
					</div>

					<div class="showcase__side">
						<p class="showcase__caption">
							{showcasePick === null ? t('accents.original') : showcase[showcasePick].label}
							{#if showcaseHex}
								<span class="showcase__code mono">{showcaseHex}</span>
							{/if}
						</p>

						<div class="showcase__picks" role="group" aria-label={t('accents.pick')}>
							<button
								class="showcase__pick"
								class:is-on={showcasePick === null}
								onclick={() => (showcasePick = null)}
								aria-pressed={showcasePick === null}
							>
								<span class="showcase__dot showcase__dot--plain" aria-hidden="true"></span>
								{t('accents.original')}
							</button>
							{#each showcase as a, i (a.key)}
								<button
									class="showcase__pick"
									class:is-on={showcasePick === i}
									onclick={() => (showcasePick = i)}
									aria-pressed={showcasePick === i}
								>
									<span
										class="showcase__dot"
										style:background={rgbToHex(a.rgb)}
										aria-hidden="true"
									></span>
									{a.label}
									<span class="showcase__pick-hex mono">{rgbToHex(a.rgb)}</span>
								</button>
							{/each}
						</div>
					</div>
				</div>
			{:else}
				<div class="compare">
					{#each SAMPLES as s (s.src)}
						<div class="compare__item">
							<button class="sample-tile" onclick={() => openSample(s)}>
								<img src={s.src} alt={s.label[locale]} loading="lazy" />
							</button>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</section>

	<section class="band" id="live">
		<div class="shell">
			<Live {t} oncapture={(blob) => openBlob(blob, { scroll: true })} />
		</div>
	</section>
</main>

<footer class="footer">
	<div class="shell">
		<div class="footer__row">
			<span>{t('footer.built')}</span>
			<a href="https://commons.wikimedia.org" target="_blank" rel="noreferrer noopener">
				{t('footer.photos')}
			</a>
			<a
				href="https://apps.apple.com/jp/app/accent-selective-color/id6801496954"
				target="_blank"
				rel="noreferrer noopener"
			>
				{t('footer.iosapp')}
			</a>
			<a href="https://github.com/MhankBarBar/1color" target="_blank" rel="noreferrer noopener">
				{t('footer.source')}
			</a>
		</div>
		<p class="footer__note">{t('footer.disclaimer')}</p>
	</div>
</footer>

<input
	bind:this={fileInput}
	type="file"
	accept="image/*"
	hidden
	onchange={(e) => {
		openBlob(e.currentTarget.files?.[0]);
		e.currentTarget.value = '';
	}}
/>
