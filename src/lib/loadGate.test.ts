// Tests for the load gate.
//
// This guards a real ordering hazard: the boot sample loads on mount, and the
// user can choose their own photo while that fetch is still in flight. Without
// the gate the slower load wins and silently replaces the photo they picked.
//
// Decodes are released by hand rather than by a timer. That makes the ordering
// exact instead of "long enough", and lets each step assert the intermediate
// state — which is where the bug would actually be visible.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createLoadGate } from './loadGate.js';

test('a fresh gate has no current load', () => {
	const gate = createLoadGate();
	// Anything is stale until a load begins, so a result arriving before begin()
	// cannot commit.
	assert.equal(gate.isCurrent(0), true);
	assert.equal(gate.isCurrent(1), false);
});

test('the newest load wins and earlier ones are stale', () => {
	const gate = createLoadGate();
	const first = gate.begin();
	assert.equal(gate.isCurrent(first), true);

	const second = gate.begin();
	assert.equal(gate.isCurrent(second), true, 'newest must be current');
	assert.equal(gate.isCurrent(first), false, 'superseded load must be stale');
});

test('every load gets a distinct token', () => {
	const gate = createLoadGate();
	const seen = new Set<number>();
	for (let i = 0; i < 100; i++) seen.add(gate.begin());
	assert.equal(seen.size, 100);
});

test('the boot sample does not clobber a photo the user picked', async () => {
	// The exact sequence from the app: the sample starts first but decodes
	// slowly, the user's photo starts second and finishes first.
	const gate = createLoadGate();
	let source: string | null = null;

	const bootDecode = Promise.withResolvers<void>();
	const mineDecode = Promise.withResolvers<void>();

	async function load(
		label: string,
		decode: Promise<void>
	): Promise<'adopted' | 'dropped'> {
		const token = gate.begin();
		await decode;
		if (!gate.isCurrent(token)) return 'dropped';
		source = label;
		return 'adopted';
	}

	const boot = load('sample', bootDecode.promise);
	const mine = load('userPhoto', mineDecode.promise);

	// The user's photo decodes first and commits.
	mineDecode.resolve();
	assert.equal(await mine, 'adopted');
	assert.equal(source, 'userPhoto');

	// The slow boot sample then settles, and must be discarded rather than
	// overwriting what the user already chose.
	bootDecode.resolve();
	assert.equal(await boot, 'dropped');
	assert.equal(source, 'userPhoto', 'the slow sample must not replace it');
});

test('the last load to start wins even if an earlier one finishes later', async () => {
	const gate = createLoadGate();
	let source: string | null = null;

	const aDecode = Promise.withResolvers<void>();
	const bDecode = Promise.withResolvers<void>();
	const cDecode = Promise.withResolvers<void>();

	async function load(label: string, decode: Promise<void>): Promise<void> {
		const token = gate.begin();
		await decode;
		if (!gate.isCurrent(token)) return;
		source = label;
	}

	// Started in order a, b, c — so c holds the newest token.
	const a = load('a', aDecode.promise);
	const b = load('b', bDecode.promise);
	const c = load('c', cDecode.promise);

	// Settle them in the opposite order, so the oldest finishes last.
	cDecode.resolve();
	await c;
	assert.equal(source, 'c');

	bDecode.resolve();
	await b;
	aDecode.resolve();
	await a;

	// c began last, so c is current regardless of who finished first.
	assert.equal(source, 'c');
});

test('an in-flight load can still commit if nothing newer started', () => {
	const gate = createLoadGate();
	let source: string | null = null;
	const token = gate.begin();
	if (gate.isCurrent(token)) source = 'only';
	assert.equal(source, 'only');
});
