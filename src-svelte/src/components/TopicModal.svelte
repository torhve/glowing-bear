<script lang="ts">
  import type { RichTextPart } from '$lib/types';
  import BaseDialog from '$components/BaseDialog.svelte';
  import LinkifiedText from '$components/LinkifiedText.svelte';

  let {
    topic = [] as RichTextPart[],
    bufferName = ''
  }: {
    topic?: RichTextPart[];
    bufferName?: string;
  } = $props();
</script>

<BaseDialog id="topic-modal" labelledby="topic-title">
  <div class="flex flex-col">
    <div class="flex items-center justify-between px-6 py-4 border-b border-border">
      <h3 id="topic-title" class="text-lg font-bold text-white">
        Channel topic {bufferName}
      </h3>
      <button
        type="button"
        data-testid="topic-modal-close"
        popovertarget="topic-modal"
        popovertargetaction="hide"
        class="text-text-secondary hover:text-white text-2xl leading-none transition-colors"
        aria-label="Close topic"
      >
        &times;
      </button>
    </div>
    <div class="px-6 py-4 max-h-96 overflow-y-auto">
      {#if topic.length > 0}
        <div class="text-sm leading-relaxed">
          {#each topic as part (part.text)}
            {#if part.text}
              <span
                class="{part.classes?.join(' ')}"
                style="{part.fgColor.name !== '0' && part.fgColor.name !== undefined ? 'color: inherit;' : ''}"
              >
            <LinkifiedText text={part.text || ''} />
              </span>
            {/if}
          {/each}
        </div>
      {:else}
        <p class="text-text-muted text-sm italic">No topic set</p>
      {/if}
    </div>
    <div class="px-6 py-4 border-t border-border flex justify-end">
      <button
        type="button"
        data-testid="topic-modal-close-button"
        popovertarget="topic-modal"
        popovertargetaction="hide"
        class="px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded text-sm font-medium transition-colors"
      >
        Close
      </button>
    </div>
  </div>
</BaseDialog>
