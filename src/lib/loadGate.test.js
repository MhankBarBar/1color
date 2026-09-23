// Tests for the load gate.
//
// This guards a real ordering hazard: the boot sample loads on mount, and the
// user can choose their own photo while that fetch is still in flight. Without
// the gate the slower load wins and silently replaces the photo they picked.

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
	const seen = new Set();
	for (let i = 0; i < 100; i++) seen.add(gate.begin());
	assert.equal(seen.size, 100);
});

test('the boot sample does not clobber a photo the user picked', async () => {
	// The exact sequence from the app: the sample starts first but decodes
	// slowly, the user's photo starts second and finishes first.
	const gate = createLoadGate();
	let source = null;

	async function load(label, decodeMs) {
		const token = gate.begin();
		await new Promise((r) => setTimeout(r, decodeMs));
		if (!gate.isCurrent(token)) return 'dropped';
		source = label;
		return 'adopted';
	}

	const boot = load('sample', 40);
	const mine = load('userPhoto', 5);
	const results = await Promise.all([boot, mine]);

	assert.equal(source, 'userPhoto', 'the user\'s photo must survive');
	assert.deepEqual(results, ['dropped', 'adopted']);
});

test('the last load to start wins even if an earlier one finishes later', async () => {
	const gate = createLoadGate();
	let source = null;
	async function load(label, decodeMs) {
		const token = gate.begin();
		await new Promise((r) => setTimeout(r, decodeMs));
		if (!gate.isCurrent(token)) return;
		source = label;
	}
	// Start three, deliberately finishing out of order.
	const a = load('a', 30);
	const b = load('b', 20);
	const c = load('c', 10);
	await Promise.all([a, b, c]);
	// c began last, so c is current — regardless of who finished first.
	assert.equal(source, 'c');
});

test('an in-flight load can still commit if nothing newer started', async () => {
	const gate = createLoadGate();
	let source = null;
	const token = gate.begin();
	await new Promise((r) => setTimeout(r, 5));
	if (gate.isCurrent(token)) source = 'only';
	assert.equal(source, 'only');
});
