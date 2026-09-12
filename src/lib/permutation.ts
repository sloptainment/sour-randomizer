// Seed -> species mapping. SPEC.md §4. Versioned by the config's `version` field, not frozen.
// Shared by the browser and the deranger, so it may not touch node or DOM APIs.

/** `DEF NUM_POKEMON` — constants/pokemon_constants.asm. Species ids are 1..251. */
export const NUM_POKEMON = 251;

/**
 * One source of randomness, named by a label. SPEC.md §4.1:
 *   SHA-256(u32be(seed) || utf8(label) || u32be(counter)) for counter = 0, 1, 2, ...
 * No separator is needed: the counter is fixed at four bytes and sits at the end, so two
 * labels of different length give inputs of different length, and two labels of the same
 * length differ inside the label.
 */
export class Keystream {
	private buf = new Uint8Array(0);
	private ctr = 0;
	private readonly label: Uint8Array;

	constructor(
		private readonly seed: number,
		label: string
	) {
		this.label = new TextEncoder().encode(label);
	}

	/** Next 4 bytes as a big-endian u32. */
	async draw(): Promise<number> {
		if (this.buf.length < 4) {
			const block = new Uint8Array(4 + this.label.length + 4);
			const view = new DataView(block.buffer);
			view.setUint32(0, this.seed);
			block.set(this.label, 4);
			view.setUint32(4 + this.label.length, this.ctr++);
			this.buf = new Uint8Array(await crypto.subtle.digest('SHA-256', block));
		}
		const v = new DataView(this.buf.buffer, this.buf.byteOffset, 4).getUint32(0);
		this.buf = this.buf.subarray(4);
		return v;
	}

	/** Unbiased integer in 0..n-1. Rejects the short tail rather than folding it. */
	async bounded(n: number): Promise<number> {
		// `2 ** 32 % 0` is NaN, and `d < NaN` is never true, so an empty range would spin here
		// forever rather than fail. Every caller must hand this a non-empty candidate list.
		if (!Number.isInteger(n) || n < 1) throw new Error(`bounded(${n}) has no answer`);
		const limit = 2 ** 32 - (2 ** 32 % n);
		for (;;) {
			const d = await this.draw();
			if (d < limit) return d % n;
		}
	}

	/** One element of `a`, uniformly. */
	async pick<T>(a: readonly T[]): Promise<T> {
		return a[await this.bounded(a.length)];
	}

	/** Fisher-Yates, in place, returning the same array. */
	async shuffle<T>(a: T[]): Promise<T[]> {
		for (let i = a.length - 1; i > 0; i--) {
			const j = await this.bounded(i + 1);
			[a[i], a[j]] = [a[j], a[i]];
		}
		return a;
	}
}

/**
 * The unconstrained species mapping for `seed` on stream `label`: `mapping[s]` is the
 * replacement for species `s`, and `mapping[0]` is 0. SPEC.md §4.2.
 *
 * Fisher-Yates with rejection sampling, abandoning an attempt the moment a fixed point is
 * placed — uniform over derangements, at a mean of 2.791 attempts. The keystream is never
 * restarted; a restart regenerates the same rejected shuffle forever.
 */
export async function derangement(seed: number, label: string): Promise<Uint8Array> {
	const ks = new Keystream(seed, label);
	for (;;) {
		const a = new Uint8Array(NUM_POKEMON + 1);
		for (let s = 1; s <= NUM_POKEMON; s++) a[s] = s;
		let ok = true;
		for (let s = NUM_POKEMON; s >= 2 && ok; s--) {
			const j = 1 + (await ks.bounded(s));
			[a[s], a[j]] = [a[j], a[s]];
			ok = a[s] !== s;
		}
		if (ok && a[1] !== 1) return a;
	}
}

/**
 * `Similar strength`: keep the candidates whose base stat total is within ±10 % of the
 * source's, widening by 10 points of percentage until at least one remains. SPEC.md §4.4.
 * Widening reaches every candidate, so it terminates. The only rule that gives way.
 */
export function widen(cands: number[], s: number, bst: number[]): number[] {
	const want = bst[s - 1];
	for (let band = 0.1; ; band += 0.1) {
		const kept = cands.filter((t) => Math.abs(bst[t - 1] - want) <= want * band);
		if (kept.length) return kept;
		if (band >= 1) return cands;
	}
}

/**
 * A rule-constrained mapping, constructed in one pass. SPEC.md §4.3.
 *
 * Rejection cannot reach one of these — the chance a random derangement puts all 89 gifts
 * species on basics is about 10^-26 — so the mapping is built rather than sampled.
 * `pool(s)` is the admitted target list for `s`; a species with no pool maps to itself.
 * Most-constrained-first is what makes "cannot fail" true for the bans.
 */
export async function construct(
	ks: Keystream,
	species: number[],
	pool: (s: number) => number[],
	strength?: number[]
): Promise<Uint8Array> {
	const order = await ks.shuffle([...species]);
	const sized = new Map(order.map((s) => [s, pool(s).length]));
	order.sort((a, b) => sized.get(a)! - sized.get(b)!);

	const map = new Uint8Array(NUM_POKEMON + 1);
	for (let s = 1; s <= NUM_POKEMON; s++) map[s] = s;
	const used = new Set<number>();
	const placed: number[] = [];
	for (const s of order) {
		let cands = pool(s).filter((t) => t !== s && !used.has(t));
		if (strength) cands = widen(cands, s, strength);
		if (!cands.length) {
			// Every admitted target is taken and the one left is `s` itself, which only a pool
			// exactly the size of its group can reach. Hand `s` a placed species' target and
			// hand that species `s`.
			// ponytail: one swap deep. A full augmenting-path matching is the upgrade if a
			// pool ever gets tight enough to defeat this.
			const donor = used.has(s)
				? undefined
				: placed.find((p) => pool(s).includes(map[p]) && pool(p).includes(s));
			if (donor === undefined) {
				// The pool is shorter than the set it must cover — a `Type theme` on a group
				// bigger than any type. The rule never gives way, so what gives is injectivity:
				// two species of this group may take the same target.
				cands = pool(s).filter((t) => t !== s);
				if (!cands.length) continue; // nothing at all admits it; it keeps its species
				if (strength) cands = widen(cands, s, strength);
			} else {
				// the donor's target is the only choice, so the strength band cannot apply here
				cands = [map[donor]];
				used.delete(map[donor]);
				map[donor] = s;
				used.add(s);
			}
		}
		const t = cands[await ks.bounded(cands.length)];
		map[s] = t;
		used.add(t);
		placed.push(s);
	}
	return map;
}
