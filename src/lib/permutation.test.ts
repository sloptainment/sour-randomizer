import assert from 'node:assert/strict';
import test from 'node:test';
import { Keystream, NUM_POKEMON, construct, derangement, widen } from './permutation';

// SPEC.md §4.8, regenerated for the labelled keystream. `wild/ROUTE_30` seed 1 needs 12
// attempts and `global` seed 2 needs 7: both catch a keystream that restarts on retry,
// because a restarted stream regenerates the same rejected shuffle forever.
const VECTORS: [string, number, number[]][] = [
	['global', 12345, [44, 66, 249, 48, 229, 3, 36, 114]],
	['global', 0, [155, 245, 192, 7, 60, 44, 113, 250]],
	['global', 1, [109, 192, 234, 184, 141, 244, 179, 193]],
	['global', 2, [140, 186, 76, 207, 150, 247, 116, 41]],
	['wild/ROUTE_30', 12345, [11, 56, 5, 245, 146, 48, 102, 163]],
	['wild/ROUTE_30', 0, [8, 61, 203, 153, 147, 155, 54, 44]],
	['wild/ROUTE_30', 1, [237, 170, 203, 230, 189, 40, 35, 164]],
	['wild/ROUTE_30', 2, [85, 110, 247, 102, 146, 155, 232, 34]],
	['trainers/FalknerGroup/FALKNER#1', 12345, [6, 213, 237, 133, 218, 113, 184, 168]],
	['trainers/FalknerGroup/FALKNER#1', 0, [160, 72, 26, 117, 154, 178, 190, 68]],
	['trainers/FalknerGroup/FALKNER#1', 1, [18, 134, 223, 217, 165, 129, 10, 193]],
	['trainers/FalknerGroup/FALKNER#1', 2, [41, 68, 157, 160, 19, 146, 188, 228]]
];

for (const [label, seed, first8] of VECTORS) {
	test(`${label} seed ${seed} hits its test vector`, async () => {
		assert.deepEqual([...(await derangement(seed, label)).slice(1, 9)], first8);
	});
}

function assertDerangement(mapping: Uint8Array): void {
	assert.equal(mapping.length, NUM_POKEMON + 1);
	assert.equal(mapping[0], 0);
	const seen = new Set<number>();
	for (let s = 1; s <= NUM_POKEMON; s++) {
		assert.notEqual(mapping[s], s, `species ${s} maps to itself`);
		assert.ok(mapping[s] >= 1 && mapping[s] <= NUM_POKEMON);
		seen.add(mapping[s]);
	}
	assert.equal(seen.size, NUM_POKEMON, 'not a bijection');
}

test('is a derangement over 1..251', async () => {
	assertDerangement(await derangement(12345, 'global'));
});

test('the label separates the streams', async () => {
	const [a, b, c, d] = await Promise.all([
		derangement(12345, 'global'),
		derangement(12345, ''),
		derangement(12345, 'wild/ROUTE_3'),
		derangement(12345, 'wild/ROUTE_30')
	]);
	assert.notDeepEqual([...a], [...b], 'a label must differ from the empty label');
	assert.notDeepEqual([...a], [...d], 'two labels must give different mappings');
	// a label that is a *prefix* of another is still a separate stream
	assert.notDeepEqual([...c], [...d]);
});

test('bounded() is in range and the stream never repeats a block', async () => {
	const ks = new Keystream(7, 'x');
	for (let i = 0; i < 50; i++) assert.ok((await ks.bounded(13)) < 13);
	const first = await new Keystream(7, 'x').draw();
	const again = await new Keystream(7, 'x').draw();
	assert.equal(first, again, 'the same seed and label must give the same stream');
});

test('bounded() refuses an empty range rather than spinning', async () => {
	// 2 ** 32 % 0 is NaN, so the rejection loop would never exit
	await assert.rejects(() => new Keystream(1, 'x').bounded(0), /no answer/);
});

test('widen() gives way until a candidate fits, and only then', () => {
	const bst = [100, 105, 200, 300];
	assert.deepEqual(widen([1, 2, 3, 4], 1, bst), [1, 2], 'within +-10 % of 100');
	assert.deepEqual(widen([3, 4], 1, bst), [3], 'widened until one fits');
	assert.deepEqual(widen([4], 1, bst), [4], 'the last candidate is reached');
});

test('construct() places every species inside its pool, never on itself', async () => {
	const basics = Array.from({ length: 60 }, (_, i) => i + 1);
	const species = Array.from({ length: 40 }, (_, i) => i + 5);
	const map = await construct(new Keystream(3, 'g'), species, () => basics);
	const seen = new Set<number>();
	for (const s of species) {
		assert.ok(basics.includes(map[s]), `${s} left its pool`);
		assert.notEqual(map[s], s, `${s} kept its own species`);
		assert.ok(!seen.has(map[s]), `${map[s]} used twice`);
		seen.add(map[s]);
	}
	// species outside the set are untouched
	assert.equal(map[200], 200);
});

test('construct() fills a pool exactly the size of its group', async () => {
	// The tight case: the pool holds the group's own species and nothing to spare, so the
	// last draw can find only itself left.
	const pool = [1, 2, 3, 4, 5];
	for (let seed = 0; seed < 20; seed++) {
		const map = await construct(new Keystream(seed, 'tight'), pool, () => pool);
		const seen = new Set(pool.map((s) => map[s]));
		assert.equal(seen.size, pool.length, `seed ${seed} is not a bijection`);
		for (const s of pool) assert.notEqual(map[s], s, `seed ${seed}: ${s} kept itself`);
	}
});

test('construct() over all 251 with no bans is still a derangement', async () => {
	const all = Array.from({ length: NUM_POKEMON }, (_, i) => i + 1);
	assertDerangement(await construct(new Keystream(9, 'global'), all, () => all));
});
