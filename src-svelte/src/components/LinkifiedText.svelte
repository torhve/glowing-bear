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

{#each tokens as token}
  {#if token.type === 'link'}
    <a href={token.value} target="_blank" rel="noopener noreferrer" class={linkClass}>{token.value}</a>
  {:else if token.type === 'code'}
    <span class="hidden-bracket">{token.delimiter}</span>
    <code>{token.value}</code>
    <span class="hidden-bracket">{token.delimiter}</span>
  {:else}
    {token.value}
  {/if}
{/each}
