<script lang="ts">
  import { connectionBanner } from '#lib/stores/connectionPresentation.ts';
  import { retryNow } from '#lib/stores/connectionManager.ts';
  import { addToast } from '#lib/toast.ts';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import Pencil from '@lucide/svelte/icons/pencil';
  import LogOut from '@lucide/svelte/icons/log-out';

  /** Reveals the connection form while the retained view survives, so backing out
   *  restores the same chat. Owned by the page: only it knows the shell layout. */
  let {
    onEditConnection,
    onLeave,
  }: { onEditConnection?: () => void; onLeave?: () => void } = $props();

  // Countdown seconds. Deliberately NOT inside the live region: a polite region
  // that re-announces every second would talk over the reason, which is the part
  // a screen-reader user actually needs to hear.
  let remainingSeconds = $state<number | null>(null);

  $effect(() => {
    const next = $connectionBanner.nextRetryAt;
    if (next === null) {
      remainingSeconds = null;
      return;
    }
    const tick = () => {
      remainingSeconds = Math.max(0, Math.ceil((next - Date.now()) / 1000));
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  });

  function handleRetry() {
    const outcome = retryNow();
    if (outcome === 'retried') return;
    if (outcome === 'needs-credentials') {
      onEditConnection?.();
      return;
    }
    if (outcome === 'no-retry-loop') {
      addToast('There is no active connection to retry', { type: 'info', duration: 3000 });
    }
  }

  // The label states what the click does. "Retry now" replaces a scheduled
  // attempt; "Reconnect" starts one where the loop has stopped (autoconnect off).
  let primaryLabel = $derived(
    $connectionBanner.kind === 'needs-credentials'
      ? 'Enter verification code'
      : $connectionBanner.kind === 'reconnecting'
      ? 'Retry now'
      : 'Reconnect',
  );

  let dotClass = $derived(
    $connectionBanner.kind === 'needs-credentials'
      ? 'bg-danger'
      : $connectionBanner.kind === 'reconnecting'
      ? 'bg-warning animate-pulse'
      : 'bg-text-muted',
  );
</script>

{#if $connectionBanner.kind !== 'none'}
  <div
    data-testid="connection-banner"
    class="connection-banner flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-panel px-3 py-2 text-sm"
    role="status"
  >
    <div class="flex items-center gap-2 min-w-0" aria-live="polite">
      <span class="w-2 h-2 rounded-full flex-shrink-0 {dotClass}" aria-hidden="true"></span>
      <span class="text-text truncate">{$connectionBanner.reason}</span>
      {#if $connectionBanner.attempt > 0}
        <span class="text-text-muted whitespace-nowrap">attempt {$connectionBanner.attempt}</span>
      {/if}
      {#if $connectionBanner.retained}
        <span class="text-text-muted whitespace-nowrap" data-testid="connection-banner-readonly">read-only</span>
      {/if}
    </div>

    {#if remainingSeconds !== null}
      <span class="text-text-secondary font-mono whitespace-nowrap" data-testid="connection-banner-countdown">
        next attempt in {remainingSeconds}s
      </span>
    {/if}

    <div class="flex items-center gap-1 ml-auto">
      <button
        type="button"
        data-testid="connection-banner-retry"
        onclick={handleRetry}
        disabled={!$connectionBanner.canRetry || $connectionBanner.attemptInFlight}
        class="flex items-center gap-1.5 rounded px-2 py-1 text-text-secondary hover:text-white hover:bg-surface-raised transition-colors disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-secondary"
        title="{primaryLabel}"
      >
        <RefreshCw size={14} />
        <span>{primaryLabel}</span>
      </button>

      <button
        type="button"
        data-testid="connection-banner-edit"
        onclick={() => onEditConnection?.()}
        class="flex items-center gap-1.5 rounded px-2 py-1 text-text-secondary hover:text-white hover:bg-surface-raised transition-colors"
        title="Edit connection settings"
      >
        <Pencil size={14} />
        <span>Edit connection</span>
      </button>

      <button
        type="button"
        data-testid="connection-banner-leave"
        onclick={() => onLeave?.()}
        class="flex items-center gap-1.5 rounded px-2 py-1 text-danger hover:bg-surface-raised transition-colors"
        title="Leave this connection"
      >
        <LogOut size={14} />
        <span>Leave</span>
      </button>
    </div>
  </div>
{/if}
