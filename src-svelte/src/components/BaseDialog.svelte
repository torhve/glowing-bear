<script lang="ts">
  let {
    id,
    labelledby,
    children
  }: {
    id: string;
    labelledby?: string;
    children: import('svelte').Snippet;
  } = $props();
</script>

<dialog
  {id}
  popover
  aria-labelledby={labelledby}
  data-testid={id}
  class="fixed left-0 right-0 top-16 mx-auto max-h-[85vh] w-full max-w-2xl overflow-hidden rounded-lg border-none bg-surface p-0 shadow-xl
    opacity-0 scale-95
    open:opacity-100 open:scale-100
    starting:open:opacity-0 starting:open:scale-95
    transition-[opacity,transform,display,overlay] transition-discrete duration-200 ease-out
    backdrop:bg-black/50 backdrop:opacity-0
    open:backdrop:opacity-100
    starting:open:backdrop:opacity-0
    backdrop:transition-[opacity,display,overlay] backdrop:transition-discrete backdrop:duration-200"
>
  {@render children()}
</dialog>
