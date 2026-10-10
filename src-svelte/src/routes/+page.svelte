<script lang="ts">
  import '../app.css';
  import type { BufferData } from '#lib/types.ts';
  import ConnectionForm from '#components/ConnectionForm.svelte';
  import ConnectionBanner from '#components/ConnectionBanner.svelte';
  import TopBar from '#components/TopBar.svelte';
  import ChatView from '#components/ChatView.svelte';
  import InputBar from '#components/InputBar.svelte';
  import BufferList from '#components/BufferList.svelte';
  import Nicklist from '#components/Nicklist.svelte';
  import Toast from '#components/Toast.svelte';
  import ContentSearchModal from '#components/ContentSearchModal.svelte';
  import X from '@lucide/svelte/icons/x';
  import { settings, updateSettings, applyHashParams } from '#lib/stores/settings.ts';
  import { initTheme } from '#lib/stores/theme.ts';
  import { get } from 'svelte/store';
  import { connected, buffers, currentBuffer, activeBufferId, activeBufferChanged, clearAllUnread, previousBufferId, wconfig, sortedVisibleBuffers, checkAndNavigatePendingNotificationBuffer } from '#lib/stores/models.ts';
  import { sidebarOrder } from '#lib/stores/bufferProjections.ts';
  import { connectionState, setReconnectAttempts, setNextReconnectAt, setErrors } from '#lib/stores/connectionStore.ts';
  import { connect, fetchMoreLines, sendWeeChatCommand, disconnect, requestNicklist, switchBuffer, listScripts, getSession, getWs, initFocusReconnect, cleanupFocusReconnect, setHotlistPollInterval } from '#lib/stores/connectionManager.ts';
  import { connectionBanner } from '#lib/stores/connectionPresentation.ts';
  import { initNotifications, onDisconnect, refreshIndicators, startIndicatorOwner } from '#lib/notifications.ts';
  import { parseRelayUrl, isPopoverOpen, bufferHasNicklist, modifyTextareaValue, captureBufferAppearance, waitForFreshBuffer, scriptInstalled } from '#lib/utils.ts';
  import { addToast, toastStore } from '#lib/toast.ts';
  import { showWindow } from '#lib/tauriWindow.ts';
  import { setChatScrollCommands } from '#lib/chatScrollContext.ts';
  import type { ChatScrollCommands, ChatScrollCommandsHolder } from '#lib/chatViewport.ts';

  // One holder for this page instance, shared with the composer through context.
  // ChatView fills it while mounted and clears it on unmount. Plain object on
  // purpose: mounting and unmounting the chat view must not re-run page effects.
  const chatScrollCommands: ChatScrollCommandsHolder = { current: null };
  setChatScrollCommands(chatScrollCommands);

  /* eslint-disable @typescript-eslint/no-explicit-any -- dev-time debug globals on window */
  if (typeof window !== 'undefined' && import.meta.env.DEV) {
    (window as any).__wconfig = wconfig;
    (window as any).__connected = connected;
    (window as any).__connectionState = connectionState;
    (window as any).__sendWeechatCommand = sendWeeChatCommand;
    (window as any).__setGbSettings = updateSettings;
    (window as any).__setHotlistPollInterval = setHotlistPollInterval;
    (window as any).__setReconnectAttempts = setReconnectAttempts;
    (window as any).__setNextReconnectAt = setNextReconnectAt;
    (window as any).__getSession = getSession;
    (window as any).__getWs = getWs;
    (window as any).__hideBufferListOnMobile = hideBufferListOnMobile;
    (window as any).__showBufferListOnMobile = showBufferListOnMobile;
    (window as any).__addToast = addToast;
    (window as any).__toastStore = toastStore;
    (window as any).__setConnectionErrors = setErrors;
    $effect(() => {
      (window as any).__wconfig = $wconfig;
      (window as any).__connected = $connected;
      (window as any).__connectionState = $connectionState;
    });
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */



  async function tryAutoConnect() {
    const s = get(settings);
    if (!s.autoconnect || !s.savepassword || !s.hostField || !s.password) {
      return;
    }
    try {
      const { host: parsedHost, port: parsedPort, path: parsedPath } = parseRelayUrl(s.hostField, s.port);
      await connect(parsedHost, parsedPort, parsedPath, s.password, s.tls, false);
    } catch (e) {
      console.warn('Auto-connect failed:', e);
    }
  }

  // Apply hash params synchronously before any component effects run
  applyHashParams();

  $effect(() => {
    // Initialize theme, notifications, touch gestures, and attempt auto-connect on mount
    initTheme();
    void initNotifications();
    initTouchGestures();
    initFocusReconnect();
    void tryAutoConnect();
    checkAndNavigatePendingNotificationBuffer();
    document.body.setAttribute('data-app-ready', 'true');
    void showWindow();

    // Re-apply hash params when URL fragment changes (e.g. user modifies bookmark)
    window.onhashchange = () => {
      applyHashParams();
    };

    return () => {
      cleanupTouchGestures();
      cleanupFocusReconnect();
      onDisconnect();
      window.onhashchange = null;
    };
  });

  $effect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if ($connected) {
        e.preventDefault();
        (e as BeforeUnloadEvent).returnValue = '';
      }
    };

    document.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      document.removeEventListener('beforeunload', handleBeforeUnload);
    };
  });

  // One lifecycle-owned owner for the title and the badge. Transports publish
  // state and never touch an indicator, so an unchanged hotlist poll that
  // re-references every background buffer writes neither.
  $effect(() => {
    const stop = startIndicatorOwner();
    return stop;
  });

  $effect(() => {
    document.documentElement.style.setProperty('--font-mono', $settings.fontfamily || 'Fira Mono, Consolas, Monaco, Courier New, monospace');
    document.documentElement.style.setProperty('--font-size', $settings.fontsize || '14px');
    document.body.style.fontSize = $settings.fontsize || '14px';
  });

  // Appearance is an explicit invalidation: a theme or custom-CSS change can
  // alter the badge palette without changing any count, and a store that
  // compares values cannot see that the picture it produced is now different.
  $effect(() => {
    void $settings.theme;
    void $settings.customCSS;
    void $settings.useFavico;
    refreshIndicators();
  });

  $effect(() => {
    const css = $settings.customCSS;
    const oldTag = document.getElementById('custom-css-tag');
    if (oldTag) {
      oldTag.parentNode?.removeChild(oldTag);
    }
    if (css && css.trim()) {
      const newTag = document.createElement('style');
      newTag.id = 'custom-css-tag';
      newTag.type = 'text/css';
      newTag.appendChild(document.createTextNode(css));
      document.head.appendChild(newTag);
    }
  });

  // Control page scrolling: scrollable on the front page, locked whenever the
  // shell is on screen. Keyed on the shell, not on $connected, so a retained
  // view keeps the layout it had — a locked, non-scrolling document with an
  // internally scrolling chat, exactly as when live.
  $effect(() => {
    void $connectionBanner.shellVisible;
    const overflow = $connectionBanner.shellVisible ? 'hidden' : 'auto';
    document.documentElement.style.overflow = overflow;
    document.body.style.overflow = overflow;
  });

  $effect(() => {
    void $activeBufferChanged;
    void $connected;
    if (!$connected) return;
    const buf = $currentBuffer;
    if (!buf) return;
    // `lines.length === 0` keeps advancing the window (each fetch doubles the
    // raw-line count) while a buffer renders empty: WeeChat counts the newest-N
    // history window over RAW lines, so a join/part-heavy channel can return N
    // smart-filtered lines and zero visible ones. Paging continues until visible
    // lines appear or the server reaches history start (allLinesFetched).
    if ((buf.requestedLines < 100 || buf.lines.length === 0) && !buf.allLinesFetched) {
      void (async () => {
        try {
          await fetchMoreLines(100);
        } catch (err) {
          console.error('[+page] fetchMoreLines failed:', err);
        // Silently ignore fetch failures on buffer switch
        }
      })();
    }
    // Deltas can create a partial 'root' group before the buffer is first
    // opened (the API streams no initial nicklist state), so the gate is the
    // authoritative-snapshot flag, not group presence.
    if (!buf.nicklistFetched) {
      requestNicklist(buf.id);
    }
  });

  $effect(() => {
    if ($settings.enableMathjax) {
      const linkId = 'katex-css';
      if (!document.getElementById(linkId)) {
        const link = document.createElement('link');
        link.id = linkId;
        link.rel = 'stylesheet';
        link.href = 'https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.5.1/katex.min.css';
        document.head.appendChild(link);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- KaTeX global on window
      if (typeof (window as any).renderMathInElement === 'undefined') {
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.5.1/katex.min.js';
        script.onload = () => {
          const autoRender = document.createElement('script');
          autoRender.src = 'https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.5.1/contrib/auto-render.min.js';
          document.body.appendChild(autoRender);
        };
        document.body.appendChild(script);
      }
    }
  });

  function handleQuickKeys(e: KeyboardEvent) {
    // Skip when focus is in an input field so Alt-combinations like Alt+7 (pipe on Norwegian layout) work for typing
    const activeEl = document.activeElement;
    const tag = activeEl?.tagName || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if ((activeEl as HTMLElement)?.isContentEditable) return;

    // Use get() to avoid $effect dependency on $settings/$sortedVisibleBuffers (prevents listener re-registration)
    const s = get(settings);
    if (e.altKey && !e.ctrlKey && !e.shiftKey && s.enableQuickKeys) {
      // Use e.code to extract digit — this works on all keyboard layouts
      const digitMatch = e.code.match(/^Digit(\d)$/);
      if (digitMatch) {
        let digitStr = digitMatch[1];
        if (!digitStr) return;
        const digit = parseInt(digitStr, 10);
        const index = digit === 0 ? 9 : digit - 1;
        e.preventDefault();
        if (!$connected) {
          addToast('Cannot switch buffers — not connected', { type: 'warning', duration: 3000 });
          return;
        }
        const sorted = get(sortedVisibleBuffers) as BufferData[];
        if (index < sorted.length) {
          const buf = sorted[index];
          if (buf) switchBuffer(buf.id);
        }
      }
    }
  }

  // Two-step buffer jump: Alt+J arms the mode, the first digit is the tens place,
  // the second digit switches to that buffer number, any other key aborts.
  let _jumpArmed = $state(false);
  let _jumpTens: number | null = $state(null);
  function handleJumpToBuffer(e: KeyboardEvent) {
    // Skip when focus is in an input field so user can type normally
    const activeEl = document.activeElement;
    const tag = activeEl?.tagName || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if ((activeEl as HTMLElement)?.isContentEditable) return;
    const code = e.keyCode || e.which;
    const digit = code - 48;
    // Alt+J -> arm jump mode (tens place reset)
    if (e.altKey && !e.ctrlKey && !e.shiftKey && code === 74) {
      e.preventDefault();
      _jumpArmed = true;
      _jumpTens = null;
      return;
    }
    if (!_jumpArmed) return;
    // Digits while armed: first is tens, second completes the buffer number
    if (digit >= 0 && digit <= 9 && !e.altKey && !e.ctrlKey && !e.shiftKey) {
      e.preventDefault();
      if (_jumpTens === null) {
        _jumpTens = digit;
        return;
      }
      const targetNum = _jumpTens * 10 + digit;
      _jumpArmed = false;
      _jumpTens = null;
      const sorted = get(sortedVisibleBuffers) as BufferData[];
      const targetIdx = targetNum - 1;
      if (targetIdx >= 0 && targetIdx < sorted.length) {
        const targetBuf = sorted[targetIdx];
        if (targetBuf) switchBuffer(targetBuf.id);
      }
      return;
    }
    // Any other key while armed -> abort
    _jumpArmed = false;
    _jumpTens = null;
  }

  let lastEscapeTime = 0;

  function handleGlobalKeyboard(e: KeyboardEvent) {
    // Escape handling first — always processes regardless of focused element
    // (blurs input on single tap, disconnects on double tap)
    if (e.code === 'Escape') {
      // Always blur the input so subsequent Alt shortcuts (e.g. Alt+1 quick key) work
      const input = document.querySelector<HTMLTextAreaElement>('[data-testid="message-input"]');
      if (document.activeElement === input) {
        input?.blur();
      }
      const now = Date.now();
      if (now - lastEscapeTime <= 500) {
        // Only disconnect if actually connected — prevents no-op on stale connections
        if (get(connected)) {
          disconnect();
        }
      }
      lastEscapeTime = now;
      return;
    }

    const code = e.keyCode || e.which;

    // PageUp/PageDown -> scroll chat (skip when focus is in an input field)
    if (!e.ctrlKey && !e.altKey && !e.shiftKey && (code === 33 || code === 34)) {
      // Don't scroll chat when user is typing in the input bar
      const activeEl = document.activeElement;
      const tag = activeEl?.tagName || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if ((activeEl as HTMLElement)?.isContentEditable) return;
      e.preventDefault();
      // The chat view decides the step and owns the write; a reader who just
      // navigated by wheel or touch keeps the position they chose.
      chatScrollCommands.current?.pageScroll(code === 33 ? -1 : 1);
      return;
    }

    // Alt+< -> previous buffer
    if (e.altKey && (e.code === 'Backquote' || e.code === 'IntlBackslash' || code === 60 || code === 226)) {
      e.preventDefault();
      const prevId = get(previousBufferId);
      if (prevId) switchBuffer(prevId);
      return;
    }

    // Alt+L -> focus input bar
    if (e.altKey && (code === 76 || code === 108)) {
      e.preventDefault();
      const input = document.querySelector<HTMLTextAreaElement>('[data-testid="message-input"]');
      input?.focus();
      return;
    }

    // Alt+n -> toggle nicklist
    if (e.altKey && !e.ctrlKey && code === 78) {
      e.preventDefault();
      const s = get(settings);
      updateSettings({ showNicklist: !s.showNicklist });
      return;
    }

    // Alt+A -> switch to most urgent buffer (notifications > unreads, sorted by number)
    // Matches AngularJS behavior: always scans from the beginning of the buffer list.
    // Repeated presses naturally advance because switching clears that buffer's counts.
    if (e.altKey && (code === 97 || code === 65) && !e.ctrlKey) {
      e.preventDefault();
      const allBuffers = Object.values(get(buffers)) as BufferData[];
      const sortedByNumber = allBuffers
        .filter((b: BufferData) => !b.hidden)
        .sort((a: BufferData, b: BufferData) => a.number - b.number);

      // First pass: find first buffer with notifications (highlights/mentions)
      for (const buf of sortedByNumber) {
        if (buf.notification > 0) {
          switchBuffer(buf.id);
          return;
        }
      }

      // Second pass: find first buffer with unread lines
      for (const buf of sortedByNumber) {
        if (buf.unread > 0) {
          switchBuffer(buf.id);
          return;
        }
      }
    }

    // Alt+Arrow up/down -> switch to adjacent buffer
    if (e.altKey && !e.ctrlKey && (code === 38 || code === 40)) {
      e.preventDefault();
      const visible = get(sortedVisibleBuffers) as BufferData[];
      const curId = get(activeBufferId);
      const curIdx = visible.findIndex((b: BufferData) => b.id === curId);
      if (curIdx === -1) return;
      const dir = code === 38 ? -1 : 1;
      const target = curIdx + dir;
      if (target >= 0 && target < visible.length) {
        const targetBuf = visible[target];
        if (targetBuf) switchBuffer(targetBuf.id);
      }
      return;
    }

    // Alt+h -> clear all unread
    if (e.altKey && !e.ctrlKey && code === 72) {
      e.preventDefault();
      clearAllUnread();
      sendWeeChatCommand('/input hotlist_clear');
      return;
    }

    // Alt/Ctrl+G -> focus buffer search
    if ((e.altKey || e.ctrlKey) && (code === 71 || code === 103)) {
      e.preventDefault();
      toggleBufferSearchGlobal();
      return;
    }

    // Ctrl+F -> content search
    if (e.ctrlKey && (code === 70 || code === 102)) {
      e.preventDefault();
      openContentSearch();
      return;
    }
  }

  function handleGlobalKeyDown(e: KeyboardEvent) {
    handleGlobalKeyboard(e);
    // Use get() to avoid $effect dependency on $settings (prevents listener re-registration)
    const s = get(settings);
    if ((e.code === 'AltLeft' || e.code === 'AltRight') && s.enableQuickKeys && !s.showQuickKeys) {
      updateSettings({ showQuickKeys: true });
    }
  }

  function handleGlobalKeyUp(e: KeyboardEvent) {
    // Use get() to avoid $effect dependency on $settings (prevents listener re-registration)
    const s = get(settings);
    if (e.code === 'AltLeft' || e.code === 'AltRight') {
      if (s.showQuickKeys) {
        updateSettings({ showQuickKeys: false });
      }
    }
  }

  function toggleBufferSearchGlobal() {
    showBufferListOnMobile();
    const modal = document.getElementById('buffer-search-modal');
    modal?.showPopover();
  }

  function openContentSearch() {
    showBufferListOnMobile();
    const modal = document.getElementById('content-search-modal');
    modal?.showPopover();
  }

  // WeeChat's grep result buffer (fullName: 'python.grep', shortName: 'grep').
  const GREP_BUFFER = 'grep';

  async function executeContentSearch(query: string) {
    const bufId = get(activeBufferId);
    // The result buffer is reused across searches, so snapshot it first: an
    // existing buffer only counts as a result once it was cleared or changed.
    const before = captureBufferAppearance(GREP_BUFFER);
    sendWeeChatCommand(`/grep ${query}`, bufId);
    // Wait for the buffer to open or change instead of sleeping a fixed second.
    const freshId = await waitForFreshBuffer(GREP_BUFFER, before, 3000);
    if (freshId !== null) {
      await switchBuffer(freshId);
      return;
    }
    // Nothing changed within the wait: either the script is missing or WeeChat
    // rejected the command. Only blame the script when the listing proves it.
    const scripts = await listScripts();
    if (scriptInstalled(scripts, 'grep') === false) {
      addToast('The /grep script is not installed', { type: 'info', duration: 4000 });
    } else {
      addToast('No results found', { type: 'info', duration: 2000 });
    }
  }

  let _altKeyPressed = $state(false);

  function handleAltKeyDown(e: KeyboardEvent) {
    if (e.key === 'Alt' || e.key === 'AltRight' || e.key === 'AltLeft') {
      _altKeyPressed = true;
    }
  }

  function handleAltKeyUp() {
    _altKeyPressed = false;
  }

  function handleTypeToFocus(e: KeyboardEvent) {
    if (typeof window === 'undefined') return;
    if (window.innerWidth < 768) return;
    if (!get(currentBuffer)) return;
    if (e.key.length !== 1) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const activeEl = document.activeElement;
    const tag = activeEl?.tagName || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if ((activeEl as HTMLElement)?.isContentEditable) return;
    if (isPopoverOpen()) return;
    const input = document.querySelector<HTMLTextAreaElement>('[data-testid="message-input"]');
    if (!input) return;
    e.preventDefault();
    input.focus();
    modifyTextareaValue('[data-testid="message-input"]', (value: string, start: number, end: number) => ({
      value: value.substring(0, start) + e.key + value.substring(end),
      cursor: start + 1,
    }));
  }

  // Register keyboard event listeners once on mount — no reactive dependencies to avoid listener tear-down/re-add cycles
  $effect(() => {
    if (typeof window !== 'undefined') {
      document.addEventListener('keydown', handleQuickKeys);
      document.addEventListener('keydown', handleJumpToBuffer);
      document.addEventListener('keydown', handleGlobalKeyDown);
      document.addEventListener('keyup', handleGlobalKeyUp);
      document.addEventListener('keydown', handleAltKeyDown);
      document.addEventListener('keyup', handleAltKeyUp);
      document.addEventListener('keydown', handleTypeToFocus);
    }

    return () => {
      if (typeof window !== 'undefined') {
        document.removeEventListener('keydown', handleQuickKeys);
        document.removeEventListener('keydown', handleJumpToBuffer);
        document.removeEventListener('keydown', handleGlobalKeyDown);
        document.removeEventListener('keyup', handleGlobalKeyUp);
        document.removeEventListener('keydown', handleAltKeyDown);
        document.removeEventListener('keyup', handleAltKeyUp);
        document.removeEventListener('keydown', handleTypeToFocus);
      }
    };
  });

  // The banner's Edit connection reveals the form over a retained chat. This is a
  // presentation mode only: it does not touch transport state, and the retained
  // snapshot survives it, so backing out restores the same view.
  let editingConnection = $state(false);

  // The mode ends on either side of it: a released snapshot means there is no
  // chat to come back to and the form is the whole screen, while a live
  // connection means the edit achieved its purpose and the form has nothing left
  // to do. Without the second half, a successful Connect would leave the form
  // covering the chat it just restored.
  $effect(() => {
    if (!$connectionBanner.shellVisible || $connected) editingConnection = false;
  });

  // Hidden by default on mobile — shown via swipe-right or menu button.
  // Always visible on desktop regardless of this flag.
  let showBufferList = $state(false);
  let nicklistOpenOnMobile = $state(false);
  // Reactive mobile state — updated via resize listener so Svelte re-renders
  // when viewport crosses the 768px threshold. Without this, isMobile() reads
  // stale window.innerWidth that Svelte doesn't track.
  let isMobileState = $state(typeof window !== 'undefined' && window.innerWidth < 768);
  // Whether current buffer has nick data to display (used for auto-hiding nicklist)
  let hasCurrentBufferNicklist = $derived(bufferHasNicklist($currentBuffer));
  let touchStartX = 0;
  let touchStartY = 0;
  let touchStartTime = 0;
  let touchStartTarget: HTMLElement | null = null;
  // Whether touch gesture originated inside the mobile nicklist overlay
  let touchStartedInNicklist = $state(false);

  // Resize listener keeps isMobileState in sync with actual viewport size.
  // This ensures {#if} blocks and touch gesture guards react correctly when
  // the viewport crosses the mobile/desktop boundary.
  $effect(() => {
    function onResize() {
      const prev = isMobileState;
      isMobileState = typeof window !== 'undefined' && window.innerWidth < 768;
      // When transitioning from mobile to desktop, close mobile overlays.
      if (prev && !isMobileState) {
        showBufferList = false;
        nicklistOpenOnMobile = false;
      }
      // When transitioning from desktop to mobile, show buffer list so
      // users can select a buffer. Reset nicklist overlay.
      if (!prev && isMobileState) {
        showBufferList = true;
        nicklistOpenOnMobile = false;
      }
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  });

  // Hide buffer list on mobile; also close nicklist overlay since overlays are mutually exclusive.
  function hideBufferListOnMobile() {
    if (isMobileState) { showBufferList = false; nicklistOpenOnMobile = false; }
  }

  // Show buffer list on mobile; close nicklist overlay since overlays are mutually exclusive.
  function showBufferListOnMobile() {
    if (isMobileState) { showBufferList = true; nicklistOpenOnMobile = false; }
  }

  function isMobile() {
    return isMobileState;
  }

  function initTouchGestures() {
    document.addEventListener('touchstart', handleTouchStart, { passive: true });
    document.addEventListener('touchmove', handleTouchMove, { passive: true });
    document.addEventListener('touchend', handleTouchEnd, { passive: true });
  }

  function cleanupTouchGestures() {
    if (typeof document === 'undefined') return;
    document.removeEventListener('touchstart', handleTouchStart);
    document.removeEventListener('touchmove', handleTouchMove);
    document.removeEventListener('touchend', handleTouchEnd);
  }

  function handleTouchStart(e: TouchEvent) {
    if (!isMobile()) return;
    const firstTouch = e.touches[0];
    if (!firstTouch) return;
    touchStartX = firstTouch.clientX;
    touchStartY = firstTouch.clientY;
    touchStartTime = Date.now();
    touchStartTarget = e.target as HTMLElement | null;
    // Track if touch originated inside the mobile nicklist overlay
    touchStartedInNicklist = touchStartTarget instanceof Element && !!touchStartTarget.closest('.mobile-nicklist-overlay');
  }

  function handleTouchMove(e: TouchEvent) {
    if (!isMobile()) return;
    const firstTouch = e.touches[0];
    if (!firstTouch) return;
    const deltaX = Math.abs(firstTouch.clientX - touchStartX);
    const deltaY = Math.abs(firstTouch.clientY - touchStartY);
    if (deltaX > deltaY && deltaX > 10) {
      e.preventDefault();
    }
  }

  function handleTouchEnd(e: TouchEvent) {
    if (!isMobile()) return;
    const firstTouch = e.changedTouches[0];
    if (!firstTouch) return;
    const touchEndX = firstTouch.clientX;
    const touchEndY = firstTouch.clientY;
    const deltaX = touchEndX - touchStartX;
    const deltaY = touchEndY - touchStartY;
    const deltaTime = Date.now() - touchStartTime;

    if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 50 && deltaTime < 500) {
      // Swipe right -> show buffer list, close nicklist (overlays are mutually exclusive)
      if (deltaX > 0) {
        if (touchStartedInNicklist && nicklistOpenOnMobile) {
          // Swipe right on nicklist overlay -> close it and show buffer list
          nicklistOpenOnMobile = false;
          showBufferList = true;
        } else {
          // Swipe right from chat/buffer area -> show buffer list, close nicklist
          showBufferList = true;
          nicklistOpenOnMobile = false;
        }
      }
      // Swipe left -> check if from right edge (nicklist) or general (buffer list)
      else {
        const rightEdgeThreshold = 80;
        // If touching the nicklist panel while open -> close it directly
        if (nicklistOpenOnMobile && touchStartedInNicklist) {
          nicklistOpenOnMobile = false;
        }
        // Swipe from right edge -> open nicklist and close buffer list
        else if (touchStartX > window.innerWidth - rightEdgeThreshold && !nicklistOpenOnMobile && (hasCurrentBufferNicklist || $settings.alwaysnicklist)) {
          nicklistOpenOnMobile = true;
          showBufferList = false;
        } else if (nicklistOpenOnMobile) {
          // Swipe left on nicklist from non-right-edge -> close it
          nicklistOpenOnMobile = false;
        } else {
          // General swipe left -> close buffer list
          showBufferList = false;
        }
      }
    }

    if (Math.abs(deltaY) > Math.abs(deltaX) && Math.abs(deltaY) > 80 && deltaTime < 500) {
      // Skip vertical swipe buffer-switching when touch originated inside the chat scroll area.
      // This prevents accidental buffer switches while scrolling through messages on mobile.
      const chatContainer = document.querySelector('[data-testid="chat-messages"]');
      if (chatContainer && touchStartTarget && chatContainer.contains(touchStartTarget)) {
        return;
      }
      // `sidebarOrder` is the same ordering `sortedVisibleBuffers` produced, but
      // memoized on structure: reading it here used to keep a component-lifetime
      // subscription to a full filter+sort that re-ran on every buffer
      // publication, including message-only traffic that cannot reorder
      // anything. Reading with get() inside a swipe handler adds no dependency.
      const order = get(sidebarOrder);
      const currentBuf = get(currentBuffer);
      const currentIndex = currentBuf ? order.indexOf(currentBuf.id) : -1;

      if (currentIndex !== -1) {
        if (deltaY < 0 && currentIndex < order.length - 1) {
          const prevId = order[currentIndex - 1];
          if (prevId) switchBuffer(prevId);
        } else if (deltaY > 0 && currentIndex > 0) {
          const nextId = order[currentIndex + 1];
          if (nextId) switchBuffer(nextId);
        }
      }
    }

    // Reset nicklist touch tracking for next gesture
    touchStartedInNicklist = false;
  }

</script>

{#if !$connectionBanner.shellVisible || editingConnection}
  <ConnectionForm onBack={editingConnection ? () => { editingConnection = false; } : undefined} />
{:else}
  <div class="main-layout h-dvh flex flex-col bg-bg" data-testid="chat-view">
    <TopBar bufferListVisible={showBufferList || !isMobileState} onBufferSelect={hideBufferListOnMobile} onSearchOpen={showBufferListOnMobile} onNicklistToggle={() => { if (isMobile()) { nicklistOpenOnMobile = !nicklistOpenOnMobile; if (nicklistOpenOnMobile) showBufferList = false; } else updateSettings({ showNicklist: !$settings.showNicklist }); }} />
    <div class="main-content flex-1 flex overflow-hidden">
      {#if showBufferList || !isMobileState}
        <BufferList altKeyPressed={_altKeyPressed} onBufferSelect={hideBufferListOnMobile} />
      {/if}
      <div class="chat-area flex-1 flex flex-col min-w-0">
        <ConnectionBanner onEditConnection={() => { editingConnection = true; }} onLeave={() => { editingConnection = false; disconnect(); }} />
        <ChatView onCommands={(commands: ChatScrollCommands | null) => { chatScrollCommands.current = commands; }} />
        <InputBar />
      </div>
      {#if $settings.showNicklist && !isMobileState && hasCurrentBufferNicklist}
        <Nicklist />
      {/if}
      <!-- Desktop nicklist rendered inline -->
      {#if isMobileState && (hasCurrentBufferNicklist || $settings.alwaysnicklist)}
        <div class="mobile-nicklist-overlay fixed top-0 right-0 bottom-0 h-screen w-52 sm:w-28 lg:w-30 z-50 transition-transform duration-200 ease-out {nicklistOpenOnMobile ? 'translate-x-0' : 'translate-x-full'}">
          <button
            onclick={() => { nicklistOpenOnMobile = false; }}
            data-testid="nicklist-close-button"
            class="mobile-nicklist-close absolute top-1 left-2 z-10 px-2 py-1 text-sm text-text-secondary hover:text-white hover:bg-surface-raised rounded"
            title="Close nicklist"
          >
            <X size={16} />
          </button>
          <div class="mobile-nicklist-container h-full bg-panel border-l border-border flex flex-col overflow-hidden">
            <Nicklist forceShow={true} onClose={() => { nicklistOpenOnMobile = false; }} />
          </div>
        </div>
      {/if}
    </div>
  </div>
{/if}

<Toast />

<ContentSearchModal onSearch={executeContentSearch} />
