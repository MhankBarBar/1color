// Shared domain types: the shapes that cross module boundaries. One file so a
// change is a single edit the compiler checks against every consumer — a
// field-name mismatch between two modules is what motivated this port.

/** A colour, 0-255 per channel. Integer after `hexToRgb`/`paletteFromImageData`,
 *  fractional in between (bucket averages), so the channels stay `number`. */
export interface Rgb {
	r: number;
	g: number;
	b: number;
}

/** HSV in linear light, all channels 0..1. `d` is the raw max-min spread, kept
 *  because the shader uses it and the CPU copy must agree. */
export interface Hsv {
	h: number;
	s: number;
	v: number;
	d: number;
}

/** The rect of the photo a ratio keeps, normalised 0..1. The renderer's `uCrop`. */
export interface CropRect {
	sx: number;
	sy: number;
	sw: number;
	sh: number;
}

/** Where the overlay block sits across the frame band. */
export type Align = 'left' | 'center' | 'right';

/** The frame fill selector. */
export type FrameId = 'none' | 'white' | 'black' | 'accent' | 'custom' | 'cheki';

/** The region tool: `circle`/`rect` parametric, `lasso`/`brush` raster from points. */
export type ShapeKind = 'circle' | 'rect' | 'lasso' | 'brush';

/** A parametric region. `cx`/`cy`/`w`/`h` normalised image units, `rot` radians.
 *  Only circle and rect have one — see `shapeForTool`. */
export interface Shape {
	kind: 'circle' | 'rect';
	cx: number;
	cy: number;
	w: number;
	h: number;
	rot: number;
}

/** A point in normalised image coordinates (0..1, y down). */
export interface Point {
	x: number;
	y: number;
}

/** One brush stroke: the points laid down, and the brush size in short-edge units. */
export interface Stroke {
	pts: Point[];
	size: number;
}

/** Everything the region tools produce, as handed to the mask layer. */
export interface MaskSpec {
	shape: Shape | null;
	lasso: Point[];
	strokes: Stroke[];
}

/** One entry in the export ratio list. `original` carries no w/h. */
export interface Ratio {
	id: string;
	label?: string | null;
	w?: number;
	h?: number;
}

/** Output pixels per side. */
export interface Size {
	w: number;
	h: number;
}

/** Export resolution cap: `std` bounds the long edge, `max` keeps the source. */
export type QualityId = 'std' | 'max';

/** How much of the overlay block to draw. */
export interface OverlaySpec {
	showSwatch: boolean;
	showCode: boolean;
	showMix: boolean;
}

/** The renderer's uniform inputs. Everything the fragment shader reads. */
export interface RenderParams {
	target: Rgb;
	width: number;
	feather: number;
	tone: number;
	contrast: number;
	preset: number;
	maskOn: number | boolean;
	bypass: number | boolean;
	crop: CropRect;
}

/** A partially-specified render param set. The renderer merges these over its
 *  defaults, so every field is optional — `target` included. */
export type RenderParamsInput = Partial<RenderParams>;

/** Anything the renderer or sampler accepts. `fitBitmap` returns a canvas when it
 *  has to downscale. */
export type PixelSource = ImageBitmap | HTMLCanvasElement | HTMLImageElement;

/** Anything `texImage2D` accepts here: the still sources plus a camera video frame. */
export type TextureSource = PixelSource | HTMLVideoElement;

/** What `loadPhoto` resolves to: the decodable source, and a display name. */
export interface LoadedPhoto {
	source: PixelSource;
	name: string;
}

/** The composition's geometry: frame fill, band width, and output size. */
export interface Geometry {
	hex: string | null;
	innerW: number;
	innerH: number;
	/** Side and top band. */
	pad: number;
	/** Bottom band. Deeper than `pad` only for an instant print's foot. */
	padBottom: number;
	outW: number;
	outH: number;
	aspect: number;
	align: Align;
	showSwatch: boolean;
	showCode: boolean;
	showMix: boolean;
	padFrac: number;
	padBottomFrac: number;
}

/** A locale's string table. Keys are dotted paths (`out.frame.white`). */
export type Dict = Record<string, string>;

/** The supported locales; English default, Japanese second. A union so the
 *  dictionary and per-locale values index without a cast. */
export type LocaleId = 'en' | 'ja';

/** A supported locale, as offered in the language switcher. */
export interface Locale {
	id: LocaleId;
	label: string;
}
