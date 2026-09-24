// Static checks on the stage overlay's CSS/markup contract.
//
// There is no DOM in Node, so these cannot render anything. They do catch the
// failures that actually happened:
//
//   1. The lasso and the brush shared one class, so the lasso's fill was also
//      applied to brush strokes. An SVG path that is not closed is filled as if
//      it were closed, so every paint stroke came out with a lid drawn from its
//      last point back to its first. An inline `fill="none"` did not help — a
//      presentation attribute has specificity zero and sits before any author
//      stylesheet rule, so a single class selector overrode it.
//
//   2. Fixing that left the stroke drawn at the brush's true width in opaque
//      white, which covered the very pixels the brush was supposed to reveal.
//      The brush is no longer drawn as a path at all: the ring shows the size and
//      the shader shows the result, so an overlay only ever hides the effect.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../app.css', import.meta.url), 'utf8');
const stage = readFileSync(new URL('../components/Stage.svelte', import.meta.url), 'utf8');

/** The declaration block for a class, without its selector. */
function rule(sel: string): string {
	const m = new RegExp(`(?:^|\\n)\\s*\\.${sel}\\s*\\{([^}]*)\\}`).exec(css);
	assert.ok(m, `no .${sel} rule in app.css`);
	return m[1];
}

test('a brush stroke is not drawn over the photo', () => {
	// A painted approximation of the stroke hides the selective-color result under
	// it, which is the one thing the brush is there to reveal.
	assert.doesNotMatch(stage, /class="stage__stroke"/, 'no brush stroke overlay');
	assert.doesNotMatch(stage, /class="stage__path"/, 'no shared path overlay');
});

test('the lasso is still filled, so its region reads as a selection', () => {
	const body = rule('stage__lasso');
	assert.match(body, /fill:/, 'the lasso must be filled');
	assert.doesNotMatch(body, /fill:\s*none/, 'the lasso should not be unfilled');
});

test('the lasso path is the only closed overlay path', () => {
	assert.match(stage, /class="stage__lasso"\s+d=\{lassoPath\}/);
	// The lasso is the closed one, which is why it may be filled.
	assert.match(stage, /\.join\(' '\)\s*\+\s*' Z'/);
});

test('the brush size ring follows the pointer when there is one', () => {
	// Pointer position wins, so the ring previews where the stroke will land.
	assert.match(stage, /const brushAt = \$derived\(pointerView \?\? \{ x: 0\.5, y: 0\.5 \}\)/);
	assert.match(stage, /style:left=\{`\$\{brushAt\.x \* 100\}%`\}/);
	assert.match(stage, /style:top=\{`\$\{brushAt\.y \* 100\}%`\}/);
});

test('the ring shows while the size slider is dragged, with no pointer', () => {
	// Otherwise the size control changes a number with nothing on the photo to say
	// what it means.
	assert.match(
		stage,
		/const showBrushRing = \$derived\(brushActive && \(pointer !== null \|\| brushHint\)\)/,
		'the ring must also show while the slider is dragged'
	);
	assert.match(stage, /brushHint = false,/, 'the hint prop exists');
});

test('the ring is sized from the brush, not a fixed width', () => {
	// A fixed width would make the size slider inert on screen.
	const ring = /\.stage__brush \{([^}]*)\}/.exec(stage);
	assert.ok(ring, 'the ring has a rule');
	assert.doesNotMatch(ring[1], /^\s*width:/m, 'the ring width is set inline from brushSize');
	assert.match(stage, /style:width=\{`\$\{brushRingPx\}px`\}/);
});

test('no overlay path carries a fill presentation attribute', () => {
	// It would be a silent no-op anyway: a class always beats a presentation
	// attribute, which is why relying on `fill="none"` was the original mistake.
	assert.doesNotMatch(stage, /<path[^>]*\sfill=/, 'use the class, not an attribute');
});
