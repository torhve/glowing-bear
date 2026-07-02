<script lang="ts">
  import { tokenizeAndCodify } from '$lib/linkTokens';

  let {
    text = '',
    linkClass = ''
  }: {
    text?: string;
    linkClass?: string;
  } = $props();

  let tokens = $derived(tokenizeAndCodify(text));
</script>

<span class="linkified-text">
  {#each tokens as token, ti (ti)}
    {#if token.type === 'link'}
      <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
      <a href={token.value} target="_blank" rel="noopener noreferrer" class="linkified-link {linkClass}">{token.value}</a>
    {:else if token.type === 'code'}
      <span class="hidden-bracket">{token.delimiter}</span>
      <code class="linkified-code">{token.value}</code>
      <span class="hidden-bracket">{token.delimiter}</span>
    {:else}
      {token.value}
    {/if}
  {/each}
</span>

<style>
  .linkified-link {
    color: var(--gb-link);
    text-decoration: none;
  }

  .linkified-link:hover {
    color: var(--gb-link-hover);
    text-decoration: underline;
  }

  /* Code segments render in monospace */
  .linkified-code {
    font-family: var(--font-mono, monospace);
  }
</style>
