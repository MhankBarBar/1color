/**
 * Monotonic token for overlapping async loads.
 *
 * Loads genuinely overlap here: the boot sample starts fetching on mount, and a
 * user can pick their own photo before it finishes decoding. Whichever settles
 * last wins in a naive implementation — so the slow sample would silently
 * replace the photo the user just chose. Each load claims a token and checks it
 * before committing; anything superseded is discarded.
 *
 * Kept as its own unit rather than inlined so the ordering rule can be tested.
 */
export function createLoadGate() {
	let current = 0;
	return {
		/** Claim the newest token. Invalidates every load already in flight. */
		begin() {
			return ++current;
		},
		/** True while `token` is still the newest load. */
		isCurrent(token) {
			return token === current;
		}
	};
}
