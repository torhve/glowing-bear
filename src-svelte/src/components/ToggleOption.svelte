<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { ChangeEventHandler } from 'svelte/elements';
  import type { LucideIcon } from '@lucide/svelte';
  import type { Settings } from '#lib/types.ts';

  let {
    id,
    name,
    icon: Icon,
    checked,
    onchange,
    testid = undefined,
    children,
  } = $props<{
    id: string;
    /** The setting this row writes: `name` and both data attributes carry it. */
    name: keyof Settings;
    icon: LucideIcon;
    checked: boolean;
    /**
     * A row is free to do more than flip its key — turning password saving off
     * also clears the stored password — so the handler is passed in, not assumed.
     */
    onchange: ChangeEventHandler<HTMLInputElement>;
    /** Only some rows have one, and a row without one renders no attribute. */
    testid?: string;
    /** The label text a user reads, after the icon. */
    children: Snippet;
  }>();
</script>

<label class="settings-option flex items-center justify-between py-2" data-settings-option={name}>
  <span class="settings-option-label text-sm text-text flex items-center gap-2">
    <Icon size={14} class="text-text-secondary shrink-0" />
    {@render children()}
  </span>
  <input
    {id}
    name={name}
    type="checkbox"
    {checked}
    {onchange}
    class="w-4 h-4"
    data-settings-checkbox={name}
    data-testid={testid}
  />
</label>
