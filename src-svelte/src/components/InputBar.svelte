<script lang="ts">
  import { currentBuffer, buffers } from '$lib/stores/models';
  import { sendMessage, sendWeeChatCommand } from '$lib/stores/connectionManager';
  import { settings } from '$lib/stores/settings';
  import { addToHistory, getHistoryUp, getHistoryDown } from '$lib/stores/inputHistory';
  import { completeNick } from '$lib/utils';
  import Send from '@lucide/svelte/icons/send';
  import { emojifyInput } from '$lib/emojify';
  import { uploadImage } from '$lib/imgur';
  import Camera from '@lucide/svelte/icons/camera';
  import Megaphone from '@lucide/svelte/icons/megaphone';
  import { get } from 'svelte/store';

  let inputRef: HTMLTextAreaElement;
  let fileInputRef: HTMLInputElement;
  let message = $state('');
  let _iterCandidate: string | null = $state(null);
  let isDraggingFile = $state(false);

  let canSend = $derived($currentBuffer && message.trim().length > 0);

  function handleSend() {
    if (!canSend) return;

    const text = message.trim();
    
    // Handle /buffer clear command
    if (/^\/buffer\s+clear\s*$/i.test(text)) {
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
      message = '';
      if (inputRef) {
        inputRef.style.height = 'auto';
      }
      return;
    }
    
    sendMessage(text);

    if ($currentBuffer) {
      addToHistory($currentBuffer.id, text);
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

  async function handleFileUpload(file: File): Promise<void> {
    try {
      const result = await uploadImage(file, (percent) => {
        // Progress callback — could show progress bar
        void percent;
      });
      // Insert URL at cursor position
      const caret = getCaretPos();
      message = message.slice(0, caret) + result.link + message.slice(caret);
      setTimeout(() => setCaretPos(caret + result.link.length), 0);
    } catch (err) {
      console.error('Image upload failed:', err);
    }
  }

  function handleFileInputChange() {
    const files = fileInputRef?.files;
    if (!files) return;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file) {
        void handleFileUpload(file);
      }
    }
    fileInputRef.value = '';
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    isDraggingFile = false;

    const files = e.dataTransfer?.files;
    if (!files) return;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file && file.type.match(/image.*/)) {
        void handleFileUpload(file);
      }
    }
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    isDraggingFile = true;
  }

  function handleDragEnd() {
    isDraggingFile = false;
  }

  $effect(() => {
    if ($currentBuffer) {
      inputRef?.focus();
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
      ondrop={handleDrop}
      ondragover={handleDragOver}
      ondragleave={handleDragEnd}
      ondragend={handleDragEnd}
      data-testid="message-input"
      placeholder={$currentBuffer ? `Message: ${$currentBuffer.shortName}` : 'Select a buffer to start chatting...'}
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
      onclick={() => { if (inputRef) { const caret = getCaretPos(); const result = completeNick(message, caret); if (result) { message = result.text; setTimeout(() => setCaretPos(result.cursor), 0); } } }}
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
