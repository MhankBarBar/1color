// Shader sources for the selective-color pass.
//
// Two dialect pairs are provided. The math is identical in both — only the
// syntax differs — because WebGL2 is not universally available: Chrome on
// Android blocklists it on a number of Adreno/Mali drivers and drops it under
// GPU-process memory pressure, and Safari only shipped it in 15. Requiring it
// meant the whole app refused to start on those devices.
//
//   ES 3.00 (WebGL2): `in`/`out`, `texture()`, a declared `out` fragment color.
//   ES 1.00 (WebGL1): `attribute`/`varying`, `texture2D()`, `gl_FragColor`,
//                     plus a GLSL 1.00 precision guard for `int` comparisons.
//
// color.js mirrors this math; the test suite asserts the two agree.

const BODY = `
vec3 toLinear(vec3 c) {
	return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}

// HSV in linear light: hue of a shadowed color matches hue of its highlight.
// Returns hue, saturation ratio, value, and the raw linear mx-mn spread in .w.
// Must stay identical to hsv() in color.js.
vec4 hsv(vec3 c) {
	vec3 lin = toLinear(c);
	float mx = max(lin.r, max(lin.g, lin.b));
	float mn = min(lin.r, min(lin.g, lin.b));
	float d = mx - mn;
	float s = mx <= 0.0 ? 0.0 : d / mx;
	float h = 0.0;
	if (d > 0.0) {
		if (mx == lin.r) h = mod((lin.g - lin.b) / d, 6.0);
		else if (mx == lin.g) h = (lin.b - lin.r) / d + 2.0;
		else h = (lin.r - lin.g) / d + 4.0;
		h /= 6.0;
		if (h < 0.0) h += 1.0;
	}
	return vec4(h, s, mx, d);
}

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

// Hue distance gated by saturation; falls back to a brightness match when the
// target has no hue of its own. Must stay identical to accentDistance().
//
// The ratio test alone is not enough: near black it is meaningless, because
// converting sRGB to linear compresses the channel spread. rgb(4,2,1) reports a
// 0.75 ratio while being visually black, which made a near-black target act as a
// hue carrier. The absolute spread in .w is the honest test there.
//
// The brightness comparison goes through sqrt for the same reason: linear light
// squeezes every dark tone together, so a black target kept dark green leaves.
// sqrt approximates the sRGB curve closely enough and is cheap here.
//
// The pixel must also be neutral itself, judged as its chroma minus the
// target's: the saturation ratio cannot do it, because a neutral near-black
// reports 0.31 and the leaves report 0.91, so no threshold separates them.
float accentDist(vec3 a, vec3 b) {
	vec4 A = hsv(a);
	vec4 B = hsv(b);
	if (B.y < 0.15 || B.w < 0.012) {
		float bright = min(1.0, abs(sqrt(A.z) - sqrt(B.z)) * 1.6);
		float gate = smoothstep(0.002, 0.008, A.w - B.w);
		return max(bright, gate);
	}
	float gate = smoothstep(0.04, 0.25, min(A.y, B.y));
	float dh = abs(A.x - B.x);
	if (dh > 0.5) dh = 1.0 - dh;
	return max(dh * 2.0, 1.0 - gate);
}

// Four fixed monochrome looks, matching the app's Standard / Soft / Deep / High.
// Uses if/else rather than an int switch so both dialects accept it.
float shapeTone(float l) {
	if (uPreset == 1) return 0.06 + 0.88 * smoothstep(0.02, 0.98, l);
	if (uPreset == 2) return smoothstep(-0.02, 1.05, l);
	if (uPreset == 3) return smoothstep(0.08, 0.92, l);
	return l;
}
`;

const UNIFORM_BLOCK = `
uniform sampler2D uImage;
uniform sampler2D uMask;
uniform vec3 uTarget;
uniform float uWidth;
uniform float uFeather;
uniform float uTone;
uniform float uContrast;
uniform int uPreset;
uniform float uMaskOn;
uniform float uBypass;
uniform vec4 uCrop;
`;

const MAIN = (
	sampleFn: 'texture' | 'texture2D',
	writeFn: (expr: string) => string
) => `
void main() {
	// The ratio crops rather than distorts: uCrop is the kept rect in normalised
	// photo units. Sampling the image and the mask through the same rect keeps
	// them registered with each other, so a region mask still lines up with the
	// pixels it was drawn over.
	vec2 uv = uCrop.xy + vUv * uCrop.zw;
	vec4 src = ${sampleFn}(uImage, uv);

	// Before/after comparison: pass the original straight through. Doing this in
	// the shader keeps the comparison on the same pipeline, so the "before" is
	// genuinely the untouched source rather than a second render path that could
	// drift from it.
	if (uBypass > 0.5) {
		${writeFn('src')};
		return;
	}

	vec3 c = src.rgb;

	float dist = accentDist(c, uTarget);

	float e0 = 0.015 + uWidth * 0.3;
	float e1 = e0 + max(uFeather * 0.16, 0.0001);
	float keep = 1.0 - smoothstep(e0, e1, dist);

	if (uMaskOn > 0.5) keep *= ${sampleFn}(uMask, uv).r;

	float y = shapeTone(luma(c));
	y = clamp(y + uTone * 0.0025, 0.0, 1.0);
	y = clamp((y - 0.5) * (1.0 + uContrast * 0.009) + 0.5, 0.0, 1.0);

	${writeFn('vec4(mix(vec3(y), c, keep), src.a)')};
}
`;

// --- ES 3.00 / WebGL2 -----------------------------------------------------

export const VERT_300 = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
	// Canvas-space uv (y down) so every other module can work in the same
	// coordinate system as a 2D canvas. Textures upload unflipped.
	vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
	gl_Position = vec4(aPos, 0.0, 1.0);
}`;

export const FRAG_300 = `#version 300 es
precision highp float;
${UNIFORM_BLOCK}
in vec2 vUv;
out vec4 outColor;
${BODY}
${MAIN('texture', (expr: string): string => `outColor = ${expr}`)}`;

// --- ES 1.00 / WebGL1 -----------------------------------------------------

export const VERT_100 = `attribute vec2 aPos;
varying vec2 vUv;
void main() {
	vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
	gl_Position = vec4(aPos, 0.0, 1.0);
}`;

export const FRAG_100 = `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
${UNIFORM_BLOCK}
varying vec2 vUv;
${BODY}
${MAIN('texture2D', (expr: string): string => `gl_FragColor = ${expr}`)}`;

/** Every uniform the fragment shader declares, in both dialects. The Renderer
 *  looks each of these up by name, so a name here that is missing there is a
 *  silent no-op — the test suite asserts the two lists match. */
export const UNIFORMS = [
	'uImage',
	'uMask',
	'uTarget',
	'uWidth',
	'uFeather',
	'uTone',
	'uContrast',
	'uPreset',
	'uMaskOn',
	'uBypass',
	'uCrop'
] as const;

/** The name of one shader uniform. Derived from `UNIFORMS` so the renderer's
 *  lookup table and the shader's declarations cannot drift apart silently. */
export type UniformName = (typeof UNIFORMS)[number];

/** Exported so the tests can check the shaders against the JS wiring without a
 *  GL context. `UNIFORMS` is the contract between the two. */
export const SHADERS = {
	vert300: VERT_300,
	frag300: FRAG_300,
	vert100: VERT_100,
	frag100: FRAG_100
};
