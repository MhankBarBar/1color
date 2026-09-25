// Image intake: file, drag-drop, clipboard, URL. Everything normalises to an
// ImageBitmap so the GL upload path is one call.

import type { LoadedPhoto, PixelSource } from './types.js';

/** GPU texture ceilings are commonly 4096 or 8192; stay well under. */
const MAX_EDGE = 4096;

export async function bitmapFromBlob(blob: Blob): Promise<PixelSource> {
	// `createImageBitmap` is the fast path, but its options are not uniformly
	// implemented: WebKit gained `imageOrientation` well after the function itself,
	// and a browser that does not know an option may reject the whole call — which
	// made photos unopenable on those browsers.
	if (typeof createImageBitmap === 'function') {
		try {
			// `from-image` bakes in EXIF orientation so phone photos arrive upright.
			return await createImageBitmap(blob, { imageOrientation: 'from-image' });
		} catch {
			try {
				return await createImageBitmap(blob);
			} catch {
				// Options unsupported or decode failed; the element path below
				// keeps WebKit working.
			}
		}
	}
	return elementFromBlob(blob);
}

/** Decode through an `<img>`, the path every browser has. Browsers apply EXIF
 *  orientation to `<img>` by default now, so photos still arrive upright; slower
 *  than `createImageBitmap`, hence the fallback role. */
async function elementFromBlob(blob: Blob): Promise<HTMLImageElement> {
	const url = URL.createObjectURL(blob);
	try {
		const img = new Image();
		img.src = url;
		// `decode()` rejects on a broken image instead of leaving a half-loaded
		// element that would upload as a blank texture.
		await img.decode();
		return img;
	} finally {
		URL.revokeObjectURL(url);
	}
}

export async function bitmapFromUrl(url: string): Promise<PixelSource> {
	const res = await fetch(url, { mode: 'cors' });
	if (!res.ok) throw new Error(`Could not fetch ${url}`);
	return bitmapFromBlob(await res.blob());
}

/** Cap the long edge, keeping uploads and per-frame GPU work bounded.
 *  The replaced bitmap is closed explicitly: an ImageBitmap holds its pixels
 *  outside the JS heap, so dropping the reference does not free them until GC
 *  runs and re-imports would pile up tens of megabytes each time. */
export function fitBitmap(bmp: PixelSource, maxEdge = MAX_EDGE): PixelSource {
	const long = Math.max(bmp.width, bmp.height);
	if (long <= maxEdge) return bmp;
	const scale = maxEdge / long;
	const c = document.createElement('canvas');
	c.width = Math.round(bmp.width * scale);
	c.height = Math.round(bmp.height * scale);
	const ctx = c.getContext('2d');
	if (!ctx) throw new Error('2D canvas unsupported');
	ctx.drawImage(bmp, 0, 0, c.width, c.height);
	// Only an ImageBitmap owns pixels that must be released explicitly; an
	// HTMLImageElement is collected normally, and has no `close`.
	if (bmp instanceof ImageBitmap) bmp.close();
	return c;
}

/** Decode once, then hand the same source to GL and to the CPU sampler. */
export async function loadPhoto(
	blob: Blob & { name?: string },
	maxEdge = MAX_EDGE
): Promise<LoadedPhoto> {
	const bmp = await bitmapFromBlob(blob);
	return { source: fitBitmap(bmp, maxEdge), name: blob.name || 'photo' };
}

/** A small RGBA readback for palette extraction and coverage math. */
export function sampleImageData(
	source: PixelSource,
	maxEdge = 320
): { data: Uint8ClampedArray; w: number; h: number } {
	const long = Math.max(source.width, source.height);
	const scale = Math.min(1, maxEdge / long);
	const w = Math.max(2, Math.round(source.width * scale));
	const h = Math.max(2, Math.round(source.height * scale));
	const c = document.createElement('canvas');
	c.width = w;
	c.height = h;
	const ctx = c.getContext('2d', { willReadFrequently: true });
	if (!ctx) throw new Error('2D canvas unsupported');
	ctx.drawImage(source, 0, 0, w, h);
	return { data: ctx.getImageData(0, 0, w, h).data, w, h };
}

export const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif'];

export const isAccepted = (file: Blob | null | undefined): boolean => {
	if (!file) return false;
	if (ACCEPTED.includes(file.type)) return true;
	// Only a File carries a name; a captured frame has none, so the extension
	// fallback does not apply to it.
	const name = file instanceof File ? file.name : '';
	return /\.(jpe?g|png|webp|avif|gif)$/i.test(name);
};
