// Image intake: file, drag-drop, clipboard, URL. Everything is normalised to an
// ImageBitmap so the GL upload path is one call.

/** GPU texture ceilings are commonly 4096 or 8192; stay well under. */
const MAX_EDGE = 4096;

export async function bitmapFromBlob(blob) {
	if (typeof createImageBitmap !== 'function') throw new Error('createImageBitmap unsupported');
	// `from-image` bakes in EXIF orientation so phone photos arrive upright.
	return createImageBitmap(blob, { imageOrientation: 'from-image' });
}

export async function bitmapFromUrl(url) {
	const res = await fetch(url, { mode: 'cors' });
	if (!res.ok) throw new Error(`Could not fetch ${url}`);
	return bitmapFromBlob(await res.blob());
}

/**
 * Cap the long edge. Keeps uploads and per-frame GPU work bounded.
 *
 * The decoded bitmap is closed when it is replaced: an ImageBitmap holds its
 * pixels outside the JS heap, so dropping the reference does not free them until
 * GC gets around to it. Re-importing photos would otherwise pile up tens of
 * megabytes each time.
 */
export function fitBitmap(bmp, maxEdge = MAX_EDGE) {
	const long = Math.max(bmp.width, bmp.height);
	if (long <= maxEdge) return bmp;
	const scale = maxEdge / long;
	const c = document.createElement('canvas');
	c.width = Math.round(bmp.width * scale);
	c.height = Math.round(bmp.height * scale);
	c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
	bmp.close?.();
	return c;
}

/** Decode once, then hand the same source to GL and to the CPU sampler. */
export async function loadPhoto(blob, maxEdge = MAX_EDGE) {
	const bmp = await bitmapFromBlob(blob);
	return { source: fitBitmap(bmp, maxEdge), name: blob.name || 'photo' };
}

/** A small RGBA readback for palette extraction and coverage math. */
export function sampleImageData(source, maxEdge = 320) {
	const long = Math.max(source.width, source.height);
	const scale = Math.min(1, maxEdge / long);
	const w = Math.max(2, Math.round(source.width * scale));
	const h = Math.max(2, Math.round(source.height * scale));
	const c = document.createElement('canvas');
	c.width = w;
	c.height = h;
	const ctx = c.getContext('2d', { willReadFrequently: true });
	ctx.drawImage(source, 0, 0, w, h);
	return { data: ctx.getImageData(0, 0, w, h).data, w, h };
}

export const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif'];

export const isAccepted = (file) =>
	file && (ACCEPTED.includes(file.type) || /\.(jpe?g|png|webp|avif|gif)$/i.test(file.name || ''));
