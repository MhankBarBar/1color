// Static checks on the icon set's markup contract.
//
// There is no DOM in Node, so these cannot render anything. They catch the
// failure that actually happened: every icon was emitted with a `viewBox` but no
// `width`/`height`, which gives an SVG no intrinsic size. On desktop the layout
// happened to resolve it to 24px, so nothing looked wrong — but WebKit resolves
// `max-width: 100%` on such an element to zero, and the Save, Share, and Compare
// buttons rendered as empty circles on Safari and Chrome on iOS. The icons that
// survived were exactly the ones that happened to have a CSS width.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { icons, icon, type IconName } from './icons.js';

const NAMES = Object.keys(icons) as IconName[];

test('every icon declares its own size', () => {
	// A viewBox alone is not a size. Without width/height the element is
	// un-resolvable in a grid or flex item, and WebKit collapses it to nothing.
	for (const name of NAMES) {
		const svg = icons[name];
		assert.match(svg, /<svg\b[^>]*\bwidth="\d+"/, `${name}: no width`);
		assert.match(svg, /<svg\b[^>]*\bheight="\d+"/, `${name}: no height`);
	}
});

test('the declared size matches the viewBox', () => {
	// A mismatch would scale the artwork rather than resize it, so a "24" viewBox
	// rendered at 24 must be a 1:1 mapping. This is what makes the intrinsic size
	// safe to rely on: the stroke widths were drawn for this scale.
	for (const name of NAMES) {
		const svg = icons[name];
		const w = /\bwidth="(\d+)"/.exec(svg)?.[1];
		const h = /\bheight="(\d+)"/.exec(svg)?.[1];
		const vb = /\bviewBox="0 0 (\d+) (\d+)"/.exec(svg);
		assert.ok(vb, `${name}: no viewBox`);
		assert.equal(w, vb[1], `${name}: width ${w} vs viewBox ${vb[1]}`);
		assert.equal(h, vb[2], `${name}: height ${h} vs viewBox ${vb[2]}`);
	}
});

test('every icon keeps its viewBox and stays hidden from assistive tech', () => {
	// The viewBox is what lets a caller resize an icon at all, and `aria-hidden`
	// is what keeps a decorative glyph out of the accessibility tree. Both were
	// load-bearing before this change and must survive it.
	for (const name of NAMES) {
		const svg = icons[name];
		assert.match(svg, /viewBox="0 0 24 24"/, `${name}: viewBox changed`);
		assert.match(svg, /aria-hidden="true"/, `${name}: no aria-hidden`);
		assert.match(svg, /stroke="currentColor"/, `${name}: does not inherit colour`);
	}
});

test('an unknown name still returns a drawable icon', () => {
	// The fallback is reachable: a dictionary key and an icon name are both
	// strings, and a typo should draw something rather than an empty button.
	const fallback = icon('definitely-not-an-icon' as IconName);
	assert.equal(fallback, icons.accent);
	assert.ok(fallback.includes('width="24"'));
});

test('every icon name used by a component exists in the set', () => {
	// Catches the other half of the same bug class: a name that is not in the set
	// silently falls back to the accent disc, so the button renders the wrong
	// glyph instead of none — harder to notice than an empty one.
	const files = [
		'src/App.svelte',
		'src/components/Editor.svelte',
		'src/components/Live.svelte',
		'src/components/Stage.svelte',
		'src/components/AccentTile.svelte'
	];
	const literal = /\bicon\(\s*'([^']+)'\s*\)/g;
	const seen = new Set<string>();

	for (const file of files) {
		const src = readFileSync(file, 'utf8');
		for (const m of src.matchAll(literal)) {
			seen.add(m[1]);
			assert.ok(
				Object.hasOwn(icons, m[1]),
				`${file}: icon('${m[1]}') is not in the icon set`
			);
		}
	}
	assert.ok(seen.size >= 8, `only found ${seen.size} literal icon names; the scan missed files`);
});
