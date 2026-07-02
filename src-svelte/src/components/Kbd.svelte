<script lang="ts">
  /**
   * Kbd — Individual key display rendered as a `<kbd>` element.
   * Used for showing keyboard shortcuts in UI documentation and help text.
   */
  let {
    class: extraClass = '',
    children,
    ...attrs
  } = $props<{
    class?: string;
    children?: import('svelte').Snippet;
    [key: string]: unknown;
  }>();
</script>

<kbd
  class="inline-flex items-center justify-center rounded border border-border bg-surface-raised px-1.5 py-0.5 text-xs font-mono font-medium text-text-secondary {extraClass}"
  {...attrs}
>
  {@render children?.()}
</kbd>
