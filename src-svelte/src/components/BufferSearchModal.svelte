<script lang="ts">
  import type { BufferPresentation, BufferSearchSort } from '#lib/types.ts';
  import { visibleBuffers, sortBuffers, compareBuffersHotlist } from '#lib/stores/models.ts';
  import { settings, updateSettings } from '#lib/stores/settings.ts';
  import { switchBuffer } from '#lib/stores/connectionManager.ts';
  import { clamp } from '#lib/num.ts';
  import {
    CUT_MARKER, bufferMatchesQuery, splitQueryMatches, topicCapacity, topicExcerpt,
    topicMatchesQuery, type RowMetrics,
  } from '#lib/bufferSearchMatch.ts';
  import { focusWhenPopoverOpens } from '#lib/dialogFocus.ts';

  import BaseDialog from '#components/BaseDialog.svelte';
  import FormInput from '#components/FormInput.svelte';
  import Search from '@lucide/svelte/icons/search';
  import X from '@lucide/svelte/icons/x';

  interface BufferGroup {
    number: number;
    buffers: BufferPresentation[];
  }

  let { onBufferSelect = () => {} } = $props();
  let bufferSearchQuery = $state('');
  let selectedIndex = $state(0);
  // The dialog is rendered unconditionally — popover visibility is toggled, not
  // mounted — so its result rows exist in the DOM even while it is closed.
  let isOpen = $state(false);
  // BaseDialog hands back its own <dialog> element. Closing through that element
  // rather than `document.getElementById('buffer-search-modal')` means the modal
  // closes the dialog it rendered even if another element ever carries that id.
  let baseDialog: { dialog: HTMLDialogElement | undefined } | undefined = $state();

  // A topic excerpt has to be cut to the width the row really has, so the dialog measures
  // that width: the room its results box has, and how wide one character is in each of the
  // two fonts a row is built from. Two hidden rulers are the second half, because a topic
  // line and a buffer-number badge do not share a font size.
  const RULER_CHARS = 20;
  const RULER_SAMPLE_CHARS = 120;
  let resultsBox = $state<HTMLDivElement | null>(null);
  let topicRuler = $state<HTMLSpanElement | null>(null);
  let badgeRuler = $state<HTMLSpanElement | null>(null);
  let resultsWidth = $state(0);
  let rowMetrics = $state<RowMetrics>({ resultsWidth: 0, charWidth: 0, badgeCharWidth: 0 });

  // One folded query drives both halves of the dialog: which rows it keeps, and what it
  // marks on the rows it keeps. They cannot drift apart, so a row never appears without
  // something on it that says why.
  let searchNeedle = $derived(bufferSearchQuery.toLowerCase());

  let filteredBuffers = $derived(
    $visibleBuffers.filter((buf: BufferPresentation) => bufferMatchesQuery(buf, searchNeedle))
  );

  // The longest topic the dialog currently shows. The topic ruler holds it and is divided by
  // its own length, so the width comes from the glyphs a row really draws. Settings lets a
  // font family replace the monospace stack with any family CSS, and then a proxy character
  // stops being the width of the text it stands for.
  let topicRulerSample = $derived(
    (filteredBuffers.reduce(
      (longest: string, buf: BufferPresentation) => (buf.rtitle.length > longest.length ? buf.rtitle : longest),
      '',
    ) || '0'.repeat(RULER_CHARS)).slice(0, RULER_SAMPLE_CHARS)
  );

  // Which order the dialog shows. 'number' is the sidebar's own order — pinned
  // first, and server-grouped exactly when the sidebar is server-grouped — so the
  // dialog and the list beside it stop disagreeing. 'unread' is the hotlist's
  // order, shared with the hotlist strip through compareBuffersHotlist: highlights,
  // then unread buffers, then the rest by WeeChat's buffer number, with no pinned
  // tier, because a mode named after activity has to rank by activity.
  let sortMode = $derived($settings.bufferSearchSort ?? 'number');

  let orderedBuffers = $derived(
    sortMode === 'unread'
      ? [...filteredBuffers].sort(compareBuffersHotlist)
      : sortBuffers(filteredBuffers, $settings.orderbyserver)
  );

  // Group merged buffers by their shared number. A group lands where its first
  // member ranks, so a merged pair surfaces as high as its most active buffer.
  let groupedBuffers = $derived(
    orderedBuffers.reduce<BufferGroup[]>((groups, buf) => {
      const existing = groups.find(g => g.number === buf.number);
      if (existing) {
        existing.buffers.push(buf);
      } else {
        groups.push({ number: buf.number, buffers: [buf] });
      }
      return groups;
    }, [])
  );

  // The row the dialog actually acts on. `selectedIndex` can go stale when the
  // result list shrinks underneath it (a buffer closes while the dialog is
  // open), so every consumer clamps through this instead of reading
  // `selectedIndex` directly. Clamping here rather than in an effect keeps it
  // correct regardless of whether the popover's toggle events have fired.
  let activeIndex = $derived.by(() => {
    const count = groupedBuffers.length;
    if (count === 0) return -1;
    return clamp(selectedIndex, 0, count - 1);
  });

  async function handleBufferClick(buffer: BufferPresentation) {
    const switched = await switchBuffer(buffer.id);
    if (!switched) return;
    bufferSearchQuery = '';
    selectedIndex = 0;
    baseDialog?.dialog?.hidePopover();
    onBufferSelect();
  }

  function handleKeyDown(e: KeyboardEvent) {
    const key = e.key;

    if (key === 'ArrowDown' || key === 'ArrowUp') {
      e.preventDefault();
      if (groupedBuffers.length === 0) return;
      if (key === 'ArrowDown') {
        selectedIndex = (selectedIndex + 1) % groupedBuffers.length;
      } else {
        selectedIndex = (selectedIndex - 1 + groupedBuffers.length) % groupedBuffers.length;
      }
      return;
    }

    if (key === 'Enter') {
      e.preventDefault();
      // Results can change between key events; never dereference a stale selection.
      const buffer = groupedBuffers[activeIndex]?.buffers[0];
      if (buffer) {
        void handleBufferClick(buffer);
      }
    }
  }

  function handleBeforeToggle(event: ToggleEvent) {
    if (event.newState !== 'open') return;
    isOpen = true;
    focusWhenPopoverOpens('buffer-search', { select: true });
  }

  function handleToggle(event: ToggleEvent) {
    isOpen = event.newState === 'open';
    if (event.newState === 'closed') {
      bufferSearchQuery = '';
      selectedIndex = 0;
    }
  }

  // Changing the order re-ranks every row, so the highlight restarts at the top
  // instead of following a buffer that has moved somewhere else in the list.
  function setSortMode(mode: BufferSearchSort) {
    if (mode === sortMode) return;
    updateSettings({ bufferSearchSort: mode });
    selectedIndex = 0;
  }

  // Scroll the highlighted result into view while the dialog is open.
  //
  // Gated on the dialog being open. `activeIndex` derives from
  // `$visibleBuffers`, so reading it here made this effect re-run on every
  // `buffers` store write — once per incoming message batch — and every run
  // did a document-wide querySelector plus a scrollIntoView on a row inside a
  // closed popover. A CPU profile of a 2000-message flood against the
  // production build put that scrollIntoView at 42% of all samples. While the
  // dialog is closed nothing observes the highlight, and opening it re-runs
  // this effect through the isOpen dependency.
  $effect(() => {
    if (!isOpen) return;
    const idx = activeIndex;
    if (idx >= 0) {
      const el = document.querySelector(`[data-search-index="${idx}"]`);
      el?.scrollIntoView({ block: 'nearest' });
    }
  });

  // Take the measurements while the dialog is open, and again whenever the results box
  // changes width. A closed popover lays its rows out at zero width, so nothing here reads
  // the DOM while it is closed; `bind:offsetWidth` reports the real width when it opens.
  // Each run is three reads on elements the dialog already has — never per row — and it runs
  // when the box changes width or the ruler's sample changes, not on every keystroke.
  $effect(() => {
    if (!isOpen || resultsWidth === 0) return;
    const sample = topicRulerSample;
    const box = resultsBox;
    const topic = topicRuler;
    const badge = badgeRuler;
    if (!box || !topic || !badge) return;
    rowMetrics = {
      resultsWidth: box.clientWidth,
      charWidth: topic.offsetWidth / sample.length,
      badgeCharWidth: badge.offsetWidth / RULER_CHARS,
    };
  });
</script>

<BaseDialog bind:this={baseDialog} id="buffer-search-modal" labelledby="buffer-search-title" noAnimation onbeforetoggle={handleBeforeToggle} ontoggle={handleToggle}>
  <div class="buffer-search-content flex flex-col max-h-[85vh]">
    <div class="buffer-search-header px-4 py-3 border-b border-border flex items-center justify-between">
      <h2 id="buffer-search-title" class="text-sm font-bold text-text">Search Buffers</h2>
      <div class="buffer-search-sort flex items-center gap-1" role="group" aria-label="Search result order">
        <button
          type="button"
          data-testid="buffer-search-sort-number"
          aria-pressed={sortMode === 'number'}
          onclick={() => setSortMode('number')}
          class="px-2 py-1 text-xs rounded border {sortMode === 'number' ? 'bg-surface-raised border-border text-text' : 'border-border text-text-muted hover:text-text'}"
        >
          Buffer order
        </button>
        <button
          type="button"
          data-testid="buffer-search-sort-unread"
          aria-pressed={sortMode === 'unread'}
          onclick={() => setSortMode('unread')}
          class="px-2 py-1 text-xs rounded border {sortMode === 'unread' ? 'bg-surface-raised border-border text-text' : 'border-border text-text-muted hover:text-text'}"
        >
          Unread first
        </button>
      </div>
      <button
        data-testid="buffer-search-close"
        type="button"
        popovertarget="buffer-search-modal"
        popovertargetaction="hide"
        class="text-text-muted hover:text-text p-1 rounded"
        aria-label="Close search"
      >
        <X size={16} />
      </button>
    </div>

    <div class="buffer-search-input-area px-4 py-2 border-b border-border">
      <div class="relative">
        <Search size={14} class="buffer-search-icon absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
        <FormInput
          id="buffer-search"
          type="text"
          value={bufferSearchQuery}
          oninput={(e: Event) => { bufferSearchQuery = (e.target as HTMLInputElement).value; selectedIndex = 0; }}
          onkeydown={handleKeyDown}
          placeholder="Search buffers..."
          variant="search"
          extraClass="pr-2"
        />
      </div>
    </div>

    <div class="buffer-search-results relative flex-1 overflow-y-auto p-2" bind:this={resultsBox} bind:offsetWidth={resultsWidth}>
      <!-- Rulers the dialog measures one character against, in each font a row really uses.
           Hidden, but laid out: an element with no box measures zero. -->
      <span
        bind:this={topicRuler}
        aria-hidden="true"
        class="buffer-search-ruler absolute -left-[9999px] top-0 whitespace-pre text-sm opacity-0 pointer-events-none select-none"
      >{topicRulerSample}</span>
      <span
        bind:this={badgeRuler}
        aria-hidden="true"
        class="buffer-search-ruler absolute -left-[9999px] top-0 whitespace-pre text-xs font-bold opacity-0 pointer-events-none select-none"
      >{'0'.repeat(RULER_CHARS)}</span>
      {#each groupedBuffers as group, idx (group.number)}
        {@const shortName = group.buffers.map(b => b.shortName).join(', ')}
        {@const fullName = group.buffers.map(b => b.fullName).join(', ')}
        {@const isActive = idx === activeIndex}
        <!-- A row that matched on its channel topic says so on a third line. A group merges
             buffers under one number, so the line shows the first member whose topic matched. -->
        {@const topicHit = searchNeedle === ''
          ? undefined
          : group.buffers.find(b => topicMatchesQuery(b, searchNeedle))}
        <!-- Each row can print one chip at its right edge: a notification count, or an unread
             count. It is drawn over the row, so it costs the topic line room as well. -->
        {@const loud = group.buffers.some(b => b.notification >= 3)}
        {@const notice = loud
          ? group.buffers.reduce((sum, b) => sum + b.notification, 0)
          : group.buffers.reduce((sum, b) => sum + (b.notification > 0 ? b.notification : b.unread), 0)}
        {@const badgeDigits = (loud || notice > 0) ? String(notice).length : 0}
        {@const topic = topicHit
          ? topicExcerpt(topicHit.rtitle, searchNeedle, topicCapacity(String(group.number).length, rowMetrics, badgeDigits))
          : null}
        <button
          onclick={() => handleBufferClick(group.buffers[0]!)}
          class="buffer-search-item w-full px-3 py-3 text-left flex items-center relative rounded hover:bg-surface-raised transition-colors {isActive ? 'buffer-search-item-active !bg-accent-strong' : ''}"
          data-search-index={idx}
        >
          <div class="flex items-center gap-2 min-w-0 flex-1">
            <span class="buffer-search-number flex-shrink-0 px-1.5 py-0.5 text-xs font-bold rounded bg-surface-raised border border-border {isActive ? 'text-white' : 'text-text'}">
              {group.number}
            </span>
            <div class="min-w-0 flex-1">
              <div class="buffer-search-shortname text-base font-bold truncate {isActive ? 'text-white' : 'text-text'}">
                {#each splitQueryMatches(shortName, searchNeedle) as piece, i (i)}
                  {#if piece.hit}<mark>{piece.text}</mark>{:else}{piece.text}{/if}
                {/each}
              </div>
              <div class="buffer-search-fullname text-sm truncate {isActive ? 'text-white' : 'text-text-secondary'}">
                {#each splitQueryMatches(fullName, searchNeedle) as piece, i (i)}
                  {#if piece.hit}<mark>{piece.text}</mark>{:else}{piece.text}{/if}
                {/each}
              </div>
              {#if topic}
                <div class="buffer-search-topic text-sm truncate {isActive ? 'text-white' : 'text-text-secondary'}" data-testid="buffer-search-topic">
                  <span class="sr-only">Channel topic: </span>
                  {#if topic.lead}<span>{CUT_MARKER} </span>{/if}
                  {#each splitQueryMatches(topic.text, searchNeedle) as piece, i (i)}
                    {#if piece.hit}<mark>{piece.text}</mark>{:else}{piece.text}{/if}
                  {/each}
                  {#if topic.trail}<span> {CUT_MARKER}</span>{/if}
                </div>
              {/if}
            </div>
          </div>

          {#if loud}
            <span class="buffer-search-badge notification-badge absolute right-3 top-1/2 -translate-y-1/2 px-1.5 py-0.5 text-xs font-bold rounded bg-danger/60 text-white">
              {notice}
            </span>
          {:else if notice > 0}
            <span class="buffer-search-badge unread-badge absolute right-3 top-1/2 -translate-y-1/2 px-1.5 py-0.5 text-xs font-bold rounded bg-warning/60 text-white">
              {notice}
            </span>
          {/if}
        </button>
      {/each}
      {#if groupedBuffers.length === 0 && bufferSearchQuery}
        <div class="buffer-search-no-results px-3 py-8 text-center text-text-secondary text-sm">No buffers found</div>
      {/if}
    </div>
  </div>
</BaseDialog>
