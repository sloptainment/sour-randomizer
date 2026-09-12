<!-- The third column. Names only, no sprites. Rendered from the patch record, so it exists
     as soon as a valid seed and a mode exist, and the mapping is never shown for a species a
     group does not hold. SPEC.md §6.5. -->
<script lang="ts">
	import { Badge, Button, Input } from 'flowbite-svelte';
	import { CATEGORIES, CATEGORY_META, type Category, type Selection } from '$lib/catalogue';
	import type { GroupPlan, Plan } from '$lib/plan';

	let {
		plan,
		selection,
		names
	}: { plan: Plan; selection: Record<Category, Selection>; names: string[] } = $props();

	const PAGE = 25;
	let query = $state('');

	const name = (id: number) => names[id - 1];
	const shared = $derived(CATEGORIES.filter((c) => selection[c].mode === 'global'));
	const perGroup = $derived(
		CATEGORIES.filter((c) => selection[c].mode === 'group' || selection[c].mode === 'slot')
	);

	/** Group mapping lists the group's own species once; Per slot lists every slot. */
	function rows(g: GroupPlan): [string, string][] {
		const seen = new Set<number>();
		const out: [string, string][] = [];
		g.slots.forEach((slot, i) => {
			if (g.mode === 'group') {
				if (seen.has(slot.species)) return;
				seen.add(slot.species);
			}
			out.push([name(slot.species), name(g.targets[i])]);
		});
		return out;
	}

	const of = (c: Category) => plan.groups.filter((g) => g.category === c);
	function matching(c: Category): GroupPlan[] {
		const q = query.trim().toLowerCase();
		return q ? of(c).filter((g) => g.group.toLowerCase().includes(q)) : of(c);
	}

	// The column cannot hold 11 106 rows, so the whole log also goes out as a file, uncapped.
	function exportText(): void {
		const out: string[] = [];
		if (plan.global) {
			out.push(`# One mapping for the whole game (${shared.map((c) => CATEGORY_META[c].label).join(', ')})`);
			names.forEach((from, i) => out.push(`${from} -> ${name(plan.global![i + 1])}`));
			out.push('');
		}
		for (const c of perGroup) {
			out.push(`# ${CATEGORY_META[c].label} — ${selection[c].mode === 'slot' ? 'every slot rolled on its own' : 'one mapping per ' + CATEGORY_META[c].group}`);
			for (const g of of(c)) {
				out.push(`## ${g.group}${g.theme ? ` (${g.theme.toLowerCase()} theme)` : ''}`);
				for (const [from, to] of rows(g)) out.push(`${from} -> ${to}`);
			}
			out.push('');
		}
		const url = URL.createObjectURL(new Blob([out.join('\n')], { type: 'text/plain' }));
		Object.assign(document.createElement('a'), { href: url, download: 'spoiler.txt' }).click();
		setTimeout(() => URL.revokeObjectURL(url));
	}
</script>

<div class="text-sm text-gray-700 dark:text-gray-300">
	{#if !plan.global && !perGroup.length}
		<p class="text-gray-500 dark:text-gray-400">Nothing is randomized yet, so there is nothing to spoil.</p>
	{:else}
		<div class="mb-3 flex flex-wrap items-center gap-2">
			{#if perGroup.length}
				<Input bind:value={query} placeholder="Filter areas and trainers…" class="max-w-56" />
			{/if}
			<Button
				size="xs"
				outline
				onclick={exportText}
				class="border-purple-600 text-purple-600 dark:border-purple-500 dark:text-purple-500"
			>
				Export as text
			</Button>
		</div>

		{#if plan.global}
			<details class="mb-4" open={!perGroup.length}>
				<summary class="cursor-pointer text-purple-600 dark:text-purple-500">
					One mapping for the whole game
					<Badge class="ml-2">{shared.map((c) => CATEGORY_META[c].label).join(' · ')}</Badge>
				</summary>
				<ul class="mt-2 grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-x-5">
					{#each names as from, i (from)}
						<li><span class="text-gray-500 dark:text-gray-400">{from}</span> → {name(plan.global[i + 1])}</li>
					{/each}
				</ul>
			</details>
		{/if}

		{#each perGroup as category (category)}
			{@const list = matching(category)}
			<details class="mb-4" open>
				<summary class="cursor-pointer text-purple-600 dark:text-purple-500">
					{CATEGORY_META[category].label}
					<Badge class="ml-2">{list.length} of {of(category).length} {CATEGORY_META[category].groups}</Badge>
					{#if selection[category].mode === 'slot'}
						<Badge color="yellow" class="ml-1">every slot rolled on its own</Badge>
					{/if}
				</summary>
				<div class="mt-2 space-y-1">
					{#each list.slice(0, PAGE) as g (g.group)}
						<details class="rounded border border-gray-200 px-3 py-1 dark:border-gray-700">
							<summary class="cursor-pointer">
								{g.group}
								<span class="text-gray-500 dark:text-gray-400">({rows(g).length})</span>
								{#if g.theme}<Badge color="purple" class="ml-1">{g.theme.toLowerCase()}</Badge>{/if}
							</summary>
							<ul class="mt-1 mb-2 grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-x-5">
								{#each rows(g) as [from, to], i (i)}
									<li><span class="text-gray-500 dark:text-gray-400">{from}</span> → {to}</li>
								{/each}
							</ul>
						</details>
					{/each}
					{#if list.length > PAGE}
						<p class="pt-1 text-gray-500 dark:text-gray-400">
							{list.length - PAGE} more {CATEGORY_META[category].groups} not shown — filter to reach them, or
							export the log.
						</p>
					{/if}
				</div>
			</details>
		{/each}
	{/if}
</div>
