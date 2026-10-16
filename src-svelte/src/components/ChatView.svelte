<script lang="ts">
  import type { BufferLine } from '#lib/types.ts';
  import { get } from 'svelte/store';
  import { activeBufferId, bufferBottom, buffers, historyCappedFor, lineLimitFor, recalculateLinesPerScreen, getReadBoundaryIndex, isUserMessageLine, serverNick } from '#lib/stores/models.ts';
  import { chatDisplay } from '#lib/stores/chatPresentation.ts';
  import { historyOutcomes, historyUnavailable } from '#lib/stores/historyState.ts';
  import { settings } from '#lib/stores/settings.ts';
  import { fetchMoreLines, closeBufferOnWeeChat, pinBuffer, unpinBuffer } from '#lib/stores/connectionManager.ts';
  import { buildMentionText, isFreeBuffer, modifyTextareaValue } from '#lib/utils.ts';
  import { ChatViewport, createChatDomAdapter, TOUCH_NAVIGATION_THRESHOLD_PX } from '#lib/chatViewport.ts';
  import type { ChatViewportState, ChatScrollCommands } from '#lib/chatViewport.ts';
  import BufferLineRow from '#components/BufferLineRow.svelte';
  import TopicModal from '#components/TopicModal.svelte';
  import LinkifiedText from '#components/LinkifiedText.svelte';
  import ChevronUp from '@lucide/svelte/icons/chevron-up';
  import Inbox from '@lucide/svelte/icons/inbox';
  import FileText from '@lucide/svelte/icons/file-text';
  import Pin from '@lucide/svelte/icons/pin';
  import PinOff from '@lucide/svelte/icons/pin-off';
  import X from '@lucide/svelte/icons/x';

  let containerRef = $state<HTMLDivElement>();
  // Live data when there is any; the retained snapshot when the transport has
  // wiped its stores but the session is still on screen. Every read below goes
  // through these two, so a retained view cannot be mistaken for live authority.
  let current = $derived($chatDisplay.buffer);
  let isLive = $derived($chatDisplay.live);
  let messages = $derived(current?.lines ?? []);
  // Stable per-row keys: every store update clones the lines, so object identity is
  // useless and index keys let a row's component state (e.g. an injected embed) follow
  // the wrong message when the line cap trims the front. lineId is stable across
  // updates; a positional suffix keeps keys unique for identical content-fallback ids
  // (relays without WeeChat line ids).
  let lineKeys = $derived.by(() => {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local dedup bookkeeping, not reactive state
    const seen = new Map<string, number>();
    return messages.map((m) => {
      const base = m.lineId ?? `line:${m.date}:${m.text}`;
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      return n === 0 ? base : `${base}#${n}`;
    });
  });
  let noembed = $derived($settings.noembed);
  // Optional bridge for siblings that express scroll intent (the global key
  // handler and the message composer). The view publishes commands while it is
  // mounted and retracts them on unmount; the caller never touches the DOM.
  let { onCommands = undefined }: { onCommands?: (commands: ChatScrollCommands | null) => void } = $props();
  let topicText = $derived(current?.title?.map(t => t.text).join('') || '');
  // Bubble mode: enabled when setting is on AND buffer is a private chat type.
  // Only 'private' type buffers (DCC chats and IRC PMs) get bubbles;
  // server, channel, and other system buffers always use table layout.
  let bubbleMode = $derived(
    $settings.stylizePrivateChats &&
    current &&
    current.type === 'private'
  );

  // Other person's nick for self-message detection in bubble mode.
  // Query buffers: shortName IS the other person's nick.
  // Private buffers: fullName is like "server.nicks.other_nick" — extract last segment.
  let otherNick = $derived(
    current ? (
      current.type === 'query'
        ? current.shortName
        : current.fullName.split('.').pop() ?? ''
    ) : ''
  );

  // My nick: prefer the buffer's own localVariables.nick; fall back to the matching
  // server buffer's nick. The fallback is an explicit store dependency rather than a
  // get(buffers) scan: the nick lives on the server buffer, and a selective
  // currentBuffer deliberately stops publishing when a *different* buffer changes —
  // which is exactly what a /nick is.
  let myNick = $derived(
    current?.localVariables?.nick ?? $serverNick
  );

  let isLoadingMore = $state(false);
  let viewBufferId = $derived(current?.id);
  // A null index means the reconnect/snapshot did not provide a trustworthy boundary.
  let readEndIndex = $derived(current ? getReadBoundaryIndex(current) : null);
  let hasUnreadDisplayed = $derived(
    readEndIndex !== null && messages.length > 0 && readEndIndex < messages.length - 1
  );
  // Count only actual user-message rows; status rows and date separators are display-only.
  let unreadCount = $derived(
    hasUnreadDisplayed && readEndIndex !== null
      ? messages.slice(readEndIndex + 1).filter(isUserMessageLine).length
      : 0
  );
  let showMarkerBeforeUnread = $derived(hasUnreadDisplayed);
  let showEndMarker = $derived(
    readEndIndex !== null && messages.length > 0 && !hasUnreadDisplayed
  );
  let readStartIndex = $derived((readEndIndex ?? -1) + 1);

  // Toggle pin/unpin for the currently active buffer via WeeChat localvar_set.
  function handleTogglePin() {
    if (!isLive) return;
    const bufId = get(activeBufferId);
    if (!bufId) return;
    const bufferData = get(buffers)[bufId];
    if (!bufferData) return;
    const wasPinned = bufferData.pinned;
    buffers.update(current => {
      const existing = current[bufId];
      if (!existing) return current;
      const updated = { ...current };
      updated[bufId] = { ...existing, pinned: !wasPinned };
      return updated;
    });
    if (wasPinned) {
      unpinBuffer(bufId);
    } else {
      pinBuffer(bufId);
    }
  }

  // Close the currently active buffer via WeeChat /close command.
  function handleCloseBuffer() {
    if (!isLive) return;
    const bufId = get(activeBufferId);
    if (!bufId) return;
    closeBufferOnWeeChat(bufId);
  }

  // ---- Viewport ownership ----
  // Every application-driven scroll of the chat container is decided by one
  // controller per mounted view. The decision tree, the follow-pin loop, the
  // read-separator placement and the WebKit layout safeguards all live in
  // lib/chatViewport.ts; this component renders, projects the model, and owns
  // the controller's lifecycle.
  const viewport = new ChatViewport({
    onFollowIntent: (atBottom) => bufferBottom.set(atBottom),
    onVisibleLinesEstimate: (numLines) => recalculateLinesPerScreen(numLines),
    onHistoryBusy: (busy) => {
      isLoadingMore = busy;
    },
    onReachTop: (force) => {
      void loadMoreHistory(force);
    },
  });

  // Bind the controller to this mounted view. A buffer change, a replaced
  // container, or unmount ends the previous visit: its queued frames, its pin
  // loop, and its in-flight history operation are cancelled rather than left to
  // act on a view they no longer belong to.
  $effect(() => {
    const bufferId = viewBufferId;
    const container = containerRef;
    if (!container) {
      viewport.detach();
      return;
    }
    viewport.attach(bufferId, createChatDomAdapter(container));
    return () => viewport.detach();
  });

  // Report what was rendered; the controller decides whether that means
  // re-placing the viewport, pinning a live tail, or doing nothing at all.
  $effect(() => {
    viewport.contentChanged({
      bufferId: viewBufferId,
      lineCount: messages.length,
      tailRef: messages.length > 0 ? messages[messages.length - 1] : undefined,
      hasUnread: hasUnreadDisplayed,
      readBoundaryKnown: readEndIndex !== null,
    });
  });

  // Publish this view's scroll commands. Both the global PageUp/PageDown handler
  // and the composer go through them, so no caller computes a scroll offset and
  // no caller can move a viewport the reader is not looking at.
  $effect(() => {
    onCommands?.({
      pageScroll: (direction: -1 | 1) => viewport.requestPageScroll(direction),
    });
    return () => onCommands?.(null);
  });

  // Track manual scrolling and request history when the reader reaches the top.
  function handleScroll() {
    viewport.handleScroll();
  }

  // A wheel or a vertical drag is deliberate navigation and is authoritative
  // immediately. A `scroll` event on its own is not: media growth, wrapping
  // reflow, native scroll anchoring and the pin loop all fire one, so treating
  // every scroll event as intent would end following on ordinary layout work.
  // Pinch-zoom, horizontal trackpad gestures, taps and horizontal sidebar swipes
  // are excluded, and a gesture that could not move this viewport in that
  // direction is not a reader choosing a position.
  $effect(() => {
    const container = containerRef;
    if (!container) return;

    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      if (!viewport.canScrollToward(event.deltaY > 0 ? 1 : -1)) return;
      viewport.noteNavigation('wheel');
    };

    // One intent per drag: the first vertical movement, not every touchmove.
    let anchorY: number | null = null;
    let noted = false;
    const onTouchStart = (event: TouchEvent) => {
      anchorY = event.touches[0]?.clientY ?? null;
      noted = false;
    };
    const onTouchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY;
      if (anchorY === null || y === undefined || noted) return;
      const delta = anchorY - y;
      if (Math.abs(delta) < TOUCH_NAVIGATION_THRESHOLD_PX) return;
      if (!viewport.canScrollToward(delta > 0 ? 1 : -1)) return;
      noted = true;
      viewport.noteNavigation('touch');
    };
    const onTouchEnd = () => {
      anchorY = null;
      noted = false;
    };

    container.addEventListener('wheel', onWheel, { passive: true });
    container.addEventListener('touchstart', onTouchStart, { passive: true });
    container.addEventListener('touchmove', onTouchMove, { passive: true });
    container.addEventListener('touchend', onTouchEnd);
    return () => {
      container.removeEventListener('wheel', onWheel);
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchmove', onTouchMove);
      container.removeEventListener('touchend', onTouchEnd);
      anchorY = null;
      noted = false;
    };
  });

  // Recalculate the visible-row estimate on window resize (debounced).
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    const onResize = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        viewport.notifyLayoutChanged();
      }, 150);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      if (resizeTimer) {
        clearTimeout(resizeTimer);
        resizeTimer = null;
      }
    };
  });

  // A font change alters every row's height: re-estimate rows and keep a
  // following view pinned. Reading views are left where the reader put them.
  $effect(() => {
    void $settings.fontsize;
    viewport.notifyLayoutChanged();
  });

  // Layout observation. The scroll container's own box is the viewport: it does
  // not grow when a row re-wraps or an image finishes loading. The content root
  // inside it does, so both are watched — two observers for the whole view rather
  // than one per message. The controller then decides what a size change means:
  // a following view re-anchors, a reading view stays where the reader left it.
  //
  // Re-running on layout mode and buffer rebinds the observer to the content root
  // that is actually mounted instead of leaving it attached to a node Svelte has
  // already discarded.
  $effect(() => {
    const container = containerRef;
    if (!container) return;
    // Dependencies here must be values that only change when the observation
    // really has to be rebound. Reading current would re-run this effect on
    // every message to the current buffer, and each re-run builds a new observer
    // that immediately reports its initial size — which the controller reads as a
    // layout change and answers with a pin, forever.
    void viewBufferId;
    void bubbleMode;

    const contentRoot = container.querySelector('.chat-table, .chat-bubble-container');
    const observer = new ResizeObserver(() => viewport.notifyLayoutChanged());
    observer.observe(container);
    if (contentRoot) observer.observe(contentRoot);
    return () => observer.disconnect();
  });

  // Animation frames do not run while the view is hidden, so a pin loop or a
  // queued restore has been holding geometry from before it went away. Returning
  // is not a resume: the stale work is dropped and only a genuinely following
  // view is re-anchored.
  $effect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') viewport.notifyVisibilityRestored();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  });

  // Handle mention click: extract nick from message prefix, insert into input at cursor.
  function handleMention(message: BufferLine) {
    if (!message.showHiddenBrackets) return;
    const prefixParts = message.prefix || [];
    const lastPart = prefixParts[prefixParts.length - 1];
    const nickName = lastPart?.text?.trim() || message.prefixtext?.trim() || '';
    if (!nickName) return;
    modifyTextareaValue('[data-testid="message-input"]', (value: string, start: number, end: number) => {
      const result = buildMentionText(value.substring(0, start) + value.substring(end), nickName, current?.nicklist?.root?.nicks);
      return { value: result.text, cursor: result.caretPos };
    });
  }

  // Copying a table selection is serialized per cell: the browser puts a tab
  // between the cells of one row and a newline between rows. A chat line reads
  // "12:34 <nick> text", so the cell tabs become single spaces and the row
  // newlines stay. A selection that never crossed a cell boundary carries no
  // tab and is left to the browser — that is the reader who pulled a URL out
  // of a message and wants only the URL.
  function handleCopy(event: ClipboardEvent) {
    const text = window.getSelection()?.toString();
    if (!text || !text.includes('\t')) return;
    event.preventDefault();
    event.clipboardData?.setData('text/plain', text.replace(/\t/g, ' '));
  }

  // A history request is claimed and finished through the controller, which owns
  // the loading guard, the exhausted-top memo, and the position restore. `force`
  // (the explicit button) bypasses the memo and restores no position.
  async function loadMoreHistory(force: boolean) {
    // A retained buffer is frozen; asking the relay for more history would
    // write into live stores the retained view is not part of.
    if (!isLive) return;
    const buffer = get(chatDisplay).buffer;
    if (!buffer || buffer.allLinesFetched) return;
    const token = viewport.beginHistory(force);
    if (!token) return;
    const topLineBefore = buffer.lines[0]?.lineId;
    try {
      // Both ways here are the reader paging upward — the explicit control and
      // reaching the top of the view — so this page may widen the window.
      await fetchMoreLines(0, buffer.id, true);
      const after = get(buffers)[buffer.id];
      const topAfter = after?.lines[0]?.lineId;
      // Nothing was prepended while the buffer sits at its line cap: the
      // displayed window already covers the server history.
      const prependedNothing = !!after
        && topAfter !== undefined
        && topAfter === topLineBefore
        && after.lines.length >= lineLimitFor(after);
      viewport.finishHistory(token, { preserveScroll: !force, prependedNothing });
    } catch (err) {
      console.warn('[fetchMoreLines] fetch failed:', err);
      viewport.finishHistory(token, { preserveScroll: !force, prependedNothing: false });
    }
  }

  function handleFetchMore() {
    viewport.requestHistoryNow();
  }

  // A live buffer that renders nothing and whose history request failed is the
  // one case where the app has to say so out loud. Everything else on screen is
  // real content, so nothing looks wrong — which is exactly how a failed load
  // becomes invisible. 'loading' is not this state, and an absent outcome is
  // not this state either: only a recorded failure renders.
  let historyMissing = $derived(isLive && historyUnavailable(current, $historyOutcomes));

  // A buffer paged to the depth ceiling cannot go deeper: the next page would ask
  // for exactly the window it already holds. The control says so instead of
  // offering a click that fetches nothing.
  let historyCapped = $derived(isLive && current !== null && historyCappedFor(current));

  // Read-only view of the viewport controller, exposed for E2E specs.
  // 'Settled' means: the pin loop is not running, no layout frame is still queued
  // for this view, and the sticky follow-settle window has expired. A spec that
  // scrolls on purpose must wait for all three, otherwise an in-flight pin
  // overwrites it. This reports existing state only - it adds no timer and
  // changes no behavior.
  $effect(() => {
    const win = window as typeof window & { __chatFollowState?: () => ChatViewportState };
    win.__chatFollowState = () => viewport.snapshot();
    return () => {
      delete win.__chatFollowState;
    };
  });
</script>
<div class="chat-view-container flex-1 flex flex-col overflow-hidden">
  {#if current}
    <div class="h-[var(--spacing-topicbar-height,32px)] bg-input-bg border-b border-border flex items-center px-3 w-full" data-testid="topic-bar-container">
      <!-- Left zone: clickable to open topic modal -->
      <button
        type="button"
        data-testid="topic-bar"
        popovertarget="topic-modal"
        class="flex items-center flex-1 min-w-0 text-left text-sm hover:bg-surface transition-colors rounded py-1"
        title="Click to view topic"
      >
        <FileText size={14} class="text-text-muted mr-1 flex-shrink-0" />
        <span class="topic-channel-name text-text flex-shrink-0 whitespace-nowrap">{current.shortName}</span>
        <span class="topic-separator text-text-muted mx-2 flex-shrink-0">-</span>
        <span class="topic-text text-text-secondary truncate overflow-hidden min-w-0">
          <LinkifiedText text={topicText} />
        </span>
      </button>

      <!-- Right zone: action controls (always visible) -->
      <div class="flex items-center gap-0.5 flex-shrink-0 ml-2" data-testid="topic-controls">
        <!-- Remote controls are absent, not merely disabled: a retained view has
             no transport to act on, and an inert button invites a click that
             cannot do anything. -->
        {#if isLive}
          <!-- Pin/Unpin button -->
          <button
            type="button"
            onclick={handleTogglePin}
            class="text-text-muted hover:text-text p-1 rounded transition-colors"
            data-testid="pin-buffer"
            title={current.pinned ? 'Unpin buffer' : 'Pin buffer'}
          >
            {#if current.pinned}
              <PinOff size={16} />
            {:else}
              <Pin size={16} />
            {/if}
          </button>

          <!-- Close button — only show if buffer has no activity (no unread/notification) -->
          {#if current.notification === 0 && current.unread === 0}
            <button
              type="button"
              onclick={handleCloseBuffer}
              class="text-text-muted hover:text-danger p-1 rounded transition-colors"
              data-testid="close-buffer"
              title="Close buffer"
            >
              <X size={16} />
            </button>
          {/if}
        {/if}
      </div>
    </div>
  {/if}

  <div
    bind:this={containerRef}
    onscroll={handleScroll}
    oncopy={handleCopy}
    data-testid="chat-messages"
    class="chat-messages flex-1 overflow-y-auto overflow-x-hidden bg-bg"
    class:favorite-font={!current || !isFreeBuffer(current)}
    class:free-font={current && isFreeBuffer(current)}
    class:hideTime={current?.hideBufferLineTimes}
    style="font-size: var(--font-size, 13px);"
  >
    {#if !current}
      <div class="chat-empty-state flex items-center justify-center h-full text-text-muted">
        <div class="text-center">
          <Inbox size={48} class="mx-auto mb-3 opacity-50" />
          <p class="chat-empty-title text-lg mb-2">No buffer selected</p>
          <p class="chat-empty-subtitle text-sm">Select a buffer from the buffer list</p>
        </div>
      </div>
    {:else if bubbleMode}
      <!-- Bubble mode layout (private/query buffers with stylizePrivateChats enabled) -->
      <div class="chat-bubble-container">
        {#if historyMissing}
          <div class="chat-history-failed flex flex-col items-center gap-2 px-4 py-6 text-center">
            <p class="text-sm text-text-secondary" data-testid="history-failed">Older messages could not be loaded.</p>
            <button type="button" data-testid="history-retry" class="rounded px-3 py-1 text-xs font-medium bg-surface-raised text-text-secondary hover:text-text transition-colors" onclick={handleFetchMore}>
              Try again
            </button>
          </div>
        {/if}
        <!-- Fetch more lines -->
        {#if !current.allLinesFetched}
          <div class="bubble-fetchmore-row">
            {#if historyCapped}
              <p class="px-3 py-1 text-xs font-medium text-text-muted" data-testid="history-capped">History limit reached</p>
            {:else}
              <button type="button" data-testid="fetch-more-lines" class="fetchmorelines flex items-center gap-1 px-3 py-1 rounded text-xs font-medium text-text-secondary hover:text-text hover:bg-surface-raised transition-colors" onclick={handleFetchMore}>
                <ChevronUp size={14} class="text-text-muted" />
                Fetch more lines
              </button>
            {/if}
            <span class={['loading-spinner', { hidden: !isLoadingMore }]}>
              Fetching more lines<span class="loading-dots"><span>.</span><span>.</span><span>.</span></span>
            </span>
          </div>
        {/if}

        {#if showMarkerBeforeUnread}
          <!-- Read lines (up to and including readEndIndex) -->
          {#each messages.slice(0, readStartIndex) as message, i (lineKeys[i]!)}
            <BufferLineRow
              {message}
              index={i}
              {messages}
              {noembed}
              bubbleMode={true}
              {otherNick}
              {myNick}
              onMention={handleMention}
            />
          {/each}
          <!-- Readmarker between read and unread -->
          <div class="readmarker" data-testid="readmarker">
            <div class="readmarker-container">
              <div class="readmarker-line"></div>
              {#if unreadCount > 0}<span class="readmarker-badge">{unreadCount} new</span>{/if}
              <div class="readmarker-line"></div>
            </div>
          </div>
          <!-- Unread lines (after readEndIndex) -->
          {#each messages.slice(readStartIndex) as message, i (lineKeys[readStartIndex + i]!)}
            <BufferLineRow
              {message}
              index={readStartIndex + i}
              {messages}
              {noembed}
              bubbleMode={true}
              {otherNick}
              {myNick}
              onMention={handleMention}
            />
          {/each}
        {:else}
          <!-- All lines visible (no readmarker needed) -->
          {#each messages as message, i (lineKeys[i]!)}
            <BufferLineRow
              {message}
              index={i}
              {messages}
              {noembed}
              bubbleMode={true}
              {otherNick}
              {myNick}
              onMention={handleMention}
            />
          {/each}
          {#if showEndMarker}
            <div class="readmarker" data-testid="readmarker">
              <div class="readmarker-container">
                <div class="readmarker-line"></div>
                {#if unreadCount > 0}<span class="readmarker-badge">{unreadCount} new</span>{/if}
                <div class="readmarker-line"></div>
              </div>
            </div>
          {/if}
        {/if}
      </div>
    {:else}
      <!-- Table layout (channels, servers, free buffers) -->
      <table class="chat-table">
        <tbody class="chat-tbody">
          {#if historyMissing}
            <tr class="bufferline history-failed-row">
              <td class="text-center py-3" colspan=3>
                <p class="text-sm text-text-secondary" data-testid="history-failed">Older messages could not be loaded.</p>
                <button type="button" data-testid="history-retry" class="mt-1 rounded px-3 py-1 text-xs font-medium bg-surface-raised text-text-secondary hover:text-text transition-colors" onclick={handleFetchMore}>
                  Try again
                </button>
              </td>
            </tr>
          {/if}
          <!-- Fetch more lines row -->
          {#if !current.allLinesFetched}
            <tr class="bufferline fetchmore-row">
              <td class="text-center py-1" colspan=3>
                {#if historyCapped}
                  <p class="text-xs font-medium text-text-muted" data-testid="history-capped">History limit reached</p>
                {:else}
                  <button type="button" data-testid="fetch-more-lines" class="fetchmorelines flex items-center gap-1 px-3 py-1 rounded text-xs font-medium text-text-secondary hover:text-text hover:bg-surface-raised transition-colors" onclick={handleFetchMore}>
                    <ChevronUp size={14} class="text-text-muted" />
                    Fetch more lines
                  </button>
                {/if}
                <span class={['loading-spinner', { hidden: !isLoadingMore }]}>
                  Fetching more lines<span class="loading-dots"><span>.</span><span>.</span><span>.</span></span>
                </span>
              </td>
            </tr>
          {/if}<!---->

          {#if showMarkerBeforeUnread}
            <!-- Read lines (up to and including readEndIndex) -->
            {#each messages.slice(0, readStartIndex) as message, i (lineKeys[i]!)}
              <BufferLineRow
                {message}
                index={i}
                {messages}
                {noembed}
                onMention={handleMention}
              />
            {/each}<!---->
            <!-- Readmarker row between read and unread -->
            <tr class="readmarker" data-testid="readmarker">
              <td colspan="3">
                <div class="readmarker-container">
                  <div class="readmarker-line"></div>
                  {#if unreadCount > 0}<span class="readmarker-badge">{unreadCount} new</span>{/if}
                  <div class="readmarker-line"></div>
                </div>
              </td>
            </tr><!---->
            <!-- Unread lines (after readEndIndex) -->
            {#each messages.slice(readStartIndex) as message, i (lineKeys[readStartIndex + i]!)}
              <BufferLineRow
                {message}
                index={readStartIndex + i}
                {messages}
                {noembed}
                onMention={handleMention}
              />
            {/each}<!---->
          {:else}
            <!-- All lines visible (no readmarker needed) -->
            {#each messages as message, i (lineKeys[i]!)}
              <BufferLineRow
                {message}
                index={i}
                {messages}
                {noembed}
                onMention={handleMention}
              />
            {/each}<!---->
            {#if showEndMarker}
              <tr class="readmarker" data-testid="readmarker">
                <td colspan="3">
                  <div class="readmarker-container">
                    <div class="readmarker-line"></div>
                    {#if unreadCount > 0}<span class="readmarker-badge">{unreadCount} new</span>{/if}
                    <div class="readmarker-line"></div>
                  </div>
                </td>
              </tr>
            {/if}
          {/if}<!---->
        </tbody>
      </table>
    {/if}<!---->
    <span data-end-of-buffer></span>
  </div>

</div>

<TopicModal
  topic={current?.title || []}
  bufferName={current?.shortName || current?.fullName || ''}
/>

<style>
  table,
  .chat-table {
    width: 100%;
    border-collapse: collapse;
    white-space-collapse: collapse;
  }

  tbody,
  .chat-tbody {
    white-space-collapse: collapse;
  }

  @media (max-width: 640px) {
    table,
    .chat-table {
      border-collapse: separate;
      border-spacing: 2px 3px;
    }

    /* Ensure tbody spans full table width so flex-based bufferlines align left */
    tbody,
    .chat-tbody {
      display: block;
      width: 100%;
    }

    /* Readmarker in table mode: make row + cell block-level so they span full table width */
    .readmarker,
    .readmarker td {
      display: block;
      width: 100%;
    }

    .readmarker td {
      padding-block: var(--spacing-line-padding-y, 8px);
    }

    /* Readmarker container: fill available width with badge centered */
    .readmarker .readmarker-container {
      width: 100%;
    }

    /* Readmarker in bubble mode: break out of parent's horizontal padding */
    .readmarker:not(tr) {
      margin-inline: -18px;
      padding: 8px 0;
    }

    .readmarker:not(tr) .readmarker-container {
      width: 100%;
    }
  }

  .fetchmore-row td {
    text-align: center;
    padding: 4px 0;
  }

   .loading-spinner {
    color: var(--gb-text-muted, #888);
    font-size: 0.85em;
  }

  .loading-spinner.hidden {
    display: none;
  }

  .readmarker td {
    padding-block: var(--spacing-line-padding-y, 8px);
  }

  .readmarker {
    height: auto;
  }

  /* Chat messages container bottom padding (gap between last line and input bar) */
  .chat-messages {
    padding-bottom: var(--spacing-chat-container-padding-bottom, 4px);
  }

  .readmarker-container {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    position: relative;
  }

  .readmarker-line {
    flex: 1;
    min-width: 20px;
    height: 1px;
    background: linear-gradient(to right, transparent, var(--gb-ribbon, #f0ad4e), var(--gb-ribbon, #f0ad4e), transparent);
    opacity: 0.6;
  }

  .readmarker-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 2px 10px;
    border-radius: 9999px;
    background-color: var(--gb-ribbon-light, rgba(240, 173, 78, 0.15));
    border: 1px solid var(--gb-ribbon, #f0ad4e);
    color: var(--gb-ribbon, #f0ad4e);
    font-size: 11px;
    font-weight: 600;
    white-space: nowrap;
    letter-spacing: 0.02em;
  }

  /* Bubble mode layout styles — overridable by themes via --spacing-* vars */
  .chat-bubble-container {
    display: flex;
    flex-direction: column;
    padding: var(--spacing-bubble-container-padding, 10px 14px);
    gap: var(--spacing-bubble-gap, 2px);
  }

  .bubble-fetchmore-row {
    text-align: center;
    padding: 6px 0;
  }

  /* Readmarker in bubble mode (div-based instead of table tr/td) */
  .readmarker:not(.readmarker td):not(tr) {
    padding: 8px 0;
  }

  .readmarker:not(tr) .readmarker-container {
    max-width: 100%;
  }

</style>
