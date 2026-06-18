<script lang="ts">
  import { currentBuffer, buffers } from '$lib/stores/models';
  import { sendMessage, sendWeeChatCommand } from '$lib/stores/connectionManager';
  import { settings } from '$lib/stores/settings';
  import { addToHistory, getHistoryUp, getHistoryDown } from '$lib/stores/inputHistory';
  import { completeNick, isPopoverOpen } from '$lib/utils';
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
    status: 'preview' | 'uploading' | 'success' | 'error';
    result?: { link: string; deletehash: string };
    error?: string;
  }

  let {
    onInsertUrls = () => {},
  }: {
    onInsertUrls?: (urls: string[]) => void;
  } = $props();

  let inputRef = $state<HTMLTextAreaElement>();
  let fileInputRef = $state<HTMLInputElement>();
  let message = $state('');
  let _iterCandidate: string | null = $state(null);
  let isDraggingFile = $state(false);
  let previewImages = $state<PreviewItem[]>([]);
  let previewOpen = $derived(previewImages.length > 0);
  let nextImageId = $state(1);

  let canSend = $derived($currentBuffer && message.length > 0);

  function handleSend() {
    if (!canSend) return;

    const text = message;

    // Split the command into multiple commands based on line breaks (matching AngularJS behavior)
    const lines = text.split(/\r?\n/);

    // Handle /buffer clear command on first line only
    if (/^\/buffer\s+clear\s*$/i.test(lines[0]!)) {
      if ($currentBuffer) {
        const currentBuffers = get(buffers);
        const bufferId = $currentBuffer.id || '';
        const existing = currentBuffers[bufferId];
        if (existing) {
          const updated = { ...currentBuffers };
          updated[bufferId] = { ...existing, lines: [], requestedLines: 0 };
          buffers.set(updated);
        }
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
      const currentBuffers = get(buffers);
      const bufferId = $currentBuffer.id || '';
      const existing = currentBuffers[bufferId];
      if (existing) {
        const updated = { ...currentBuffers };
        updated[bufferId] = { ...existing, lines: [], requestedLines: 0 };
        buffers.set(updated);
      }
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
  // base64Strings handles images from clipboard.getAsString() fallback (macOS Safari).
  async function collectImagesForPreview(
    files: FileList | File[],
    base64Strings?: string[],
  ): Promise<void> {
    const imageFiles = Array.from(files).filter(f => f.type.match(/image.*/));
    console.log('[collectImagesForPreview] entered — files:', Array.from(files).map(f => ({ name: f.name, type: f.type })), 'base64Strings:', base64Strings?.length ?? 0);
    console.log('[collectImagesForPreview] after filter — imageFiles:', imageFiles.length, imageFiles.map(f => ({ name: f.name, type: f.type })));
    if (imageFiles.length === 0 && !(base64Strings?.length)) {
      console.log('[collectImagesForPreview] no images found, returning early');
      return;
    }

    const newItems: PreviewItem[] = [];

    for (const file of imageFiles) {
      console.log('[collectImagesForPreview] reading file:', file.name, file.type, file.size + ' bytes');
      const dataUrl = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => {
          console.log('[collectImagesForPreview] FileReader done for', file.name, 'dataUrl length:', (reader.result as string).length);
          resolve(reader.result as string);
        };
        reader.onerror = (e) => {
          console.error('[collectImagesForPreview] FileReader error for', file.name, e);
          resolve('');
        };
        reader.readAsDataURL(file);
      });
      newItems.push({
        id: nextImageId++,
        name: file.name,
        size: file.size,
        dataUrl,
        progress: 0,
        status: 'preview',
      });
    }

    // Add base64 data URLs directly (no FileReader needed)
    if (base64Strings) {
      for (const dataUrl of base64Strings) {
        newItems.push({
          id: nextImageId++,
          name: 'pasted-image.png',
          size: Math.round(dataUrl.length * 0.75),
          dataUrl,
          progress: 0,
          status: 'preview',
        });
      }
    }

    console.log('[collectImagesForPreview] setting previewImages:', previewImages.length + newItems.length, 'total items');
    previewImages = [...previewImages, ...newItems];
    previewOpen = true;
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

  function closePreview() {
    previewOpen = false;
    previewImages = [];
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
      console.log('[handlePaste] no clipboardData');
      return;
    }

    // Strategy 1: clipboardData.files (Firefox on macOS)
    const allFiles = Array.from(data.files);
    const files = allFiles.filter(f => f.type.match(/image.*/));
    console.log('[handlePaste] clipboardData.files:', allFiles.length, 'total,', files.length, 'images', allFiles.map(f => ({ name: f.name, type: f.type })));
    if (files.length > 0) {
      e.preventDefault();
      console.log('[handlePaste] using strategy 1 (files), calling collectImagesForPreview');
      void collectImagesForPreview(files);
      return;
    }

    // Strategy 2+3: clipboardData.items API (Chrome, Safari)
    const items = data.items;
    if (!items) {
      console.log('[handlePaste] no clipboardData.items');
      return;
    }

    const imageFiles: File[] = [];
    const imageStringsPromises: Promise<string | null>[] = [];

    console.log('[handlePaste] clipboardData.items count:', items.length);
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      console.log('[handlePaste] item[' + i + ']:', item?.kind, item?.type);
      if (item && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          console.log('[handlePaste] item[' + i + '] getAsFile() succeeded:', file.name, file.type, file.size + ' bytes');
          imageFiles.push(file);
        } else {
          console.log('[handlePaste] item[' + i + '] getAsFile() returned null, falling back to getAsString');
          imageStringsPromises.push(
            new Promise(resolve => {
              item.getAsString(s => {
                console.log('[handlePaste] getAsString callback:', s ? 'got ' + s.substring(0, 60) + '...' : 'null');
                resolve(s || null);
              });
            }),
          );
        }
      }
    }

    console.log('[handlePaste] collected:', imageFiles.length, 'files,', imageStringsPromises.length, 'promises');
    if (imageFiles.length === 0 && imageStringsPromises.length === 0) {
      console.log('[handlePaste] no images found, aborting');
      return;
    }

    e.preventDefault();

    // Wait for all getAsString callbacks to complete before processing
    const resolvedStrings = await Promise.all(imageStringsPromises);
    const strings = resolvedStrings.filter((s): s is string => s !== null && s.length > 0);
    console.log('[handlePaste] resolved strings:', strings.length);

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

<div data-testid="input-bar" class="bg-surface-raised border-t border-border p-2">
  <div class="flex items-center space-x-2">

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
      class="flex-1 bg-input-bg border border-border rounded px-3 py-2 text-text text-sm placeholder-text-muted focus:outline-none focus:border-accent resize-none transition-colors {isDraggingFile ? 'border-accent bg-accent/10' : ''}"
      style="min-height: 36px; max-height: 150px;"
    ></textarea>

    <button
      onclick={() => fileInputRef?.click()}
      data-testid="upload-image-button"
      class="px-2 py-2 text-text-secondary hover:text-text hover:bg-border rounded transition-colors"
      title="Upload image"
    >
      <Camera size={18} />
    </button>

    <button
      onclick={() => { if (inputRef) { const caret = getCaretPos(); const result = completeNick(message, caret, _iterCandidate); if (result) { message = result.text; _iterCandidate = result.iterCandidate; setTimeout(() => setCaretPos(result.cursor), 0); } } }}
      data-testid="nick-complete-button"
      class="px-2 py-2 text-text-secondary hover:text-text hover:bg-border rounded transition-colors"
      title="Complete nick"
    >
      <Megaphone size={18} />
    </button>

    <button
      onclick={handleSend}
      disabled={!canSend}
      data-testid="send-button"
      class="px-3 py-2 bg-accent hover:bg-accent-hover disabled:bg-border disabled:cursor-not-allowed text-white rounded transition-colors"
    >
      <Send size={16} />
    </button>
  </div>
</div>

{#if previewOpen}
  <ImageUploadPreview
    images={previewImages}
    onInsert={handleInsertUrls}
    onClose={closePreview}
  />
{/if}
