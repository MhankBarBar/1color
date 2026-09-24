// Static checks on the shaders in shaders.js.
//
// There is no GL context in Node, so these cannot prove the shaders compile.
// They do catch the failure modes that actually bite:
//   - a uniform declared in GLSL but never looked up in JS (a silent no-op),
//   - a uniform the JS sets that the shader does not declare (always null),
//   - the two dialects drifting apart, which would break WebGL1 devices.
//
// Both dialects are checked, because the app runs on WebGL2 where available and
// falls back to WebGL1 — Chrome on Android blocklists WebGL2 on a number of
// Adreno/Mali drivers, so the fallback is not hypothetical.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SHADERS, UNIFORMS } from './shaders.js';
import { Renderer, type GL, type RendererCanvas } from './gl.js';
import { cropRect } from './export.js';

/** One dialect's sources and the regexes that identify it. */
interface Dialect {
	name: string;
	vert: string;
	frag: string;
	version: RegExp;
	inKeyword: RegExp;
	outKeyword: RegExp;
	attributeKeyword: RegExp;
	sampler: RegExp;
	maskSampler: RegExp;
	writes: RegExp;
	fragColor: RegExp;
}

const DIALECTS: Dialect[] = [
	{
		name: 'ES 3.00 (WebGL2)',
		vert: SHADERS.vert300,
		frag: SHADERS.frag300,
		version: /^#version 300 es/,
		inKeyword: /\bin\s+vec2\s+vUv;/,
		outKeyword: /\bout\s+vec2\s+vUv;/,
		attributeKeyword: /\bin\s+vec2\s+aPos;/,
		sampler: /texture\s*\(\s*uImage/,
		maskSampler: /texture\s*\(\s*uMask/,
		writes: /outColor\s*=/,
		fragColor: /\bout\s+vec4\s+outColor;/
	},
	{
		name: 'ES 1.00 (WebGL1)',
		vert: SHADERS.vert100,
		frag: SHADERS.frag100,
		version: /^(?!.*#version)/,
		inKeyword: /\bvarying\s+vec2\s+vUv;/,
		outKeyword: /\bvarying\s+vec2\s+vUv;/,
		attributeKeyword: /\battribute\s+vec2\s+aPos;/,
		sampler: /texture2D\s*\(\s*uImage/,
		maskSampler: /texture2D\s*\(\s*uMask/,
		writes: /gl_FragColor\s*=/,
		fragColor: /\bvarying\s+vec2\s+vUv;/
	}
];

/** Uniform names the fragment source actually declares. */
const declaredIn = (frag: string): string[] =>
	[...frag.matchAll(/^\s*uniform\s+\w+\s+(\w+)\s*;/gm)].map((m) => m[1]);

/** A uniform counts as used if it appears anywhere but its own declaration. */
const usedIn = (frag: string, names: readonly string[]): string[] => {
	const body = frag.replace(/^\s*uniform\s+\w+\s+\w+\s*;\s*$/gm, '');
	return names.filter((n) => new RegExp(`\\b${n}\\b`).test(body));
};

for (const d of DIALECTS) {
	test(`${d.name}: correct dialect and structure`, () => {
		assert.match(d.vert, d.version, 'vertex stage dialect marker');
		assert.match(d.frag, d.version, 'fragment stage dialect marker');
		assert.match(d.vert, d.attributeKeyword, 'vertex input declaration');
		assert.match(d.vert, d.outKeyword, 'vertex varying output');
		assert.match(d.frag, d.inKeyword, 'fragment varying input');
		// WebGL1 cannot assume highp in fragment shaders, so the ES 1.00 dialect
		// guards it; ES 3.00 always supports it.
		if (d.name.includes('1.00')) {
			assert.match(d.frag, /GL_FRAGMENT_PRECISION_HIGH/, 'missing highp guard');
			assert.match(d.frag, /precision\s+mediump\s+float;/, 'missing mediump fallback');
		} else {
			assert.match(d.frag, /precision\s+highp\s+float;/, 'explicit float precision');
		}
		assert.match(d.frag, /void\s+main\s*\(\s*\)/);
		assert.match(d.frag, d.fragColor, 'fragment output declaration');
		assert.match(d.frag, d.writes, 'fragment writes its color');
	});

	test(`${d.name}: samples both textures`, () => {
		assert.match(d.frag, d.sampler, 'the photo texture must be sampled');
		assert.match(d.frag, d.maskSampler, 'the mask texture must be sampled');
	});

	test(`${d.name}: uniform wiring matches the renderer`, () => {
		const declared = declaredIn(d.frag);
		// Compared as plain strings: `UNIFORMS` is a literal tuple now, so
		// `includes` would demand one of its exact members rather than any name.
		const bound: readonly string[] = UNIFORMS;
		assert.deepEqual(
			declared.filter((n) => !bound.includes(n)),
			[],
			'declared in GLSL but never bound in JS'
		);
		assert.deepEqual(
			bound.filter((n) => !declared.includes(n)),
			[],
			'bound in JS but not declared in GLSL'
		);
	});

	test(`${d.name}: every uniform is read`, () => {
		// An unused uniform is dead weight and usually a sign of half-finished
		// wiring. This also covers the controls: uWidth, uFeather, uTone,
		// uContrast, uPreset, uMaskOn and uBypass must all be read, or the
		// matching control would silently do nothing.
		const declared = declaredIn(d.frag);
		const unused = declared.filter((n) => !usedIn(d.frag, declared).includes(n));
		assert.deepEqual(unused, [], 'declared and bound but never read');
	});

	test(`${d.name}: vertex and fragment stages agree on varyings`, () => {
		const outs = [...d.vert.matchAll(/^(?:out|varying)\s+\w+\s+(\w+)\s*;/gm)].map((m) => m[1]);
		const ins = [...d.frag.matchAll(/^(?:in|varying)\s+\w+\s+(\w+)\s*;/gm)].map((m) => m[1]);
		assert.ok(outs.length > 0, 'vertex stage has no varyings');
		assert.deepEqual(outs, ins, 'varying mismatch between stages');
	});
}

test('both dialects declare exactly the same uniforms', () => {
	// If one dialect gained a uniform the other lacked, that device class would
	// silently lose a control.
	const a = declaredIn(SHADERS.frag300).sort();
	const b = declaredIn(SHADERS.frag100).sort();
	assert.deepEqual(a, b);
});

test('both dialects implement the same math helpers', () => {
	// The shader bodies are generated from one template, so a divergence here
	// would mean the generator broke rather than the math.
	for (const fn of ['toLinear', 'hsv', 'luma', 'accentDist', 'shapeTone']) {
		assert.match(SHADERS.frag300, new RegExp(`${fn}\\s*\\(`), `300 missing ${fn}`);
		assert.match(SHADERS.frag100, new RegExp(`${fn}\\s*\\(`), `100 missing ${fn}`);
	}
	// Same numeric constants in both, so the two cannot drift perceptually.
	for (const c of ['0.2126', '0.7152', '0.0722', '0.015', '0.3', '0.16', '0.04', '0.25']) {
		assert.ok(SHADERS.frag300.includes(c), `300 missing constant ${c}`);
		assert.ok(SHADERS.frag100.includes(c), `100 missing constant ${c}`);
	}
});

test('the WebGL1 dialect avoids ES 3.00-only syntax', () => {
	// These are hard compile errors on a WebGL1 driver.
	assert.ok(!/#version\s+300/.test(SHADERS.frag100));
	assert.ok(!/\btexture\s*\(/.test(SHADERS.frag100.replace(/texture2D/g, '')), 'uses texture()');
	assert.ok(!/\bout\s+vec4\b/.test(SHADERS.frag100), 'declares an out variable');
	assert.ok(!/\bin\s+vec2\b/.test(SHADERS.frag100), 'uses in');
	assert.ok(!/\battribute\b/.test(SHADERS.frag100.replace('attribute vec2 aPos;', '')), 'attribute in fragment');
});

test('the WebGL2 dialect uses the ES 3.00 forms', () => {
	assert.match(SHADERS.vert300, /^#version 300 es/);
	assert.match(SHADERS.frag300, /^#version 300 es/);
	assert.ok(!/gl_FragColor/.test(SHADERS.frag300), 'gl_FragColor is not available in ES 3.00');
	assert.ok(!/texture2D\s*\(/.test(SHADERS.frag300), 'texture2D is removed in ES 3.00');
});

// --- uniform values --------------------------------------------------------

/** One recorded uniform call: its name, then the values passed. */
type UniformCall = [name: string, ...values: unknown[]];

/** The fake context plus what it recorded for assertions. */
interface FakeGL {
	gl: GL;
	calls: UniformCall[];
	bad: unknown[];
}

/**
 * A WebGL context that records uniform values and rejects non-finite ones.
 *
 * `gl.uniform4f(loc, undefined, ...)` is legal and does not throw: it uploads
 * NaN, the shader's uv becomes NaN, every texture sample misses, and the photo
 * renders as one flat colour with nothing logged. That is precisely how the
 * ratio crop broke — the renderer read `crop.x` while `cropRect` returned
 * `crop.sx` — so the check belongs here, at the boundary where it went wrong.
 *
 * Structural typing does the work: the stub implements exactly the surface
 * `Renderer` touches, and any call it makes that this omits is a compile error.
 */
function fakeGL(): FakeGL {
	const calls: UniformCall[] = [];
	const bad: unknown[] = [];
	const record = (name: string, values: unknown[]): void => {
		calls.push([name, ...values]);
		for (const v of values) {
			if (typeof v === 'number' && !Number.isFinite(v)) bad.push([name, v]);
		}
	};
	const gl: GL = {
		VERTEX_SHADER: 1,
		FRAGMENT_SHADER: 2,
		ARRAY_BUFFER: 3,
		STATIC_DRAW: 4,
		FLOAT: 5,
		TEXTURE_2D: 6,
		TEXTURE0: 7,
		TEXTURE1: 8,
		RGBA: 9,
		UNSIGNED_BYTE: 10,
		TEXTURE_WRAP_S: 11,
		TEXTURE_WRAP_T: 12,
		CLAMP_TO_EDGE: 13,
		TEXTURE_MIN_FILTER: 14,
		TEXTURE_MAG_FILTER: 15,
		LINEAR: 16,
		LINK_STATUS: 17,
		COMPILE_STATUS: 18,
		COLOR_BUFFER_BIT: 19,
		TRIANGLE_STRIP: 20,
		createShader: () => ({}) as WebGLShader,
		shaderSource: () => {},
		compileShader: () => {},
		getShaderParameter: () => true,
		getShaderInfoLog: () => '',
		deleteShader: () => {},
		createProgram: () => ({}) as WebGLProgram,
		attachShader: () => {},
		bindAttribLocation: () => {},
		linkProgram: () => {},
		getProgramParameter: () => true,
		getProgramInfoLog: () => '',
		useProgram: () => {},
		createBuffer: () => ({}) as WebGLBuffer,
		bindBuffer: () => {},
		bufferData: () => {},
		getAttribLocation: () => 0,
		enableVertexAttribArray: () => {},
		vertexAttribPointer: () => {},
		getUniformLocation: (_p: WebGLProgram, n: string) =>
			({ name: n }) as unknown as WebGLUniformLocation,
		createTexture: () => ({}) as WebGLTexture,
		bindTexture: () => {},
		texParameteri: () => {},
		uniform1i: (l: WebGLUniformLocation | null, v: number) =>
			record(`uniform1i:${locName(l)}`, [v]),
		uniform1f: (l: WebGLUniformLocation | null, v: number) =>
			record(`uniform1f:${locName(l)}`, [v]),
		uniform3f: (l: WebGLUniformLocation | null, a: number, b: number, c: number) =>
			record(`uniform3f:${locName(l)}`, [a, b, c]),
		uniform4f: (
			l: WebGLUniformLocation | null,
			a: number,
			b: number,
			c: number,
			d: number
		) => record(`uniform4f:${locName(l)}`, [a, b, c, d]),
		activeTexture: () => {},
		pixelStorei: () => {},
		texImage2D: () => {},
		viewport: () => {},
		clearColor: () => {},
		clear: () => {},
		drawArrays: () => {},
		deleteTexture: () => {},
		deleteProgram: () => {}
	} as unknown as GL;
	return { gl, calls, bad };
}

/** The name this stub gives a uniform location, so recordings can be keyed. */
function locName(l: WebGLUniformLocation | null): string {
	return (l as unknown as { name?: string } | null)?.name ?? '?';
}

/** A canvas whose `getContext('webgl2')` is the fake, and nothing else. */
function fakeCanvas(gl: GL): RendererCanvas {
	return {
		width: 10,
		height: 10,
		getContext: (id: string) => (id === 'webgl2' ? gl : null)
	} as RendererCanvas;
}

/** A stand-in texture source: the renderer only reads width/height from it. */
const fakeSource = { width: 4, height: 3 } as unknown as ImageBitmap;

test('every uniform value handed to GL is a real number', () => {
	// A field-name mismatch between `cropRect` and the renderer used to upload NaN
	// and blank the photo. Nothing else in the suite could see it.
	const { gl, bad } = fakeGL();

	const r = new Renderer(fakeCanvas(gl));
	r.setImage(fakeSource);
	r.setParams({
		target: { r: 252, g: 192, b: 0 },
		width: 30,
		feather: 40,
		tone: 0,
		contrast: 0,
		preset: 0,
		maskOn: 1,
		bypass: 0,
		crop: cropRect(4032, 3024, '1:1')
	});
	r.resize(10, 10, 1);
	r.render();

	assert.deepEqual(bad, [], `non-finite uniform values: ${JSON.stringify(bad)}`);
});

test('the renderer reads the same crop fields cropRect produces', () => {
	// The contract, stated directly: whatever cropRect names its fields, the
	// renderer must read those names. Asserted through the real uniform call.
	const { gl, calls } = fakeGL();

	const r = new Renderer(fakeCanvas(gl));
	r.setImage(fakeSource);
	const crop = cropRect(4032, 3024, '1:1');
	r.setParams({ crop });
	r.resize(10, 10, 1);
	r.render();

	const call = calls.filter((c) => c[0] === 'uniform4f:uCrop').pop();
	assert.ok(call, 'uCrop is set');
	assert.deepEqual(
		call.slice(1),
		[crop.sx, crop.sy, crop.sw, crop.sh],
		'uCrop must receive cropRect\'s own fields'
	);
});

test('the default crop is the identity', () => {
	// Nothing set: the shader must still sample the whole photo rather than NaN.
	const { gl, calls } = fakeGL();

	const r = new Renderer(fakeCanvas(gl));
	r.setImage(fakeSource);
	r.resize(10, 10, 1);
	r.render();

	const call = calls.filter((c) => c[0] === 'uniform4f:uCrop').pop();
	assert.ok(call, 'uCrop is set from the defaults');
	assert.deepEqual(call.slice(1), [0, 0, 1, 1], 'the identity keeps the whole photo');
});
