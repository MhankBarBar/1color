// Tests for image intake.
//
// The decode path is browser-dependent and its failure mode is invisible: a
// browser that cannot decode looks exactly like a corrupt file, because both
// surface as the same message. So the fallback chain is asserted here rather
// than left to be discovered on a device.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bitmapFromBlob, isAccepted } from './image.js';

/** The globals `bitmapFromBlob` reaches for, saved so each test can restore them. */
const globals = globalThis as Record<string, unknown>;

/**
 * Install stub decode globals for one test.
 *
 * `imageBitmap` stands in for the platform function; returning `undefined` means
 * the browser does not have it at all, which is the case the fallback exists for.
 */
function stubGlobals(
	imageBitmap: ((blob: Blob, opts?: unknown) => Promise<unknown>) | undefined
): { restore: () => void; decoded: () => number } {
	const previous = {
		createImageBitmap: globals.createImageBitmap,
		Image: globals.Image,
		URL: globals.URL
	};
	let decodes = 0;

	if (imageBitmap) globals.createImageBitmap = imageBitmap;
	else delete globals.createImageBitmap;

	globals.Image = class {
		src = '';
		width = 1200;
		height = 800;
		async decode(): Promise<void> {
			decodes++;
		}
	};
	globals.URL = {
		createObjectURL: () => 'blob:stub',
		revokeObjectURL: () => {}
	};

	return {
		decoded: () => decodes,
		restore: () => {
			if (previous.createImageBitmap === undefined) delete globals.createImageBitmap;
			else globals.createImageBitmap = previous.createImageBitmap;
			globals.Image = previous.Image;
			globals.URL = previous.URL;
		}
	};
}

const someBlob = (): Blob => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });

test('a browser without createImageBitmap still decodes a photo', async () => {
	// WebKit shipped ImageBitmap well after other engines, and older WebKit never
	// got it at all. Requiring it meant the app could not open a single photo
	// there — the sample images included.
	const stub = stubGlobals(undefined);
	try {
		const source = await bitmapFromBlob(someBlob());
		assert.equal(stub.decoded(), 1, 'the element path must have been used');
		assert.equal((source as { width: number }).width, 1200);
	} finally {
		stub.restore();
	}
});

test('a browser that rejects the imageOrientation option still decodes', async () => {
	// This is the one that actually bit: the function exists, but it rejects the
	// `imageOrientation` option rather than ignoring it, so the call failed on a
	// browser that could otherwise decode the file perfectly.
	const calls: Array<unknown> = [];
	const stub = stubGlobals(async (_blob, opts) => {
		calls.push(opts);
		if (opts) throw new TypeError('unsupported option');
		return { width: 640, height: 480 };
	});
	try {
		const source = await bitmapFromBlob(someBlob());
		assert.deepEqual(calls, [{ imageOrientation: 'from-image' }, undefined]);
		assert.equal((source as { width: number }).width, 640, 'the optionless call must be used');
		assert.equal(stub.decoded(), 0, 'the element path is a last resort');
	} finally {
		stub.restore();
	}
});

test('a browser that cannot decode the blob at all reports it', async () => {
	// The failure must still be reachable: falling back is not the same as
	// swallowing the error, and a genuinely broken file has to surface.
	const stub = stubGlobals(async () => {
		throw new TypeError('unsupported option');
	});
	try {
		globals.Image = class {
			src = '';
			async decode(): Promise<void> {
				throw new Error('The source image cannot be decoded.');
			}
		};
		await assert.rejects(() => bitmapFromBlob(someBlob()), /cannot be decoded/);
	} finally {
		stub.restore();
	}
});

test('an accepted file is judged by type, and by name only when it has one', () => {
	assert.equal(isAccepted(someBlob()), true, 'a typed image blob is accepted');
	assert.equal(isAccepted(null), false);
	assert.equal(isAccepted(undefined), false);
	// A captured camera frame is a Blob with no name; it must not be rejected for
	// lacking one.
	assert.equal(isAccepted(new Blob([], { type: 'image/png' })), true);
	assert.equal(isAccepted(new Blob([], { type: 'text/plain' })), false);
});
