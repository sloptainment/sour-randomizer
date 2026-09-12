/**
 * Derives the offset lists by diffing the deranged builds against the canonical ROM, and
 * writes src/data/. SPEC.md §2.5. Reads builds; it never sources them itself and never
 * parses .asm for offsets. It reads the source tree for two things only: species data and
 * the check-shaped site list.
 *
 *   npm run extract
 *
 * Every check below is a hard failure. They are the whole reason this consumes builds
 * rather than trusting a hand-assembled list.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ROM_SIZE, calculateChecksums } from '../lib/stadium';
import { pools } from '../lib/catalogue';
import { plan as planPatch, type Offsets } from '../lib/plan';
import {
	CATEGORY_NAMES,
	ENTRY_BASE,
	isTied,
	permOf,
	plan as filePlan,
	speciesNames,
	speciesToken,
	contextAt,
	type Category
} from './derange';

const BUILD_ROOT = process.env.SC_BUILD_ROOT ?? join(homedir(), 'var');
const TREE = process.env.SC_TREE ?? join(homedir(), 'projects/sourcrystal');
const DATA = join(import.meta.dirname, '../data');

const ROM_SHA1 = 'e97b5cc1ed2abe9114da7a0f1795f2374796fc53';

/** tools/stadium rewrites these on every build, so a byte differing inside them is not an
 *  offset. One that happens to satisfy new == P(old) there is coincidence. */
const CHECKSUM_REGIONS = [
	[0x014e, 0x0150],
	[0x1ffde0, 0x200000]
];
const inChecksumRegion = (o: number) => CHECKSUM_REGIONS.some(([lo, hi]) => o >= lo && o < hi);

let failed = 0;
function check(ok: boolean, label: string, detail = ''): boolean {
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
	if (!ok) failed++;
	return ok;
}

type Labelled = {
	build: string;
	base: number;
	R: number[];
	groups: Record<string, { c: number; count: number }>;
	meta: Record<string, { category: Category; tied: boolean; label: string }>;
	counts: Record<string, number>;
	entries: string[];
	total: number;
};

const romOf = (dir: string) => readFileSync(join(BUILD_ROOT, dir, 'artifact/sourcrystal_debug.gbc'));
const mappingOf = <T>(dir: string): T =>
	JSON.parse(readFileSync(join(BUILD_ROOT, dir, 'mapping.json'), 'utf-8'));

/** Every byte differing from the canonical ROM, outside the checksum regions. */
function diffOffsets(canonical: Uint8Array, rom: Uint8Array): number[] {
	const offsets = [];
	for (let o = 0; o < canonical.length; o++) {
		if (canonical[o] !== rom[o] && !inChecksumRegion(o)) offsets.push(o);
	}
	return offsets;
}

// --- 1. the canonical ROM -----------------------------------------------------------------

const canonical = romOf('sourcrystal');
console.log('\n1 - the canonical ROM');
check(canonical.length === ROM_SIZE, `${ROM_SIZE} bytes`, `got ${canonical.length}`);
const sha1 = createHash('sha1').update(canonical).digest('hex');
check(sha1 === ROM_SHA1, `sha1 ${ROM_SHA1}`, `got ${sha1}`);

// --- 2. every differing byte carries exactly one label ------------------------------------

console.log('\n2 - every differing byte satisfies new == P(old) for exactly one label');
const labelled: Record<'A' | 'B', { m: Labelled; labels: Map<number, string> }> = {} as never;
for (const [build, dir] of [
	['A', 'sourrand-a'],
	['B', 'sourrand-b']
] as const) {
	const m = mappingOf<Labelled>(dir);
	const rom = romOf(dir);
	check(m.build === build, `${dir} is build ${build}`, `got ${m.build}`);
	// (old, new) -> the labels that explain it. Discordance makes this at most one entry.
	const byPair = new Map<number, string[]>();
	for (const [label, { c }] of Object.entries(m.groups)) {
		permOf(m.R, c).forEach((v, i) => {
			const key = (i + 1) * 256 + v;
			byPair.set(key, [...(byPair.get(key) ?? []), label]);
		});
	}
	const labels = new Map<number, string>();
	let unlabelled = 0;
	let ambiguous = 0;
	for (const o of diffOffsets(canonical, rom)) {
		const gs = byPair.get(canonical[o] * 256 + rom[o]) ?? [];
		if (gs.length === 1) labels.set(o, gs[0]);
		else if (gs.length === 0) unlabelled++;
		else ambiguous++;
	}
	check(!ambiguous, `build ${build}: no byte carries two labels`, `${ambiguous} ambiguous`);
	check(!unlabelled, `build ${build}: no byte carries zero labels`, `${unlabelled} unlabelled`);
	labelled[build] = { m, labels };
}

const A = labelled.A;
const B = labelled.B;
const perm3 = mappingOf<{ seed: number; perm: Record<string, number> }>('sourrand-c');
const rom3 = romOf('sourrand-c');
const perm3a = [0, ...Array.from({ length: 251 }, (_, i) => perm3.perm[String(i + 1)])];
const diff3 = diffOffsets(canonical, rom3);
check(
	diff3.every((o) => rom3[o] === perm3a[canonical[o]]),
	`build 4 (seed ${perm3.seed}): new == perm(old) at all ${diff3.length} differing bytes`
);

// --- 3. per-group count -------------------------------------------------------------------

console.log('\n3 - every group receives exactly the substitutions made in it');
for (const [build, { m, labels }] of Object.entries(labelled)) {
	const got: Record<string, number> = {};
	for (const l of labels.values()) got[l] = (got[l] ?? 0) + 1;
	const wrong = Object.entries(m.groups).filter(([l, g]) => (got[l] ?? 0) !== g.count);
	check(
		!wrong.length,
		`build ${build}: all ${Object.keys(m.groups).length} labels`,
		wrong.length ? `${wrong.length} wrong, first ${JSON.stringify(wrong[0])}` : ''
	);
	check(labels.size === m.total, `build ${build}: ${m.total} substitutions in total`, `got ${labels.size}`);
}

// --- 4. two-run agreement, and the composed trainer ids ------------------------------------

console.log('\n4 - two-run agreement');
const isDigit = (l: string) => /^T\d+$/.test(l);
check(
	A.labels.size === B.labels.size && [...A.labels.keys()].every((o) => B.labels.has(o)),
	'both builds label the same offsets'
);
const shared = [...A.labels].filter(([, l]) => !isDigit(l));
const disagree = shared.filter(([o, l]) => B.labels.get(o) !== l);
check(!disagree.length, `both builds agree on all ${shared.length} non-composed labels`, `${disagree.length} differ`);

/** An offset's canonical group id, `category/group`. Trainer entries are composed. */
const groupAt = new Map<number, string>();
let outOfRange = 0;
for (const [o, la] of A.labels) {
	const lb = B.labels.get(o)!;
	if (!isDigit(la)) {
		groupAt.set(o, la);
		continue;
	}
	const i = Number(la.slice(1)) * ENTRY_BASE + Number(lb.slice(1));
	if (!isDigit(lb) || i < 0 || i >= A.m.entries.length) outOfRange++;
	else groupAt.set(o, `trainers/${A.m.entries[i]}`);
}
check(!outOfRange, `every composed id names one of the ${A.m.entries.length} trainer entries`, `${outOfRange} outside range`);

const canonCounts: Record<string, number> = {};
for (const g of groupAt.values()) canonCounts[g] = (canonCounts[g] ?? 0) + 1;
const wantCounts = Object.fromEntries(
	Object.entries(A.m.counts).map(([g, n]) => [`${A.m.meta[g].category}/${g}`, n])
);
const badCount = Object.keys({ ...canonCounts, ...wantCounts }).filter(
	(g) => (canonCounts[g] ?? 0) !== (wantCounts[g] ?? 0)
);
check(!badCount.length, `all ${Object.keys(wantCounts).length} groups got exactly their substitutions`, `${badCount.length} wrong: ${badCount.slice(0, 3)}`);

// entries lie in the ROM in source order with no break, and no two ranges overlap
const span = new Map<string, [number, number]>();
for (const [o, g] of groupAt) {
	if (!g.startsWith('trainers/') || g.startsWith('trainers/BattleTower')) continue;
	const cur = span.get(g);
	span.set(g, cur ? [Math.min(cur[0], o), Math.max(cur[1], o)] : [o, o]);
}
const order = [...span].sort((a, b) => a[1][0] - b[1][0]).map(([g]) => A.m.entries.indexOf(g.slice('trainers/'.length)));
const breaks = order.filter((v, i) => i && v < order[i - 1]).length;
check(breaks <= 1, 'entries lie in the ROM in source order', `${breaks} breaks (parties.asm has 2 SECTIONs)`);
const ranges = [...span.values()].sort((a, b) => a[0] - b[0]);
const overlaps = ranges.filter((r, i) => i && r[0] <= ranges[i - 1][1]).length;
check(!overlaps, `none of the ${ranges.length} entry ranges overlap another`, `${overlaps} overlap`);

// --- 5. disjoint and complete --------------------------------------------------------------

console.log('\n5 - the partition');
const categories: Record<Category, Record<string, number[]>> = { wild: {}, trainers: {}, gifts: {} };
for (const [o, g] of [...groupAt].sort((a, b) => a[0] - b[0])) {
	const cut = g.indexOf('/');
	const category = g.slice(0, cut) as Category;
	const name = g.slice(cut + 1);
	(categories[category][name] ??= []).push(o);
}
const total = groupAt.size;
check(total === A.m.total, `${A.m.total} offsets, partitioned into ${Object.keys(canonCounts).length} groups`, `got ${total}`);
for (const c of CATEGORY_NAMES) {
	const n = Object.values(categories[c]).reduce((a, g) => a + g.length, 0);
	console.log(`        ${c}: ${Object.keys(categories[c]).length} groups, ${n} offsets`);
}

// --- 6. every offset holds a species id -----------------------------------------------------

console.log('\n6 - every offset holds a species id');
check(
	[...groupAt.keys()].every((o) => canonical[o] >= 1 && canonical[o] <= 251),
	'canonical[offset] is in 1..251 everywhere'
);

// --- 7. cross-permutation identity ----------------------------------------------------------

console.log('\n7 - cross-permutation identity');
const patched = Uint8Array.from(canonical);
for (const o of groupAt.keys()) patched[o] = perm3a[canonical[o]];
calculateChecksums(patched);
const differing = rom3.reduce((n, b, i) => n + (b === patched[i] ? 0 : 1), 0);
check(differing === 0, 'offsets from A and B + perm(build 4) + stadium == build 4, over all 2 MB', `${differing} bytes differ`);

// --- 8. the repair build --------------------------------------------------------------------

console.log('\n8 - the repair build');
const romR = romOf('sourrand-r');
const diffR = diffOffsets(canonical, romR);
// Unlike every other check, a repair build of the wrong shape *declines the repair* rather
// than failing the extract: SPEC.md §2.6 check 8. All three conditions are evaluated, so one
// failing does not hide the other two.
const repairShape: [boolean, string, string][] = [
	[diffR.length === 24, 'exactly 24 differing bytes', `got ${diffR.length}`],
	[
		diffR.every((o) => canonical[o] === 0x7d && romR[o] === 0x9c && !canonical[o - 1] && !canonical[o - 2]),
		'each is the third byte of a `bigdt`, 0x7D -> 0x9C',
		''
	],
	[diffR.every((o) => !groupAt.has(o)), 'no repair offset appears in any group', '']
];
for (const [ok, label, detail] of repairShape) {
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
}
const repairOk = repairShape.every(([ok]) => ok);
const repairs = repairOk ? { odd_egg_exp: diffR.map((o) => [o, [0x9c]]) } : {};
if (!repairOk) console.log('        the repair is declined — `repairs` is emitted empty and §5.4 is void');

// the species constants, shared by the species data and the check-shaped site scan
const names = speciesNames(TREE);
const token = speciesToken(names);

// --- species.json -------------------------------------------------------------------------

/** Display names, from data/pokemon/names.asm, which pads each to NAME_LENGTH - 1 with '@'. */
function displayNames(): string[] {
	const src = readFileSync(join(TREE, 'data/pokemon/names.asm'), 'utf-8');
	return [...src.matchAll(/^\tdb "([^"]*)"/gm)].map((m) => m[1].replaceAll('@', '')).slice(0, 251);
}

function speciesData() {
	const id = new Map(names.map((n, i) => [n, i + 1]));
	const bst = new Array<number>(251).fill(0);
	const types = new Array<string[]>(251);
	for (const f of readdirSync(join(TREE, 'data/pokemon/base_stats')).sort()) {
		const src = readFileSync(join(TREE, `data/pokemon/base_stats/${f}`), 'utf-8');
		const who = id.get(/^\tdb (\w+)/m.exec(src)![1])!;
		const stats = /^\tdb\s+(\d+),\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+)/m.exec(src)!;
		bst[who - 1] = stats.slice(1, 7).reduce((a, b) => a + Number(b), 0);
		types[who - 1] = /^\tdb (\w+), (\w+) ; type/m.exec(src)!.slice(1, 3).map((t) => t.replace(/_TYPE$/, ''));
	}
	const evos: number[][] = Array.from({ length: 251 }, () => []);
	const blocks = readFileSync(join(TREE, 'data/pokemon/evos_attacks.asm'), 'utf-8').split(/^\w+EvosAttacks:$/m).slice(1);
	blocks.forEach((block, i) => {
		for (const line of block.split('\n')) {
			if (/^\tdb 0 ;/.test(line)) break;
			const m = /^\tdb EVOLVE_\w+,.*?(\w+)\s*$/.exec(line);
			if (m && id.has(m[1])) evos[i].push(id.get(m[1])!);
		}
	});
	return { names: displayNames(), bst, types, evolves_to: evos, blocks: blocks.length };
}

const sp = speciesData();
const { blocks: _blocks, ...speciesOut } = sp;
console.log('\nspecies data');
check(sp.blocks === 251, '251 evos_attacks blocks', `got ${sp.blocks}`);
check(sp.names.length === 251 && sp.names[0] === 'BULBASAUR' && sp.names[250] === 'CELEBI', '251 display names, BULBASAUR first and CELEBI last');
check(sp.bst.every((v) => v > 0) && sp.types.every((t) => t?.length === 2), 'every species has a base stat total and two types');
const edges = sp.evolves_to.reduce((n, e) => n + e.length, 0);
const basics = sp.evolves_to.flat();
const nBasic = 251 - new Set(basics).size;
const nFinal = sp.evolves_to.filter((e) => !e.length).length;
check(edges === 132, '132 evolution edges', `got ${edges}`);
check(nBasic === 129, '129 basics', `got ${nBasic}`);
check(nFinal === 138, '138 fully evolved', `got ${nFinal}`);

// --- 9. one value per slot ------------------------------------------------------------------

console.log('\n9 - one value per slot');
{
	const b64 = (offs: number[]) => Buffer.from(offs.map((o) => canonical[o])).toString('base64');
	const draft: Offsets = {
		rom_sha1: ROM_SHA1,
		total,
		categories: Object.fromEntries(
			CATEGORY_NAMES.map((c) => [
				c,
				Object.fromEntries(
					Object.entries(categories[c]).map(([g, offs]) => [
						g,
						{ offsets: offs, species: b64(offs), tied: isTied(c, g) }
					])
				)
			])
		) as Offsets['categories'],
		repairs: {}
	};
	const sel = { mode: 'slot' as const, rules: [] };
	const drafted = await planPatch(
		{ version: 1, rom: ROM_SHA1, seed: 12345, wild: sel, trainers: sel, gifts: sel },
		draft,
		speciesOut,
		pools(speciesOut)
	);
	const bad = drafted.groups.filter((g) =>
		g.slots.some((s, i) => s.offsets.some((o) => drafted.records.get(o)![0] !== g.targets[i]))
	);
	check(!bad.length, `every offset of a slot received its slot's value, across ${drafted.groups.length} groups`, `${bad.length} groups wrong`);
	const tiedGroups = drafted.groups.filter((g) => draft.categories[g.category][g.group].tied);
	const collapsed = tiedGroups.reduce((n, g) => n + g.slots.filter((s) => s.offsets.length > 1).length, 0);
	check(collapsed > 0, `${collapsed} slots in the ${tiedGroups.length} tied groups hold more than one offset`);
}

// --- 10. every check-shaped site has a verdict ------------------------------------------------

console.log('\n10 - every check-shaped site has a verdict');

function walkTree(dir: string, out: string[] = []): string[] {
	for (const e of readdirSync(join(TREE, dir), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		if (e.isDirectory()) walkTree(`${dir}/${e.name}`, out);
		else if (e.name.endsWith('.asm')) out.push(`${dir}/${e.name}`);
	}
	return out;
}

/** A place in the game's code that *compares* against a species rather than placing one. */
const CONSTRUCTS: [string, RegExp][] = [
	['engine', /^\s*cp\s+$/],
	['maps', /^\s*(?:ifequal|ifnotequal|setval)\s+$/]
];
const sites: string[] = [];
for (const [root, lead] of CONSTRUCTS) {
	for (const rel of walkTree(root)) {
		readFileSync(join(TREE, rel), 'utf-8')
			.split('\n')
			.forEach((line, i) => {
				for (const m of line.matchAll(token)) {
					if (contextAt(line, m.index) === 'code' && lead.test(line.slice(0, m.index))) {
						sites.push(`${rel}:${i + 1}`);
					}
				}
			});
	}
}

// the group the extractor put each in-scope site in, so a `tied` verdict can be held to it
const siteGroupAt = new Map<string, string>();
for (const f of filePlan(TREE)) {
	let nth = 0;
	readFileSync(join(TREE, f.rel), 'utf-8')
		.split('\n')
		.forEach((line, i) => {
			if (f.lines && !f.lines.has(i + 1)) return;
			for (const m of line.matchAll(token)) {
				if (contextAt(line, m.index) !== 'code') continue;
				siteGroupAt.set(`${f.rel}:${i + 1}`, f.group(i + 1, nth++));
			}
		});
}

type Verdict = { site: string; verdict: string; group: string | null };
const verdicts = new Map<string, Verdict>();
{
	let cur: Record<string, string> = {};
	for (const line of readFileSync(join(DATA, 'verdicts.yaml'), 'utf-8').split('\n')) {
		const m = /^(-)?\s*(\w+):\s*(.*)$/.exec(line);
		if (!m) continue;
		if (m[1]) cur = {};
		cur[m[2]] = m[3].trim();
		if (m[2] === 'note' || m[3].trim() === '') continue;
		if (cur.site && cur.verdict) {
			verdicts.set(cur.site, {
				site: cur.site,
				verdict: cur.verdict,
				group: cur.group === 'null' ? null : cur.group
			});
		}
	}
}
const LEGAL_VERDICTS = new Set(['tied', 'limitation', 'not a pair']);
const missing = sites.filter((s) => !verdicts.has(s));
const extra = [...verdicts.keys()].filter((s) => !sites.includes(s));
check(!missing.length, `all ${sites.length} check-shaped sites carry a verdict`, `${missing.length} unjudged: ${missing.slice(0, 5)}`);
check(!extra.length, 'no verdict names a site that is gone', `${extra.length} stale: ${extra.slice(0, 5)}`);
check(
	[...verdicts.values()].every((v) => LEGAL_VERDICTS.has(v.verdict)),
	'every verdict is tied, limitation or not a pair'
);
const wrongGroup = [...verdicts.values()].filter(
	(v) => v.verdict === 'tied' && siteGroupAt.get(v.site) !== v.group
);
check(
	!wrongGroup.length,
	'every tied site landed in the group its verdict names',
	wrongGroup.length ? `${wrongGroup.length} wrong, first ${wrongGroup[0].site} -> ${siteGroupAt.get(wrongGroup[0].site)} want ${wrongGroup[0].group}` : ''
);

// --- write ----------------------------------------------------------------------------------

if (failed) {
	console.log(`\n${failed} checks failed — nothing written`);
	process.exit(1);
}

const b64 = (offs: number[]) => Buffer.from(offs.map((o) => canonical[o])).toString('base64');
const offsets = {
	rom_sha1: ROM_SHA1,
	total,
	categories: Object.fromEntries(
		CATEGORY_NAMES.map((c) => [
			c,
			Object.fromEntries(
				Object.entries(categories[c])
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([g, offs]) => [g, { offsets: offs, species: b64(offs), tied: isTied(c, g) }])
			)
		])
	),
	repairs
};
writeFileSync(join(DATA, 'offsets.json'), JSON.stringify(offsets));
writeFileSync(join(DATA, 'species.json'), JSON.stringify(speciesOut));

const distinct = (c: Category) => new Set(Object.values(categories[c]).flat().map((o) => canonical[o])).size;
console.log(
	`\nwrote ${total} offsets: ` +
		CATEGORY_NAMES.map(
			(c) =>
				`${c}=${Object.values(categories[c]).reduce((n, g) => n + g.length, 0)} in ${Object.keys(categories[c]).length} groups, ${distinct(c)} distinct species`
		).join('; ')
);
