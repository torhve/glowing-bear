<script lang="ts">
  /**
   * Sep — Separator between keys in a KbdGroup. Renders a small, muted symbol (+ by default).
   */
  let {
    label = '+',
    class: extraClass = '',
    ...attrs
  } = $props<{
    label?: string;
    class?: string;
    [key: string]: unknown;
  }>();
</script>

<span class="text-text-secondary mx-0.5 select-none {extraClass}" {...attrs}>{label}</span>
