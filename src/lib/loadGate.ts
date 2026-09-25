/**
 * Monotonic token for overlapping async loads.
 *
 * The boot sample starts fetching on mount and the user can pick a photo before
 * it finishes decoding; naively the last to settle wins, so the slow sample would
 * silently replace the photo just chosen. Each load claims a token and checks it
 * before committing, discarding superseded loads.
 */
export interface LoadGate {
	/** Claim the newest token. Invalidates every load already in flight. */
	begin(): number;
	/** True while `token` is still the newest load. */
	isCurrent(token: number): boolean;
}

export function createLoadGate(): LoadGate {
	let current = 0;
	return {
		begin(): number {
			return ++current;
		},
		isCurrent(token: number): boolean {
			return token === current;
		}
	};
}
