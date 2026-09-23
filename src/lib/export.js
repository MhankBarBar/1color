// Full-resolution export. Rebuilds the whole composition at output size rather
// than upscaling the on-screen canvas: frame, margin, photo, and the optional
// swatch / color-code / color-mix overlays.

import { Renderer } from './gl.js';
import { MaskLayer } from './mask.js';
import { hexToRgb, rgbToHex, inkOn } from './color.js';

export const RATIOS = [
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

const QUALITY = { std: 2048, max: Infinity };

/** Output canvas size for a ratio, quality cap, and margin. */
export function outputSize(imgW, imgH, ratioId, quality) {
	const ratio = RATIOS.find((r) => r.id === ratioId);
	const ar = ratio && ratio.w ? ratio.w / ratio.h : imgW / imgH;

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
 * @param {'none'|'white'|'black'|'accent'|'custom'} frame
 * @param {string} accentHex
 * @param {string} [customHex]
 */
export function frameHexFor(frame, accentHex, customHex) {
	if (frame === 'white') return '#F6F6F8';
	if (frame === 'black') return '#08080A';
	if (frame === 'accent') return accentHex;
	if (frame === 'custom') return customHex || accentHex;
	return null;
}

/** Fraction of the short edge used as frame padding. */
export const framePad = (margin) => (margin / 100) * 0.18;

/**
 * @returns {Promise<{blob: Blob, width: number, height: number}>}
 */
export async function exportComposite({
	source,
	params,
	maskSpec,
	frame = 'none',
	customFrame = null,
	margin = 0,
	ratio = 'original',
	quality = 'std',
	showSwatch = false,
	showCode = false,
	showMix = false,
	mixPalette = null
}) {
	const { w: innerW, h: innerH } = outputSize(
		source.width, source.height, ratio, quality
	);

	const frameHex = frameHexFor(frame, rgbToHex(params.target), customFrame);
	const pad = frameHex ? Math.round(framePad(margin) * Math.min(innerW, innerH)) : 0;
	const outW = innerW + pad * 2;
	const outH = innerH + pad * 2;

	const out = document.createElement('canvas');
	out.width = outW;
	out.height = outH;
	const ctx = out.getContext('2d');

	if (frameHex) {
		ctx.fillStyle = frameHex;
		ctx.fillRect(0, 0, outW, outH);
	}

	// Render the photo at output resolution on a throwaway GL context.
	const glCanvas = document.createElement('canvas');
	glCanvas.width = innerW;
	glCanvas.height = innerH;
	const r = new Renderer(glCanvas);
	const mask = new MaskLayer(innerW, innerH);
	mask.drawAll(maskSpec);
	r.setImage(source);
	r.setMask(mask.canvas);
	r.setParams(params);
	r.resize(innerW, innerH, 1);
	r.render();
	ctx.drawImage(glCanvas, pad, pad);
	r.dispose();

	const hex = rgbToHex(params.target);
	const ink = frameHex ? inkOn(hexToRgb(frameHex)) : '#F6F6F8';
	const unit = Math.min(innerW, innerH);

	if (showSwatch || showCode || showMix) {
		const lines = [];
		if (showSwatch) lines.push({ kind: 'swatch' });
		if (showCode) lines.push({ kind: 'code', text: hex });
		if (showMix) lines.push({ kind: 'mix' });

		const rowH = unit * 0.075;

		// With a frame, the overlays sit in the frame band and read against it.
		// Without one they land directly on the photo, so they need an inset from
		// the edge and a scrim behind them — light ink on a bright photo was
		// otherwise invisible. This is the frameless case the app added.
		const inset = frameHex ? pad : Math.round(unit * 0.035);
		const bottom = outH - inset - unit * 0.02;
		let y = bottom - rowH * lines.length;

		if (!frameHex) {
			const scrimTop = Math.max(0, y - rowH * 0.35);
			const scrimH = outH - scrimTop;
			const g = ctx.createLinearGradient(0, scrimTop, 0, outH);
			g.addColorStop(0, 'rgba(0,0,0,0)');
			g.addColorStop(1, 'rgba(0,0,0,0.62)');
			ctx.fillStyle = g;
			ctx.fillRect(0, scrimTop, outW, scrimH);
		}

		for (const line of lines) {
			if (line.kind === 'swatch') {
				const d = rowH * 0.62;
				ctx.fillStyle = hex;
				ctx.beginPath();
				ctx.arc(inset + d / 2, y + rowH / 2, d / 2, 0, Math.PI * 2);
				ctx.fill();
				ctx.strokeStyle = ink;
				ctx.globalAlpha = 0.35;
				ctx.lineWidth = Math.max(1, unit * 0.002);
				ctx.stroke();
				ctx.globalAlpha = 1;
			} else if (line.kind === 'code') {
				ctx.fillStyle = ink;
				ctx.font = `600 ${Math.round(rowH * 0.5)}px ui-monospace, "SF Mono", Menlo, monospace`;
				ctx.textBaseline = 'middle';
				ctx.fillText(line.text, inset + rowH * 0.8, y + rowH / 2);
			} else {
				// The bar spans the photo's width, inset on both sides so it lines
				// up with the swatch and code above it.
				drawMix(ctx, { x: inset, y, w: outW - inset * 2, h: rowH, palette: mixPalette, ink });
			}
			y += rowH;
		}
	}

	const blob = await new Promise((res) => out.toBlob(res, 'image/png'));
	if (!blob) throw new Error('Export failed.');
	return { blob, width: outW, height: outH };
}

/** Proportional bar of the photo's dominant colors, in the app's own idiom. */
function drawMix(ctx, { x, y, w, h, palette, ink }) {
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

export function downloadBlob(blob, filename) {
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export async function shareBlob(blob, filename, title) {
	const file = new File([blob], filename, { type: blob.type });
	if (navigator.canShare?.({ files: [file] })) {
		try {
			await navigator.share({ files: [file], title });
			return 'shared';
		} catch (err) {
			if (err?.name === 'AbortError') return 'cancelled';
			// fall through to download
		}
	}
	downloadBlob(blob, filename);
	return 'downloaded';
}
