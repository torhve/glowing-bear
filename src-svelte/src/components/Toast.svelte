<script lang="ts">
    import { toastStore, removeToast } from '$lib/toast';
    import { onMount, onDestroy } from 'svelte';
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
            case 'success': return 'bg-green-600 text-white';
            case 'error': return 'bg-red-600 text-white';
            case 'warning': return 'bg-yellow-500 text-black';
            default: return 'bg-gray-700 text-white';
        }
    }
</script>

<div class="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm" data-testid="toast-container">
    {#each _toasts as toast (toast.id)}
        <div
            class="{getTypeClass(toast.type)} rounded-lg shadow-lg px-4 py-3 flex items-start gap-2 animate-in fade-in slide-in-from-bottom-2"
            data-testid="toast"
        >
            {#if toast.type === 'success'}
                <CheckCircle size={16} class="text-white flex-shrink-0 mt-0.5" />
            {:else if toast.type === 'error'}
                <AlertCircle size={16} class="text-white flex-shrink-0 mt-0.5" />
            {:else if toast.type === 'warning'}
                <AlertTriangle size={16} class="text-black flex-shrink-0 mt-0.5" />
            {/if}
            <span class="flex-1 text-sm">{toast.message}</span>
            <button
                onclick={() => handleClose(toast.id)}
                class="text-white/80 hover:text-white flex-shrink-0"
                data-testid="toast-close"
            >
                <X size={16} />
            </button>
        </div>
    {/each}
</div>
