<script lang="ts">
  /**
   * The box the connection form explains a failed connection in.
   *
   * Eight failure causes use it and they differ only in what they say, so the
   * wrapper lives here once: the class string, the `data-testid` the E2E specs
   * click through, and the `data-error-type` that lets a spec assert *which* cause
   * was named and that a named cause did not also raise the generic one.
   *
   * `connection-error` is not an internal name. Settings injects whatever a user
   * types into its custom CSS field, so a user stylesheet can target this box
   * today; the class is kept verbatim rather than re-derived from parts.
   */
  let {
    errorType,
    children,
  }: {
    errorType: string;
    children: import('svelte').Snippet;
  } = $props();
</script>

<div
  data-testid="error-message"
  data-error-type={errorType}
  class="connection-error bg-danger/10 border border-danger rounded p-3 text-sm text-danger"
>
  {@render children()}
</div>
