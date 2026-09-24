// GPU renderer for the selective-color pass. One fragment shader does the whole
// job: hue distance -> keep mask, mask layer, monochrome curve, tone/contrast,
// then blends the original color back through the keep value.
//
// Runs on WebGL2 where available and falls back to WebGL1 otherwise. Requiring
// WebGL2 refused to start at all on devices where it is missing — notably Chrome
// on Android, which blocklists it on a number of Adreno/Mali drivers and drops
// it under GPU memory pressure.
//
// The math here must stay in lockstep with color.js — that module is the CPU
// copy used for the coverage readout, so a divergence shows up as the readout
// disagreeing with the pixels.

import { VERT_300, FRAG_300, VERT_100, FRAG_100, UNIFORMS } from './shaders.js';
import type { UniformName } from './shaders.js';
import type { RenderParams, RenderParamsInput, TextureSource } from './types.js';

export { UNIFORMS, SHADERS } from './shaders.js';

/** Both context flavours the renderer may hold. Exported so the test double can
 *  be typed against the same union the renderer uses. */
export type GL = WebGLRenderingContext | WebGL2RenderingContext;

function compile(gl: GL, type: number, src: string): WebGLShader {
	const sh = gl.createShader(type);
	if (!sh) throw new Error('Could not create shader.');
	gl.shaderSource(sh, src);
	gl.compileShader(sh);
	if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
		const log = gl.getShaderInfoLog(sh);
		gl.deleteShader(sh);
		throw new Error(`Shader compile failed: ${log}`);
	}
	return sh;
}

function makeTexture(gl: GL): WebGLTexture {
	const t = gl.createTexture();
	if (!t) throw new Error('Could not create texture.');
	gl.bindTexture(gl.TEXTURE_2D, t);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
	return t;
}

const DEFAULTS: RenderParams = {
	target: { r: 255, g: 192, b: 0 },
	width: 30,
	feather: 40,
	tone: 0,
	contrast: 0,
	preset: 0,
	maskOn: 0,
	bypass: 0,
	// The kept rect of the photo, in normalised units — the shape `cropRect` in
	// export.ts returns. The identity is the whole photo, which is what `original`
	// means.
	crop: { sx: 0, sy: 0, sw: 1, sh: 1 }
};

/** The canvas a Renderer draws into. Both the stage and the offscreen thumbnail
 *  renderer pass a real one; the tests pass a stub with a fake context. */
export interface RendererCanvas {
	width: number;
	height: number;
	getContext(
		id: string,
		opts?: WebGLContextAttributes
	): RenderingContext | null;
}

export class Renderer {
	readonly canvas: RendererCanvas;
	gl: GL;
	isGL2: boolean;
	prog: WebGLProgram;
	attribLoc: number;
	u: Record<UniformName, WebGLUniformLocation | null>;
	imageTex: WebGLTexture;
	maskTex: WebGLTexture;
	/** The source currently resident in imageTex, for upload deduplication. */
	_src: TextureSource | null;
	params: RenderParams;
	hasImage: boolean;

	constructor(canvas: RendererCanvas) {
		this.canvas = canvas;

		// `preserveDrawingBuffer` must stay true. With it false the drawing buffer
		// is only valid inside the frame you drew it: any later recomposite
		// (scroll, resize, layout settle, tab switch) presents an empty buffer,
		// which reads as the photo area going black. The stage paints on demand
		// rather than in a loop, so preserving the buffer keeps the image on screen.
		const opts: WebGLContextAttributes = {
			antialias: false,
			alpha: true,
			premultipliedAlpha: false,
			preserveDrawingBuffer: true,
			// Ask for the discrete GPU where the browser lets us choose.
			powerPreference: 'high-performance'
		};

		// WebGL2 first, then WebGL1. Both are fine: the shader math is identical,
		// only the dialect differs.
		let gl: GL | null = null;
		let isGL2 = false;
		try {
			gl = canvas.getContext('webgl2', opts) as GL | null;
			isGL2 = !!gl;
		} catch {
			gl = null;
		}
		if (!gl) {
			try {
				gl =
					(canvas.getContext('webgl', opts) as GL | null) ||
					(canvas.getContext('experimental-webgl', opts) as GL | null);
			} catch {
				gl = null;
			}
		}
		if (!gl) {
			throw new Error(
				'This browser cannot run WebGL, which this editor needs to render the photo.'
			);
		}
		this.gl = gl;
		this.isGL2 = isGL2;

		const vert = isGL2 ? VERT_300 : VERT_100;
		const frag = isGL2 ? FRAG_300 : FRAG_100;

		const prog = gl.createProgram();
		if (!prog) throw new Error('Could not create shader program.');
		gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, vert));
		gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, frag));
		// WebGL2 needs the attribute bound before linking; WebGL1 assigns it during
		// linking. Binding on GL1 is harmless, so do it unconditionally.
		gl.bindAttribLocation(prog, 0, 'aPos');
		gl.linkProgram(prog);
		if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
			throw new Error(`Shader link failed: ${gl.getProgramInfoLog(prog)}`);
		}
		this.prog = prog;
		gl.useProgram(prog);

		const buf = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, buf);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
		this.attribLoc = gl.getAttribLocation(prog, 'aPos');
		if (this.attribLoc >= 0) {
			gl.enableVertexAttribArray(this.attribLoc);
			gl.vertexAttribPointer(this.attribLoc, 2, gl.FLOAT, false, 0, 0);
		}

		// Built from UNIFORMS so a uniform added to the shader and forgotten here is
		// a compile error rather than a silently missing lookup. `Object.fromEntries`
		// widens the key to `string`, so the record type is asserted back on — the
		// keys are exactly UNIFORMS by construction.
		this.u = Object.fromEntries(
			UNIFORMS.map((name) => [name, gl.getUniformLocation(prog, name)])
		) as Record<UniformName, WebGLUniformLocation | null>;

		this.imageTex = makeTexture(gl);
		this.maskTex = makeTexture(gl);
		this._src = null;
		this.params = { ...DEFAULTS };
		this.hasImage = false;

		gl.uniform1i(this.u.uImage, 0);
		gl.uniform1i(this.u.uMask, 1);
	}

	upload(source: TextureSource): void {
		const gl = this.gl;
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, this.imageTex);
		gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
		this.hasImage = true;
		this._src = source;
	}

	/**
	 * Upload a still and draw it.
	 *
	 * Skips the upload when this exact source is already resident. A still can be
	 * several tens of megabytes as a texture, and without this guard every
	 * repaint — and every consumer sharing a renderer — re-uploaded the whole
	 * thing. That is what made re-importing a photo stall.
	 *
	 * The live camera path calls `upload` directly, since a video element is
	 * always new pixels and must never be skipped.
	 */
	setImage(source: TextureSource): void {
		if (this._src !== source || !this.hasImage) this.upload(source);
		this.render();
	}

	/** Uploads the mask layer only when it changed. */
	setMask(source: TextureSource): void {
		const gl = this.gl;
		gl.activeTexture(gl.TEXTURE1);
		gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
		gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
	}

	setParams(p: RenderParamsInput): void {
		this.params = { ...DEFAULTS, ...p };
	}

	/** Resize the drawing buffer to the element's CSS box at `dpr`. */
	resize(cssW: number, cssH: number, dpr = Math.min(globalThis.devicePixelRatio || 1, 2)): void {
		const w = Math.max(1, Math.round(cssW * dpr));
		const h = Math.max(1, Math.round(cssH * dpr));
		if (this.canvas.width !== w || this.canvas.height !== h) {
			this.canvas.width = w;
			this.canvas.height = h;
		}
	}

	render(): void {
		const { gl, u, params } = this;
		if (!this.hasImage) return;

		gl.viewport(0, 0, this.canvas.width, this.canvas.height);
		gl.useProgram(this.prog);
		if (this.attribLoc >= 0) {
			gl.enableVertexAttribArray(this.attribLoc);
			gl.vertexAttribPointer(this.attribLoc, 2, gl.FLOAT, false, 0, 0);
		}
		gl.clearColor(0, 0, 0, 0);
		gl.clear(gl.COLOR_BUFFER_BIT);

		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, this.imageTex);
		gl.activeTexture(gl.TEXTURE1);
		gl.bindTexture(gl.TEXTURE_2D, this.maskTex);

		const t = params.target;
		gl.uniform3f(u.uTarget, t.r / 255, t.g / 255, t.b / 255);
		gl.uniform1f(u.uWidth, params.width / 100);
		gl.uniform1f(u.uFeather, params.feather / 100);
		gl.uniform1f(u.uTone, params.tone);
		gl.uniform1f(u.uContrast, params.contrast);
		gl.uniform1i(u.uPreset, params.preset | 0);
		gl.uniform1f(u.uMaskOn, params.maskOn ? 1 : 0);
		gl.uniform1f(u.uBypass, params.bypass ? 1 : 0);
		// `crop` uses the same field names `cropRect` returns. Passing undefined here
		// does not throw — it uploads NaN, the uv becomes NaN, every texture sample
		// misses, and the whole photo renders as one flat color with no error
		// anywhere. That is exactly how it failed once.
		const cr = params.crop;
		gl.uniform4f(u.uCrop, cr.sx, cr.sy, cr.sw, cr.sh);

		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
	}

	dispose(): void {
		const gl = this.gl;
		gl.deleteTexture(this.imageTex);
		gl.deleteTexture(this.maskTex);
		gl.deleteProgram(this.prog);
		// Hand the context back. Deleting the objects above frees the driver
		// memory they hold, but the context itself stays live and still counts
		// against the browser's limit until it is explicitly lost — Chrome on
		// Android allows far fewer live contexts than desktop, so a stage torn
		// down and rebuilt a few times could leave the next context creation
		// failing outright. The extension is optional; where it is missing the
		// context is simply left to the GC, which is the old behaviour.
		gl.getExtension('WEBGL_lose_context')?.loseContext();
	}
}

/**
 * One shared offscreen renderer for all thumbnails.
 *
 * Each thumbnail tile used to own a WebGL context. Browsers cap live contexts
 * (Chrome evicts the oldest past ~16), and every context carries real driver
 * memory, so four tiles for one photo was wasteful. They are also static — they
 * only change when the photo or the sampled accent changes — so there is no
 * reason to keep a GPU pipeline warm for them.
 *
 * This renders into a reused canvas and hands back a snapshot the caller can
 * paint once with `drawImage`. Sequential use only, which is how it is called.
 */
let thumb: { canvas: HTMLCanvasElement; renderer: Renderer } | null = null;

export function renderThumbnail(
	source: TextureSource,
	params: RenderParamsInput,
	w: number,
	h: number
): HTMLCanvasElement {
	if (!thumb) {
		const canvas = document.createElement('canvas');
		thumb = { canvas, renderer: new Renderer(canvas) };
	}
	const { canvas, renderer } = thumb;
	const cw = Math.max(2, Math.round(w));
	const ch = Math.max(2, Math.round(h));
	if (canvas.width !== cw || canvas.height !== ch) {
		canvas.width = cw;
		canvas.height = ch;
	}
	// setImage deduplicates the upload when this source is already resident, so
	// four tiles for one photo upload it once rather than four times.
	renderer.setImage(source);
	renderer.setParams({ ...params, maskOn: 0 });
	renderer.resize(cw, ch, 1);
	renderer.render();
	return canvas;
}
