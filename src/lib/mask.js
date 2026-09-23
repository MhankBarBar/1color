// The mask layer: a white-on-black canvas the shader multiplies into the keep
// value. White keeps color, black forces monochrome, and the shader's
// smoothstep on the sampled value supplies the soft edge — so this layer can
// stay low resolution without looking soft.
//
// All geometry is stored in normalised image coordinates (0..1, y down) so it
// survives canvas resizes and export at a different resolution.

const MASK_MAX_EDGE = 1536;

export class MaskLayer {
	constructor(imgW, imgH) {
		const scale = Math.min(1, MASK_MAX_EDGE / Math.max(imgW, imgH));
		this.w = Math.max(2, Math.round(imgW * scale));
		this.h = Math.max(2, Math.round(imgH * scale));
		this.canvas = document.createElement('canvas');
		this.canvas.width = this.w;
		this.canvas.height = this.h;
		this.ctx = this.canvas.getContext('2d', { willReadFrequently: false });
		this.clear();
	}

	clear() {
		this.ctx.globalCompositeOperation = 'source-over';
		this.ctx.fillStyle = '#000';
		this.ctx.fillRect(0, 0, this.w, this.h);
	}

	/** Repaint every shape from scratch. Used when a transform changes. */
	drawAll({ shape, lasso, strokes }) {
		this.clear();
		const ctx = this.ctx;
		ctx.fillStyle = '#fff';
		ctx.strokeStyle = '#fff';
		ctx.lineJoin = 'round';
		ctx.lineCap = 'round';

		if (shape) {
			ctx.save();
			ctx.translate(shape.cx * this.w, shape.cy * this.h);
			ctx.rotate(shape.rot || 0);
			ctx.beginPath();
			if (shape.kind === 'rect') {
				ctx.rect((-shape.w * this.w) / 2, (-shape.h * this.h) / 2, shape.w * this.w, shape.h * this.h);
			} else {
				ctx.ellipse(0, 0, (shape.w * this.w) / 2, (shape.h * this.h) / 2, 0, 0, Math.PI * 2);
			}
			ctx.fill();
			ctx.restore();
		}

		if (lasso && lasso.length > 2) {
			ctx.beginPath();
			ctx.moveTo(lasso[0].x * this.w, lasso[0].y * this.h);
			for (let i = 1; i < lasso.length; i++) ctx.lineTo(lasso[i].x * this.w, lasso[i].y * this.h);
			ctx.closePath();
			ctx.fill();
		}

		for (const s of strokes || []) this._strokePath(s.pts, s.size);
	}

	/** Incremental paint: one segment, no full repaint. */
	strokeSegment(a, b, size) {
		const ctx = this.ctx;
		ctx.strokeStyle = '#fff';
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';
		ctx.lineWidth = Math.max(1, size * Math.max(this.w, this.h));
		ctx.beginPath();
		ctx.moveTo(a.x * this.w, a.y * this.h);
		ctx.lineTo(b.x * this.w, b.y * this.h);
		ctx.stroke();
	}

	_strokePath(pts, size) {
		if (!pts || pts.length < 2) return;
		const ctx = this.ctx;
		ctx.lineWidth = Math.max(1, size * Math.max(this.w, this.h));
		ctx.beginPath();
		ctx.moveTo(pts[0].x * this.w, pts[0].y * this.h);
		for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x * this.w, pts[i].y * this.h);
		ctx.stroke();
	}
}

// --- shape hit-testing and handles ---------------------------------------

/** Normalised distance from a point to a shape's outline, in units of the
 *  shape's own half-extent. <1 means inside. */
export function shapeHitTest(shape, px, py) {
	const dx = px - shape.cx;
	const dy = py - shape.cy;
	const cos = Math.cos(-(shape.rot || 0));
	const sin = Math.sin(-(shape.rot || 0));
	const lx = dx * cos - dy * sin;
	const ly = dx * sin + dy * cos;
	const hw = shape.w / 2;
	const hh = shape.h / 2;
	if (shape.kind === 'rect') return Math.max(Math.abs(lx) / hw, Math.abs(ly) / hh);
	return Math.hypot(lx / hw, ly / hh);
}

export const SHAPE_MIN = 0.04;

export function makeShape(kind, cx = 0.5, cy = 0.5) {
	const s = kind === 'rect' ? 0.34 : 0.3;
	return { kind, cx, cy, w: s, h: s, rot: 0 };
}

/** Tools that are drawn as a parametric shape rather than a raster mask. */
export const SHAPE_TOOLS = ['circle', 'rect'];

/**
 * The starting shape for a tool, or null for tools that do not use one.
 *
 * `lasso` and `brush` build a raster mask from points, so they must have no
 * shape at all. Returning a shape for them is not harmless: the overlay renders
 * any non-rect shape as an ellipse, so a stray shape makes the lasso tool draw a
 * circle over the photo. Centralised here so every caller gets the same answer.
 */
export function shapeForTool(kind) {
	return SHAPE_TOOLS.includes(kind) ? makeShape(kind, 0.5, 0.5) : null;
}
