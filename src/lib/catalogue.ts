/**
 * The option catalogue: the modes, the rules, the legality table and the legendary list.
 * SPEC.md §3. Selected once per category — one mode, any number of rules.
 *
 * Nothing here reads the ROM or the offset list. The one number that decides legality, a
 * category's distinct species count, is a property of the game's content and is passed in.
 */

export type Category = 'wild' | 'trainers' | 'gifts';
export type Mode = 'unchanged' | 'global' | 'group' | 'slot';
export type RuleName =
	| 'similar-strength'
	| 'no-legendaries'
	| 'type-theme'
	| 'catch-them-all'
	| 'fully-evolved'
	| 'basic-only';

export type Selection = { mode: Mode; rules: RuleName[] };
export type Config = {
	version: number;
	rom: string;
	seed: number;
} & Record<Category, Selection>;

export type SpeciesData = {
	names: string[];
	bst: number[];
	types: string[][];
	evolves_to: number[][];
};

export const CATEGORIES: Category[] = ['wild', 'trainers', 'gifts'];

/** The version list. No migration code is ever written; the field turns a silent wrong
 *  result into a loud refusal. SPEC.md §4.6. */
export const READABLE_VERSIONS = [1];
export const MAX_SEED = 4294967295;

export const CATEGORY_META: Record<
	Category,
	{ label: string; group: string; groups: string; blurb: string; modes: Mode[] }
> = {
	wild: {
		label: 'Wild encounters',
		group: 'area',
		groups: 'areas',
		blurb: 'Grass, water, fishing, headbutt trees, swarms, roamers, the bug contest.',
		modes: ['unchanged', 'global', 'group', 'slot']
	},
	trainers: {
		label: 'Trainer parties',
		group: 'trainer',
		groups: 'trainers',
		blurb: 'Every opponent, including the Battle Tower floor pools.',
		modes: ['unchanged', 'global', 'group', 'slot']
	},
	gifts: {
		// gifts is not offered Group mapping: its groups are script files and tables, which is
		// not a boundary a player would recognise. It still has groups — the ties need them.
		label: 'Starters & gifts',
		group: 'script',
		groups: 'scripts',
		blurb: 'The three starters, gift Pokémon, in-game trades, the Odd Egg.',
		modes: ['unchanged', 'global', 'slot']
	}
};

export const MODE_LABEL: Record<Mode, string> = {
	unchanged: 'Unchanged',
	global: 'Global mapping',
	group: 'Group mapping',
	slot: 'Per slot'
};

export const RULES: { id: RuleName; label: string; blurb: string }[] = [
	{
		id: 'similar-strength',
		label: 'Similar strength',
		blurb: 'The replacement is within ±10 % of the base stat total, widening until one fits.'
	},
	{
		id: 'no-legendaries',
		label: 'No legendaries',
		blurb: 'The 11 legendaries leave the mapping. Lugia stays at the Whirl Islands.'
	},
	{
		id: 'type-theme',
		label: 'Type theme',
		blurb: 'Every replacement in one group shares a type, drawn from the types big enough for it.'
	},
	{
		id: 'catch-them-all',
		label: 'Catch them all',
		blurb: 'Every species of the admitted pool appears at least once among the replacements.'
	},
	{ id: 'fully-evolved', label: 'Fully evolved', blurb: 'The replacement cannot evolve further.' },
	{
		id: 'basic-only',
		label: 'Basic only',
		blurb: 'Only a species with no pre-evolution. 129 of them, the legendaries included.'
	}
];

export const RULE_NAMES = RULES.map((r) => r.id);
export const RULE_LABEL = Object.fromEntries(RULES.map((r) => [r.id, r.label])) as Record<RuleName, string>;

/** No file in the source marks a species as legendary, so the list is an opinion, and
 *  extracted data holds only facts. SPEC.md §2.5. */
export const LEGENDARIES = [
	'ARTICUNO',
	'ZAPDOS',
	'MOLTRES',
	'MEWTWO',
	'MEW',
	'RAIKOU',
	'ENTEI',
	'SUICUNE',
	'LUGIA',
	'HO-OH',
	'CELEBI'
];

export type Pools = {
	all: number[];
	legendary: Set<number>;
	basic: Set<number>;
	fullyEvolved: Set<number>;
	byType: Record<string, number[]>;
};

/** The species sets every rule draws from, derived once from the extracted data. */
export function pools(sp: SpeciesData): Pools {
	const all = sp.names.map((_, i) => i + 1);
	const legendary = new Set(
		LEGENDARIES.map((n) => {
			const i = sp.names.indexOf(n);
			if (i < 0) throw new Error(`no species named ${n}`);
			return i + 1;
		})
	);
	const evolved = new Set(sp.evolves_to.flat());
	const byType: Record<string, number[]> = {};
	sp.types.forEach((ts, i) => {
		for (const t of new Set(ts)) (byType[t] ??= []).push(i + 1);
	});
	return {
		all,
		legendary,
		basic: new Set(all.filter((s) => !evolved.has(s))),
		fullyEvolved: new Set(all.filter((s) => !sp.evolves_to[s - 1].length)),
		byType
	};
}

/** The pool a rule set admits, before any per-group type theme. `type-theme`,
 *  `similar-strength` and `catch-them-all` do not shorten it. */
export function admitted(p: Pools, rules: readonly RuleName[]): number[] {
	return p.all.filter(
		(s) =>
			!(rules.includes('no-legendaries') && p.legendary.has(s)) &&
			!(rules.includes('fully-evolved') && !p.fullyEvolved.has(s)) &&
			!(rules.includes('basic-only') && !p.basic.has(s))
	);
}

/** The size of the pool a single rule allows, or null when it does not shorten one. */
export function poolSize(p: Pools, rule: RuleName): number | null {
	if (rule === 'no-legendaries') return null; // shortens sources and targets by the same 11
	if (rule === 'fully-evolved') return p.fullyEvolved.size;
	if (rule === 'basic-only') return p.basic.size;
	return null;
}

export type Legality = { ok: boolean; satisfied?: boolean; reason?: string };

/**
 * A bijection over the whole game must use every species as a target, so under
 * `Global mapping` a rule that shortens the pool is legal only when the category's distinct
 * species count is not greater than the pool size. SPEC.md §3.2.
 *
 * The other modes have no bijection to protect and accept any pool.
 */
export function legality(p: Pools, rule: RuleName, mode: Mode, distinct: number): Legality {
	if (mode !== 'global') return { ok: true };
	if (rule === 'catch-them-all') {
		return { ok: false, satisfied: true, reason: 'Already true — a whole-game mapping puts every species in the game.' };
	}
	if (rule === 'type-theme') {
		return { ok: false, reason: `One type never holds ${distinct.toLocaleString()} species.` };
	}
	const size = poolSize(p, rule);
	if (size === null || distinct <= size) return { ok: true };
	return {
		ok: false,
		reason: `This category holds more species than the pool — ${distinct} behind it, ${size} admitted.`
	};
}

/** The rules that make the mapping something `derangement()` cannot produce. */
export function constrains(rules: readonly RuleName[]): boolean {
	return rules.some((r) => r !== 'catch-them-all');
}

/**
 * The cross-category pairings a selection breaks. SPEC.md §6.6 and §7.7: a slot never
 * crosses a category, so these can never be tied; the app names the broken ones and never
 * refuses the selection.
 *
 * Two categories keep their pairings only while they share one mapping — both on
 * `Global mapping` — or while neither is written at all.
 */
export function brokenPairings(sel: Record<Category, Selection>): string[] {
	const aligned = (a: Category, b: Category) =>
		(sel[a].mode === 'global' && sel[b].mode === 'global') ||
		(sel[a].mode === 'unchanged' && sel[b].mode === 'unchanged');
	const out: string[] = [];
	if (!aligned('trainers', 'gifts')) {
		out.push('Trainer parties and Starters & gifts differ, so the rival fields a starter he never took.');
	}
	if (!aligned('wild', 'gifts')) {
		out.push('Wild encounters and Starters & gifts differ, so the beast cries in the Burned Tower and the Tin Tower name a different Pokémon from the one roaming Johto.');
		out.push('Wild encounters and Starters & gifts differ, so the checks for a caught species — the Magikarp rater, Bill’s grandfather, the in-game trades — ask for one the world no longer holds.');
	}
	if (sel.gifts.mode !== 'unchanged') {
		out.push('Starters & gifts is randomized, so evolving the hatched Togepi before Elm sees it loses the Everstone.');
	}
	return out;
}

/**
 * Every category on `Global mapping` shares one mapping, built under the union of their
 * rules, so a rule set on one moves the others' results. SPEC.md §4.1 and §6.4.
 */
export function sharedMappingConflict(sel: Record<Category, Selection>): string | null {
	const shared = CATEGORIES.filter((c) => sel[c].mode === 'global');
	if (shared.length < 2) return null;
	const withRules = shared.filter((c) => sel[c].rules.length);
	if (!withRules.length) return null;
	const names = shared.map((c) => CATEGORY_META[c].label);
	const list = `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
	return `${list} share one mapping while they are on Global mapping, so the rules on ${withRules
		.map((c) => CATEGORY_META[c].label.toLowerCase())
		.join(' and ')} move the others' results too.`;
}
