<script lang="ts">
import { buffers, activeBufferId } from '$lib/stores/models';
import { switchBuffer } from '$lib/stores/connectionManager';
import type { BufferData } from '$lib/types';

let { onBufferSelect = () => {} } = $props();

// Buffers with unread activity, excluding active and hidden buffers.
let entries = $derived(
    Object.values($buffers)
        .filter(b => !b.hidden && b.id !== $activeBufferId && (b.notification > 0 || b.unread > 0))
        .sort((a, b) => {
            // Highlights (notification) first, then regular unread.
            const aHighlight = a.notification > 0 ? 1 : 0;
            const bHighlight = b.notification > 0 ? 1 : 0;
            if (aHighlight !== bHighlight) return bHighlight - aHighlight;
            // Within same category, higher total count first.
            const aTotal = a.notification + a.unread;
            const bTotal = b.notification + b.unread;
            return bTotal - aTotal;
        })
);

// Truncate long buffer names to max 18 chars with ellipsis.
function truncateName(name: string): string {
    return name.length > 18 ? name.slice(0, 15) + '\u2026' : name;
}

// Switch to the clicked buffer and notify parent.
function handleItemClick(buffer: BufferData) {
    switchBuffer(buffer.id);
    onBufferSelect();
}
</script>

<div data-testid="buffer-hotlist" class="flex items-center gap-1 min-w-0 flex-shrink overflow-x-auto">
    {#each entries as entry (entry.id)}
        <button
            onclick={() => handleItemClick(entry)}
            data-testid="hotlist-buffer-item"
            class="flex items-center gap-0.5 text-xs whitespace-nowrap cursor-pointer hover:text-white px-0.5 rounded {entry.notification > 0 ? 'text-danger font-semibold' : 'text-text-secondary'}"
        >
            <span class="truncate max-w-[3rem]">{truncateName(entry.shortName)}</span>
            <span
                data-testid="hotlist-count"
                class="font-medium {entry.notification > 0 ? 'text-danger' : 'text-accent'}"
            >
                ({entry.notification + entry.unread})
            </span>
        </button>
    {/each}
</div>
