import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pools, type Category, type Config, type SpeciesData } from './catalogue';
import { patchRom, romProblem } from './patch';
import { plan, type Offsets } from './plan';

const DATA = join(import.meta.dirname, '../data');
const offsets: Offsets = JSON.parse(readFileSync(join(DATA, 'offsets.json'), 'utf-8'));
const species: SpeciesData = JSON.parse(readFileSync(join(DATA, 'species.json'), 'utf-8'));
const p = pools(species);

const BUILD_ROOT = process.env.SC_BUILD_ROOT ?? join(homedir(), 'var');
const romPath = (dir: string) => join(BUILD_ROOT, dir, 'artifact/sourcrystal.gbc');

function builds(): [Uint8Array, Uint8Array] | null {
	try {
		return [readFileSync(romPath('sourcrystal')), readFileSync(romPath('sourrand-c'))];
	} catch {
		return null;
	}
}

const global3: Config = {
	version: 1,
	rom: offsets.rom_sha1,
	seed: 3,
	wild: { mode: 'global', rules: [] },
	trainers: { mode: 'global', rules: [] },
	gifts: { mode: 'global', rules: [] }
};

// End to end, through the code the browser actually runs: patching the canonical ROM under
// seed 3 must reproduce the source-level build made from the same seed, byte for byte across
// all 2 MB. The extractor's check 7 in the app's own path.
test('patching under seed 3 reproduces the seed 3 build', async (t) => {
	const pair = builds();
	if (!pair) return t.skip(`no builds under ${BUILD_ROOT}`);
	const [canonical, expected] = pair;
	const { records } = await plan(global3, offsets, species, p);
	// build 4 was made from the sources, which carry no repair
	for (const [off] of Object.values(offsets.repairs).flat()) records.delete(off);
	const patched = patchRom(canonical, records);
	const differing = expected.reduce((n, b, i) => n + (b === patched[i] ? 0 : 1), 0);
	assert.equal(differing, 0, `${differing} bytes differ`);
});

test('the repair is the only thing that separates the app from the build', async (t) => {
	const pair = builds();
	if (!pair) return t.skip(`no builds under ${BUILD_ROOT}`);
	const [canonical, expected] = pair;
	const { records } = await plan(global3, offsets, species, p);
	const patched = patchRom(canonical, records);
	const differing: number[] = [];
	expected.forEach((b, i) => {
		if (b !== patched[i]) differing.push(i);
	});
	const repairs = Object.values(offsets.repairs).flat().map(([off]) => off);
	// the 24 repair bytes, and the three derived checksum regions they invalidate
	assert.ok(repairs.every((o) => differing.includes(o)));
	assert.ok(differing.every((o) => repairs.includes(o) || o < 0x150 || o >= 0x1ffde0));
});

test('the canonical ROM is accepted and anything else is not', async (t) => {
	const pair = builds();
	if (!pair) return t.skip(`no builds under ${BUILD_ROOT}`);
	const [canonical] = pair;
	assert.equal(await romProblem(canonical, offsets.rom_sha1), null);
	const wrong = Uint8Array.from(canonical);
	wrong[0x1000] ^= 0xff;
	assert.match((await romProblem(wrong, offsets.rom_sha1)) ?? '', /not the supported build/);
	assert.match((await romProblem(canonical.subarray(0, 1024), offsets.rom_sha1)) ?? '', /1,024 bytes/);
});

test('an Unchanged category leaves its offsets exactly as they were', async (t) => {
	const pair = builds();
	if (!pair) return t.skip(`no builds under ${BUILD_ROOT}`);
	const [canonical] = pair;
	const wildOnly: Config = { ...global3, trainers: { mode: 'unchanged', rules: [] }, gifts: { mode: 'unchanged', rules: [] } };
	const { records } = await plan(wildOnly, offsets, species, p);
	const patched = patchRom(canonical, records);
	for (const c of ['trainers', 'gifts'] as Category[]) {
		for (const g of Object.values(offsets.categories[c])) {
			for (const o of g.offsets) assert.equal(patched[o], canonical[o], `${c} offset ${o} moved`);
		}
	}
});
