/**
 * The share unit. SPEC.md §4.6 — a single file holding the seed, the mode and the rules for
 * each category, the SHA-1 of the canonical ROM, and a version.
 *
 * A config is exchanged whole or not at all: any fault refuses the whole file and loads
 * nothing, because a partly-loaded config produces a ROM that is not the sender's.
 */
import {
	CATEGORIES,
	CATEGORY_META,
	MAX_SEED,
	READABLE_VERSIONS,
	RULE_NAMES,
	legality,
	type Category,
	type Config,
	type Mode,
	type Pools,
	type RuleName,
	type Selection
} from './catalogue';

const KEYS = ['version', 'rom', 'seed', ...CATEGORIES];
const MODES: Mode[] = ['unchanged', 'global', 'group', 'slot'];

export function serialize(config: Config): string {
	return JSON.stringify(
		{
			version: config.version,
			rom: config.rom,
			seed: config.seed,
			...Object.fromEntries(CATEGORIES.map((c) => [c, config[c]]))
		},
		null,
		2
	);
}

export function configName(seed: number): string {
	return `sourcrystal_${seed}.json`;
}

/** The seed is an integer, not a phrase: one written form, no question of case, spacing or
 *  accent. Decimal digits only, `0 .. 4294967295`, leading zeros absorbed. SPEC.md §4.7. */
export function parseSeed(text: string): number | null {
	const t = text.trim();
	if (!/^\d+$/.test(t)) return null;
	const v = Number(t);
	return Number.isSafeInteger(v) && v >= 0 && v <= MAX_SEED ? v : null;
}

function selection(value: unknown, category: Category, p: Pools, distinct: number): Selection {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error(`${category} is not an object`);
	}
	const extra = Object.keys(value).filter((k) => k !== 'mode' && k !== 'rules');
	if (extra.length) throw new Error(`${category} holds an unknown key, ${extra[0]}`);

	const { mode, rules } = value as { mode: unknown; rules: unknown };
	if (typeof mode !== 'string' || !MODES.includes(mode as Mode)) {
		throw new Error(`${category}.mode is not a mode, ${String(mode)}`);
	}
	if (!CATEGORY_META[category].modes.includes(mode as Mode)) {
		throw new Error(`${category}.mode is not offered for this category, ${mode}`);
	}
	if (!Array.isArray(rules)) throw new Error(`${category}.rules is not a list`);
	for (const r of rules) {
		if (typeof r !== 'string' || !RULE_NAMES.includes(r as RuleName)) {
			throw new Error(`${category}.rules holds an unknown rule, ${String(r)}`);
		}
		if (rules.indexOf(r) !== rules.lastIndexOf(r)) throw new Error(`${category}.rules repeats ${r}`);
		if (!legality(p, r as RuleName, mode as Mode, distinct).ok) {
			throw new Error(`${category}.rules holds ${r}, which is not legal under ${mode}`);
		}
	}
	return { mode: mode as Mode, rules: rules as RuleName[] };
}

/**
 * Reads an exported config, or throws an `Error` naming the field and the fault. The caller
 * shows the message and keeps the controls as they were.
 */
export function readConfig(
	text: string,
	rom: string,
	distinct: Record<Category, number>,
	p: Pools
): Config {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new Error('that file is not JSON');
	}
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		throw new Error('that file is not a config object');
	}
	const c = raw as Record<string, unknown>;
	const extra = Object.keys(c).filter((k) => !KEYS.includes(k));
	if (extra.length) throw new Error(`unknown key, ${extra[0]}`);
	for (const k of KEYS) if (!(k in c)) throw new Error(`missing key, ${k}`);

	if (typeof c.version !== 'number' || !READABLE_VERSIONS.includes(c.version)) {
		throw new Error(`version ${String(c.version)} is not one this app reads`);
	}
	if (c.rom !== rom) throw new Error(`rom ${String(c.rom)} is a different build`);
	if (typeof c.seed !== 'number' || !Number.isInteger(c.seed) || c.seed < 0 || c.seed > MAX_SEED) {
		throw new Error(`seed ${String(c.seed)} is outside 0 to ${MAX_SEED}`);
	}
	const out = { version: c.version, rom: c.rom, seed: c.seed } as Config;
	for (const category of CATEGORIES) {
		out[category] = selection(c[category], category, p, distinct[category]);
	}
	return out;
}
