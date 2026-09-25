// Shared domain types.
//
// These are the shapes that cross module boundaries. They live in one file so a
// change to, say, the crop rect is a single edit that the compiler then checks
// against every consumer — the class of bug that motivated this port was exactly
// a field-name mismatch between two modules, which nothing but a type could have
// caught.

/** A colour, 0-255 per channel. Integer after `hexToRgb` or `paletteFromImageData`,
 *  but fractional in between (bucket averages), so the channels stay `number`. */
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

/** The region tool. `circle` and `rect` are parametric; `lasso` and `brush` are
 *  raster masks built from points. */
export type ShapeKind = 'circle' | 'rect' | 'lasso' | 'brush';

/** A parametric region. `cx`/`cy`/`w`/`h` are normalised image units; `rot` is
 *  radians. Only circle and rect ever have one — see `shapeForTool`. */
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
 *  defaults, so every field is genuinely optional — `target` included. */
export type RenderParamsInput = Partial<RenderParams>;

/** Anything the renderer or the sampler will accept as pixels. `fitBitmap`
 *  returns a canvas instead of a bitmap when it has to downscale. */
export type PixelSource = ImageBitmap | HTMLCanvasElement | HTMLImageElement;

/** Anything `texImage2D` will accept here: the still sources plus a video frame
 *  from the live camera path. */
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
	/** Bottom band. Equal to `pad` except for an instant-print frame, which has a
	 *  deliberately deeper foot. */
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

/** The supported locales. English is the default, Japanese the second. A union
 *  rather than `string` so the dictionary and every per-locale value can be
 *  indexed without a cast. */
export type LocaleId = 'en' | 'ja';

/** A supported locale, as offered in the language switcher. */
export interface Locale {
	id: LocaleId;
	label: string;
}
