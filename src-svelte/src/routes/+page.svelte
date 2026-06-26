<script lang="ts">
  import '../app.css';
  import type { BufferData } from '$lib/types';
  import ConnectionForm from '$components/ConnectionForm.svelte';
  import TopBar from '$components/TopBar.svelte';
  import ChatView from '$components/ChatView.svelte';
  import InputBar from '$components/InputBar.svelte';
  import BufferList from '$components/BufferList.svelte';
  import Nicklist from '$components/Nicklist.svelte';
  import Toast from '$components/Toast.svelte';
  import X from '@lucide/svelte/icons/x';
  import { settings, updateSettings, applyHashParams } from '$lib/stores/settings';
  import { initTheme } from '$lib/stores/theme';
  import { get } from 'svelte/store';
  import { connected, buffers, currentBuffer, activeBufferId, activeBufferChanged, clearAllUnread, previousBufferId, wconfig, sortedVisibleBuffers, checkAndNavigatePendingNotificationBuffer } from '$lib/stores/models';
  import { connectionState, setReconnectAttempts, setErrors } from '$lib/stores/connectionStore';
  import { connect, fetchMoreLines, sendWeeChatCommand, disconnect, requestNicklist, switchBuffer, getWs } from '$lib/stores/connectionManager';
  import { Protocol } from '$lib/weechat';
  import { initNotifications, updateTitle, updateFavico, onDisconnect } from '$lib/notifications';
  import { parseRelayUrl, isPopoverOpen, bufferHasNicklist, modifyTextareaValue } from '$lib/utils';
  import { addToast, toastStore } from '$lib/toast';

  /* eslint-disable @typescript-eslint/no-explicit-any -- dev-time debug globals on window */
  if (typeof window !== 'undefined' && import.meta.env.DEV) {
    (window as any).__wconfig = wconfig;
    (window as any).__connected = connected;
    (window as any).__connectionState = connectionState;
    (window as any).__sendWeechatCommand = sendWeeChatCommand;
    (window as any).__setGbSettings = updateSettings;
    (window as any).__setReconnectAttempts = setReconnectAttempts;
    (window as any).__Protocol = Protocol;
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
    void tryAutoConnect();
    checkAndNavigatePendingNotificationBuffer();
    document.body.setAttribute('data-app-ready', 'true');

    // Re-apply hash params when URL fragment changes (e.g. user modifies bookmark)
    window.onhashchange = () => {
      applyHashParams();
    };

    return () => {
      cleanupTouchGestures();
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

  $effect(() => {
    void $buffers;
    updateTitle();
    updateFavico();
  });

  $effect(() => {
    document.documentElement.style.setProperty('--font-mono', $settings.fontfamily || 'Fira Mono, Consolas, Monaco, Courier New, monospace');
    document.documentElement.style.setProperty('--font-size', $settings.fontsize || '14px');
    document.body.style.fontSize = $settings.fontsize || '14px';
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

  $effect(() => {
    void $connected;
    const svelteEl = document.getElementById('svelte');
    const overflow = $connected ? 'hidden' : 'auto';
    if (svelteEl) {
      svelteEl.style.overflow = overflow;
    }
    document.body.style.overflow = overflow;
  });

  $effect(() => {
    void $activeBufferChanged;
    void $connected;
    if (!$connected) return;
    const buf = $currentBuffer;
    if (!buf) return;
    if (buf.requestedLines < 100 && !buf.allLinesFetched) {
      void (async () => {
        try {
          await fetchMoreLines(100);
        } catch (err) {
          console.error('[+page] fetchMoreLines failed:', err);
          // Silently ignore fetch failures on buffer switch
        }
      })();
    }
    if (!('root' in (buf.nicklist || {}))) {
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

  let _jumpDecimal: number | null = $state(null);

  function handleJumpToBuffer(e: KeyboardEvent) {
    // Skip when focus is in an input field so user can type normally
    const activeEl = document.activeElement;
    const tag = activeEl?.tagName || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if ((activeEl as HTMLElement)?.isContentEditable) return;

    const code = e.keyCode || e.which;
    const digit = code - 48;

    // Alt+J -> start jump mode
    if (e.altKey && !e.ctrlKey && !e.shiftKey && code === 74) {
      e.preventDefault();
      _jumpDecimal = null;
      return;
    }

    // In jump mode, first digit
    if (_jumpDecimal !== null && digit >= 0 && digit <= 9 && !e.altKey && !e.ctrlKey && !e.shiftKey) {
      e.preventDefault();
      if (_jumpDecimal === null) {
        _jumpDecimal = digit;
      } else {
        // Second digit -> jump to buffer
        const targetNum = _jumpDecimal * 10 + digit;
        const sorted = get(sortedVisibleBuffers) as BufferData[];
        const targetIdx = targetNum - 1;
        if (targetIdx >= 0 && targetIdx < sorted.length) {
          const targetBuf = sorted[targetIdx];
          if (targetBuf) switchBuffer(targetBuf.id);
        }
        _jumpDecimal = null;
      }
      return;
    }

    // Non-digit key while in jump mode -> abort
    if (_jumpDecimal !== null && !(digit >= 0 && digit <= 9)) {
      _jumpDecimal = null;
    }
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
      const chatContainer = document.querySelector<HTMLDivElement>('[data-testid="chat-messages"]');
      if (chatContainer) {
        chatContainer.scrollTop += code === 33
          ? -chatContainer.clientHeight * 0.8
          : chatContainer.clientHeight * 0.8;
      }
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

  let showBufferList = $state(false);
  let nicklistOpenOnMobile = $state(false);
  // Whether current buffer has nick data to display (used for auto-hiding nicklist)
  let hasCurrentBufferNicklist = $derived(bufferHasNicklist($currentBuffer));
  let touchStartX = 0;
  let touchStartY = 0;
  let touchStartTime = 0;
  let touchStartTarget: HTMLElement | null = null;
  // Whether touch gesture originated inside the mobile nicklist overlay
  let touchStartedInNicklist = $state(false);

  function hideBufferListOnMobile() {
    if (isMobile()) showBufferList = false;
  }

  function showBufferListOnMobile() {
    if (isMobile()) showBufferList = true;
  }

  function isMobile() {
    return typeof window !== 'undefined' && window.innerWidth < 768;
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
    touchStartedInNicklist = !!touchStartTarget?.closest('.mobile-nicklist-overlay');
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
      // Swipe right -> show buffer list (skip if touch started on nicklist overlay)
      if (deltaX > 0) {
        if (touchStartedInNicklist && nicklistOpenOnMobile) {
          // Swipe right on nicklist -> close it, do NOT trigger buffer list
          nicklistOpenOnMobile = false;
        } else {
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
        // Only open nicklist on swipe if buffer has nicks or alwaysnicklist is set
        else if (touchStartX > window.innerWidth - rightEdgeThreshold && !nicklistOpenOnMobile && (hasCurrentBufferNicklist || $settings.alwaysnicklist)) {
          nicklistOpenOnMobile = true;
          showBufferList = false;
        } else if (nicklistOpenOnMobile) {
          nicklistOpenOnMobile = false;
        } else {
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
      const sortedBuffs = $sortedVisibleBuffers;
      const currentBuf = $currentBuffer;
      const currentIndex = sortedBuffs.findIndex(b => b.id === currentBuf?.id);

      if (currentIndex !== -1) {
        if (deltaY < 0 && currentIndex < sortedBuffs.length - 1) {
          const prev = sortedBuffs[currentIndex - 1];
          if (prev) switchBuffer(prev.id);
        } else if (deltaY > 0 && currentIndex > 0) {
          const next = sortedBuffs[currentIndex + 1];
          if (next) switchBuffer(next.id);
        }
      }
    }

    // Reset nicklist touch tracking for next gesture
    touchStartedInNicklist = false;
  }

</script>

{#if !$connected}
  <ConnectionForm />
{:else}
  <div class="main-layout h-dvh flex flex-col bg-bg" data-testid="chat-view">
    <TopBar bufferListVisible={showBufferList || !isMobile()} onBufferSelect={hideBufferListOnMobile} onSearchOpen={showBufferListOnMobile} onNicklistToggle={() => { if (isMobile()) nicklistOpenOnMobile = !nicklistOpenOnMobile; else updateSettings({ showNicklist: !$settings.showNicklist }); }} />
    <div class="main-content flex-1 flex overflow-hidden">
      {#if showBufferList || !isMobile()}
        <BufferList altKeyPressed={_altKeyPressed} onBufferSelect={hideBufferListOnMobile} />
      {/if}
      <div class="chat-area flex-1 flex flex-col min-w-0">
        <ChatView />
        <InputBar />
      </div>
      {#if $settings.showNicklist && !isMobile() && hasCurrentBufferNicklist}
        <Nicklist />
      {/if}
      <!-- Desktop nicklist rendered inline -->
      {#if isMobile() && (hasCurrentBufferNicklist || $settings.alwaysnicklist)}
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
            <Nicklist onClose={() => { nicklistOpenOnMobile = false; }} />
          </div>
        </div>
      {/if}
    </div>
  </div>
{/if}

<Toast />
