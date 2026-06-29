<script lang="ts">
  import { currentBuffer, buffers } from '$lib/stores/models';
  import { sendMessage, sendWeeChatCommand } from '$lib/stores/connectionManager';
  import { settings } from '$lib/stores/settings';
  import { addToHistory, getHistoryUp, getHistoryDown } from '$lib/stores/inputHistory';
  import { completeNick, isPopoverOpen, filterImageFiles } from '$lib/utils';
  import Send from '@lucide/svelte/icons/send';
  import { emojifyInput } from '$lib/emojify';
  import Camera from '@lucide/svelte/icons/camera';
  import Megaphone from '@lucide/svelte/icons/megaphone';
  import { get } from 'svelte/store';
  import ImageUploadPreview from './ImageUploadPreview.svelte';
  import { DEBUG_INPUT } from '$lib/debug';

  interface PreviewItem {
    id: number;
    name: string;
    size: number;
    dataUrl: string;
    file?: File;
    progress: number;
    status: 'loading' | 'preview' | 'uploading' | 'success' | 'error';
    result?: { link: string; deletehash: string };
    error?: string;
  }

  let {
    onInsertUrls = () => {},
  }: {
    onInsertUrls?: (urls: string[]) => void;
  } = $props();

  // Paste debugging — controlled by DEBUG_INPUT flag in $lib/debug
  function log(...args: unknown[]) { if (DEBUG_INPUT) console.log('[paste]', ...args); }

  let inputRef = $state<HTMLTextAreaElement>();
  let fileInputRef = $state<HTMLInputElement>();
  let message = $state('');
  let _iterCandidate: string | null = $state(null);
  let isDraggingFile = $state(false);
  let previewImages = $state<PreviewItem[]>([]);
  // Ref to ImageUploadPreview component for programmatic dialog show/hide
  let previewDialogRef = $state<{ dialog: HTMLDialogElement | undefined }>();
  let nextImageId = $state(1);

  let showColorPicker = $state(false);
  let isHovered = $state(false);
  let textareaFocused = $state(false);
  // Last known cursor position — saved on input/blur so format buttons work reliably
  // even when clicking them causes the textarea to lose focus.
  let lastCaretPos = $state(0);
  let _ctrlDown = $state(false);

  // WeeChat standard color palette (IRC color codes 00-15)
  const IRC_COLORS = [
    { code: '00', name: 'White', css: '#FFFFFF' },
    { code: '01', name: 'Black', css: '#000000' },
    { code: '02', name: 'Blue', css: '#000080' },
    { code: '03', name: 'Green', css: '#008000' },
    { code: '04', name: 'Red', css: '#FF0000' },
    { code: '05', name: 'Brown', css: '#808000' },
    { code: '06', name: 'Purple', css: '#800080' },
    { code: '07', name: 'Orange', css: '#FF8000' },
    { code: '08', name: 'Yellow', css: '#FFFF00' },
    { code: '09', name: 'LightGreen', css: '#00FF00' },
    { code: '10', name: 'Teal', css: '#008080' },
    { code: '11', name: 'LightCyan', css: '#00FFFF' },
    { code: '12', name: 'LightBlue', css: '#0000FF' },
    { code: '13', name: 'Pink', css: '#FF00FF' },
    { code: '14', name: 'Grey', css: '#808080' },
    { code: '15', name: 'LightGrey', css: '#C0C0C0' },
  ] as const;

  let canSend = $derived($currentBuffer && message.length > 0);

  // Clear all messages from a buffer, resetting lines and requestedLines count.
  function clearBufferMessages(bufferId: string) {
    const current = get(buffers);
    const buf = current[bufferId];
    if (!buf) return;
    const updated = { ...current };
    updated[bufferId] = { ...buf, lines: [], requestedLines: 0 };
    buffers.set(updated);
  }

  function handleSend() {
    if (!canSend) return;

    const text = message;

    // Split the command into multiple commands based on line breaks (matching AngularJS behavior)
    const lines = text.split(/\r?\n/);

    // Handle /buffer clear command on first line only
    if (/^\/buffer\s+clear\s*$/i.test(lines[0]!)) {
      if ($currentBuffer) {
        clearBufferMessages($currentBuffer.id);
        sendWeeChatCommand('/buffer clear');
      }
    }

    for (const line of lines) {
      // Skip empty lines
      if (line.length === 0) continue;

      // Ask before a /quit
      if (line === '/quit' || line.indexOf('/quit ') === 0) {
        if (!window.confirm("Are you sure you want to quit WeeChat? This will prevent you from connecting with Glowing Bear until you restart WeeChat on the command line!")) {
          continue;
        }
      }

      sendMessage(line);
      if ($currentBuffer) {
        addToHistory($currentBuffer.id, line);
      }
    }

    if (text === '/c' && $currentBuffer) {
      clearBufferMessages($currentBuffer.id);
    }

    message = '';

    if (inputRef) {
      inputRef.style.height = 'auto';
      inputRef.blur();
    }
  }

  function getCaretPos(): number {
    return inputRef?.selectionStart ?? 0;
  }

  function setCaretPos(pos: number) {
    if (inputRef) {
      inputRef.setSelectionRange(pos, pos);
    }
  }

  // Insert text at current cursor position, then advance cursor past inserted text.
  // Uses lastCaretPos (tracked on input/blur) so it works after textarea loses focus on button click.
  // When forceFocus is true, focuses the textarea before inserting (used by global paste handler).
  function insertAtCursor(text: string, forceFocus = false): void {
    const caret = textareaFocused ? getCaretPos() : lastCaretPos;
    message = message.slice(0, caret) + text + message.slice(caret);
    if (forceFocus) {
      inputRef?.focus();
    }
    setTimeout(() => setCaretPos(caret + text.length), 0);
  }

  // Insert a bold/italic/underline mIRC control char at the cursor position.
  function toggleFormat(attr: 'bold' | 'italic' | 'underline'): void {
    if (!$settings.enableFormatting) return;
    const codes = { bold: '\x02', italic: '\x1d', underline: '\x1f' };
    insertAtCursor(codes[attr]);
    inputRef?.focus();
  }

  // Insert an IRC color code (\x03NN) at the cursor position.
  function applyColor(colorCode: string): void {
    if (!$settings.enableFormatting) return;
    insertAtCursor(`\x03${colorCode}`);
    showColorPicker = false;
    inputRef?.focus();
  }

  // Insert the mIRC reset code (\x0f) at the cursor position to clear formatting.
  function insertReset(): void {
    if (!$settings.enableFormatting) return;
    insertAtCursor('\x0f');
    inputRef?.focus();
  }

  function handleKeyDown(e: KeyboardEvent) {
    // Don't process keyboard shortcuts when a modal/dialog is open or focus is elsewhere
    if (isPopoverOpen() && document.activeElement !== inputRef) return false;

    const code = e.keyCode || e.which;

    // Escape -> blur input
    if (e.code === 'Escape' || code === 27) {
      e.preventDefault();
      inputRef?.blur();
      return true;
    }

    // AltGraph detection — skip all handling
    if (e.getModifierState && e.getModifierState('AltGraph')) {
      return false;
    }

    // Formatting shortcuts always take priority over readline bindings
    if (e.ctrlKey && !e.altKey && document.activeElement === inputRef) {
      // Ctrl+B — toggle bold
      if (code === 66 && !e.shiftKey) {
        e.preventDefault();
        toggleFormat('bold');
        return true;
      }
      // Ctrl+I — toggle italic
      if (code === 73 && !e.shiftKey) {
        e.preventDefault();
        toggleFormat('italic');
        return true;
      }
      // Ctrl+_ — toggle underline (matches WeeChat; frees Ctrl+U for readline)
      if (e.key === '_' || (code === 189 && e.shiftKey)) {
        e.preventDefault();
        toggleFormat('underline');
        return true;
      }
      // Ctrl+Shift+R — insert reset code
      if (code === 82 && e.shiftKey) {
        e.preventDefault();
        insertReset();
        return true;
      }
      // Ctrl+K — toggle color picker
      if (code === 75 && !e.shiftKey) {
        e.preventDefault();
        showColorPicker = !showColorPicker;
        return true;
      }
    }

    // Enter to submit, shift-enter for newline
    if (code === 13 && !e.shiftKey && document.activeElement === inputRef) {
      e.preventDefault();
      handleSend();
      return true;
    }

    if (code === 13 && e.shiftKey && document.activeElement === inputRef) {
      e.preventDefault();
      message += '\n';
      return true;
    }

    // Tab -> nick completion, then command completion if applicable
    if (code === 9 && !e.altKey && !e.ctrlKey && !e.shiftKey) {
      e.preventDefault();
      const caretPos = getCaretPos();
      const result = completeNick(message, caretPos, _iterCandidate);
      if (result) {
        message = result.text;
        _iterCandidate = result.iterCandidate;
        setTimeout(() => setCaretPos(result.cursor), 0);
      } else {
        _iterCandidate = null;
      }
      return true;
    }

    // Shift-Tab -> command completion backward (not yet implemented)
    if (code === 9 && !e.altKey && !e.ctrlKey && e.shiftKey) {
      e.preventDefault();
      return true;
    }

    // Arrow up -> go up in history
    if (e.type === 'keydown' && code === 38 && document.activeElement === inputRef) {
      // In case of multiline we don't want to do this unless at the first line
      if (message) {
        const caretPos = getCaretPos();
        if (message.slice(0, caretPos).indexOf('\n') !== -1) {
          return false;
        }
      }
      e.preventDefault();
      if ($currentBuffer) {
        message = getHistoryUp($currentBuffer.id, message);
      }
      // Set cursor to last position
      setTimeout(() => {
        if (message) {
          setCaretPos(message.length);
        }
      }, 1);
      return true;
    }

    // Arrow down -> go down in history
    if (e.type === 'keydown' && code === 40 && document.activeElement === inputRef) {
      // In case of multiline we don't want to do this unless it's the last line
      let caretPos = getCaretPos();
      if (message) {
        if (message.slice(caretPos).indexOf('\n') !== -1) {
          return false;
        }
      }
      e.preventDefault();
      if ($currentBuffer) {
        message = getHistoryDown($currentBuffer.id, message);
      }
      return true;
    }

    // Some readline keybindings
    if ($settings.readlineBindings && e.ctrlKey && !e.altKey && !e.shiftKey && document.activeElement === inputRef) {
      const caretPos = getCaretPos();
      // Ctrl-a: move to start of line
      if (code === 65) {
        e.preventDefault();
        setCaretPos(0);
        return true;
      }
      // Ctrl-e: move to end of line
      if (code === 69) {
        e.preventDefault();
        setCaretPos(message.length);
        return true;
      }
      // Ctrl-u: delete from beginning of line to cursor
      if (code === 85) {
        e.preventDefault();
        message = message.substring(caretPos);
        setTimeout(() => setCaretPos(0));
        return true;
      }
      // Ctrl-k: delete from cursor to end of line
      if (code === 75) {
        e.preventDefault();
        message = message.substring(0, caretPos);
        setTimeout(() => setCaretPos(caretPos));
        return true;
      }
      // Ctrl-w: delete word before cursor
      if (code === 87) {
        e.preventDefault();
        const trimmedValue = message.substring(0, caretPos);
        const lastSpace = trimmedValue.replace(/\s+$/, '').lastIndexOf(' ') + 1;
        message = message.substring(0, lastSpace) + message.substring(caretPos);
        setTimeout(() => setCaretPos(lastSpace));
        return true;
      }
     // Ctrl-h: backspace
        if (code === 72) {
          e.preventDefault();
          if (caretPos > 0) {
            message = message.substring(0, caretPos - 1) + message.substring(caretPos - 1);
            setTimeout(() => setCaretPos(caretPos - 1));
          }
          return true;
        }
        // Ctrl-b: disabled — Ctrl+B is used for bold formatting
        // if (code === 66) {
        //   e.preventDefault();
        //   setCaretPos(Math.max(0, caretPos - 1));
        //   return true;
        // }
        // Ctrl-f: move forward one character
        if (code === 70) {
          e.preventDefault();
          setCaretPos(Math.min(message.length, caretPos + 1));
          return true;
        }
        return false;
    }

    // Page up -> scroll up
    if (e.type === 'keydown' && code === 33 && document.activeElement === inputRef && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      const chatContainer = document.querySelector<HTMLDivElement>('[data-testid="chat-messages"]');
      if (chatContainer) {
        chatContainer.scrollTop -= chatContainer.clientHeight * 0.8;
      }
      return true;
    }

    // Page down -> scroll down
    if (e.type === 'keydown' && code === 34 && document.activeElement === inputRef && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      const chatContainer = document.querySelector<HTMLDivElement>('[data-testid="chat-messages"]');
      if (chatContainer) {
        chatContainer.scrollTop += chatContainer.clientHeight * 0.8;
      }
      return true;
    }
  }

  function handleInput() {
    if (inputRef) {
      inputRef.style.height = 'auto';
      inputRef.style.height = Math.min(inputRef.scrollHeight, 150) + 'px';
      // Save cursor position so format buttons work after textarea loses focus.
      lastCaretPos = inputRef.selectionStart;
    }

    // Emojify :shortcode: patterns as user types, matching AngularJS behavior
    if ($settings.enableEmojify) {
      const caret = inputRef?.selectionStart ?? 0;
      const result = emojifyInput(message, caret);
      if (result.text !== message) {
        message = result.text;
        setTimeout(() => setCaretPos(result.caretPos), 0);
      }
    }
  }

  // Convert files to preview items and open the preview modal.
  // Uses URL.createObjectURL for instant previews (no FileReader hang on iOS).
  // base64Strings handles images from clipboard.getAsString() fallback (macOS Safari).
  function collectImagesForPreview(
    files: FileList | File[],
    base64Strings?: string[],
  ): void {
    const imageFiles = filterImageFiles(Array.from(files));
    if (imageFiles.length === 0 && !(base64Strings?.length)) return;

    // Create preview items synchronously — createObjectURL is instant, no FileReader needed
    const fileItems: PreviewItem[] = [];
    for (const file of imageFiles) {
      fileItems.push({
        id: nextImageId++,
        name: file.name,
        size: file.size,
        dataUrl: URL.createObjectURL(file),
        file,
        progress: 0,
        status: 'preview',
      });
    }

    // Add base64 data URLs directly (pasted images without File objects)
    const directItems: PreviewItem[] = [];
    if (base64Strings) {
      for (const dataUrl of base64Strings) {
        directItems.push({
          id: nextImageId++,
          name: 'pasted-image.png',
          size: Math.round(dataUrl.length * 0.75),
          dataUrl,
          progress: 0,
          status: 'preview',
        });
      }
    }

    for (const item of [...fileItems, ...directItems]) {
      previewImages.push(item);
    }

    // Show dialog programmatically — avoids {#if} reactivity issues after async boundaries
    previewDialogRef?.dialog?.showPopover();

    inputRef?.focus();
  }

  // Insert uploaded URLs at cursor position, space-separated
  function handleInsertUrls(urls: string[]) {
    const caret = getCaretPos();
    const urlsText = urls.join(' ');
    message = message.slice(0, caret) + urlsText + message.slice(caret);
    setTimeout(() => setCaretPos(caret + urlsText.length), 0);
    onInsertUrls(urls);
  }

  // Close image preview dialog, revoking object URLs to prevent memory leaks
  function closePreview() {
    for (const img of previewImages) {
      if (img.file) {
        URL.revokeObjectURL(img.dataUrl);
      }
    }
    previewDialogRef?.dialog?.hidePopover();
    previewImages.splice(0);
    inputRef?.focus();
  }

  // Handle paste events — detect images from clipboard.
  // Tries multiple browser strategies in order:
  // 1. clipboardData.files (Firefox on macOS exposes pasted images this way)
  // 2. clipboardData.items + getAsFile() (Chrome standard behavior)
  // 3. clipboardData.items + getAsString() (Safari fallback when getAsFile returns null)
  async function handlePaste(e: ClipboardEvent) {
    const data = e.clipboardData;
    if (!data) {
      log('no clipboardData');
      return;
    }

    // Strategy 1: clipboardData.files (Firefox on macOS)
    // Firefox's clipboard files are ephemeral and get GC'd before FileReader can read them,
    // so we must read their content immediately within this event handler.
    const allFiles = Array.from(data.files);
    const files = filterImageFiles(allFiles);
    log('clipboardData.files:', allFiles.length, 'total,', files.length, 'images', allFiles.map(f => ({ name: f.name, type: f.type })));
    if (files.length > 0) {
      e.preventDefault();
      log('using strategy 1 (files), reading immediately to avoid GC');
      const dataUrls = await Promise.all(
        files.map(file =>
          new Promise<string>(resolve => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = () => resolve('');
            reader.readAsDataURL(file);
          }),
        ),
      );
      const validUrls = dataUrls.filter(u => u.length > 0);
      log('strategy 1 resolved', validUrls.length, 'data URLs');
      void collectImagesForPreview([], validUrls);
      return;
    }

    // Strategy 2+3: clipboardData.items API (Chrome, Safari)
    const items = data.items;
    if (!items) {
      log('no clipboardData.items, falling back to getData');
      // items API unavailable (e.g. some browser contexts, Playwright DataTransfer).
      // Fall back to getData for plain text paste.
      e.preventDefault();
      const pastedText = data.getData('text/plain') || data.getData('text');
      if (pastedText) {
        log('pasted', pastedText.length, 'characters of text via getData fallback');
        inputRef?.focus();
        insertAtCursor(pastedText, true);
      }
      return;
    }

    const imageFiles: File[] = [];
    const imageStringsPromises: Promise<string | null>[] = [];

    log('clipboardData.items count:', items.length);
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      log('item[' + i + ']:', item?.kind, item?.type);
      if (item && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          log('item[' + i + '] getAsFile() succeeded:', file.name, file.type, file.size + ' bytes');
          imageFiles.push(file);
        } else {
          log('item[' + i + '] getAsFile() returned null, falling back to getAsString');
          imageStringsPromises.push(
            new Promise(resolve => {
              item.getAsString(s => {
                log('getAsString callback:', s ? 'got ' + s.substring(0, 60) + '...' : 'null');
                resolve(s || null);
              });
            }),
          );
        }
      }
    }

    log('collected:', imageFiles.length, 'files,', imageStringsPromises.length, 'promises');
    if (imageFiles.length === 0 && imageStringsPromises.length === 0) {
      log('no images found, handling text paste');
      // No images in clipboard — handle plain text paste.
      // Explicitly prevent default and insert at cursor to avoid race conditions
      // between browser's native paste and Svelte's bind:value reactivity.
      e.preventDefault();
      const pastedText = data.getData('text/plain') || data.getData('text');
      if (pastedText) {
        log('pasted', pastedText.length, 'characters of text');
        inputRef?.focus();
        insertAtCursor(pastedText, true);
      }
      return;
    }

    e.preventDefault();

    // Wait for all getAsString callbacks to complete before processing
    const resolvedStrings = await Promise.all(imageStringsPromises);
    const strings = resolvedStrings.filter((s): s is string => s !== null && s.length > 0);
    log('resolved strings:', strings.length);

    void collectImagesForPreview(imageFiles, strings.length ? strings : undefined);
  }

  function handleFileInputChange() {
    const files = fileInputRef?.files;
    if (!files) return;
    void collectImagesForPreview(files);
    if (fileInputRef) fileInputRef.value = '';
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    isDraggingFile = false;

    const files = e.dataTransfer?.files;
    if (!files) return;
    void collectImagesForPreview(files);
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    isDraggingFile = true;
  }

  function handleDragEnd() {
    isDraggingFile = false;
  }

  // Don't auto-focus the input on mount or buffer switch — user must use Alt+L or type a character to focus

  // Set mobile-friendly input attributes that TypeScript DOM types don't include
  $effect(() => {
    if (inputRef) {
      inputRef.setAttribute('autocorrect', 'off');
      inputRef.autocomplete = 'off';
      inputRef.spellcheck = false;
      inputRef.enterKeyHint = 'send';
    }
  });

  // Close color picker when clicking outside the input bar
  $effect(() => {
    if (!showColorPicker) return;
    function handleClickOutside(e: MouseEvent) {
      const inputBar = document.querySelector('[data-testid="input-bar"]');
      if (inputBar && !inputBar.contains(e.target as Node)) {
        showColorPicker = false;
        document.removeEventListener('click', handleClickOutside);
      }
    }
    setTimeout(() => document.addEventListener('click', handleClickOutside), 0);
    return () => document.removeEventListener('click', handleClickOutside);
  });

  // Expose a reset function for E2E tests to clear message and formatting state
  $effect(() => {
    const win = window as typeof window & { __resetFormattingState?: () => void };
    win.__resetFormattingState = () => {
      message = '';
      showColorPicker = false;
      _ctrlDown = false;
      textareaFocused = false;
      isHovered = false;
      if (inputRef) {
        inputRef.value = '';
      }
    };
    return () => {
      delete win.__resetFormattingState;
    };
  });

  // Track Ctrl key state globally to show/hide the formatting toolbar
  // Only shows when input bar is focused — user can't use the keybindings otherwise.
  // Listens on window (not document) because Playwright dispatches keyboard events at page level,
  // which may not bubble correctly through document on macOS.
  $effect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.key === 'Control' || e.ctrlKey) && document.activeElement === inputRef) {
        _ctrlDown = true;
      }
    }
    function handleKeyUp(e: KeyboardEvent) {
      // Only check e.key — the !e.ctrlKey guard causes issues in Playwright
      // where the browser's modifier state may lag behind the keyup event.
      if (e.key === 'Control') {
        _ctrlDown = false;
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  });

  // Global paste listener — catches paste events when focus is NOT on the textarea,
  // inserts plain text at cursor position and focuses the input bar.
  $effect(() => {
    function handleGlobalPaste(e: ClipboardEvent) {
      // Only intercept if focus is NOT on our textarea
      if (document.activeElement === inputRef) return;

      const data = e.clipboardData;
      if (!data) return;

      // Check for images first — if clipboard contains images, skip global handling
      // so the user can paste them into an appropriate target.
      const allFiles = Array.from(data.files);
      if (filterImageFiles(allFiles).length > 0) return;

      const items = data.items;
      if (items) {
        for (let i = 0; i < items.length; i++) {
          const item = items[i] as DataTransferItem | undefined;
          if (item && item.type.startsWith('image/')) return;
        }
      }

      // Plain text paste — insert at cursor and focus the textarea
      const pastedText = data.getData('text/plain') || data.getData('text');
      if (!pastedText) return;

      e.preventDefault();
      inputRef?.focus();
      insertAtCursor(pastedText, true);
    }
    document.addEventListener('paste', handleGlobalPaste);
    return () => document.removeEventListener('paste', handleGlobalPaste);
  });
</script>

<div data-testid="input-bar" class="input-bar-container flex-shrink-0">
  <div class="input-bar-inner bg-panel border-t border-border"
       role="group"
       onmouseenter={() => { isHovered = true; }}
       onmouseleave={() => { if (!showColorPicker) isHovered = false; }}
       onfocusin={() => { textareaFocused = true; }}
       onfocusout={() => { textareaFocused = false; }}
  >

    <!-- Format toolbar — visible when Ctrl key is held, color picker is open, or input bar is hovered/focused -->
    <div
      class="format-toolbar transition-all duration-150 ease-in-out overflow-hidden {((_ctrlDown || showColorPicker || isHovered || textareaFocused) ? 'max-h-12 opacity-100' : 'max-h-0 opacity-0')}"
      role="toolbar"
      aria-label="Text formatting"
    >
      <div class="flex items-center gap-1 px-1">
        <button
          type="button"
          data-testid="format-bold"
          onclick={() => toggleFormat('bold')}
          class="format-btn px-2 py-0.5 text-xs font-bold rounded border transition-colors bg-input-bg border-border text-text-secondary hover:text-text hover:border-text-secondary"
          title="Bold (Ctrl+B)"
        >B</button>
        <button
          type="button"
          data-testid="format-italic"
          onclick={() => toggleFormat('italic')}
          class="format-btn px-2 py-0.5 text-xs italic rounded border transition-colors bg-input-bg border-border text-text-secondary hover:text-text hover:border-text-secondary"
          title="Italic (Ctrl+I)"
        >I</button>
        <button
          type="button"
          data-testid="format-underline"
          onclick={() => toggleFormat('underline')}
          class="format-btn px-2 py-0.5 text-xs underline rounded border transition-colors bg-input-bg border-border text-text-secondary hover:text-text hover:border-text-secondary"
          title="Underline (Ctrl+_)"
        >U</button>
        <button
          type="button"
          data-testid="format-reset"
          onclick={insertReset}
          class="format-btn px-2 py-0.5 text-xs rounded border transition-colors bg-input-bg border-border text-text-secondary hover:text-text hover:border-text-secondary font-mono"
          title="Reset formatting (Ctrl+Shift+R)"
        >RST</button>
        <button
          type="button"
          data-testid="format-color"
          onclick={() => showColorPicker = !showColorPicker}
          class="format-btn px-2 py-0.5 text-xs font-bold rounded border transition-colors bg-input-bg border-border text-text-secondary hover:text-text hover:border-text-secondary"
          title="Color (Ctrl+K)"
        >C</button>
      </div>

      <!-- Color picker popover -->
      {#if showColorPicker}
        <div
          class="color-picker-popover fixed bottom-20 left-4 p-2 bg-surface border border-border rounded shadow-lg z-50"
          role="listbox"
          aria-label="Text color"
        >
          <div class="grid grid-cols-8 gap-1">
            {#each IRC_COLORS as color (color.code)}
              <button
                type="button"
                data-testid="color-{color.code}"
                onclick={() => applyColor(color.code)}
                class="color-swatch w-7 h-7 rounded border border-border flex items-center justify-center text-xs font-mono hover:scale-110 transition-transform"
                style="background-color: {color.css}; color: {color.css === '#FFFFFF' || color.css === '#FFFF00' ? '#000000' : '#FFFFFF'};"
                title="{color.name} ({color.code})"
              >{color.code}</button>
            {/each}
          </div>
        </div>
      {/if}
    </div>

    <div class="input-bar-row flex items-center space-x-2">

    <input
      id="upload-image-file"
      type="file"
      accept="image/*"
      multiple
      bind:this={fileInputRef}
      onchange={handleFileInputChange}
      class="hidden"
    />

    <textarea
      id="message-input"
      name="message"
      bind:this={inputRef}
      bind:value={message}
      onkeydown={handleKeyDown}
      oninput={handleInput}
      onpaste={handlePaste}
      ondrop={handleDrop}
      ondragover={handleDragOver}
      ondragleave={handleDragEnd}
      ondragend={handleDragEnd}
          onblur={() => {
            // Also set textareaFocused here because the capture-phase onfocusout
            // on the parent div doesn't fire for programmatic blur() calls.
            textareaFocused = false;
            lastCaretPos = inputRef?.selectionStart ?? 0;
          }}
      data-testid="message-input"
      placeholder={$currentBuffer ? `Message ${$currentBuffer.shortName}` : 'Select a buffer to start chatting...'}
      rows={1}
      class="input-bar-textarea flex-1 bg-input-bg border border-border rounded text-text text-sm placeholder-text-muted focus:outline-none focus:border-accent resize-none transition-colors min-h-9 max-h-[150px] {isDraggingFile ? 'border-accent bg-accent/10' : ''}"
      
    ></textarea>

    <button
      onclick={() => fileInputRef?.click()}
      data-testid="upload-image-button"
      class="input-bar-upload px-2 py-2 text-text-secondary hover:text-text hover:bg-border rounded transition-colors"
      title="Upload image"
    >
      <Camera size={18} />
    </button>

    <button
      onclick={() => { if (inputRef) { const caret = getCaretPos(); const result = completeNick(message, caret, _iterCandidate); if (result) { message = result.text; _iterCandidate = result.iterCandidate; setTimeout(() => setCaretPos(result.cursor), 0); } } }}
      data-testid="nick-complete-button"
      class="input-bar-nickcomplete px-2 py-2 text-text-secondary hover:text-text hover:bg-border rounded transition-colors"
      title="Complete nick"
    >
      <Megaphone size={18} />
    </button>

    <button
      onclick={handleSend}
      disabled={!canSend}
      data-testid="send-button"
      class="input-bar-send px-3 py-2 bg-accent hover:bg-accent-hover disabled:bg-border disabled:cursor-not-allowed text-white rounded transition-colors btn-glow"
    >
      <Send size={16} />
    </button>
    </div>
  </div>
</div>

<ImageUploadPreview
  bind:this={previewDialogRef}
  images={previewImages}
  onInsert={handleInsertUrls}
  onClose={closePreview}
/>

<style>
  /* Spacing — overridable by themes via --spacing-* vars */
  .input-bar-inner {
padding: var(--spacing-input-bar-padding-y, 5px) var(--spacing-input-bar-padding-x, 12px);
  }

  /* Symmetric vertical padding on the input row — equal space above/below textarea */
  .input-bar-row {
padding: var(--spacing-input-bar-row-padding-y, 1px) 0;
  }

  .input-bar-textarea {
padding: var(--spacing-textarea-padding-y, 8px) var(--spacing-textarea-padding-x, 12px);
  }
</style>
