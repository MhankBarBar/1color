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

const DIALECTS = [
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
const declaredIn = (frag) =>
	[...frag.matchAll(/^\s*uniform\s+\w+\s+(\w+)\s*;/gm)].map((m) => m[1]);

/** A uniform counts as used if it appears anywhere but its own declaration. */
const usedIn = (frag, names) => {
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
		assert.deepEqual(
			declared.filter((n) => !UNIFORMS.includes(n)),
			[],
			'declared in GLSL but never bound in JS'
		);
		assert.deepEqual(
			UNIFORMS.filter((n) => !declared.includes(n)),
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
