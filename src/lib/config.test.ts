import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { pools, type Category, type Config, type SpeciesData } from './catalogue';
import { parseSeed, readConfig, serialize } from './config';
import { distinctSpecies, type Offsets } from './plan';

const DATA = join(import.meta.dirname, '../data');
const offsets: Offsets = JSON.parse(readFileSync(join(DATA, 'offsets.json'), 'utf-8'));
const species: SpeciesData = JSON.parse(readFileSync(join(DATA, 'species.json'), 'utf-8'));
const p = pools(species);
const distinct = { wild: 0, trainers: 0, gifts: 0 } as Record<Category, number>;
for (const c of ['wild', 'trainers', 'gifts'] as Category[]) distinct[c] = distinctSpecies(offsets, c);

const GOOD: Config = {
	version: 1,
	rom: offsets.rom_sha1,
	seed: 12345,
	wild: { mode: 'group', rules: ['similar-strength', 'type-theme'] },
	trainers: { mode: 'global', rules: [] },
	gifts: { mode: 'unchanged', rules: [] }
};
const read = (text: string) => readConfig(text, offsets.rom_sha1, distinct, p);

test('a config survives export and import unchanged', () => {
	assert.deepEqual(read(serialize(GOOD)), GOOD);
});

test('the seed is an integer, not a phrase', () => {
	assert.equal(parseSeed('  0012345 '), 12345, 'leading zeros are absorbed');
	assert.equal(parseSeed('4294967295'), 4294967295);
	for (const bad of ['', ' ', '0x1f', '12.5', '-1', '4294967296', 'lucky']) {
		assert.equal(parseSeed(bad), null, `${bad} was accepted`);
	}
});

// Any fault refuses the whole file and loads nothing: loading the legal parts hands the
// receiver a different ROM, with the warning arriving after the difference exists.
const FAULTS: [string, unknown, RegExp][] = [
	['a version this app does not read', { ...GOOD, version: 2 }, /version 2/],
	['a different build', { ...GOOD, rom: 'a'.repeat(40) }, /different build/],
	['a seed out of range', { ...GOOD, seed: 4294967296 }, /seed .* outside/],
	['a seed that is not a number', { ...GOOD, seed: '12345' }, /seed .* outside/],
	['an unknown top-level key', { ...GOOD, starters: [1] }, /unknown key, starters/],
	['a missing category', { version: 1, rom: GOOD.rom, seed: 1, wild: GOOD.wild, trainers: GOOD.trainers }, /missing key, gifts/],
	['an unknown mode', { ...GOOD, wild: { mode: 'per-offset', rules: [] } }, /wild.mode is not a mode/],
	['a mode the category is not offered', { ...GOOD, gifts: { mode: 'group', rules: [] } }, /gifts.mode is not offered/],
	['an unknown rule', { ...GOOD, wild: { mode: 'group', rules: ['no-ubers'] } }, /unknown rule, no-ubers/],
	['a repeated rule', { ...GOOD, wild: { mode: 'group', rules: ['type-theme', 'type-theme'] } }, /repeats type-theme/],
	['an unknown key inside a category', { ...GOOD, wild: { mode: 'group', rules: [], nickname: 'x' } }, /unknown key, nickname/],
	// SPEC.md §3.2's law: one type never holds 167 species
	['an illegal combination', { ...GOOD, wild: { mode: 'global', rules: ['type-theme'] } }, /not legal under global/],
	['a pool shorter than the category', { ...GOOD, trainers: { mode: 'global', rules: ['fully-evolved'] } }, /not legal under global/]
];

for (const [name, value, reason] of FAULTS) {
	test(`import refuses ${name}`, () => {
		assert.throws(() => read(JSON.stringify(value)), reason);
	});
}

test('import refuses text that is not JSON, and a bare list', () => {
	assert.throws(() => read('seed 12345'), /not JSON/);
	assert.throws(() => read('[1,2,3]'), /not a config object/);
});

test('the legality law lets gifts take a rule the other two cannot', () => {
	assert.ok(distinct.gifts <= p.basic.size);
	assert.deepEqual(read(serialize({ ...GOOD, gifts: { mode: 'global', rules: ['basic-only'] } })).gifts, {
		mode: 'global',
		rules: ['basic-only']
	});
	assert.throws(
		() => read(JSON.stringify({ ...GOOD, wild: { mode: 'global', rules: ['basic-only'] } })),
		/not legal/
	);
});
