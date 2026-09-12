import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
	CATEGORIES,
	admitted,
	pools,
	type Category,
	type Config,
	type Mode,
	type RuleName,
	type SpeciesData
} from './catalogue';
import { distinctSpecies, plan, slotsOf, type Offsets } from './plan';

const DATA = join(import.meta.dirname, '../data');
const offsets: Offsets = JSON.parse(readFileSync(join(DATA, 'offsets.json'), 'utf-8'));
const species: SpeciesData = JSON.parse(readFileSync(join(DATA, 'species.json'), 'utf-8'));
const p = pools(species);

function config(
	seed: number,
	sel: Partial<Record<Category, { mode: Mode; rules?: RuleName[] }>>
): Config {
	const out = { version: 1, rom: offsets.rom_sha1, seed } as Config;
	for (const c of CATEGORIES) {
		out[c] = { mode: sel[c]?.mode ?? 'unchanged', rules: sel[c]?.rules ?? [] };
	}
	return out;
}

const all = (mode: Mode, rules: RuleName[] = []) =>
	config(12345, { wild: { mode, rules }, trainers: { mode, rules }, gifts: { mode, rules } });

const canonicalAt = new Map<number, number>();
for (const c of CATEGORIES) {
	for (const g of Object.values(offsets.categories[c])) {
		for (const slot of slotsOf(g)) for (const o of slot.offsets) canonicalAt.set(o, slot.species);
	}
}

test('the offset list is a partition, and the plan writes exactly it', async () => {
	assert.equal(canonicalAt.size, offsets.total);
	const record = (await plan(all('global'), offsets, species, p)).records;
	const repaired = Object.values(offsets.repairs).flat().length;
	assert.equal(record.size, offsets.total + repaired);
	for (const off of canonicalAt.keys()) assert.ok(record.has(off), `${off} not written`);
});

test('Global mapping gives one species one replacement across every category', async () => {
	const planned = await plan(all('global'), offsets, species, p);
	assert.ok(planned.global);
	for (const [off, value] of planned.records) {
		if (!canonicalAt.has(off)) continue; // a repair
		assert.equal(value[0], planned.global[canonicalAt.get(off)!]);
	}
});

test('an Unchanged category is not written, and takes the repair with it', async () => {
	const planned = await plan(config(7, { wild: { mode: 'global' } }), offsets, species, p);
	for (const c of ['trainers', 'gifts'] as Category[]) {
		for (const g of Object.values(offsets.categories[c])) {
			for (const o of g.offsets) assert.ok(!planned.records.has(o), `${c} offset ${o} was written`);
		}
	}
	const withGifts = await plan(config(7, { gifts: { mode: 'global' } }), offsets, species, p);
	for (const [off] of Object.values(offsets.repairs).flat()) {
		assert.ok(!planned.records.has(off), 'the repair ran with gifts Unchanged');
		assert.equal(withGifts.records.get(off)?.[0], 156);
	}
});

test('Per slot writes one value per slot and never keeps a species', async () => {
	const planned = await plan(all('slot'), offsets, species, p);
	let tied = 0;
	for (const g of planned.groups) {
		g.slots.forEach((slot, i) => {
			assert.notEqual(g.targets[i], slot.species, `${g.group} kept ${slot.species}`);
			if (slot.offsets.length > 1) tied++;
			for (const o of slot.offsets) assert.equal(planned.records.get(o)![0], g.targets[i]);
		});
	}
	assert.ok(tied > 0, 'no tied group collapsed two offsets into one slot');
});

test('a tied group holds one species per slot', () => {
	for (const c of CATEGORIES) {
		for (const [name, g] of Object.entries(offsets.categories[c])) {
			if (!g.tied) continue;
			const seen = new Set(slotsOf(g).map((s) => s.species));
			assert.equal(seen.size, slotsOf(g).length, `${name} has two slots for one species`);
		}
	}
});

test('Basic only reaches every gifts species under Global mapping', async () => {
	const cfg = config(12345, { gifts: { mode: 'global', rules: ['basic-only'] } });
	const planned = await plan(cfg, offsets, species, p);
	for (const g of planned.groups) {
		for (const t of g.targets) assert.ok(p.basic.has(t), `${species.names[t - 1]} is not basic`);
	}
	assert.ok(distinctSpecies(offsets, 'gifts') <= p.basic.size, 'the legality law is what makes it fit');
});

test('Type theme puts one type behind a whole group', async () => {
	const cfg = config(4, { wild: { mode: 'group', rules: ['type-theme'] } });
	for (const g of (await plan(cfg, offsets, species, p)).groups) {
		assert.ok(g.theme, `${g.group} drew no type`);
		for (const t of g.targets) {
			assert.ok(species.types[t - 1].includes(g.theme!), `${g.group}: ${t} is not ${g.theme}`);
		}
	}
});

test('Fully evolved and No legendaries hold together per group', async () => {
	const cfg = config(5, { trainers: { mode: 'group', rules: ['fully-evolved', 'no-legendaries'] } });
	for (const g of (await plan(cfg, offsets, species, p)).groups) {
		for (const t of g.targets) {
			assert.ok(p.fullyEvolved.has(t));
			assert.ok(!p.legendary.has(t));
		}
	}
});

test('Catch them all reaches every admitted species', async () => {
	const rules: RuleName[] = ['catch-them-all', 'no-legendaries'];
	const cfg = config(11, { trainers: { mode: 'group', rules } });
	const planned = await plan(cfg, offsets, species, p);
	const hit = new Set(planned.groups.flatMap((g) => g.targets));
	const missed = admitted(p, rules).filter((s) => !hit.has(s));
	assert.deepEqual(missed, [], `${missed.length} species unreachable`);
});

test('Catch them all leaves each Group mapping group a mapping', async () => {
	const cfg = config(11, { trainers: { mode: 'group', rules: ['catch-them-all'] } });
	for (const g of (await plan(cfg, offsets, species, p)).groups) {
		const seen = new Map<number, number>();
		g.slots.forEach((slot, i) => {
			const already = seen.get(slot.species);
			if (already !== undefined) assert.equal(g.targets[i], already, `${g.group} maps ${slot.species} two ways`);
			seen.set(slot.species, g.targets[i]);
		});
	}
});

test('No legendaries leaves the legendaries where they are', async () => {
	const planned = await plan(all('global', ['no-legendaries']), offsets, species, p);
	for (const s of p.legendary) assert.equal(planned.global![s], s);
	for (const [off, value] of planned.records) {
		if (canonicalAt.has(off)) assert.ok(!p.legendary.has(value[0]) || p.legendary.has(canonicalAt.get(off)!));
	}
});

test('Per slot always has something to draw, even on the tightest themed pool', async () => {
	// DRAGONS_DEN_B1F under Type theme + Basic only can draw DRAGON, whose only basic species
	// is DRATINI — which the slot already holds. The type draw must not leave a slot with an
	// empty candidate list.
	const rules: RuleName[] = ['type-theme', 'basic-only'];
	for (const seed of [0, 1, 2, 3, 4, 5]) {
		const planned = await plan(config(seed, { wild: { mode: 'slot', rules } }), offsets, species, p);
		for (const g of planned.groups) {
			for (const t of g.targets) {
				assert.ok(p.basic.has(t), `${g.group}: ${species.names[t - 1]} is not basic`);
				assert.ok(species.types[t - 1].includes(g.theme!), `${g.group}: ${t} is not ${g.theme}`);
			}
		}
	}
});

// The constrained constructions have no external vectors; this table is the implementation's
// own output, pinned so a change to the construction is loud. SPEC.md §4.8.
const PINNED: [string, string, Config, number[]][] = [
	['gifts basic-only, global', 'ElmsLab', config(12345, { gifts: { mode: 'global', rules: ['basic-only'] } }), [207, 48, 218, 161, 185]],
	['wild type-theme, per group', 'ROUTE_30', config(4, { wild: { mode: 'group', rules: ['type-theme'] } }), [77, 146, 146, 244, 4, 229, 229, 244]],
	['trainers similar-strength, per slot', 'FalknerGroup/FALKNER#1', config(8, { trainers: { mode: 'slot', rules: ['similar-strength'] } }), [165, 102, 41, 83]]
];

for (const [name, group, cfg, want] of PINNED) {
	test(`${name} matches its pinned first eight`, async () => {
		const planned = await plan(cfg, offsets, species, p);
		const found = planned.groups.find((g) => g.group === group);
		assert.ok(found, `${group} is not in the plan`);
		assert.deepEqual(found.targets.slice(0, 8), want);
	});
}
