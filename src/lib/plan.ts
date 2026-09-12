/**
 * Selections and seed to patch record. SPEC.md §5.1.
 *
 * `plan` is a pure function with no ROM parameter: the canonical species behind every offset
 * is shipped beside the offset, so nothing here reads the upload. The spoiler log and the
 * tests read what it returns; nothing re-does the choosing.
 */
import {
	CATEGORIES,
	admitted,
	constrains,
	type Category,
	type Config,
	type Mode,
	type Pools,
	type RuleName,
	type SpeciesData
} from './catalogue';
import { Keystream, construct, derangement, widen } from './permutation';

export type Group = { offsets: number[]; species: string; tied: boolean };
export type Offsets = {
	rom_sha1: string;
	total: number;
	categories: Record<Category, Record<string, Group>>;
	repairs: Record<string, [number, number[]][]>;
};

/** One or more offsets that must hold the same species. Derived, never stored. */
export type Slot = { species: number; offsets: number[] };

export type GroupPlan = {
	category: Category;
	group: string;
	mode: Mode;
	slots: Slot[];
	/** parallel to `slots` */
	targets: number[];
	/** what this group's rules admit, for the `Catch them all` pass */
	pool: number[];
	/** the drawn type, when `Type theme` is on */
	theme?: string;
};

export type Plan = {
	records: Map<number, Uint8Array>;
	/** the one mapping every `Global mapping` category shares, when there is one */
	global: Uint8Array | null;
	groups: GroupPlan[];
};

function bytes(b64: string): Uint8Array {
	const raw = atob(b64);
	return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** Inside a tied group, all offsets holding the same canonical species are one slot;
 *  everywhere else, one offset is one slot. SPEC.md §4.5. */
export function slotsOf(g: Group): Slot[] {
	const species = bytes(g.species);
	if (!g.tied) return g.offsets.map((o, i) => ({ species: species[i], offsets: [o] }));
	const by = new Map<number, number[]>();
	g.offsets.forEach((o, i) => {
		const at = by.get(species[i]);
		if (at) at.push(o);
		else by.set(species[i], [o]);
	});
	return [...by].map(([species, offsets]) => ({ species, offsets }));
}

/** Every species behind one category's offsets. */
function speciesOf(offsets: Offsets, category: Category): Set<number> {
	const seen = new Set<number>();
	for (const g of Object.values(offsets.categories[category])) for (const s of bytes(g.species)) seen.add(s);
	return seen;
}

/** The distinct species behind one category's offsets — the number the legality law reads. */
export function distinctSpecies(offsets: Offsets, category: Category): number {
	return speciesOf(offsets, category).size;
}

/**
 * The one mapping every `Global mapping` category shares. Built once, under the union of
 * their rules, each applied to the species its own category holds. SPEC.md §4.3.
 */
async function globalMapping(
	config: Config,
	offsets: Offsets,
	sp: SpeciesData,
	p: Pools,
	shared: Category[]
): Promise<Uint8Array> {
	const rules = [...new Set(shared.flatMap((c) => config[c].rules))];
	if (!constrains(rules)) return derangement(config.seed, 'global');

	// No legendaries removes the 11 from S and from every pool, so they map to themselves.
	const banned = rules.includes('no-legendaries') ? p.legendary : new Set<number>();
	const holds = new Map(shared.map((c) => [c, speciesOf(offsets, c)]));
	const byCategory = new Map(shared.map((c) => [c, new Set(admitted(p, config[c].rules))]));

	const pool = (s: number): number[] => {
		let out = p.all.filter((t) => !banned.has(t));
		for (const c of shared) {
			if (holds.get(c)!.has(s)) out = out.filter((t) => byCategory.get(c)!.has(t));
		}
		return out;
	};
	const ks = new Keystream(config.seed, 'global');
	const species = p.all.filter((s) => !banned.has(s));
	return construct(ks, species, pool, rules.includes('similar-strength') ? sp.bst : undefined);
}

/** The admitted pool for one group, and the type theme drawn for it. */
async function groupPool(
	ks: Keystream,
	p: Pools,
	sp: SpeciesData,
	rules: readonly RuleName[],
	need: number
): Promise<{ pool: number[]; theme?: string }> {
	const base = admitted(p, rules);
	if (!rules.includes('type-theme')) return { pool: base };
	// The eligible types: those whose species, after the other bans, can fill the group.
	const kept = new Set(base);
	const size = (t: string) => p.byType[t].filter((s) => kept.has(s)).length;
	const types = Object.keys(p.byType).sort();
	let eligible = types.filter((t) => size(t) >= need);
	if (!eligible.length) {
		// No type is big enough — `swarm` holds 139 distinct species and the largest type holds
		// 50. The theme never gives way, so the widest types are drawn from instead and the
		// group's mapping stops being injective.
		const widest = Math.max(...types.map(size));
		eligible = types.filter((t) => size(t) === widest);
	}
	const theme = eligible[await ks.bounded(eligible.length)];
	return { pool: base.filter((s) => sp.types[s - 1].includes(theme)), theme };
}

/**
 * Every species of the admitted pool must appear at least once among the category's targets.
 * Runs after every group of the category is planned independently. SPEC.md §4.4.
 */
async function catchThemAll(
	seed: number,
	category: Category,
	rules: readonly RuleName[],
	p: Pools,
	plans: GroupPlan[]
): Promise<void> {
	const count = new Map<number, number>();
	for (const g of plans) for (const t of g.targets) count.set(t, (count.get(t) ?? 0) + 1);
	const missing = admitted(p, rules).filter((s) => !count.has(s));
	if (!missing.length) return;

	// Under `Group mapping` the group is a mapping, so a replacement takes every slot of the
	// same species with it; under `Per slot` a slot moves alone.
	const movable = new Map<GroupPlan, number[][]>();
	for (const g of plans) {
		if (g.mode !== 'group') {
			movable.set(g, g.slots.map((_, i) => [i]));
			continue;
		}
		const bySpecies = new Map<number, number[]>();
		g.slots.forEach((s, i) => bySpecies.set(s.species, [...(bySpecies.get(s.species) ?? []), i]));
		movable.set(g, [...bySpecies.values()]);
	}

	const ks = new Keystream(seed, `${category}/catch-them-all`);
	for (const want of missing) {
		const cands: [GroupPlan, number[]][] = [];
		for (const g of plans) {
			if (!g.pool.includes(want)) continue;
			for (const at of movable.get(g)!) {
				// the target must survive its own loss, and a slot never takes its own species
				if (g.slots[at[0]].species !== want && count.get(g.targets[at[0]])! > at.length) {
					cands.push([g, at]);
				}
			}
		}
		if (!cands.length) continue;
		const [g, at] = cands[await ks.bounded(cands.length)];
		count.set(g.targets[at[0]], count.get(g.targets[at[0]])! - at.length);
		for (const i of at) g.targets[i] = want;
		count.set(want, at.length);
	}
}

/** Selections and seed to patch record. SPEC.md §5.1. */
export async function plan(
	config: Config,
	offsets: Offsets,
	sp: SpeciesData,
	p: Pools
): Promise<Plan> {
	const shared = CATEGORIES.filter((c) => config[c].mode === 'global');
	const global = shared.length ? await globalMapping(config, offsets, sp, p, shared) : null;
	const groups: GroupPlan[] = [];

	for (const category of CATEGORIES) {
		const { mode, rules } = config[category];
		if (mode === 'unchanged') continue;
		const mine: GroupPlan[] = [];

		for (const [name, g] of Object.entries(offsets.categories[category])) {
			const slots = slotsOf(g);
			const entry: GroupPlan = { category, group: name, mode, slots, targets: [], pool: p.all };

			if (mode === 'global') {
				entry.targets = slots.map((s) => global![s.species]);
			} else {
				const label = `${category}/${name}`;
				const distinct = new Set(slots.map((s) => s.species));
				const ks = new Keystream(config.seed, label);
				// Per slot needs two species in the pool, not one: with one, a slot already
				// holding it has nothing left to draw. `wild/DRAGONS_DEN_B1F` under
				// `Type theme` + `Basic only` is the case — DRAGON holds one basic, DRATINI,
				// and the slot holds DRATINI.
				const { pool, theme } = await groupPool(ks, p, sp, rules, mode === 'group' ? distinct.size : 2);
				entry.pool = pool;
				entry.theme = theme;

				if (mode === 'group') {
					const map = constrains(rules)
						? await construct(
								ks,
								[...distinct],
								() => pool,
								rules.includes('similar-strength') ? sp.bst : undefined
							)
						: await derangement(config.seed, label);
					entry.targets = slots.map((s) => map[s.species]);
				} else {
					// Per slot: each slot draws on its own, and never keeps its species.
					for (const s of slots) {
						let cands = pool.filter((t) => t !== s.species);
						if (!cands.length) {
							entry.targets.push(s.species); // nothing but itself is admitted
							continue;
						}
						if (rules.includes('similar-strength')) cands = widen(cands, s.species, sp.bst);
						entry.targets.push(cands[await ks.bounded(cands.length)]);
					}
				}
			}
			mine.push(entry);
		}

		if (mode !== 'global' && rules.includes('catch-them-all')) {
			await catchThemAll(config.seed, category, rules, p, mine);
		}
		groups.push(...mine);
	}

	const records = new Map<number, Uint8Array>();
	for (const g of groups) {
		g.slots.forEach((slot, i) => {
			for (const off of slot.offsets) records.set(off, Uint8Array.of(g.targets[i]));
		});
	}
	// The one repair, applied whenever gifts is written and never otherwise. SPEC.md §5.4.
	if (config.gifts.mode !== 'unchanged') {
		for (const list of Object.values(offsets.repairs)) {
			for (const [off, values] of list) records.set(off, Uint8Array.from(values));
		}
	}
	return { records, global, groups };
}
