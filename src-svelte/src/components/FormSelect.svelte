<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { ChangeEventHandler } from 'svelte/elements';
  import { FORM_FIELD_CLASS } from '#lib/formControlClass.ts';

  interface Props {
    id: string;
    value: string;
    onchange: ChangeEventHandler<HTMLSelectElement>;
    'data-testid'?: string;
    /** The `<option>` elements. */
    children: Snippet;
  }

  let {
    id,
    value,
    onchange,
    'data-testid': dataTestId = '',
    children,
  }: Props = $props();
</script>

<!--
  A `<select>` on the settings-field surface. Deliberately not FormInput's
  uncontrolled-value workaround: that exists for Playwright's `.fill()` on text
  inputs, and a select is chosen by `value`, never filled.
-->
<select
  {id}
  value={value}
  {onchange}
  class={FORM_FIELD_CLASS}
  data-testid={dataTestId || id}
>
  {@render children()}
</select>
