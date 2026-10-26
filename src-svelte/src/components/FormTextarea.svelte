<script lang="ts">
  import type { FormEventHandler } from 'svelte/elements';
  import { FORM_FIELD_CLASS } from '#lib/formControlClass.ts';

  interface Props {
    id: string;
    value: string;
    /** Matches what `<textarea>` accepts: Svelte types `oninput` as Event-based. */
    oninput: FormEventHandler<HTMLTextAreaElement>;
    rows?: number;
    placeholder?: string;
    'data-testid'?: string;
  }

  let {
    id,
    value,
    oninput,
    rows = 4,
    placeholder = '',
    'data-testid': dataTestId = '',
  }: Props = $props();
</script>

<!--
  A `<textarea>` on the settings-field surface, set in a monospace face because the
  one field it serves is CSS the user writes and reads as code.
-->
<textarea
  {id}
  value={value}
  {oninput}
  {rows}
  {placeholder}
  class={`${FORM_FIELD_CLASS} font-mono`}
  data-testid={dataTestId || id}
></textarea>
