// Full-resolution export. Rebuilds the whole composition at output size rather
// than upscaling the on-screen canvas: frame, margin, photo, and the optional
// swatch / color-code / color-mix overlays.

import { Renderer } from './gl.js';
import { MaskLayer } from './mask.js';
import { hexToRgb, rgbToHex, inkOn } from './color.js';
import type {
	Align,
	CropRect,
	FrameId,
	Geometry,
	MaskSpec,
	OverlaySpec,
	PixelSource,
	QualityId,
	Ratio,
	RenderParamsInput,
	Rgb,
	Size
} from './types.js';

export const RATIOS: Ratio[] = [
	{ id: 'original', label: null },
	{ id: '1:1', w: 1, h: 1 },
	{ id: '4:5', w: 4, h: 5 },
	{ id: '5:4', w: 5, h: 4 },
	{ id: '3:4', w: 3, h: 4 },
	{ id: '4:3', w: 4, h: 3 },
	{ id: '6:7', w: 6, h: 7 },
	{ id: '7:6', w: 7, h: 6 },
	{ id: '3:2', w: 3, h: 2 },
	{ id: '2:3', w: 2, h: 3 },
	{ id: '9:16', w: 9, h: 16 },
	{ id: '16:9', w: 16, h: 9 },
	{ id: '2.39:1', w: 2.39, h: 1 }
];

const QUALITY: Record<QualityId, number> = { std: 2048, max: Infinity };

/**
 * The largest canvas this export is allowed to build.
 *
 * iOS Safari refuses a canvas over 4096 on a side or roughly 16.7M pixels in
 * total, and a good number of Android GPUs are no better. Past the ceiling the
 * failure is silent: the 2D context stops accepting draws and `toBlob` calls
 * back with `null`, so the export threw on a phone while the identical settings
 * worked on desktop. It bites hardest at `max` quality with a frame, where a
 * 12MP photo plus padding reaches 5120x4112 — over both limits.
 *
 * The cap applies to the *finished* composition, frame padding included,
 * because that is the canvas that actually gets created.
 */
export const MAX_EXPORT_EDGE = 4096;
export const MAX_EXPORT_AREA = 4096 * 4096;

/** Output canvas size for a ratio, quality cap, and margin. */
export function outputSize(
	imgW: number,
	imgH: number,
	ratioId: string,
	quality: QualityId
): Size {
	const ratio = RATIOS.find((r) => r.id === ratioId);
	const ar = ratio && ratio.w && ratio.h ? ratio.w / ratio.h : imgW / imgH;

	// Fit the largest rect of aspect `ar` inside the source, then scale to quality.
	let w = imgW;
	let h = Math.round(imgW / ar);
	if (h > imgH) {
		h = imgH;
		w = Math.round(imgH * ar);
	}

	const cap = QUALITY[quality] ?? QUALITY.std;
	const long = Math.max(w, h);
	if (long > cap) {
		const s = cap / long;
		w = Math.round(w * s);
		h = Math.round(h * s);
	}
	return { w: Math.max(2, w), h: Math.max(2, h) };
}

/**
 * The frame's fill, or null for no frame. Shared by the live preview and the
 * export so the two cannot disagree about what the frame looks like.
 */
export function frameHexFor(
	frame: FrameId,
	accentHex: string,
	customHex?: string | null
): string | null {
	if (frame === 'white') return '#F6F6F8';
	if (frame === 'black') return '#08080A';
	if (frame === 'accent') return accentHex;
	if (frame === 'custom') return customHex || accentHex;
	// An instant print is white regardless of the accent: the paper is the point.
	if (frame === 'cheki') return '#F6F6F8';
	return null;
}

/** Fraction of the short edge used as frame padding. */
export const framePad = (margin: number): number => (margin / 100) * 0.18;

/**
 * How much deeper an instant print's foot is than its other three sides.
 *
 * A cheki's whole character is the wide band under the photo, which is where the
 * color code is written. Uniform padding with a caption underneath is just a
 * white border.
 */
export const CHEKI_FOOT = 3.2;

/**
 * The part of the photo a ratio keeps, in normalised photo units.
 *
 * A ratio crops rather than stretches. Scaling the quad to a different aspect
 * than the photo makes the shader map the whole texture onto it, so a 4:3 photo
 * exported at 1:1 came out visibly squashed. Cropping keeps every pixel's shape
 * and simply loses the edges, which is what a crop ratio is supposed to mean.
 *
 * The crop is the largest centred rect of the target aspect that fits, which is
 * the same rect `outputSize` computes — the two must agree, or the preview and
 * the file would show different framing.
 */
export function cropRect(imgW: number, imgH: number, ratioId: string): CropRect {
	const ratio = RATIOS.find((r) => r.id === ratioId);
	const ar = ratio && ratio.w && ratio.h ? ratio.w / ratio.h : imgW / imgH;

	let w = imgW;
	let h = imgW / ar;
	if (h > imgH) {
		h = imgH;
		w = imgH * ar;
	}
	return {
		sx: (imgW - w) / 2 / imgW,
		sy: (imgH - h) / 2 / imgH,
		sw: w / imgW,
		sh: h / imgH
	};
}

/** Where the overlay block sits across the band. */
export const ALIGNMENTS: Record<Align, number> = { left: 0, center: 0.5, right: 1 };

/** Input to `composeWithinCeiling`. */
export interface CeilingInput {
	wanted: Size;
	frame: FrameId;
	accentHex: string;
	customHex?: string | null;
	margin: number;
	align: Align;
	showSwatch: boolean;
	showCode: boolean;
	showMix: boolean;
}

/** The fitted composition: the photo box to draw, and its geometry. */
export interface CeilingFit {
	innerW: number;
	innerH: number;
	geo: Geometry;
}

/**
 * Shrink a composition until its canvas fits the browser ceiling.
 *
 * The clamp cannot be computed in one step from the pre-pad size: the frame band
 * is added *after* the photo box is chosen, so scaling the photo to exactly the
 * limit and then padding it lands back over the limit. At `max` quality with a
 * 50% margin on a 12MP photo that produced a 4097-pixel side — one pixel past
 * the ceiling, which is enough for `toBlob` to call back with `null` and the
 * export to fail with no other symptom.
 *
 * So the fit is solved iteratively: compose at the current scale, and if the
 * result is still over, divide the scale by the overshoot. Rounding means the
 * fixed point is not analytic, and each pass is exact, so a handful converge.
 */
export function composeWithinCeiling({
	wanted,
	frame,
	accentHex,
	customHex = null,
	margin,
	align,
	showSwatch,
	showCode,
	showMix
}: CeilingInput): CeilingFit {
	const compose = (w: number, h: number): Geometry =>
		composeGeometry({
			imgW: w,
			imgH: h,
			frame,
			accentHex,
			customHex,
			margin,
			align,
			showSwatch,
			showCode,
			showMix
		});

	let scale = 1;
	let innerW = wanted.w;
	let innerH = wanted.h;
	let geo = compose(innerW, innerH);

	// Bounded rather than `while`: rounding could in principle oscillate around
	// the limit, and an export that never returns is worse than one a pixel
	// large. Eight passes is far more than convergence needs.
	for (let pass = 0; pass < 8; pass++) {
		const over = Math.max(
			geo.outW / MAX_EXPORT_EDGE,
			geo.outH / MAX_EXPORT_EDGE,
			Math.sqrt((geo.outW * geo.outH) / MAX_EXPORT_AREA)
		);
		if (over <= 1) break;
		scale /= over;
		innerW = Math.max(2, Math.round(wanted.w * scale));
		innerH = Math.max(2, Math.round(wanted.h * scale));
		geo = compose(innerW, innerH);
	}

	return { innerW, innerH, geo };
}

/** Rows the overlay block occupies: the swatch/code line, and the mix bar. */
export const overlayRowCount = (o: OverlaySpec): number =>
	(o.showSwatch || o.showCode ? 1 : 0) + (o.showMix ? 1 : 0);

/**
 * The smallest legible row height, as a fraction of the photo's short edge.
 *
 * Below this the color code stops being readable, so the band must not shrink
 * past it — that is what sets the margin's floor.
 */
export const MIN_ROW_FRAC = 0.02;

/** How much of the band the color-mix bar spans. Under 1 so the bar reads as a
 *  proportional chip rather than a full-bleed rule, and so the block has room to
 *  move when it is aligned away from the left. */
const MIX_BAR_FRAC = 0.62;

/**
 * The margin below which the band could no longer hold a legible block.
 *
 * Scale-independent: both the band and the block scale off the photo's short
 * edge, so this is a plain percentage. Exposed so the margin slider can start
 * here instead of showing a dead zone — the band used to be floored at the
 * block's height, which made the slider inert across its whole travel because
 * the floor exceeded anything the slider could ask for.
 */
export const overlayMinMargin = (o: OverlaySpec): number =>
	Math.ceil(overlayRowCount(o) * MIN_ROW_FRAC * 1.35 * (100 / 0.18));

/** The laid-out metrics of the overlay block, in output units. */
interface OverlayMetrics {
	unit: number;
	rowH: number;
	inlineParts: string[];
	rowCount: number;
	blockH: number;
	minPad: number;
}

/** Input to `overlayMetrics`: the photo box, the band, and what to draw. */
type MetricsInput = OverlaySpec & {
	innerW: number;
	innerH: number;
	pad: number;
	padBottom: number;
	hasFrame: boolean;
};

/**
 * Metrics for the swatch / code / mix block, in output units.
 *
 * Everything scales off the photo's short edge, so the same numbers lay out the
 * block at export resolution and at preview resolution.
 *
 * With a frame the block is fitted to the band rather than the band grown to fit
 * the block. The band is then always exactly the margin, which is what makes the
 * margin control honest.
 */
function overlayMetrics({
	innerW,
	innerH,
	pad,
	padBottom,
	hasFrame,
	showSwatch,
	showCode,
	showMix
}: MetricsInput): OverlayMetrics {
	const unit = Math.min(innerW, innerH);
	const inlineParts: string[] = [];
	if (showSwatch) inlineParts.push('swatch');
	if (showCode) inlineParts.push('code');
	// The swatch and the color code share a line — they describe the same thing,
	// and stacking them on separate rows made them read as unrelated. The color
	// mix bar spans the width, so it keeps its own line.
	const rowCount = overlayRowCount({ showSwatch, showCode, showMix });
	const natural = unit * 0.075;
	// 1.35 leaves the band visibly framing the block rather than letting it fill
	// the space edge to edge. The deepest band governs: an instant print's foot is
	// where the block goes, so fitting to the shallower sides would shrink it for
	// no reason.
	const band = Math.max(pad, padBottom);
	const fitted = hasFrame && rowCount ? band / 1.35 / rowCount : natural;
	const rowH = hasFrame && rowCount ? Math.min(natural, fitted) : natural;
	return {
		unit,
		rowH,
		inlineParts,
		rowCount,
		blockH: rowH * rowCount,
		// Band needed to hold a legible block.
		minPad: rowCount ? MIN_ROW_FRAC * unit * rowCount * 1.35 : 0
	};
}

/** Input to `composeGeometry`. The overlay toggles are optional: each has a
 *  default, and the tests rely on passing only the ones they vary. */
export interface ComposeInput extends Partial<OverlaySpec> {
	imgW: number;
	imgH: number;
	frame?: FrameId;
	accentHex: string;
	customHex?: string | null;
	margin?: number;
	align?: Align;
}

/**
 * The whole composition's geometry: frame fill, band width, and output size.
 *
 * One function for the export and the preview. They previously each derived the
 * band from `framePad` and `blockH` inline, which let the preview disagree with
 * the saved file about how tall the band was — the preview showed one thing and
 * the file another.
 */
export function composeGeometry({
	imgW,
	imgH,
	frame = 'none',
	accentHex,
	customHex = null,
	margin = 0,
	align = 'left',
	showSwatch = false,
	showCode = false,
	showMix = false
}: ComposeInput): Geometry {
	const hex = frameHexFor(frame, accentHex, customHex);
	// The band is exactly the margin. It is deliberately not floored at the
	// block's height: doing that made the margin slider inert for its whole
	// travel, because the floor exceeded anything the slider could request.
	const pad = hex ? Math.round(framePad(margin) * Math.min(imgW, imgH)) : 0;
	// One side may differ: an instant print's foot carries the color code, so it
	// is deliberately deeper than the top and sides.
	const padBottom = hex && frame === 'cheki' ? Math.round(pad * CHEKI_FOOT) : pad;

	const outW = imgW + pad * 2;
	const outH = imgH + pad + padBottom;
	return {
		hex,
		innerW: imgW,
		innerH: imgH,
		pad,
		padBottom,
		outW,
		outH,
		aspect: outW / outH,
		align,
		showSwatch,
		showCode,
		showMix,
		// Padding as a fraction of the framed width. The preview needs it because
		// CSS percentage padding resolves against the containing block's width and
		// would not match this box, so it scales the value to pixels itself.
		padFrac: pad / outW,
		// Against the height, not the width: the preview scales this one by the
		// composition's height to get the foot in pixels.
		padBottomFrac: padBottom / outH
	};
}

/** Input to `exportComposite`. */
export interface ExportInput extends OverlaySpec {
	source: PixelSource & Size;
	/** Partial by design: the renderer merges these over its defaults, and the
	 *  crop is derived here from `ratio` rather than supplied by the caller. */
	params: RenderParamsInput;
	maskSpec: MaskSpec;
	frame?: FrameId;
	customFrame?: string | null;
	margin?: number;
	ratio?: string;
	quality?: QualityId;
	align?: Align;
	mixPalette?: Rgb[] | null;
}

export interface ExportResult {
	blob: Blob;
	width: number;
	height: number;
}

export async function exportComposite({
	source,
	params,
	maskSpec,
	frame = 'none',
	customFrame = null,
	margin = 0,
	ratio = 'original',
	quality = 'std',
	align = 'left',
	showSwatch = false,
	showCode = false,
	showMix = false,
	mixPalette = null
}: ExportInput): Promise<ExportResult> {
	// `outputSize` returns the photo's cropped size for this ratio, so the
	// composition is built around what the crop actually keeps.
	const accent = rgbToHex(params.target ?? { r: 252, g: 192, b: 0 });
	const wanted = outputSize(source.width, source.height, ratio, quality);
	// Fit the composition to the canvas ceiling before anything is allocated.
	// Asking for more than a browser's largest canvas is not an error it reports:
	// the 2D context goes blank and `toBlob` hands back `null`, which surfaced as
	// the same generic failure on every platform at `max` quality with a frame.
	const { innerW, innerH, geo } = composeWithinCeiling({
		wanted,
		frame,
		accentHex: accent,
		customHex: customFrame,
		margin,
		align,
		showSwatch,
		showCode,
		showMix
	});
	const frameHex = geo.hex;

	const out = document.createElement('canvas');
	out.width = geo.outW;
	out.height = geo.outH;
	const ctx = out.getContext('2d');
	if (!ctx) throw new Error('Export failed: no 2D context.');

	if (frameHex) {
		ctx.fillStyle = frameHex;
		ctx.fillRect(0, 0, geo.outW, geo.outH);
	}

	// Render the photo at output resolution on a throwaway GL context.
	//
	// The canvas is the *cropped* size and the shader applies the crop, so the
	// photo arrives already framed at the target ratio instead of being stretched
	// to it. The mask layer stays full-image: the shader samples it through the
	// same UV rect as the image, so a region still lines up with the pixels it was
	// drawn over.
	const glCanvas = document.createElement('canvas');
	glCanvas.width = innerW;
	glCanvas.height = innerH;
	const r = new Renderer(glCanvas);
	const mask = new MaskLayer(source.width, source.height);
	mask.drawAll(maskSpec);
	r.setImage(source);
	r.setMask(mask.canvas);
	r.setParams({ ...params, crop: cropRect(source.width, source.height, ratio) });
	r.resize(innerW, innerH, 1);
	r.render();
	ctx.drawImage(glCanvas, geo.pad, geo.pad);
	r.dispose();
	// Drop the GL canvas's backing store now that its pixels are composited.
	// `dispose` frees the driver objects, but the canvas still holds a
	// photo-sized buffer, and the PNG encode below is the moment the tab is
	// closest to its memory ceiling — mobile browsers fail the encode there
	// rather than anywhere the caller can see. Shrinking to 1x1 releases it
	// immediately instead of waiting for the GC.
	glCanvas.width = 1;
	glCanvas.height = 1;

	drawOverlayBlock(ctx, {
		innerW,
		innerH,
		pad: geo.pad,
		padBottom: geo.padBottom,
		width: geo.outW,
		height: geo.outH,
		hasFrame: !!frameHex,
		hex: accent,
		ink: frameHex ? inkOn(hexToRgb(frameHex)) : undefined,
		align,
		showSwatch,
		showCode,
		showMix,
		palette: mixPalette
	});

	const blob = await new Promise<Blob | null>((res) => out.toBlob(res, 'image/png'));
	if (!blob) throw new Error('Export failed.');
	return { blob, width: geo.outW, height: geo.outH };
}

/** Input to `drawOverlayBlock`. */
export interface OverlayBlockInput extends OverlaySpec {
	innerW: number;
	innerH: number;
	pad: number;
	/** The bottom band, which may be deeper than the other three sides. */
	padBottom?: number;
	width: number;
	height: number;
	hasFrame: boolean;
	hex: string;
	ink?: string;
	align?: Align;
	palette?: Rgb[] | null;
}

/**
 * Paint the swatch / code / mix block.
 *
 * Shared by the export and the on-screen preview, which is the point: the
 * preview used to show the frame and nothing else, so the overlays only appeared
 * after saving. Both callers pass the same output-unit geometry; the preview
 * scales the context rather than the numbers.
 */
export function drawOverlayBlock(
	ctx: CanvasRenderingContext2D,
	{
		innerW,
		innerH,
		pad,
		padBottom = pad,
		width,
		height,
		hasFrame,
		hex,
		ink,
		align = 'left',
		showSwatch = false,
		showCode = false,
		showMix = false,
		palette = null
	}: OverlayBlockInput
): void {
	const { unit, rowH, inlineParts, rowCount, blockH } = overlayMetrics({
		innerW,
		innerH,
		pad,
		padBottom,
		hasFrame,
		showSwatch,
		showCode,
		showMix
	});
	if (!rowCount) return;

	const text = ink ?? '#F6F6F8';
	const frac = ALIGNMENTS[align];

	// Where the block sits:
	//   framed   -> in the band below the photo, never over the image
	//   frameless -> on the photo, so it needs a scrim to stay readable
	const blockTop = hasFrame
		? innerH + pad + (padBottom - blockH) / 2
		: photoInset(height, blockH, unit);

	const inset = hasFrame ? pad : Math.round(unit * 0.035);
	// The band the block may use. The mix bar is not full width, so a bar aligned
	// away from the left would otherwise run off the right edge.
	const span = width - inset * 2;
	const mixW = span * MIX_BAR_FRAC;
	const midY = (row: number): number => blockTop + row * rowH + rowH / 2;

	// The block's own width, so `center` and `right` can be placed against it.
	const swatchW = showSwatch ? rowH * 0.62 : 0;
	const gapW = showSwatch && showCode ? rowH * 0.42 : 0;
	const codeW = showCode ? hex.length * rowH * 0.5 * 0.62 : 0;
	const inlineW = swatchW + gapW + codeW;
	const blockW = Math.max(inlineW, showMix ? mixW : 0);
	const x0 = inset + (span - blockW) * frac;

	if (!hasFrame) {
		const scrimTop = Math.max(0, blockTop - rowH * 0.35);
		const g = ctx.createLinearGradient(0, scrimTop, 0, height);
		g.addColorStop(0, 'rgba(0,0,0,0)');
		g.addColorStop(1, 'rgba(0,0,0,0.62)');
		ctx.fillStyle = g;
		ctx.fillRect(0, scrimTop, width, height - scrimTop);
	}

	if (inlineParts.length) {
		const cy = midY(0);
		const d = rowH * 0.62;
		let x = x0;

		if (showSwatch) {
			ctx.fillStyle = hex;
			ctx.beginPath();
			ctx.arc(x + d / 2, cy, d / 2, 0, Math.PI * 2);
			ctx.fill();
			ctx.strokeStyle = text;
			ctx.globalAlpha = 0.35;
			ctx.lineWidth = Math.max(1, unit * 0.002);
			ctx.stroke();
			ctx.globalAlpha = 1;
			x += d;
		}

		if (showCode) {
			// Gap only when the swatch is actually present, so a lone code
			// still starts at the inset rather than floating.
			if (showSwatch) x += rowH * 0.42;
			ctx.fillStyle = text;
			ctx.font = `600 ${Math.round(rowH * 0.5)}px ui-monospace, "SF Mono", Menlo, monospace`;
			ctx.textBaseline = 'middle';
			ctx.textAlign = 'left';
			ctx.fillText(hex, x, cy);
		}
	}

	if (showMix) {
		const row = inlineParts.length ? 1 : 0;
		drawMix(ctx, {
			x: x0,
			y: blockTop + row * rowH,
			w: mixW,
			h: rowH,
			palette,
			ink: text
		});
	}
}

/** Where a frameless block sits above the photo's bottom edge. */
function photoInset(height: number, blockH: number, unit: number): number {
	return height - Math.round(unit * 0.035) - unit * 0.02 - blockH;
}

/** Input to `drawMix`. */
interface MixInput {
	x: number;
	y: number;
	w: number;
	h: number;
	palette: Rgb[] | null;
	ink: string;
}

/** Proportional bar of the photo's dominant colors, in the app's own idiom. */
function drawMix(ctx: CanvasRenderingContext2D, { x, y, w, h, palette, ink }: MixInput): void {
	const pal = palette;
	if (!pal || !pal.length) return;

	const barH = h * 0.55;
	const barY = y + (h - barH) / 2;
	const gap = w * 0.008;
	const segW = (w - gap * (pal.length - 1)) / pal.length;

	ctx.globalAlpha = 0.28;
	ctx.fillStyle = ink;
	ctx.fillRect(x, barY, w, barH);
	ctx.globalAlpha = 1;

	pal.forEach((c, i) => {
		ctx.fillStyle = rgbToHex(c);
		ctx.fillRect(x + i * (segW + gap), barY, segW, barH);
	});
}

export function downloadBlob(blob: Blob, filename: string): void {
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export async function shareBlob(
	blob: Blob,
	filename: string,
	title: string
): Promise<'shared' | 'cancelled' | 'downloaded'> {
	const file = new File([blob], filename, { type: blob.type });
	if (navigator.canShare?.({ files: [file] })) {
		try {
			await navigator.share({ files: [file], title });
			return 'shared';
		} catch (err) {
			if (err instanceof Error && err.name === 'AbortError') return 'cancelled';
			// fall through to download
		}
	}
	downloadBlob(blob, filename);
	return 'downloaded';
}
