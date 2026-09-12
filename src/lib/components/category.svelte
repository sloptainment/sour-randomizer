<!-- One category's mode radio list and its rules. SPEC.md §6.4. -->
<script lang="ts">
	import { Badge, Checkbox, Helper, Radio } from 'flowbite-svelte';
	import {
		CATEGORY_META,
		MODE_LABEL,
		RULES,
		legality,
		type Category,
		type Mode,
		type Pools,
		type RuleName,
		type Selection
	} from '$lib/catalogue';

	let {
		category,
		selection = $bindable(),
		pools,
		offsets,
		groups,
		distinct,
		conflict
	}: {
		category: Category;
		selection: Selection;
		pools: Pools;
		offsets: number;
		groups: number;
		distinct: number;
		conflict: string | null;
	} = $props();

	const meta = $derived(CATEGORY_META[category]);

	function prose(mode: Mode): string {
		if (mode === 'unchanged') return 'Left exactly as the game shipped.';
		if (mode === 'global') return 'One mapping for the whole game, shared with every other category set this way.';
		if (mode === 'group') return `One mapping for each ${meta.group} — ${groups.toLocaleString()} of them.`;
		return 'Every slot rolled on its own.';
	}

	function toggle(rule: RuleName, on: boolean): void {
		const at = selection.rules.indexOf(rule);
		if (on && at < 0) selection.rules.push(rule);
		if (!on && at >= 0) selection.rules.splice(at, 1);
	}
</script>

<h2 class="text-lg font-semibold">{meta.label}</h2>
<!-- the three numbers together say what Group mapping will do, and which one refuses a rule -->
<p class="text-xs text-gray-500 dark:text-gray-400">
	{offsets.toLocaleString()} offsets · {groups.toLocaleString()}
	{meta.groups} · {distinct.toLocaleString()} distinct species
</p>
<p class="mt-1 mb-4 text-sm text-gray-600 dark:text-gray-400">{meta.blurb}</p>

<h3 class="mb-2 text-sm font-semibold">Mode</h3>
{#each meta.modes as mode (mode)}
	<Radio name="mode-{category}" value={mode} bind:group={selection.mode} class="mb-2 items-start">
		<span class="ml-1 block">
			<span class="block">{MODE_LABEL[mode]}</span>
			<span class="block text-xs text-gray-500 dark:text-gray-400">{prose(mode)}</span>
		</span>
	</Radio>
{/each}
{#if !meta.modes.includes('group')}
	<Helper class="mb-2 text-xs">
		No <b>Group mapping</b> here — a gift's group is one script file or one table, which is not a
		boundary a player would recognise.
	</Helper>
{/if}

<hr class="my-4 border-gray-200 dark:border-gray-700" />

{#if selection.mode === 'unchanged'}
	<p class="text-sm text-gray-500 dark:text-gray-400">Rules apply to a mode. Pick one above.</p>
{:else}
	<h3 class="mb-2 text-sm font-semibold">Rules</h3>
	{#each RULES as rule (rule.id)}
		{@const legal = legality(pools, rule.id, selection.mode, distinct)}
		<div class="mb-2" class:opacity-60={!legal.ok}>
			<Checkbox
				checked={selection.rules.includes(rule.id)}
				disabled={!legal.ok}
				onchange={(e) => toggle(rule.id, (e.currentTarget as HTMLInputElement).checked)}
			>
				{rule.label}
				{#if legal.satisfied}
					<Badge color="green" class="ml-2">satisfied</Badge>
				{:else if !legal.ok}
					<Badge color="gray" class="ml-2">not available</Badge>
				{/if}
			</Checkbox>
			<p class="ml-6 text-xs text-gray-500 dark:text-gray-400">{legal.ok ? rule.blurb : legal.reason}</p>
		</div>
	{/each}
{/if}

{#if conflict}
	<hr class="my-4 border-gray-200 dark:border-gray-700" />
	<p class="text-sm font-semibold text-amber-600 dark:text-amber-500">{conflict}</p>
{/if}
