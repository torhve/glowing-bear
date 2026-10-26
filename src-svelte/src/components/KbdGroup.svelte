<script lang="ts">
  /**
   * KbdGroup — Horizontal group of keys with consistent gap.
   * Renders as a `<kbd>` element containing multiple `<Kbd>` children and optional `<Sep>` separators.
   */
  interface Props {
    ref?: HTMLElement | null;
    class?: string;
    children?: import('svelte').Snippet;
    [key: string]: unknown;
  }

  let {
    ref = $bindable(null),
    class: extraClass = '',
    children,
    ...restProps
  }: Props = $props();
</script>

<kbd
  bind:this={ref}
  class="inline-flex items-center gap-1 {extraClass}"
  {...restProps}
>
  {@render children?.()}
</kbd>
