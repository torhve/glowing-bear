<script lang="ts">
    import { toastStore, removeToast } from '$lib/toast';
    
    import X from '@lucide/svelte/icons/x';
    import CheckCircle from '@lucide/svelte/icons/check-circle';
    import AlertCircle from '@lucide/svelte/icons/alert-circle';
    import AlertTriangle from '@lucide/svelte/icons/alert-triangle';

    let _toasts: import('$lib/toast').Toast[] = $state([]);

    $effect(() => {
        const unsub = toastStore.subscribe(value => {
            _toasts = value;
        });
        return unsub;
    });

    function handleClose(id: number) {
        removeToast(id);
    }

    function getTypeClass(type: string): string {
        switch (type) {
            case 'success': return 'bg-success text-text';
            case 'error': return 'bg-danger text-text';
            case 'warning': return 'bg-warning text-text';
            default: return 'bg-surface-raised text-text';
        }
    }
</script>

<div class="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm" data-testid="toast-container">
    {#each _toasts as toast (toast.id)}
        <div
            class="toast-item {getTypeClass(toast.type)} rounded-lg shadow-lg px-4 py-3 flex items-start gap-2 animate-in fade-in slide-in-from-bottom-2"
            data-testid="toast"
        >
            {#if toast.type === 'success'}
                <CheckCircle size={16} class="toast-icon text-text flex-shrink-0 mt-0.5" />
            {:else if toast.type === 'error'}
                <AlertCircle size={16} class="toast-icon text-text flex-shrink-0 mt-0.5" />
            {:else if toast.type === 'warning'}
                <AlertTriangle size={16} class="toast-icon text-text flex-shrink-0 mt-0.5" />
            {/if}
            <span class="toast-message flex-1 text-sm">{toast.message}</span>
            <button
                onclick={() => handleClose(toast.id)}
                class="text-text-secondary/60 hover:text-text flex-shrink-0"
                data-testid="toast-close"
            >
                <X size={16} />
            </button>
            {#if toast.buttons && toast.buttons.length > 0}
                <div class="toast-actions flex gap-2 mt-2">
                    {#each toast.buttons as btn, i (btn.text + i)}
                        <button
                            onclick={() => btn.action()}
                            class="px-3 py-1 text-xs font-medium rounded bg-accent text-white hover:bg-accent-hover"
                            data-toast-action
                        >
                            {btn.text}
                        </button>
                    {/each}
                </div>
            {/if}
        </div>
    {/each}
</div>
