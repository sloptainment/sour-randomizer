/**
 * Substitutes every in-scope species token in a source tree, so that a rebuild can be
 * diffed against the canonical ROM to derive the offsets. SPEC.md §2.1-§2.4.
 * Run inside a buildenv overlay; it rewrites the tree in place.
 *
 *   npm run derange -- --labelled A --tree "$PWD" --out mapping.json
 *   npm run derange -- --seed 3    --tree "$PWD" --out mapping.json
 *   npm run derange -- --repairs   --tree "$PWD" --out mapping.json
 *   npm run derange -- --plan      --tree DIR                        # counts only, no writes
 *
 * The group declarations of SPEC.md §2.3 live here and nowhere else. Nothing is grouped by
 * hand and no group is declared by address: a group is a boundary the source already draws.
 *
 * A species token is substituted only in *code* context, never inside a comment or a quoted
 * string.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Keystream, NUM_POKEMON, derangement } from '../lib/permutation';

export type Category = 'wild' | 'trainers' | 'gifts';
export const CATEGORY_NAMES: Category[] = ['wild', 'trainers', 'gifts'];

/** Trainer entries exceed the 250-group bound, so an entry id is composed from two builds:
 *  build A labels `i / BASE | 0`, build B labels `i % BASE`, and the pair names the entry. */
export const ENTRY_BASE = 25;
const BT_POOL = 21; // BATTLETOWER_NUM_UNIQUE_MON
const GROUP_BOUND = NUM_POKEMON - 1; // {identity, P1..Pk} discordant on 251 symbols

// --- scope: SPEC.md §2.2 ----------------------------------------------------------------

const wild = (n: string) => `data/wild/${n}.asm`;
const AREA_STEMS = ['johto_grass', 'johto_water', 'kanto_grass', 'kanto_water', 'bug_contest_safari_mons'];
const SWARM_STEMS = ['swarm_grass', 'swarm_grass_alt', 'swarm_water', 'swarm_water_alt'];
const FILE_STEMS = ['fish', 'treemons', 'treemons_asleep'];

const TRAINER_PARTIES = 'data/trainers/parties.asm';
const BATTLE_TOWER = 'data/battle_tower/parties.asm';

// maps/ is opt-out. Three whole-file exclusions, all depictions or debug code.
const MAP_EXCLUSIONS = new Set([
	// every species site is inside `if DEF(_DEBUG)`, incl. a `givepoke BULBASAUR + x` loop
	'maps/PlayersHouse2F.asm',
	// 17 `getmonname` sites naming *dolls*, each followed by `checkevent EVENT_DECO_*_DOLL`
	'maps/GoldenrodDeptStoreRoof.asm',
	// the zoo pen signs: `pokepic` + `cry` pairs behind fossil-event gates, nothing caught,
	// battled or checked. The same shape as the dolls, ruled the same way.
	'maps/FuchsiaCity.asm'
]);

// Two map files that check each other's gift are one group; SPEC.md §2.3.2.
const MAP_ABSORB: Record<string, string> = {
	'maps/VioletPokecenter1F.asm': 'ElmsLab',
	'maps/OaksLab.asm': 'ElmsLab',
	'maps/CeruleanCaveB1F.asm': 'PokemonMansionB1F',
	'maps/BurnedTowerB1F.asm': 'TinTower1F'
};

/** engine/ is opt-in by line: engine/ holds behaviour keyed by species, so nothing in it is
 *  in scope but these. Each line joins the group of the map file whose script reaches it. */
const ENGINE_LINES: [string, number[], Category, string][] = [
	['engine/events/specials.asm', [543, 556, 569], 'wild', 'roamers'],
	['engine/overworld/wildmons.asm', [594, 596], 'wild', 'roamers'],
	['engine/overworld/events.asm', [1216, 1222, 1228], 'wild', 'roamers'],
	['engine/events/dratini.asm', [19], 'gifts', 'DragonShrine'],
	['engine/events/shuckle.asm', [9, 79], 'gifts', 'ManiasHouse'],
	['engine/events/magikarp.asm', [11], 'gifts', 'LakeOfRageMagikarpHouse'],
	['engine/pokemon/breeding.asm', [275], 'gifts', 'ElmsLab'],
	['engine/events/unown_walls.asm', [4], 'gifts', 'TinTowerRoof']
];

/** A group is tied when two bytes holding the same species must keep holding the same
 *  species. Declared for the group, never for a byte. SPEC.md §2.3.2. */
const TIED_WILD = new Set(['swarm', 'roamers', 'NATIONAL_PARK_BUG_CONTEST']);

/** Both spellings of an area declaration: `def_grass_wildmons` / `def_water_wildmons` in the
 *  encounter tables, a bare `map_id` in the contest and safari tables. */
const AREA = /^\t(?:def_(?:grass|water)_wildmons|map_id) ([A-Z0-9_]+)/;
const ENTRY = /^\tdb "([^"]*)@", *TRAINERTYPE/;
const CLASS = /^([A-Za-z_]\w*):/;

export type FilePlan = {
	rel: string;
	category: Category;
	lines?: Set<number>;
	group: (line: number, nth: number) => string;
};

/** The maps in scope, taken from the build's own INCLUDE list rather than a glob of
 *  maps/*.asm: 11 of the 433 files there are unincluded vanilla leftovers, and deranging one
 *  inflates the substitution count against the diff. */
function mapFiles(tree: string): string[] {
	const scripts = readFileSync(join(tree, 'data/maps/scripts.asm'), 'utf-8');
	return [...scripts.matchAll(/INCLUDE "(maps\/[^"]+)"/g)]
		.map((m) => m[1])
		.filter((f) => !MAP_EXCLUSIONS.has(f))
		.sort();
}

/** Every trainer entry of parties.asm, in source order: `db "NAME@"` to `db -1`, the
 *  normal party and the challenge-mode party together. Named for the class and the name and
 *  never by a number, because the 620 entries share only 420 (class, name) pairs. */
export function trainerEntries(tree: string): { start: number; name: string }[] {
	const out: { start: number; name: string }[] = [];
	const seen = new Map<string, number>();
	let cls = '';
	readFileSync(join(tree, TRAINER_PARTIES), 'utf-8')
		.split('\n')
		.forEach((line, i) => {
			const c = CLASS.exec(line);
			if (c) cls = c[1];
			const e = ENTRY.exec(line);
			if (!e) return;
			const key = `${cls}/${e[1]}`;
			const n = (seen.get(key) ?? 0) + 1;
			seen.set(key, n);
			out.push({ start: i + 1, name: `${key}#${n}` });
		});
	return out;
}

/** Splits a file into groups at its own area declarations. */
function byArea(tree: string, rel: string): (line: number) => string {
	const marks: [number, string][] = [];
	readFileSync(join(tree, rel), 'utf-8')
		.split('\n')
		.forEach((line, i) => {
			const m = AREA.exec(line);
			if (m) marks.push([i + 1, m[1]]);
		});
	return (line) => {
		const hit = marks.filter(([at]) => at <= line).pop();
		if (!hit) throw new Error(`${rel}:${line} has no area above it`);
		return hit[1];
	};
}

/** The whole group declaration. SPEC.md §2.3. */
export function plan(tree: string): FilePlan[] {
	const challenge = readdirSync(join(tree, 'data/wild/challenge_mode')).sort();
	const files: FilePlan[] = [];
	const fixed = (rel: string, category: Category, g: string) =>
		files.push({ rel, category, group: () => g });

	// wild — one area, the three tied groups, and each remaining file
	for (const stem of AREA_STEMS) {
		for (const rel of [wild(stem), `data/wild/challenge_mode/${stem}.asm`]) {
			if (!challenge.includes(`${stem}.asm`) && rel.includes('challenge_mode')) continue;
			files.push({ rel, category: 'wild', group: byArea(tree, rel) });
		}
	}
	for (const stem of SWARM_STEMS) {
		fixed(wild(stem), 'wild', 'swarm');
		fixed(`data/wild/challenge_mode/${stem}.asm`, 'wild', 'swarm');
	}
	fixed(wild('swarm_location_data'), 'wild', 'swarm');
	fixed('engine/battle/swarm_shiny.asm', 'wild', 'swarm');
	fixed('engine/battle/swarm_shiny_alt.asm', 'wild', 'swarm');
	fixed(wild('flee_mons'), 'wild', 'roamers');
	fixed('data/events/bug_contest_winners.asm', 'wild', 'NATIONAL_PARK_BUG_CONTEST');
	for (const stem of FILE_STEMS) fixed(wild(stem), 'wild', stem);

	// trainers — one entry of parties.asm, one floor pool of the battle tower
	const entries = trainerEntries(tree);
	if (entries.length !== 620) throw new Error(`${entries.length} trainer entries, want 620`);
	files.push({
		rel: TRAINER_PARTIES,
		category: 'trainers',
		group: (line) => entries[entryIndex(entries, line)].name
	});
	files.push({
		rel: BATTLE_TOWER,
		category: 'trainers',
		group: (_line, nth) => `BattleTower#${Math.floor(nth / BT_POOL) + 1}`
	});

	// gifts — one map file, or one table; absorptions per SPEC.md §2.3.2
	for (const rel of mapFiles(tree)) {
		files.push({
			rel,
			category: 'gifts',
			group: () => MAP_ABSORB[rel] ?? rel.slice('maps/'.length, -'.asm'.length)
		});
	}
	fixed('data/events/npc_trades.asm', 'gifts', 'npc_trades');
	fixed('data/events/odd_eggs.asm', 'gifts', 'odd_eggs');

	for (const [rel, lines, category, group] of ENGINE_LINES) {
		files.push({ rel, category, lines: new Set(lines), group: () => group });
	}
	return files;
}

export function entryIndex(entries: { start: number }[], line: number): number {
	let i = -1;
	while (i + 1 < entries.length && entries[i + 1].start <= line) i++;
	if (i < 0) throw new Error(`parties.asm:${line} sits above the first entry`);
	return i;
}

/** A group is tied when the source says so; every gifts group is. SPEC.md §2.3.2. */
export function isTied(category: Category, group: string): boolean {
	return category === 'gifts' || (category === 'wild' && TIED_WILD.has(group));
}

// --- species tokens ----------------------------------------------------------------------

/** The 251 species names, in id order. Stops before NUM_POKEMON: const_skip and EGG are
 *  outside the pool by construction and never appear. */
export function speciesNames(tree: string): string[] {
	const src = readFileSync(join(tree, 'constants/pokemon_constants.asm'), 'utf-8');
	const names = [...src.slice(0, src.indexOf('DEF NUM_POKEMON')).matchAll(/^\tconst (\w+)/gm)].map(
		(m) => m[1]
	);
	if (names.length !== NUM_POKEMON) throw new Error(`${names.length} species names, want 251`);
	return names;
}

export function speciesToken(names: string[]): RegExp {
	return new RegExp(`\\b(${[...names].sort((a, b) => b.length - a.length).join('|')})\\b`, 'g');
}

/** Where does column `col` of `line` sit? Only a ';' outside a string opens a comment, and a
 *  string may hold one before the real comment does. */
export function contextAt(line: string, col: number): 'code' | 'comment' | 'string' {
	let quotes = 0;
	for (let i = 0; i < col; i++) {
		if (line[i] === '"') quotes++;
		else if (line[i] === ';' && quotes % 2 === 0) return 'comment';
	}
	return quotes % 2 === 1 ? 'string' : 'code';
}

/**
 * Walks every in-scope species token of the tree, file by file and line by line. `visit`
 * returns the replacement name, or undefined to leave the token alone; the result holds the
 * new text of each file the visit changed.
 */
export function walk(
	tree: string,
	files: FilePlan[],
	visit: (f: FilePlan, group: string, name: string) => string | undefined
): Record<string, string> {
	const names = speciesNames(tree);
	const token = speciesToken(names);
	const written: Record<string, string> = {};
	for (const f of files) {
		let nth = 0;
		const text = readFileSync(join(tree, f.rel), 'utf-8');
		const out = text
			.split('\n')
			.map((line, i) =>
				f.lines && !f.lines.has(i + 1)
					? line
					: line.replace(token, (match, name: string, col: number) => {
							if (contextAt(line, col) !== 'code') return match;
							const group = f.group(i + 1, nth++);
							return visit(f, group, name) ?? match;
						})
			)
			.join('\n');
		if (out !== text) written[f.rel] = out;
	}
	return written;
}

// --- the group permutation family: SPEC.md §2.1 -------------------------------------------

/**
 * `Pi = R . rot(ci) . R^-1`, with `R` a fixed permutation of the 251 species and the `ci`
 * distinct and non-zero. Every `Pi` is then a derangement and no two agree at any species,
 * so a differing byte carries at most one label. Plain rotations are wrong: a rotation adds
 * a constant, so a `SPECIES + x` site satisfies `new == P(old)` at every species and the
 * loudest failure of the diff method becomes guaranteed silent.
 */
export async function family(
	labels: string[],
	tag: string
): Promise<{ R: number[]; c: Record<string, number> }> {
	if (labels.length > GROUP_BOUND) {
		throw new Error(`${labels.length} groups exceeds the bound of ${GROUP_BOUND}`);
	}
	const ks = new Keystream(0, tag);
	const R = await ks.shuffle([...Array(NUM_POKEMON).keys()]);
	const cs = await ks.shuffle([...Array(GROUP_BOUND).keys()].map((i) => i + 1));
	return { R, c: Object.fromEntries(labels.map((g, i) => [g, cs[i]])) };
}

export function permOf(R: number[], c: number): number[] {
	const inv: number[] = [];
	R.forEach((y, x) => (inv[y] = x));
	return Array.from({ length: NUM_POKEMON }, (_, i) => R[(inv[i] + c) % NUM_POKEMON] + 1);
}

// --- the runs -----------------------------------------------------------------------------

/** The label a build gives a group. Everything but a trainer entry keeps the same label in
 *  both builds, so those offsets are labelled twice and the two-run check covers them. */
function labelOf(build: string, f: FilePlan, group: string, entryOf: Map<string, number>): string {
	const i = entryOf.get(group);
	if (i === undefined) return `${f.category}/${group}`;
	return build === 'A' ? `T${Math.floor(i / ENTRY_BASE)}` : `T${i % ENTRY_BASE}`;
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const flag = (name: string) => {
		const i = argv.indexOf(`--${name}`);
		return i === -1 ? undefined : argv[i + 1];
	};
	const tree = flag('tree') ?? '.';
	const out = flag('out');
	const build = flag('labelled');
	const seed = flag('seed');
	const files = plan(tree);
	const names = speciesNames(tree);
	const ids = new Map(names.map((n, i) => [n, i + 1]));

	if (argv.includes('--plan')) {
		const groups = new Map<string, { category: Category; n: number }>();
		walk(tree, files, (f, g) => {
			const key = `${f.category}/${g}`;
			const e = groups.get(key) ?? { category: f.category, n: 0 };
			groups.set(key, { ...e, n: e.n + 1 });
			return undefined;
		});
		for (const c of CATEGORY_NAMES) {
			const mine = [...groups.values()].filter((g) => g.category === c);
			console.log(`${c}: ${mine.length} groups, ${mine.reduce((n, g) => n + g.n, 0)} offsets`);
		}
		console.log(`total ${[...groups.values()].reduce((n, g) => n + g.n, 0)} offsets`);
		return;
	}
	if (!out) throw new Error('usage: (--labelled A|B | --seed N | --repairs) --out FILE [--tree DIR]');

	if (argv.includes('--repairs')) {
		// SPEC.md §5.4 — every Odd Egg entry stores `bigdt 125`, the Medium Fast level-5
		// total, and 109 of 251 species have a higher level-5 threshold.
		const rel = 'data/events/odd_eggs.asm';
		const text = readFileSync(join(tree, rel), 'utf-8');
		const edits = text.split('\n').filter((l) => /^\s*bigdt 125\b/.test(l)).length;
		writeFileSync(join(tree, rel), text.replaceAll(/^(\s*bigdt )125\b/gm, '$1156'));
		writeFileSync(out, JSON.stringify({ repairs: { file: rel, from: 125, to: 156, edits } }));
		console.log(`${edits} bigdt edits in ${rel}`);
		return;
	}

	if (build) {
		const entries = trainerEntries(tree);
		const entryOf = new Map(entries.map((e, i) => [e.name, i]));
		const meta = new Map<string, { category: Category; tied: boolean; label: string }>();
		const counts: Record<string, number> = {};
		walk(tree, files, (f, g) => {
			meta.set(g, {
				category: f.category,
				tied: isTied(f.category, g),
				label: labelOf(build, f, g, entryOf)
			});
			counts[g] = (counts[g] ?? 0) + 1;
			return undefined;
		});
		const labels = [...new Set([...meta.values()].map((m) => m.label))].sort();
		const { R, c } = await family(labels, `label-family-${build}`);
		const perms = Object.fromEntries(labels.map((l) => [l, permOf(R, c[l])]));

		const byLabel: Record<string, number> = {};
		const written = walk(tree, files, (f, g, name) => {
			const label = meta.get(g)!.label;
			byLabel[label] = (byLabel[label] ?? 0) + 1;
			return names[perms[label][ids.get(name)! - 1] - 1];
		});
		for (const [rel, text] of Object.entries(written)) writeFileSync(join(tree, rel), text);

		const total = Object.values(byLabel).reduce((a, b) => a + b, 0);
		writeFileSync(
			out,
			JSON.stringify({
				build,
				base: ENTRY_BASE,
				R,
				groups: Object.fromEntries(labels.map((l) => [l, { c: c[l], count: byLabel[l] ?? 0 }])),
				meta: Object.fromEntries(
					[...meta].map(([g, m]) => [g, { category: m.category, tied: m.tied, label: m.label }])
				),
				counts,
				entries: entries.map((e) => e.name),
				total
			})
		);
		console.log(`build ${build}: ${total} substitutions across ${labels.length} labels`);
		return;
	}

	if (seed === undefined) throw new Error('one of --labelled, --seed, --repairs is required');
	const perm = await derangement(Number(seed), 'global');
	let total = 0;
	const written = walk(tree, files, (_f, _g, name) => {
		total++;
		return names[perm[ids.get(name)!] - 1];
	});
	for (const [rel, text] of Object.entries(written)) writeFileSync(join(tree, rel), text);
	writeFileSync(
		out,
		JSON.stringify({
			seed: Number(seed),
			label: 'global',
			perm: Object.fromEntries([...perm.entries()].slice(1)),
			total
		})
	);
	console.log(`seed ${seed}: ${total} substitutions`);
}

// the extractor imports the plan from here; only rewrite a tree when run directly
if (import.meta.filename === process.argv[1]) await main();
