<!-- One page, three columns, no tabs: the categories are coupled under Global mapping, and a
     tab would hide two of three and hide the coupling. SPEC.md §6. -->
<script lang="ts">
	import { browser } from '$app/environment';
	import { Button, DarkMode, Fileupload, Heading, Helper, Input, Label, Toast } from 'flowbite-svelte';
	import offsetsJson from '$data/offsets.json';
	import speciesJson from '$data/species.json';
	import CategoryPanel from './category.svelte';
	import SpoilerLog from './spoiler-log.svelte';
	import {
		CATEGORIES,
		CATEGORY_META,
		MODE_LABEL,
		brokenPairings,
		legality,
		pools,
		sharedMappingConflict,
		type Category,
		type Config,
		type Selection,
		type SpeciesData
	} from '$lib/catalogue';
	import { configName, parseSeed, readConfig, serialize } from '$lib/config';
	import { patchRom, romProblem } from '$lib/patch';
	import { distinctSpecies, plan as makePlan, type Offsets, type Plan } from '$lib/plan';

	const offsets = offsetsJson as unknown as Offsets;
	const species = speciesJson as unknown as SpeciesData;
	const p = pools(species);
	const distinct = Object.fromEntries(
		CATEGORIES.map((c) => [c, distinctSpecies(offsets, c)])
	) as Record<Category, number>;
	const counts = Object.fromEntries(
		CATEGORIES.map((c) => [
			c,
			{
				offsets: Object.values(offsets.categories[c]).reduce((n, g) => n + g.offsets.length, 0),
				groups: Object.keys(offsets.categories[c]).length
			}
		])
	) as Record<Category, { offsets: number; groups: number }>;

	// Every category defaults to Unchanged, every rule off: the app asks before it acts.
	let selection: Record<Category, Selection> = $state({
		wild: { mode: 'unchanged', rules: [] },
		trainers: { mode: 'unchanged', rules: [] },
		gifts: { mode: 'unchanged', rules: [] }
	});
	let rom: Uint8Array | null = $state(null);
	let romName = $state('');
	let seedText = $state(browser ? String(crypto.getRandomValues(new Uint32Array(1))[0]) : '');
	let current: Category = $state('wild');
	let spoilerOpen = $state(true);
	let toast: { message: string; ok: boolean } | null = $state(null);
	let planned: Plan | null = $state(null);

	const seed = $derived(parseSeed(seedText));
	const anyMode = $derived(CATEGORIES.some((c) => selection[c].mode !== 'unchanged'));
	const ready = $derived(rom !== null && seed !== null && anyMode && planned !== null);
	const conflict = $derived(sharedMappingConflict(selection));
	const broken = $derived(brokenPairings(selection));

	function say(message: string, ok: boolean): void {
		toast = { message, ok };
		if (ok) setTimeout(() => (toast?.message === message ? (toast = null) : null), 5000);
	}

	function config(): Config {
		return {
			version: 1,
			rom: offsets.rom_sha1,
			seed: seed ?? 0,
			...($state.snapshot(selection) as Record<Category, Selection>)
		};
	}

	// A mode change can refuse a rule that was legal under the previous one. Drop it rather
	// than carry a selection that plan() would apply and the config's own import would refuse.
	$effect(() => {
		for (const category of CATEGORIES) {
			const sel = selection[category];
			const legal = sel.rules.filter((r) => legality(p, r, sel.mode, distinct[category]).ok);
			if (legal.length !== sel.rules.length) sel.rules = legal;
		}
	});

	// The spoiler log renders the patch record, so the record is calculated as soon as a seed
	// and a mode exist — long before the Download button is pressed.
	$effect(() => {
		const wanted = config();
		planned = null;
		if (seed === null || !anyMode) return;
		let live = true;
		makePlan(wanted, offsets, species, p).then(
			(r) => {
				if (live) planned = r;
			},
			(e) => {
				if (live) say(`Could not derive the mapping — ${e instanceof Error ? e.message : String(e)}.`, false);
			}
		);
		return () => (live = false);
	});

	function save(blob: Blob, name: string): void {
		const url = URL.createObjectURL(blob);
		Object.assign(document.createElement('a'), { href: url, download: name }).click();
		setTimeout(() => URL.revokeObjectURL(url));
	}

	async function upload(files: FileList | null): Promise<void> {
		const file = files?.[0];
		if (!file) return;
		// A file can move or lose its permission between being picked and being read. Drop the
		// ROM either way: keeping the last one would patch a build the user thinks they swapped.
		try {
			const bytes = new Uint8Array(await file.arrayBuffer());
			const problem = await romProblem(bytes, offsets.rom_sha1);
			if (problem) {
				rom = null;
				say(problem, false);
				return;
			}
			rom = bytes;
			romName = file.name;
			say(`${file.name} validated.`, true);
		} catch (e) {
			rom = null;
			say(`Could not read ${file.name} — ${e instanceof Error ? e.message : String(e)}.`, false);
		}
	}

	async function importConfig(files: FileList | null): Promise<void> {
		const file = files?.[0];
		if (!file) return;
		// Refuse the whole file on any fault and load nothing: loading the legal parts would
		// hand the receiver a different ROM, with the warning arriving after the difference.
		try {
			const c = readConfig(await file.text(), offsets.rom_sha1, distinct, p);
			seedText = String(c.seed);
			for (const category of CATEGORIES) {
				selection[category] = { mode: c[category].mode, rules: [...c[category].rules] };
			}
			say('Config loaded.', true);
		} catch (e) {
			say(`Config refused, nothing loaded — ${e instanceof Error ? e.message : String(e)}.`, false);
		}
	}

	function download(): void {
		if (!rom || !planned || seed === null) return;
		const out = patchRom(rom, planned.records);
		save(new Blob([out.buffer as ArrayBuffer]), `sourcrystal_${seed}.gbc`);
	}
</script>

<div class="flex h-full min-h-0 flex-col">
<header class="mb-5 flex flex-wrap items-center justify-between gap-5 shrink-0">
	<Heading tag="h1">
		<span class="text-purple-600 dark:text-purple-500">Sour</span> Randomizer
	</Heading>
	<div class="flex flex-wrap items-center gap-3">
		<!-- The config is not a step — it is a second way to fill steps 1 and 2. -->
		<Label for="config" class="sr-only">Import config</Label>
		<Fileupload
			id="config"
			accept=".json"
			class="max-w-56"
			onchange={(e) => importConfig((e.currentTarget as HTMLInputElement).files)}
		/>
		<Button
			outline
			disabled={seed === null}
			onclick={() => save(new Blob([serialize(config())], { type: 'application/json' }), configName(seed!))}
			class="border-purple-600 whitespace-nowrap text-purple-600 dark:border-purple-500 dark:text-purple-500"
		>
			Export config
		</Button>
		<Button
			outline
			onclick={() => (spoilerOpen = !spoilerOpen)}
			class="border-purple-600 whitespace-nowrap text-purple-600 dark:border-purple-500 dark:text-purple-500"
		>
			{spoilerOpen ? 'Hide' : 'Show'} spoiler log
		</Button>
		<DarkMode class="size-10 outline-1 outline-gray-100 focus:outline-solid dark:outline-gray-700" />
	</div>
</header>

{#if toast}
	<!-- keyed so a second message revives a Toast the user dismissed -->
	{#key toast}
		<Toast color={toast.ok ? 'green' : 'red'} class="absolute top-4 right-4 z-10" dismissable>
			{toast.message}
		</Toast>
	{/key}
{/if}

<div
	class="grid flex-1 gap-6 overflow-y-auto {spoilerOpen
		? 'lg:grid-cols-[18rem_minmax(0,1fr)_minmax(0,1fr)]'
		: 'lg:grid-cols-[18rem_minmax(0,1fr)]'}"
>
	<!-- The rail reads in one direction: in, choose, out. -->
	<nav class="space-y-6">
		{#snippet step(n: number, title: string, done: boolean)}
			<div class="mb-2 flex items-center gap-2">
				<span
					class="flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-bold {done
						? 'bg-purple-600 text-white dark:bg-purple-500'
						: 'bg-gray-200 text-gray-500 dark:bg-gray-700 dark:text-gray-400'}"
				>
					{n}
				</span>
				<h2 class="text-sm font-semibold">{title}</h2>
			</div>
		{/snippet}

		<div>
			{@render step(1, 'ROM and seed', rom !== null && seed !== null)}
			<Label for="rom" class="pb-2 text-xs">Your Sour Crystal build</Label>
			<Fileupload
				id="rom"
				accept=".gbc"
				onchange={(e) => upload((e.currentTarget as HTMLInputElement).files)}
			/>
			<Helper class="mt-1 text-xs">
				{rom ? `${romName} validated.` : `One exact build (.gbc, SHA-1 ${offsets.rom_sha1.slice(0, 12)}…).`}
				It never leaves your browser.
			</Helper>

			<Label for="seed" class="pt-3 pb-2 text-xs">Seed</Label>
			<Input id="seed" bind:value={seedText} inputmode="numeric" />
			<Helper class="mt-1 text-xs" color={seed === null ? 'red' : 'gray'}>
				{seed === null ? 'Whole numbers only, 0 to 4294967295.' : `Using seed ${seed}.`}
			</Helper>
		</div>

		<div>
			{@render step(2, 'What to randomize', anyMode)}
			<div class="space-y-1">
				{#each CATEGORIES as category (category)}
					{@const sel = selection[category]}
					<button
						class="w-full rounded-lg border p-3 text-left {current === category
							? 'border-purple-600 bg-purple-50 dark:border-purple-500 dark:bg-purple-950'
							: 'border-gray-200 dark:border-gray-700'}"
						onclick={() => (current = category)}
					>
						<span class="block font-semibold">{CATEGORY_META[category].label}</span>
						<span class="block text-xs text-gray-500 dark:text-gray-400">
							{MODE_LABEL[sel.mode]}{sel.rules.length
								? ` · ${sel.rules.length} rule${sel.rules.length > 1 ? 's' : ''}`
								: ''}
						</span>
					</button>
				{/each}
			</div>
			{#if !anyMode}
				<Helper class="mt-2 text-xs">
					Every category starts <b>Unchanged</b>. Pick a mode for at least one.
				</Helper>
			{/if}
		</div>

		<div>
			{@render step(3, 'Download', ready)}
			<!-- one line per §7.7 limitation this selection breaks, and nothing when none is -->
			{#each broken as line (line)}
				<p class="mb-2 text-xs text-gray-500 dark:text-gray-400">{line}</p>
			{/each}
			<p class="mb-2 text-xs font-semibold text-amber-600 dark:text-amber-500">
				Seeds are not logic-checked. A run may be uncompletable.
			</p>
			<Button onclick={download} disabled={!ready} class="w-full bg-purple-600 dark:bg-purple-500">
				Download ROM
			</Button>
		</div>
	</nav>

	<main class="rounded-lg border border-gray-200 p-5 dark:border-gray-700">
		<CategoryPanel
			category={current}
			bind:selection={selection[current]}
			pools={p}
			offsets={counts[current].offsets}
			groups={counts[current].groups}
			distinct={distinct[current]}
			{conflict}
		/>
	</main>

	{#if spoilerOpen}
		<aside
			class="rounded-lg border border-gray-200 p-4 lg:sticky lg:top-4 lg:max-h-[85vh] lg:overflow-y-auto dark:border-gray-700"
		>
			<h2 class="mb-3 font-semibold">Spoiler log</h2>
			{#if planned}
				<SpoilerLog plan={planned} {selection} names={species.names} />
			{:else if seed === null}
				<p class="text-sm text-gray-500 dark:text-gray-400">Enter a valid seed.</p>
			{:else if !anyMode}
				<p class="text-sm text-gray-500 dark:text-gray-400">
					Nothing is randomized yet, so there is nothing to spoil.
				</p>
			{:else}
				<p class="text-sm text-gray-500 dark:text-gray-400">Rolling…</p>
			{/if}
		</aside>
	{/if}
</div>

<footer class="mt-5 shrink-0 text-center text-xs text-gray-500 dark:text-gray-400">
	<img style="margin:auto; height:100%; width: auto;" src="/badge.png">
</footer>
</div>
