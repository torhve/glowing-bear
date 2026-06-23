<script lang="ts">
  import type { TokenGroup } from '$lib/linkTokens';

  let {
    groups
  }: {
    groups: TokenGroup[];
  } = $props();
</script>

{#each groups as group, gi (gi)}
  <span class="token-group {group.classes}">
    {#each group.tokens as token, ti (ti)}
      {#if token.type === 'link'}
        <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
        <a href={token.value} target="_blank" rel="noopener noreferrer" class="irc-link">{token.value}</a>
      {:else if token.type === 'code'}
        <span class="hidden-bracket">{token.delimiter}</span>
        <code class="irc-code">{token.value}</code>
        <span class="hidden-bracket">{token.delimiter}</span>
      {:else}
        {token.value}
      {/if}
    {/each}
  </span>
{/each}
