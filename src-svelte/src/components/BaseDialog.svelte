<script lang="ts">
  let {
    id,
    labelledby,
    noAnimation = false,
    children,
    ...attrs // eslint-disable-line svelte/valid-compile
  }: {
    id: string;
    labelledby?: string;
    noAnimation?: boolean;
    children: import('svelte').Snippet;
    [key: string]: unknown;
  } = $props();

  let animationClasses = $derived(
    noAnimation ? '' : 'opacity-0 scale-95 open:opacity-100 open:scale-100 starting:open:opacity-0 starting:open:scale-95 transition-[opacity,transform,display,overlay] transition-discrete duration-200 ease-out'
  );
  let backdropClasses = $derived(
    noAnimation ? 'backdrop:bg-black/50 backdrop:opacity-0' : 'backdrop:bg-black/50 backdrop:opacity-0 open:backdrop:opacity-100 starting:open:backdrop:opacity-0 backdrop:transition-[opacity,display,overlay] backdrop:transition-discrete backdrop:duration-200'
  );
</script>

 <dialog
    {...attrs}
    {id}
    popover="auto"
    aria-labelledby={labelledby}
    data-testid={id}
    class="fixed left-0 right-0 top-16 mx-auto max-h-[85vh] w-full max-w-2xl overflow-hidden rounded-lg border-none bg-surface p-0 shadow-xl {animationClasses} {backdropClasses}"
  >
  {@render children()}
</dialog>
