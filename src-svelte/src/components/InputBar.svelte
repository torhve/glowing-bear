<script lang="ts">
  import { buffers, pendingBufferSwitch, setActiveBuffer, findBufferByShortName, newPendingSwitch } from '#lib/stores/models.ts';
  import { sendMessage, sendWeeChatCommand, getSession, getActiveTransport, requestLegacyCompletion } from '#lib/stores/connectionManager.ts';
  import { chatDisplay } from '#lib/stores/chatPresentation.ts';
  import { requestCompletion, rankCandidates, completionInsert } from '#lib/api/api-features.ts';
  import { cycleKey, entryIndex, stepIndex, type CompletionCycle, type CompletionDirection } from '#lib/completionCycle.ts';
  import { settings } from '#lib/stores/settings.ts';
  import { addToHistory, getHistoryUp, getHistoryDown } from '#lib/stores/inputHistory.ts';
  import { isPopoverOpen, filterImageFiles, joinMultilineToSingle, MULTILINE_PASTE_THRESHOLD, completeNick } from '#lib/utils.ts';
  import Send from '@lucide/svelte/icons/send';
  import { emojifyInput } from '#lib/emojify.ts';
  import { tick, untrack } from 'svelte';
  import Camera from '@lucide/svelte/icons/camera';
  import Megaphone from '@lucide/svelte/icons/megaphone';
  import Type from '@lucide/svelte/icons/type';
  import { get } from 'svelte/store';
  import ImageUploadPreview from './ImageUploadPreview.svelte';
  import MultiLinePasteDialog from './MultiLinePasteDialog.svelte';
  import { DEBUG_INPUT } from '#lib/debug.ts';
  import { addToast } from '#lib/toast.ts';
  import { activeConnectionProfile } from '#lib/connectionProfile.ts';
  import {
    applyDraftClaim,
    claimDraft,
    conversationKeyFor,
    readDraft,
    writeDraft,
    type DraftRef,
  } from '#lib/stores/conversationDrafts.ts';
  import { readChatScrollCommands } from '#lib/chatScrollContext.ts';

  // The chat viewport of this page, reached through context rather than a
  // document query: the composer expresses intent, the view moves the viewport.
  const chatScrollCommands = readChatScrollCommands();
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

  // Paste debugging — controlled by DEBUG_INPUT flag in #lib/debug
  function log(...args: unknown[]) { if (DEBUG_INPUT) console.log('[paste]', ...args); }

  let inputRef = $state<HTMLTextAreaElement>();
  let colorPickerRef = $state<HTMLDivElement | undefined>();
  let fileInputRef = $state<HTMLInputElement>();
  // Which conversation the text in this composer belongs to. Both halves are
  // required: no relay means no profile, and no buffer means no conversation, and
  // without either the composer holds text that cannot be filed anywhere.
  // The composer belongs to the conversation the reader can actually see. It used
  // to read `currentBuffer`, which a retained view does not have: the chat rendered
  // a conversation while the composer believed there was none, so the text being
  // typed had nowhere to be filed and the placeholder denied the screen above it.
  const current = $derived($chatDisplay.buffer);
  const isLive = $derived($chatDisplay.live);

  const profileKey = $derived($activeConnectionProfile?.key ?? null);
  const conversationKey = $derived(conversationKeyFor(current));
  const ownerRef = $derived<DraftRef | null>(
    profileKey && conversationKey ? { profileKey, conversationKey } : null,
  );

  // The same identity read without subscribing to it, for mount and for event
  // handlers that must not re-run on every buffer publication.
  function currentOwnerRef(): DraftRef | null {
    const relay = get(activeConnectionProfile)?.key ?? null;
    const conversation = conversationKeyFor(get(chatDisplay).buffer);
    return relay && conversation ? { profileKey: relay, conversationKey: conversation } : null;
  }

  // Seeded from the draft belonging to the conversation this bar mounts onto, so a
  // disconnect (which unmounts this component) does not discard a message the user
  // was still typing — and so a different conversation does not inherit it.
  const mountRef = currentOwnerRef();
  const mountDraft = mountRef ? readDraft(mountRef) : null;

  let message = $state(mountDraft?.text ?? '');
  // The conversation `message` belongs to. Text is saved under this key, never
  // under whatever is selected by the time an effect finally runs.
  let boundRef = $state<DraftRef | null>(mountRef);
  // A restored selection is applied once the restored text is in the textarea.
  let pendingSelection = $state<[number, number] | null>(
    mountDraft ? [mountDraft.selectionStart, mountDraft.selectionEnd] : null,
  );
  let _iterCandidate: string | null = $state(null);
  // Legacy command completion: WeeChat answers with the candidate list and the
  // exact span to replace, so the client only places a candidate and walks the
  // list while the composer still holds the text that list was asked for. The
  // span is carried forward instead of re-derived, because after a completion
  // the word sitting at the replacement point is the candidate the client put
  // there, not one the relay has ever seen.
  let _legacyCycle: CompletionCycle | null = null;
  // The API transport walks the same kind of cycle: the relay answered for the
  // word that was asked about, and re-asking after a candidate lands asks a
  // different question — a completed command plus a space is answered with
  // buffer names.
  let _apiCycle: CompletionCycle | null = null;
  let isDraggingFile = $state(false);
  let previewImages = $state<PreviewItem[]>([]);
  // Ref to ImageUploadPreview component for programmatic dialog show/hide
  let previewDialogRef = $state<{ dialog: HTMLDialogElement | undefined }>();
  // Pending text shown in the multi-line paste confirmation dialog (null = closed)
  let pendingMultiLineText = $state<string | null>(null);
  // The conversation a pending multi-line paste belongs to. A confirmation answered
  // after a switch would insert another chat's clipboard text into the one on screen.
  let pendingMultiLineOwner = $state<DraftRef | null>(null);
  // The conversation an image preview was collected for, so the links an upload
  // produces land in the draft they were pasted into.
  let previewOwner = $state<DraftRef | null>(null);
  // Ref to MultiLinePasteDialog component for programmatic dialog show/hide
  let multiLinePasteDialogRef = $state<{ dialog: HTMLDialogElement | undefined }>();
  let nextImageId = $state(1);

  let showColorPicker = $state(false);
  let showFormatToolbar = $state(false);
  // Last known cursor position — saved on input/blur so format buttons work reliably
  // even when clicking them causes the textarea to lose focus.
  let lastCaretPos = $state(0);

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

  // Liveness, not presence. A retained buffer is a real conversation with real
  // text in the composer, and it still cannot accept a send — presence alone would
  // read as permission.
  // Why the composer will not send, in the composer's own words rather than in a
  // toast elsewhere on the screen.
  let composerNotice = $state<string | null>(null);

  let canSend = $derived(isLive && current !== null && message.length > 0);

  // The explanation belongs to the attempt that failed, so it clears when the
  // composer becomes able to answer — a notice left standing after a successful
  // reconnect would describe a connection that no longer exists.
  $effect(() => {
    if (isLive && composerNotice !== null) composerNotice = null;
  });

  // The hint has to describe the screen the reader is looking at. Naming the
  // conversation is true in both states; claiming no buffer is selected is not
  // true in a retained view, and claiming the message will be sent is not true
  // either.
  const composerPlaceholder = $derived(
    current === null
      ? 'Select a buffer to start chatting...'
      : isLive
      ? `Message ${current.shortName}`
      : `Message ${current.shortName} — kept while reconnecting`,
  );

  function sameOwner(a: DraftRef | null, b: DraftRef | null): boolean {
    if (a === null || b === null) return a === b;
    return a.profileKey === b.profileKey && a.conversationKey === b.conversationKey;
  }

  /**
   * File what the composer holds under the conversation it belongs to.
   *
   * Called from the input event, so a keystroke is persisted before any effect gets
   * a chance to run, and from the mirror below, so programmatic edits — completion,
   * formatting, history recall, paste, send recovery — are persisted too. A save that
   * would change nothing is a no-op, so the two paths do not echo each other.
   */
  function persistDraft(text: string): void {
    const ref = boundRef;
    if (!ref) return;
    const start = inputRef?.selectionStart ?? lastCaretPos;
    const end = inputRef?.selectionEnd ?? lastCaretPos;
    writeDraft(ref, text, start, end);
  }

  /**
   * Put text back where it belongs after a send that did not consume it.
   *
   * The composer may have moved on while the socket was answering: the reader
   * switched conversations, or typed. Failed lines go to the conversation they were
   * typed in, never into whatever is on screen now, and text the reader produced in
   * the meantime stays below them.
   */
  function returnToComposer(ref: DraftRef | null, text: string): void {
    if (!ref) return;
    if (sameOwner(boundRef, ref)) {
      const typedDuringSend = message;
      message = text + (typedDuringSend ? '\n' + typedDuringSend : '');
      return;
    }
    const existing = readDraft(ref);
    const merged = existing?.text ? `${text}\n${existing.text}` : text;
    writeDraft(ref, merged, merged.length, merged.length);
  }

  $effect(() => {
    persistDraft(message);
  });

  // Rebind the composer when the conversation or the relay changes. The outgoing
  // text is saved under its own owner *before* anything is loaded, so a switch
  // cannot file one chat's draft under another's — `boundRef`, not the currently
  // selected buffer, decides where it went.
  $effect(() => {
    const target = ownerRef;
    const previous = untrack(() => boundRef);
    if (sameOwner(previous, target)) return;
    if (previous) persistDraft(untrack(() => message));
    // A pending multi-line confirmation is a question asked in the outgoing
    // conversation. Carrying it across the switch would answer a question the reader
    // no longer has on screen, so it is cancelled without inserting anything.
    if (pendingMultiLineText !== null && !sameOwner(target, pendingMultiLineOwner)) {
      pendingMultiLineText = null;
      pendingMultiLineOwner = null;
      multiLinePasteDialogRef?.dialog?.hidePopover();
    }
    boundRef = target;
    // Completion cycling belongs to one conversation's text; carrying it into another
    // would make Tab continue a list the reader is no longer looking at.
    _iterCandidate = null;
    _legacyCycle = null;
    _apiCycle = null;

    const entry = target ? readDraft(target) : null;
    message = entry?.text ?? '';
    pendingSelection = entry ? [entry.selectionStart, entry.selectionEnd] : null;
  });

  // Apply a restored selection once the text it belongs to has reached the textarea.
  // Waiting for the flush is what makes the ordering hold: when the rebind effect
  // writes both the text and the selection, this effect runs *before* the render
  // that puts the text in the DOM, and setting a selection on a textarea that is
  // about to be rewritten is pointless — writing `value` moves the caret to the end.
  $effect(() => {
    const selection = pendingSelection;
    if (!selection) return;
    pendingSelection = null;
    const owner = boundRef;
    void tick().then(() => {
      // A switch during the wait means this selection belongs to a conversation the
      // composer no longer holds; applying it would move the caret in the wrong one.
      if (!inputRef || !sameOwner(boundRef, owner)) return;
      inputRef.setSelectionRange(selection[0], selection[1]);
      syncInputHeight();
    });
  });

  // Clear all messages from a buffer, resetting lines and requestedLines count.
  function clearBufferMessages(bufferId: string) {
    const current = get(buffers);
    const buf = current[bufferId];
    if (!buf) return;
    const updated = { ...current };
    updated[bufferId] = { ...buf, lines: [], requestedLines: 0 };
    buffers.set(updated);
  }

  async function handleSend() {
    if (message.length === 0) return;

    // Refused before the composer is emptied. The send below clears the textarea
    // before the round-trip, so a refusal that happens after that point has
    // already taken the text — and Enter reaches this function even though the
    // button beside it is disabled, so the refusal has to explain itself here.
    if (!isLive || current === null) {
      composerNotice = 'Not connected — your text is kept.';
      return;
    }

    composerNotice = null;
    const text = message;

    // Everything this send may write — history, buffer clearing, the draft it came
    // from — belongs to the conversation Enter was pressed in. Reading the current
    // buffer after an await lets a switch during delivery land the result elsewhere.
    const sendRef = boundRef;
    const sendBuffer = get(chatDisplay).buffer;
    const sendBufferId = sendBuffer?.id ?? null;

    // Split the command into multiple commands based on line breaks (matching AngularJS behavior)
    const lines = text.split(/\r?\n/);

    // Lines the socket refused. Keeping them is the point: a failed send must not
    // silently discard what the user typed.
    const unsent: string[] = [];

    // Clear the input before the round-trip, as the legacy client did: a tall
    // multi-line textarea keeps the chat viewport short while the send is in
    // flight, so the line we just sent can pin the view to the shrunken
    // bottom and then be stranded ~one textarea height above the final one.
    // On failure the loop below restores the unsent text.
    message = '';
    if (inputRef) inputRef.style.height = 'auto';

    // Handle /buffer clear command on first line only
    if (/^\/buffer\s+clear\s*$/i.test(lines[0]!)) {
      // Clear locally only when the socket accepted the command — otherwise the buffer
      // looks emptied while its lines are still on the server. The command is aimed at
      // the buffer Enter was pressed in: `/buffer clear` with no argument clears the
      // buffer it is executed on, so aiming it at core would empty the wrong one.
      if (sendBuffer && await sendWeeChatCommand('/buffer clear', sendBufferId!)) {
        clearBufferMessages(sendBufferId!);
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

      // Handle /q and /query: switch to existing buffer or set pending for new buffer
      const queryMatch = line.match(/^\/(?:q|query)\s+(\S+)/i);
      if (queryMatch) {
        const nick = queryMatch[1] ?? '';
        // Only the buffer in the current IRC server context is the intended target
        // — the same nick can be queried on two servers at once.
        const serverContext = sendBuffer?.server ? sendBuffer.server : null;
        // Find existing query/private buffer matching the nick (case-insensitive)
        const existingBuf = findBufferByShortName(nick, ['query', 'private'], serverContext);
        if (existingBuf) {
          // Buffer exists — switch immediately
          setActiveBuffer(existingBuf.id);
        } else {
          // Buffer doesn't exist yet — set pending so the transport auto-switches
          // on buffer_opened once WeeChat creates it.
          pendingBufferSwitch.set(nick ? newPendingSwitch(nick, serverContext) : null);
        }
      }

      // History records only what the socket accepted, so ArrowUp never offers back a
      // line that was not sent.
      if (await sendMessage(line)) {
        if (sendBufferId) addToHistory(sendBufferId, line);
      } else {
        unsent.push(line);
      }
    }

    // The composer was emptied before the round-trip, so anything in it now was
    // typed during delivery or belongs to a conversation the reader moved to. Both are
    // the reader's, and a completed send has no claim on either.
    if (unsent.length === 0) {
      if (text === '/c' && sendBufferId) {
        clearBufferMessages(sendBufferId);
      }
    } else {
      // Put back exactly the lines that failed, and say so instead of failing silently.
      // The wording stays generic: the socket can be closing even while `connected` is true.
      returnToComposer(sendRef, unsent.join('\n'));
      addToast('Message could not be sent — your text was kept', { type: 'warning', duration: 5000 });
    }

    if (inputRef) {
      if (unsent.length === 0) {
        inputRef.style.height = 'auto';
        // Keep focus off a send that finished; the composer is empty.
        inputRef.blur();
      } else {
        // Keep focus on a failed send so the text can be corrected and retried, and
        // size the textarea for the text that came back.
        syncInputHeight();
      }
    }
  }


  // Relay API completion (G2 strategy): server candidates, locally re-ranked
  // by nick recency. Candidates already embed the configured completer suffix;
  // add_space means a space must follow. The list is asked for once and then
  // walked, because re-asking after a candidate has landed asks a different
  // question — the relay answers a completed command with buffer names.
  async function completeViaApi(text: string, caretPos: number, direction: CompletionDirection): Promise<{ text: string; cursor: number; iterCandidate: string | null } | null> {
    const session = getSession();
    const { buffer, live } = get(chatDisplay);
    // `live` is stated explicitly rather than inferred from a missing apiBufferId:
    // a retained buffer has no authority fields anyway, but a guard that only
    // notices when they are absent would quietly reopen if the session lifecycle
    // ever changed.
    if (!live || !session || !buffer || buffer.apiBufferId === undefined) return null;
    const key = cycleKey(text, buffer.id);
    let cycle = _apiCycle && _apiCycle.key === key ? _apiCycle : null;
    let index: number;
    if (!cycle) {
      const res = await requestCompletion(session, {
        bufferId: buffer.apiBufferId as never,
        command: text,
        cursor: caretPos,
      });
      if (!res.ok || res.candidates.length === 0) return null;
      const spokeAt: Record<string, number> = {};
      for (const nickKey in buffer.nicklist) {
        for (const nick of buffer.nicklist[nickKey]!.nicks) {
          spokeAt[nick.name.toLowerCase()] = nick.spokeAt ?? 0;
        }
      }
      index = entryIndex(res.candidates.length, direction);
      cycle = {
        key,
        // Server candidates, locally re-ranked by nick recency.
        candidates: rankCandidates(res.candidates, spokeAt),
        addSpace: res.addSpace,
        index,
        start: res.replaceStart,
        end: res.replaceEnd,
        context: res.context,
      };
    } else {
      index = stepIndex(cycle, direction);
    }
    const candidate = cycle.candidates[index]!;
    const insert = completionInsert(candidate, cycle.addSpace, cycle.context);
    const resultText = text.slice(0, cycle.start) + insert + text.slice(cycle.end);
    // One candidate is a finished completion, not a list to keep walking: the
    // cycle is dropped so the next Tab asks the relay about the new word.
    _apiCycle = cycle.candidates.length > 1
      ? { ...cycle, key: cycleKey(resultText, buffer.id), index, end: cycle.start + insert.length }
      : null;
    return {
      text: resultText,
      cursor: cycle.start + insert.length,
      iterCandidate: candidate,
    };
  }


  async function completeViaLegacyCommand(
    text: string,
    caretPos: number,
    direction: CompletionDirection,
  ): Promise<{ text: string; cursor: number; iterCandidate: string | null } | null> {
    const { buffer, live } = get(chatDisplay);
    if (!live || !buffer) return null;
    const key = cycleKey(text, buffer.id);
    let cycle = _legacyCycle && _legacyCycle.key === key ? _legacyCycle : null;
    let index: number;
    if (!cycle) {
      const res = await requestLegacyCompletion(buffer.id, caretPos, text);
      if (!res) return null;
      index = entryIndex(res.candidates.length, direction);
      cycle = {
        key,
        candidates: res.candidates,
        addSpace: res.addSpace,
        index,
        start: Math.min(res.replaceStart, text.length),
        end: Math.min(res.replaceEnd, text.length),
        context: '',
      };
    } else {
      index = stepIndex(cycle, direction);
    }
    const candidate = cycle.candidates[index]!;
    const insert = candidate + (cycle.addSpace ? ' ' : '');
    const resultText = text.slice(0, cycle.start) + insert + text.slice(cycle.end);
    // One candidate is a finished completion, not a list to keep walking: the
    // cycle is dropped so the next Tab asks the relay about the new word.
    _legacyCycle = cycle.candidates.length > 1
      ? { ...cycle, key: cycleKey(resultText, buffer.id), index, end: cycle.start + insert.length }
      : null;
    return {
      text: resultText,
      cursor: cycle.start + insert.length,
      iterCandidate: candidate,
    };
  }


  // Transport-aware completion: the API relay answers via /api/completion; the
  // legacy transport asks the relay for command candidates and uses the
  // client-side matcher for nicks (nick_completer read from wconfig during the
  // legacy handshake).
  async function completeInput(text: string, caretPos: number, direction: CompletionDirection): Promise<{ text: string; cursor: number; iterCandidate: string | null } | null> {
    if (getActiveTransport() === 'legacy') {
      // A leading slash is a command, and only WeeChat knows which commands
      // exist — custom aliases included. Anything else is a nick.
      if (text.startsWith('/')) return completeViaLegacyCommand(text, caretPos, direction);
      return completeNick(text, caretPos, _iterCandidate);
    }
    return completeViaApi(text, caretPos, direction);
  }

  function getCaretPos(): number {
    return inputRef?.selectionStart ?? 0;
  }

  function setCaretPos(pos: number) {
    if (inputRef) {
      inputRef.setSelectionRange(pos, pos);
    }
  }

  /**
   * Move the caret on the next task, but only while the composer still holds the
   * conversation the offset was measured in. A deferred offset from another
   * conversation's text would land somewhere arbitrary in this one.
   */
  function restoreCaretIfOwned(ref: DraftRef | null, position: number): void {
    setTimeout(() => {
      if (!sameOwner(boundRef, ref)) return;
      setCaretPos(position);
    }, 0);
  }

  /**
   * Add text to a conversation that is not on screen.
   *
   * Appended to whatever that draft says now, never spliced in with an offset
   * captured before the reader kept editing it.
   */
  function appendToDraft(ref: DraftRef, text: string): void {
    const existing = readDraft(ref);
    const merged = existing?.text ? `${existing.text} ${text}` : text;
    writeDraft(ref, merged, merged.length, merged.length);
  }

  // Toolbar and picker buttons must not steal focus from the textarea: mousedown would
  // blur it and collapse its caret, so the control char would land at the wrong place.
  function keepFocusOnInput(e: MouseEvent): void {
    e.preventDefault();
  }

  // Insert text at current cursor position, then advance cursor past inserted text.
  // Uses lastCaretPos (tracked on input/blur) so it works after textarea loses focus on button click.
  // When forceFocus is true, focuses the textarea before inserting (used by global paste handler).
  async function insertAtCursor(text: string, forceFocus = false): Promise<void> {
    const caret = inputRef === document.activeElement ? getCaretPos() : lastCaretPos;
    const ownerAtInsert = boundRef;
    message = message.slice(0, caret) + text + message.slice(caret);
    if (forceFocus) {
      inputRef?.focus();
    }
    // tick() moves the caret in the same flush that writes the new value into the
    // textarea. A setTimeout(0) here left a window where a keystroke landed at the
    // old caret and the deferred restore then split the typed text around it.
    await tick();
    // The caret belongs to the conversation the insertion was made in. If the reader
    // switched during the flush, this offset would move a caret through someone
    // else's text.
    if (!sameOwner(boundRef, ownerAtInsert)) return;
    setCaretPos(caret + text.length);
  }

  // Insert a bold/italic/underline mIRC control char at the cursor position.
  function toggleFormat(attr: 'bold' | 'italic' | 'underline'): void {
    if (!$settings.enableFormatting) return;
    const codes = { bold: '\x02', italic: '\x1d', underline: '\x1f' };
    insertAtCursor(codes[attr]);
    showFormatToolbar = false;
    inputRef?.focus();
  }

  // Insert an IRC color code (\x03NN) at the cursor position.
  function applyColor(colorCode: string): void {
    if (!$settings.enableFormatting) return;
    insertAtCursor(`\x03${colorCode}`);
    showColorPicker = false;
    showFormatToolbar = false;
    inputRef?.focus();
  }

  // Keyboard path into the color picker. Opening it hides the format toolbar, which
  // detaches the button that held focus, so Tab would restart at the top of the page
  // and the swatches would never be reached. Focus the first swatch instead.
  async function focusFirstColorSwatch(): Promise<void> {
    if (!showColorPicker) return;
    await tick();
    // The picker can be closed during the flush; focusing a swatch that is gone
    // would move focus out of a composer the reader is still using.
    if (!showColorPicker) return;
    colorPickerRef?.querySelector<HTMLButtonElement>('button')?.focus();
  }

  // Escape leaves the picker and hands focus back to the input it came from.
  function closeColorPickerFromKeyboard(): void {
    showColorPicker = false;
    showFormatToolbar = false;
    inputRef?.focus();
  }

  // Insert the mIRC reset code (\x0f) at the cursor position to clear formatting.
  function insertReset(): void {
    if (!$settings.enableFormatting) return;
    insertAtCursor('\x0f');
    showFormatToolbar = false;
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
        void focusFirstColorSwatch();
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
      void runCompletion();
      return true;
    }

    // Shift-Tab -> walk the command list the previous Tab produced, backwards
    if (code === 9 && !e.altKey && !e.ctrlKey && e.shiftKey) {
      e.preventDefault();
      void runCompletion('backward');
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
      if (current) {
        message = getHistoryUp(current.id, message);
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
      if (current) {
        message = getHistoryDown(current.id, message);
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

    // Page up -> ask the chat view to scroll up one screen
    if (e.type === 'keydown' && code === 33 && document.activeElement === inputRef && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      chatScrollCommands.current?.pageScroll(-1);
      return true;
    }

    // Page down -> ask the chat view to scroll down one screen
    if (e.type === 'keydown' && code === 34 && document.activeElement === inputRef && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      chatScrollCommands.current?.pageScroll(1);
      return true;
    }
  }

  // Grow the textarea with its content, capped at the height the CSS allows.
  function syncInputHeight(): void {
    if (!inputRef) return;
    inputRef.style.height = 'auto';
    inputRef.style.height = Math.min(inputRef.scrollHeight, 150) + 'px';
  }

  function handleInput() {
    if (inputRef) {
      syncInputHeight();
      // Save cursor position so format buttons work after textarea loses focus.
      lastCaretPos = inputRef.selectionStart;
    }
    // Persist from the event itself: the DOM value is the truth at this moment, and
    // an effect flush must not be the only thing standing between a keystroke and a
    // teardown.
    persistDraft(inputRef?.value ?? message);
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
    // Every upload path funnels through here — paste, drop, the file picker, and
    // the clipboard-string fallback — so this is the one place the answer has to
    // live. An image preview that cannot be sent is a draft the user assembled
    // for a session that is not there; saying so at the moment of the attempt is
    // cheaper than letting it sit in the composer looking ready.
    if (!isLive) {
      composerNotice = 'Not connected — images are kept until the relay is back';
      return;
    }
    // The conversation this clipboard content came from, captured before any async
    // read resolves.
    const pasteOwner = boundRef;
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
    previewOwner = pasteOwner;
    previewDialogRef?.dialog?.showPopover();

    inputRef?.focus();
  }

  // Insert uploaded URLs at cursor position, space-separated
  function handleInsertUrls(urls: string[]) {
    if (urls.length === 0) return;
    const urlsText = urls.join(' ');
    const owner = previewOwner;
    if (sameOwner(boundRef, owner)) {
      const caret = getCaretPos();
      message = message.slice(0, caret) + urlsText + message.slice(caret);
      restoreCaretIfOwned(owner, caret + urlsText.length);
    } else if (owner) {
      // The reader moved on while the upload ran. The links still belong to that
      // conversation, so they join its current draft instead of this one.
      appendToDraft(owner, urlsText);
    } else {
      // No conversation owns the composer, so there is no draft to file them under.
      message += urlsText;
    }
    onInsertUrls(urls);
  }

  /**
   * Run one completion and apply it only if nothing has overtaken it.
   *
   * Tab and the clickable completion control both come through here so neither can
   * apply a stale result. The claim is taken before the await; the result is rejected
   * if the draft moved, and it is only shown while the composer still belongs to the
   * conversation the completion was requested in.
   */
  async function runCompletion(direction: CompletionDirection = 'forward'): Promise<void> {
    // Shift-Tab walks a command list back; it does not start a nick completion.
    // A nick cycle has one candidate worth having and no order worth walking.
    if (direction === 'backward' && !message.startsWith('/')) return;
    const caretPos = getCaretPos();
    const ref = boundRef;
    const claim = ref ? claimDraft(ref) : null;
    const textAtRequest = message;
    const result = await completeInput(message, caretPos, direction);
    if (!result) {
      _iterCandidate = null;
      _legacyCycle = null;
      _apiCycle = null;
      return;
    }
    if (claim) {
      if (!applyDraftClaim(claim, result.text, result.cursor, result.cursor)) return;
    } else if (message !== textAtRequest) {
      // No conversation owns this composer, so there is no draft to claim against;
      // the text itself is the only evidence that the reader has since edited it.
      return;
    }
    if (sameOwner(boundRef, ref)) {
      message = result.text;
      restoreCaretIfOwned(ref, result.cursor);
    }
    _iterCandidate = result.iterCandidate;
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
    previewOwner = null;
    inputRef?.focus();
  }
  // True when a paste should trigger the multi-line confirmation dialog (threshold or more lines)
  function isMultiLinePaste(pastedText: string): boolean {
    return pastedText.split(/\r?\n/).length >= MULTILINE_PASTE_THRESHOLD;
  }

  // Show the multi-line paste confirmation dialog for the given pasted text
  function showMultiLinePasteDialog(pastedText: string) {
    pendingMultiLineText = pastedText;
    pendingMultiLineOwner = boundRef;
    multiLinePasteDialogRef?.dialog?.showPopover();
  }

  // Handle the user's choice in the multi-line paste dialog, then close it and refocus the input
  function finishMultiLinePaste(action: 'join' | 'separate' | 'cancel') {
    const text = pendingMultiLineText;
    const owner = pendingMultiLineOwner;
    pendingMultiLineText = null;
    pendingMultiLineOwner = null;
    multiLinePasteDialogRef?.dialog?.hidePopover();
    if (text === null) return;
    // The paste belongs to the conversation it was pasted into. Answering the
    // confirmation after a switch would put someone else's clipboard text here.
    if (!sameOwner(boundRef, owner)) return;
    if (action === 'join') {
      const joined = joinMultilineToSingle(text);
      if (joined.length > 0) {
        insertAtCursor(joined, true);
      }
    } else if (action === 'separate') {
      insertAtCursor(text, true);
    }
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
        if (isMultiLinePaste(pastedText)) {
          showMultiLinePasteDialog(pastedText);
          return;
        }
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
        if (isMultiLinePaste(pastedText)) {
          showMultiLinePasteDialog(pastedText);
          return;
        }
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

  // Close the color picker when the user presses outside the input bar.
  $effect(() => {
    if (!showColorPicker) return;
    function handlePressOutside(e: PointerEvent) {
      const inputBar = document.querySelector('[data-testid="input-bar"]');
      if (inputBar && !inputBar.contains(e.target as Node)) {
        showColorPicker = false;
        showFormatToolbar = false;
        document.removeEventListener('pointerdown', handlePressOutside);
      }
    }
    // Installed immediately, and keyed on pointerdown rather than click: the press that
    // opened the picker is already over by the time this listener exists, so there is
    // no window where an outside press is ignored. Keying it on click would need a
    // deferral, because opening the picker also hides the toolbar and detaches the
    // button that is still propagating that same click.
    document.addEventListener('pointerdown', handlePressOutside);
    return () => document.removeEventListener('pointerdown', handlePressOutside);
  });

  // Expose a reset function for E2E tests to clear message and formatting state
  $effect(() => {
    const win = window as typeof window & { __resetFormattingState?: () => void };
    win.__resetFormattingState = () => {
      message = '';
      pendingMultiLineText = null;
      pendingMultiLineOwner = null;
      multiLinePasteDialogRef?.dialog?.hidePopover();
      showColorPicker = false;
      showFormatToolbar = false;
      if (inputRef) {
        inputRef.value = '';
      }
    };
    return () => {
      delete win.__resetFormattingState;
    };
  });

  // Global paste listener — catches paste events when focus is NOT on the textarea,
  // inserts plain text at cursor position and focuses the input bar.
  $effect(() => {
    function handleGlobalPaste(e: ClipboardEvent) {
      // Skip if a popover/modal is open — let paste reach its natural target
      // (e.g. content search input, buffer search input, etc.)
      if (isPopoverOpen()) return;

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
      if (isMultiLinePaste(pastedText)) {
        showMultiLinePasteDialog(pastedText);
        return;
      }
      insertAtCursor(pastedText, true);
    }
    document.addEventListener('paste', handleGlobalPaste);
    return () => document.removeEventListener('paste', handleGlobalPaste);
  });
</script>

<div data-testid="input-bar" class="input-bar-container flex-shrink-0"
  style="padding-bottom: env(safe-area-inset-bottom, 0px);">

  <div class="input-bar-inner bg-panel border-t border-border"
    role="group"
  >

    <!-- Format toolbar — shown via toggle button, hidden on any format action -->
    {#if showFormatToolbar}
      <div
        class="format-toolbar"
        role="toolbar"
        aria-label="Text formatting"
        tabindex="-1"
        onmousedown={keepFocusOnInput}
      >
        <div class="flex items-center gap-1 px-1">
          <button
            type="button"
            data-testid="format-bold"
            onclick={() => { toggleFormat('bold'); showFormatToolbar = false; }}
            class="format-btn px-2 py-0.5 text-xs font-bold rounded border transition-colors bg-input-bg border-border text-text-secondary hover:text-text hover:border-text-secondary"
            title="Bold (Ctrl+B)"
          >B</button>
          <button
            type="button"
            data-testid="format-italic"
            onclick={() => { toggleFormat('italic'); showFormatToolbar = false; }}
            class="format-btn px-2 py-0.5 text-xs italic rounded border transition-colors bg-input-bg border-border text-text-secondary hover:text-text hover:border-text-secondary"
            title="Italic (Ctrl+I)"
          >I</button>
          <button
            type="button"
            data-testid="format-underline"
            onclick={() => { toggleFormat('underline'); showFormatToolbar = false; }}
            class="format-btn px-2 py-0.5 text-xs underline rounded border transition-colors bg-input-bg border-border text-text-secondary hover:text-text hover:border-text-secondary"
            title="Underline (Ctrl+_)"
          >U</button>
          <button
            type="button"
            data-testid="format-reset"
            onclick={() => { insertReset(); showFormatToolbar = false; }}
            class="format-btn px-2 py-0.5 text-xs rounded border transition-colors bg-input-bg border-border text-text-secondary hover:text-text hover:border-text-secondary font-mono"
            title="Reset formatting (Ctrl+Shift+R)"
          >RST</button>
          <button
            type="button"
            data-testid="format-color"
            onclick={() => { showColorPicker = !showColorPicker; showFormatToolbar = false; void focusFirstColorSwatch(); }}
            class="format-btn px-2 py-0.5 text-xs font-bold rounded border transition-colors bg-input-bg border-border text-text-secondary hover:text-text hover:border-text-secondary"
            title="Color (Ctrl+K)"
          >C</button>
        </div>
      </div>
    {/if}

    <div class="input-bar-row flex items-center space-x-2 sm:space-x-1">

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
          lastCaretPos = inputRef?.selectionStart ?? 0;
        }}
        data-testid="message-input"
        placeholder={composerPlaceholder}
        rows={1}
        class="input-bar-textarea flex-1 min-w-0 bg-input-bg border border-border rounded text-text text-sm placeholder-text-muted focus:outline-none focus:border-accent resize-none transition-colors min-h-9 max-h-[150px] {isDraggingFile ? 'border-accent bg-accent/10' : ''}"

      ></textarea>

      {#if $settings.enableFormatting}
        <button
          onclick={() => showFormatToolbar = !showFormatToolbar}
          data-testid="format-toggle"
          class="input-bar-format flex-shrink-0 hidden sm:inline-flex px-2 py-2 text-text-secondary hover:text-text hover:bg-border rounded transition-colors"
          title="Formatting"
        >
          <Type size={18} />
        </button>
      {/if}

      <button
        onclick={() => fileInputRef?.click()}
        data-testid="upload-image-button"
        class="input-bar-upload flex-shrink-0 px-2 py-2 text-text-secondary hover:text-text hover:bg-border rounded transition-colors"
        title="Upload image"
      >
        <Camera size={18} />
      </button>

      <button
        onclick={() => void runCompletion()}
        data-testid="nick-complete-button"
        class="input-bar-nickcomplete flex-shrink-0 hidden md:inline-flex px-2 py-2 text-text-secondary hover:text-text hover:bg-border rounded transition-colors"
        title="Complete nick"
      >
        <Megaphone size={18} />
      </button>

      <button
        onclick={handleSend}
        disabled={!canSend}
        data-testid="send-button"
        class="input-bar-send flex-shrink-0 px-3 py-2 bg-accent hover:bg-accent-hover disabled:bg-border disabled:cursor-not-allowed text-white rounded transition-colors btn-glow"
      >
        <Send size={16} />
      </button>
    </div>
    {#if composerNotice}
      <p class="composer-notice px-2 pb-1 text-xs text-warning" role="status" aria-live="polite" data-testid="composer-notice">{composerNotice}</p>
    {/if}
  </div>

  <!-- Color picker popover — rendered outside toolbar so it stays visible when toolbar hides -->
  {#if showColorPicker}
    <div
      class="color-picker-popover fixed bottom-20 left-4 p-2 bg-surface border border-border rounded shadow-lg z-50"
      role="group"
      aria-label="Text color"
      bind:this={colorPickerRef}
    >
      <div class="grid grid-cols-8 gap-1">
        {#each IRC_COLORS as color (color.code)}
          <button
            type="button"
            data-testid="color-{color.code}"
            onclick={() => applyColor(color.code)}
            onmousedown={keepFocusOnInput}
            onkeydown={(e) => {
              if (e.key !== 'Escape') return;
              // stopPropagation, not just preventDefault: +page.svelte listens for Escape on
              // the document, blurs whatever is focused, and treats a second Escape within
              // 500 ms as a disconnect. Handing focus back to the input and then letting that
              // handler see the same keypress would blur it straight back out.
              e.preventDefault();
              e.stopPropagation();
              closeColorPickerFromKeyboard();
            }}
            class="color-swatch w-7 h-7 rounded border border-border flex items-center justify-center text-xs font-mono hover:scale-110 transition-transform"
            style="background-color: {color.css}; color: {color.css === '#FFFFFF' || color.css === '#FFFF00' ? '#000000' : '#FFFFFF'};"
            title="{color.name} ({color.code})"
          >{color.code}</button>
        {/each}
      </div>
    </div>
  {/if}
</div>

<ImageUploadPreview
  bind:this={previewDialogRef}
  images={previewImages}
  onInsert={handleInsertUrls}
  onClose={closePreview}
/>

<MultiLinePasteDialog
  bind:this={multiLinePasteDialogRef}
  text={pendingMultiLineText ?? ''}
  onJoin={() => finishMultiLinePaste('join')}
  onSeparate={() => finishMultiLinePaste('separate')}
  onCancel={() => finishMultiLinePaste('cancel')}
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

  /* Reduced padding on small screens to prevent icon clipping */
  @media (max-width: 639px) {
    .input-bar-inner {
padding: var(--spacing-input-bar-padding-y, 3px) var(--spacing-input-bar-padding-x, 6px);
    }

    .input-bar-textarea {
padding: var(--spacing-textarea-padding-y, 6px) var(--spacing-textarea-padding-x, 8px);
    }
  }
</style>
