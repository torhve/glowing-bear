<script lang="ts">
  import { currentBuffer, buffers } from '$lib/stores/models';
  import { sendMessage, sendWeeChatCommand } from '$lib/stores/connectionManager';
  import { settings } from '$lib/stores/settings';
  import { addToHistory, getHistoryUp, getHistoryDown } from '$lib/stores/inputHistory';
  import { completeNick, isPopoverOpen, filterImageFiles, readFileAsDataUrl } from '$lib/utils';
  import Send from '@lucide/svelte/icons/send';
  import { emojifyInput } from '$lib/emojify';
  import Camera from '@lucide/svelte/icons/camera';
  import Megaphone from '@lucide/svelte/icons/megaphone';
  import { get } from 'svelte/store';
  import ImageUploadPreview from './ImageUploadPreview.svelte';

  interface PreviewItem {
    id: number;
    name: string;
    size: number;
    dataUrl: string;
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

  // Debug flag — open console and set `window.__debugPaste = true` before pasting
  let debugPaste = $derived(typeof window !== 'undefined' && (window as any).__debugPaste === true);
  function log(...args: unknown[]) { if (debugPaste) console.log('[paste]', ...args); }

  let inputRef = $state<HTMLTextAreaElement>();
  let fileInputRef = $state<HTMLInputElement>();
  let message = $state('');
  let _iterCandidate: string | null = $state(null);
  let isDraggingFile = $state(false);
  let previewImages = $state<PreviewItem[]>([]);
  // Ref to ImageUploadPreview component for programmatic dialog show/hide
  let previewDialogRef = $state<{ dialog: HTMLDialogElement | undefined }>();
  let nextImageId = $state(1);

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

  function handleKeyDown(e: KeyboardEvent) {
    // Don't process keyboard shortcuts when a modal/dialog is open or focus is elsewhere
    if (isPopoverOpen() && document.activeElement !== inputRef) return false;

    const code = e.keyCode || e.which;

    // AltGraph detection — skip all handling
    if (e.getModifierState && e.getModifierState('AltGraph')) {
      return false;
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
        // Ctrl-b: move back one character
        if (code === 66) {
          e.preventDefault();
          setCaretPos(Math.max(0, caretPos - 1));
          return true;
        }
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
    }

    // Emojify :shortcode: patterns as user types, matching AngularJS behavior
    const caret = inputRef?.selectionStart ?? 0;
    const result = emojifyInput(message, caret);
    if (result.text !== message) {
      message = result.text;
      setTimeout(() => setCaretPos(result.caretPos), 0);
    }
  }

  // Convert files to preview items and open the preview modal.
  // Collect images for preview. Pushes placeholders synchronously before any await,
  // then reads files asynchronously and updates placeholders in-place.
  // base64Strings handles images from clipboard.getAsString() fallback (macOS Safari).
  async function collectImagesForPreview(
    files: FileList | File[],
    base64Strings?: string[],
  ): Promise<void> {
    const imageFiles = filterImageFiles(Array.from(files));
    if (imageFiles.length === 0 && !(base64Strings?.length)) return;

    // Phase 1: push placeholder items synchronously to trigger dialog open
    const placeholders: PreviewItem[] = [];
    for (const file of imageFiles) {
      placeholders.push({
        id: nextImageId++,
        name: file.name,
        size: file.size,
        dataUrl: '',
        progress: 0,
        status: 'loading',
      });
    }

    // Add base64 data URLs directly (no FileReader needed)
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

    for (const item of [...placeholders, ...directItems]) {
      previewImages.push(item);
    }

    // Show dialog programmatically — avoids {#if} reactivity issues after async boundaries
    previewDialogRef?.dialog?.showPopover();

    // Phase 2: read files asynchronously and update placeholders in-place
    for (let i = 0; i < imageFiles.length; i++) {
      const file = imageFiles[i]!;
      const placeholder = placeholders[i]!;
      const dataUrl = await readFileAsDataUrl(file);
      placeholder.dataUrl = dataUrl;
      placeholder.status = dataUrl ? 'preview' : 'error';
    }

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

  // Close image preview dialog
  function closePreview() {
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
      log('no clipboardData.items');
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
      log('no images found, aborting');
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

  // Only auto-focus on desktop — mobile users prioritize reading over typing
  $effect(() => {
    if ($currentBuffer && typeof window !== 'undefined' && window.innerWidth >= 768) {
      if (!isPopoverOpen()) {
        inputRef?.focus();
      }
    }
  });

  // Set mobile-friendly input attributes that TypeScript DOM types don't include
  $effect(() => {
    if (inputRef) {
      inputRef.setAttribute('autocorrect', 'off');
      inputRef.autocomplete = 'off';
      inputRef.spellcheck = false;
      inputRef.enterKeyHint = 'send';
    }
  });
</script>

<div data-testid="input-bar" class="input-bar-container flex-shrink-0">
  <div class="input-bar-inner bg-surface border-t border-border px-3 py-2">
    <div class="input-bar-row flex items-center space-x-2">

    <input
      type="file"
      accept="image/*"
      multiple
      bind:this={fileInputRef}
      onchange={handleFileInputChange}
      class="hidden"
    />

    <textarea
      bind:this={inputRef}
      bind:value={message}
      onkeydown={handleKeyDown}
      oninput={handleInput}
      onpaste={handlePaste}
      ondrop={handleDrop}
      ondragover={handleDragOver}
      ondragleave={handleDragEnd}
      ondragend={handleDragEnd}
      data-testid="message-input"
      placeholder={$currentBuffer ? `Message ${$currentBuffer.shortName}` : 'Select a buffer to start chatting...'}
      rows={1}
      class="input-bar-textarea flex-1 bg-input-bg border border-border rounded px-3 py-2 text-text text-sm placeholder-text-muted focus:outline-none focus:border-accent resize-none transition-colors {isDraggingFile ? 'border-accent bg-accent/10' : ''}"
      style="min-height: 36px; max-height: 150px;"
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
      class="input-bar-send px-3 py-2 bg-accent hover:bg-accent-hover disabled:bg-border disabled:cursor-not-allowed text-white rounded transition-colors"
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
