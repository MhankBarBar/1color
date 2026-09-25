// Shader sources for the selective-color pass, in two dialects with identical math (ES 3.00
// `in`/`out`+`texture()`, ES 1.00 `attribute`/`varying`+`texture2D()`). WebGL2 is not universal:
// Android Chrome blocklists it on Adreno/Mali and Safari shipped it only in 15. color.js mirrors it.

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

// Hue distance gated by saturation, falling back to a brightness match for a hue-less
// target. Must stay identical to accentDistance(): the .w spread test, the sqrt on
// brightness, and the neutrality gate all exist because rgb(4,2,1) is visually black.
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
	// photo units. Sampling image and mask through the same rect keeps them
	// registered, so a region mask still lines up with the pixels it was drawn over.
	vec2 uv = uCrop.xy + vUv * uCrop.zw;
	vec4 src = ${sampleFn}(uImage, uv);

	// Doing the before/after comparison in the shader keeps the "before" on the same
	// pipeline — genuinely the untouched source, not a second path that could drift.
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

/** Every uniform the fragment shader declares, in both dialects. The Renderer looks
 *  each up by name, so a name here missing there is a silent no-op — the test suite
 *  asserts the two lists match. */
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

/** The name of one shader uniform. Derived from `UNIFORMS` so the renderer's lookup
 *  table and the shader's declarations cannot drift apart silently. */
export type UniformName = (typeof UNIFORMS)[number];

/** Exported so tests can check the shaders against the JS wiring without a GL
 *  context; `UNIFORMS` is the contract between the two. */
export const SHADERS = {
	vert300: VERT_300,
	frag300: FRAG_300,
	vert100: VERT_100,
	frag100: FRAG_100
};
