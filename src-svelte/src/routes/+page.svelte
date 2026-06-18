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
  import { settings, updateSettings } from '$lib/stores/settings';
  import { initTheme } from '$lib/stores/theme';
  import { get } from 'svelte/store';
  import { connected, buffers, currentBuffer, activeBufferId, activeBufferChanged, clearAllUnread, previousBufferId, wconfig } from '$lib/stores/models';
  import { connect, fetchMoreLines, sendWeeChatCommand, disconnect, requestNicklist, switchBuffer } from '$lib/stores/connectionManager';
  import { Protocol } from '$lib/weechat';
  import { initNotifications, updateTitle, updateFavico, onDisconnect } from '$lib/notifications';
  import { sortBuffers, parseRelayUrl, isPopoverOpen } from '$lib/utils';

  /* eslint-disable @typescript-eslint/no-explicit-any -- dev-time debug globals on window */
  if (typeof window !== 'undefined' && import.meta.env.DEV) {
    (window as any).__wconfig = wconfig;
    (window as any).__connected = connected;
    (window as any).__sendWeechatCommand = sendWeeChatCommand;
    (window as any).__setGbSettings = updateSettings;
    (window as any).__Protocol = Protocol;
    $effect(() => {
      (window as any).__wconfig = $wconfig;
      (window as any).__connected = $connected;
    });
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  async function tryAutoConnect() {
    if (!$settings.autoconnect || !$settings.savepassword || !$settings.hostField || !$settings.password) {
      return;
    }
    try {
      const { host: parsedHost, port: parsedPort, path: parsedPath } = parseRelayUrl($settings.hostField, $settings.port);
      await connect(parsedHost, parsedPort, parsedPath, $settings.password, $settings.tls, false);
      parseHashAndNavigate();
    } catch (e) {
      console.warn('Auto-connect failed:', e);
    }
  }

  function parseHashAndNavigate() {
    if (typeof window === 'undefined') return;
    const hash = window.location.hash.slice(1);
    if (!hash) return;

    // Parse hash parameters (host, port, path, password, autoconnect)
    const params: Record<string, string> = {};
    hash.split('&').forEach(val => {
      const segs = val.split('=');
      if (segs.length >= 2 && segs[0]) {
        params[segs[0]] = decodeURIComponent(segs.slice(1).join('='));
      }
    });

    if (params.host) {
      updateSettings({ hostField: params.host });
    }
    if (params.port) {
      updateSettings({ port: params.port });
    }
    if (params.autoconnect) {
      updateSettings({ autoconnect: params.autoconnect === 'true' });
    }
  }

  $effect(() => {
    // Initialize theme, notifications, touch gestures, and attempt auto-connect on mount
    initTheme();
    initNotifications();
    initTouchGestures();
    void tryAutoConnect();
    document.body.setAttribute('data-app-ready', 'true');

    return () => {
      cleanupTouchGestures();
      onDisconnect();
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
    if (svelteEl) {
      svelteEl.style.overflow = $connected ? 'hidden' : 'auto';
    }
  });

  $effect(() => {
    void $activeBufferChanged;
    void $connected;
    if (!$connected) return;
    const buf = $currentBuffer;
    if (!buf) return;
    if (buf.requestedLines < 100) {
      fetchMoreLines(100).catch(() => {});
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
    // Use get() to avoid $effect dependency on $settings/$buffers (prevents listener re-registration)
    const s = get(settings);
    const b = get(buffers);
    if (e.altKey && !e.ctrlKey && !e.shiftKey && s.enableQuickKeys) {
      // Use e.code to extract digit — this works on all keyboard layouts
      const digitMatch = e.code.match(/^Digit(\d)$/);
      if (digitMatch) {
        let digitStr = digitMatch[1];
        if (!digitStr) return;
        const digit = parseInt(digitStr, 10);
        const index = digit === 0 ? 9 : digit - 1;
        e.preventDefault();
        const sorted = sortBuffers(Object.values(b).filter((bu: BufferData) => !bu.hidden), s.orderbyserver);
        if (index < sorted.length) {
          const buf = sorted[index];
          if (buf) switchBuffer(buf.id);
        }
      }
    }
  }

  let _jumpDecimal: number | null = $state(null);

  function handleJumpToBuffer(e: KeyboardEvent) {
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
        const allBuffs = get(buffers);
        const sorted = Object.values(allBuffs)
          .filter((b: BufferData) => !b.hidden)
          .sort((a: BufferData, b: BufferData) => a.number - b.number);
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
    const code = e.keyCode || e.which;

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

    // Alt+A -> switch to buffer with activity (prioritize notification, then unread)
    if (e.altKey && (code === 97 || code === 65) && !e.ctrlKey) {
      e.preventDefault();
      const allBuffs = get(buffers);
      /* eslint-disable @typescript-eslint/no-explicit-any -- buffer objects from store */
      const sortedBuffs = Object.values(allBuffs)
        .filter((b: any) => !b.hidden)
        .sort((a: any, b: any) => a.number - b.number);
      const currentId = get(activeBufferId);
      let startIndex = sortedBuffs.findIndex((b: any) => b.id === currentId);
      /* eslint-enable @typescript-eslint/no-explicit-any */
      if (startIndex === -1) startIndex = 0;

      // First pass: find first buffer with notification > 0 (highest priority / highlight)
      for (let i = 1; i < sortedBuffs.length; i++) {
        const idx = (startIndex + i) % sortedBuffs.length;
        const b = sortedBuffs[idx];
        if (b && b.notification > 0) {
          switchBuffer(b.id);
          return;
        }
      }
      // Second pass: find first buffer with unread > 0
      for (let i = 1; i < sortedBuffs.length; i++) {
        const idx = (startIndex + i) % sortedBuffs.length;
        const b = sortedBuffs[idx];
        if (b && b.unread > 0) {
          switchBuffer(b.id);
          return;
        }
      }
    }

    // Alt+Arrow up/down -> switch to adjacent buffer
    if (e.altKey && !e.ctrlKey && (code === 38 || code === 40)) {
      e.preventDefault();
      /* eslint-disable @typescript-eslint/no-explicit-any -- buffer objects from store */
      const allB = get(buffers);
      const visible = Object.values(allB)
        .filter((b: any) => !b.hidden)
        .sort((a: any, b: any) => a.number - b.number);
      const curId = get(activeBufferId);
      const curIdx = visible.findIndex((b: any) => b.id === curId);
      /* eslint-enable @typescript-eslint/no-explicit-any */
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

    // Alt+G -> focus buffer search
    if (e.altKey && (code === 71 || code === 103)) {
      e.preventDefault();
      toggleBufferSearchGlobal();
      return;
    }

    // Escape -> double-tap -> disconnect (let native popover handle closing modals)
    if (e.code === 'Escape') {
      const now = Date.now();
      if (now - lastEscapeTime <= 500) {
        disconnect();
      }
      lastEscapeTime = now;
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
    // Don't type-to-focus when a modal/dialog is open
    if (isPopoverOpen()) return;
    const input = document.querySelector<HTMLTextAreaElement>('[data-testid="message-input"]');
    if (!input) return;
    e.preventDefault();
    input.focus();
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const newValue = input.value.substring(0, start) + e.key + input.value.substring(end);
    input.value = newValue;
    const newCursor = start + 1;
    input.setSelectionRange(newCursor, newCursor);
    input.dispatchEvent(new Event('input', { bubbles: true }));
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

  let showBufferList = $state(true);
  let nicklistOpenOnMobile = $state(false);
  let touchStartX = 0;
  let touchStartY = 0;
  let touchStartTime = 0;

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
      // Swipe right -> show buffer list
      if (deltaX > 0) {
        showBufferList = true;
        nicklistOpenOnMobile = false;
      }
      // Swipe left -> check if from right edge (nicklist) or general (buffer list)
      else {
        const rightEdgeThreshold = 40;
        if (touchStartX > window.innerWidth - rightEdgeThreshold && !nicklistOpenOnMobile) {
          nicklistOpenOnMobile = true;
        } else if (nicklistOpenOnMobile) {
          nicklistOpenOnMobile = false;
        } else {
          showBufferList = false;
        }
      }
    }

    if (Math.abs(deltaY) > Math.abs(deltaX) && Math.abs(deltaY) > 80 && deltaTime < 500) {
      const allBuffers = Object.values($buffers).filter(b => !b.hidden);
      const currentBuf = $currentBuffer;
      const currentIndex = allBuffers.findIndex(b => b.id === currentBuf?.id);

      if (currentIndex !== -1) {
        if (deltaY < 0 && currentIndex < allBuffers.length - 1) {
          const prev = allBuffers[currentIndex - 1];
          if (prev) switchBuffer(prev.id);
        } else if (deltaY > 0 && currentIndex > 0) {
          const next = allBuffers[currentIndex + 1];
          if (next) switchBuffer(next.id);
        }
      }
    }
  }
</script>

{#if !$connected}
  <ConnectionForm />
{:else}
  <div class="h-dvh flex flex-col bg-bg" data-testid="chat-view">
    <TopBar onBufferSelect={hideBufferListOnMobile} onSearchOpen={showBufferListOnMobile} />
    <div class="flex-1 flex overflow-hidden">
      {#if showBufferList || !isMobile()}
        <BufferList altKeyPressed={_altKeyPressed} onBufferSelect={hideBufferListOnMobile} />
      {/if}
      <div class="flex-1 flex flex-col min-w-0">
        <ChatView />
        <InputBar />
      </div>
      {#if $settings.showNicklist && !isMobile()}
        <Nicklist />
      {/if}
      {#if isMobile()}
        <div class="fixed top-0 right-0 bottom-0 h-screen w-52 sm:w-28 lg:w-30 z-50 transition-transform duration-200 ease-out {nicklistOpenOnMobile ? 'translate-x-0' : 'translate-x-full'}">
          <button
            onclick={() => { nicklistOpenOnMobile = false; }}
            data-testid="nicklist-close-button"
            class="absolute top-1 left-2 z-10 px-2 py-1 text-sm text-text-secondary hover:text-white hover:bg-surface-raised rounded"
            title="Close nicklist"
          >
            <X size={16} />
          </button>
          <div class="h-full bg-surface border-l border-border flex flex-col overflow-hidden">
            <Nicklist onClose={() => { nicklistOpenOnMobile = false; }} />
          </div>
        </div>
      {/if}
    </div>
  </div>
{/if}

<Toast />
