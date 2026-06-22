<script lang="ts">
    import { toastStore, removeToast } from '$lib/toast';
    import { untrack } from 'svelte';

    import X from '@lucide/svelte/icons/x';
    import CheckCircle from '@lucide/svelte/icons/check-circle';
    import AlertCircle from '@lucide/svelte/icons/alert-circle';
    import AlertTriangle from '@lucide/svelte/icons/alert-triangle';

    let _active: import('$lib/toast').Toast[] = $state([]);
    // Map of toast ID -> toast data for toasts currently playing exit animation
    let _removing: Map<number, import('$lib/toast').Toast> = $state(new Map());

    $effect(() => {
        return toastStore.subscribe(value => {
            untrack(() => {
                const prevActive = _active;
                const newIds = new Set(value.map(t => t.id));
                const externallyRemoved = prevActive.filter(t => !newIds.has(t.id));
                let nextRemoving = _removing;
                for (const t of externallyRemoved) {
                    if (!nextRemoving.has(t.id)) {
                        // eslint-disable-next-line svelte/prefer-svelte-reactivity
                        nextRemoving = new Map(nextRemoving);
                        nextRemoving.set(t.id, t);
                        setTimeout(() => scheduleCleanup(t.id), 200);
                    }
                }
                _removing = nextRemoving;
                _active = value;
            });
        });
    });

    function scheduleCleanup(id: number) {
        // eslint-disable-next-line svelte/prefer-svelte-reactivity
        const next = new Map(_removing);
        next.delete(id);
        _removing = next;
    }

    // Display list: active toasts + toasts in exit animation
    let _displayToasts: import('$lib/toast').Toast[] = $derived.by(() => {
        const activeIds = new Set(_active.map(t => t.id));
        const result = [..._active];
        for (const [id, toast] of _removing) {
            if (!activeIds.has(id)) {
                result.push(toast);
            }
        }
        return result;
    });

    function handleClose(id: number) {
        const toast = _active.find(t => t.id === id) ?? _removing.get(id);
        if (!toast) return;
        if (!_removing.has(id)) {
            // eslint-disable-next-line svelte/prefer-svelte-reactivity
            const next = new Map(_removing);
            next.set(id, toast);
            _removing = next;
        }
        setTimeout(() => {
            removeToast(id);
            setTimeout(() => scheduleCleanup(id), 0);
        }, 200);
    }

    function getTypeClass(type: string): string {
        switch (type) {
            case 'success': return 'bg-success text-text';
            case 'error': return 'bg-danger text-text';
            case 'warning': return 'bg-warning text-black';
            default: return 'bg-surface-raised text-text';
        }
    }

</script>

<div class="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm" data-testid="toast-container">
    {#each _displayToasts as toast (toast.id)}
        <div
            class:toast-removing={_removing.has(toast.id)}
            class="relative group toast-wrapper"
        >
            <div
                class="toast-item {getTypeClass(toast.type)} rounded-lg shadow-lg px-4 py-3 flex items-start gap-2 relative z-10"
                data-testid="toast"
            >
                {#if toast.type === 'success'}
                    <CheckCircle size={16} class="toast-icon text-text flex-shrink-0 mt-0.5" />
                {:else if toast.type === 'error'}
                    <AlertCircle size={16} class="toast-icon text-text flex-shrink-0 mt-0.5" />
                {:else if toast.type === 'warning'}
                    <AlertTriangle size={16} class="toast-icon text-black flex-shrink-0 mt-0.5" />
                {/if}
                <span class="toast-message flex-1 text-sm">{toast.message}</span>
                <button
                    onclick={() => handleClose(toast.id)}
                    class="text-text-secondary/60 hover:text-text flex-shrink-0 transition-colors"
                    data-testid="toast-close"
                >
                    <X size={16} />
                </button>
                {#if toast.buttons && toast.buttons.length > 0}
                    <div class="toast-actions flex gap-2 mt-2">
                        {#each toast.buttons as btn, i (btn.text + i)}
                        <button
                            onclick={() => btn.action()}
                            class="px-3 py-1 text-xs font-medium rounded bg-accent text-white hover:bg-accent-hover btn-glow"
                            data-toast-action
                            data-testid={`toast-${btn.text.toLowerCase()}-button`}
                        >
                                {btn.text}
                            </button>
                        {/each}
                    </div>
                {/if}
            </div>
        </div>
    {/each}
</div>


