<script lang="ts">
  import type { BufferLine, PluginMetadata } from '$lib/types';
  import { tokenizeAndCodify, type TokenGroup } from '$lib/linkTokens';
  import TokenGroupRenderer from '$components/TokenGroupRenderer.svelte';
  import PluginEmbed from '$components/PluginEmbed.svelte';
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Minus from '@lucide/svelte/icons/minus';
  import { detectPrefixIcon, type PrefixIconType } from '$lib/utils/prefixIcons';
  import { imageExts, videoExts, audioExts, normalizeImageUrl } from '$lib/utils/mediaExtensions';
  import { detectEmbedUrl } from '$lib/utils/urlEmbeds';
  import { get } from 'svelte/store';
  import { settings } from '$lib/stores/settings';

  let {
    message,
    index,
    messages,
    noembed,
    bubbleMode = false,
    otherNick = '',
    myNick = '',
    onMention
  }: {
    message: BufferLine;
    index: number;
    messages: BufferLine[];
    noembed: boolean;
    bubbleMode?: boolean;
    otherNick?: string;
    myNick?: string;
    onMention?: (msg: BufferLine) => void;
  } = $props();

  let previousMessage = $derived(index > 0 ? messages[index - 1] : null);
  let isDateChange = $derived(isDateChangeMessage(message));
  let isRepeatedTime = $derived(
    !isDateChange && previousMessage && message.shortTime === previousMessage.shortTime
  );
  let isRepeatedPrefix = $derived(
    !isDateChange && previousMessage && message.prefixtext === previousMessage.prefixtext
  );
  let isHighlight = $derived(message.highlight);
  let metadata = $derived(buildMetadata());

  // Extract nick from prefix text, stripping angle brackets (e.g. "<gbbot123>" → "gbbot123").
  function extractNick(prefixText: string): string {
    const trimmed = prefixText.trim();
    const match = trimmed.match(/^<(.+)>$/);
    return match ? match[1]! : trimmed;
  }

  // Nick of the message sender extracted from prefix.
  let msgNick = $derived(extractNick(message.prefixtext).toLowerCase());

  // Self message: prefix matches my nick or has irc_selfmsg tag.
  let isSelfMessage = $derived(
    (message.tags && message.tags.includes('irc_selfmsg')) ||
    (bubbleMode && myNick && msgNick === myNick.toLowerCase())
  );

  // Other message: prefix matches the other participant's nick.
  let isOtherMessage = $derived(
    bubbleMode && otherNick && msgNick === otherNick.toLowerCase()
  );

  // Middle (server/status) message: anything that isn't self, other, or a date separator.
  // Catches quit notices, join/part events, disconnect messages, etc.
  let isMiddle = $derived(
    !isDateChange && !isSelfMessage && !isOtherMessage
  );

  // Previous message classification for grouping logic.
  let prevIsSelf = $derived(previousMessage ? (
    (previousMessage.tags && previousMessage.tags.includes('irc_selfmsg')) ||
    (bubbleMode && myNick && extractNick(previousMessage.prefixtext).toLowerCase() === myNick.toLowerCase())
  ) : false);
  let prevIsMiddle = $derived(previousMessage ? (
    !isDateChangeMessage(previousMessage) &&
    !(previousMessage.tags && previousMessage.tags.includes('irc_selfmsg')) &&
    !(bubbleMode && myNick && extractNick(previousMessage.prefixtext).toLowerCase() === myNick.toLowerCase()) &&
    !(bubbleMode && otherNick && extractNick(previousMessage.prefixtext).toLowerCase() === otherNick.toLowerCase())
  ) : false);

  // Determine if this message starts a new visual group.
  // A group starts when: first message, date separator, or type changed (self↔other↔middle).
  let isGroupStart = $derived(
    index === 0 ||
    (previousMessage && isDateChangeMessage(previousMessage)) ||
    isMiddle ||
    (previousMessage && isSelfMessage !== prevIsSelf) ||
    (previousMessage && isMiddle !== prevIsMiddle)
  );

  const urlRegex = /(?:(?:https?|ftp):\/\/|www\.|ftp\.)\S*[^\s.;,(){}<>[\]]/gi;

  // Extract embeddable URLs from message text and build plugin metadata for each.
  function buildMetadata(): PluginMetadata[] {
    if (!message.text) {
      return [];
    }
    const urls = message.text.match(urlRegex);
    if (!urls) {
      return [];
    }
    const result: PluginMetadata[] = [];
    for (const rawUrl of urls) {
      const url = rawUrl.trim();
      let name: string | null = null;
      let content: string | (() => void) = '';

      if (imageExts.test(url)) {
        name = 'Image';
        content = normalizeImageUrl(url);
      } else if (videoExts.test(url)) {
        name = 'Video';
        content = url;
      } else if (audioExts.test(url)) {
        name = 'Audio';
        content = url;
      } else {
        const embedMatch = detectEmbedUrl(url);
        if (embedMatch) {
          name = embedMatch.name;
          content = url;
        }
      }

      if (name) {
        if (get(settings).debugBuildMetadata) {
          console.log(`[buildMetadata] url="${url}" name="${name}" content="${content}" nsfw=${/nsfw/i.test(message.text)}`);
        }
        result.push({
          content,
          nsfw: /nsfw/i.test(message.text),
          name,
          className: '',
          visible: !noembed
        });
      }
    }
    return result;
  }

  function isDateChangeMessage(msg: BufferLine): boolean {
    // Detect by WeeChat formatting codes in prefix or text.
    if (msg.prefixtext.startsWith('\u0019') || msg.text.startsWith('\u0019')) return true;
    // Detect by common date separator patterns: "DayName (Month DD[, YYYY])" or "---".
    const t = msg.text.trim();
    if (/^(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\s*\(/i.test(t)) return true;
    if (/^[\u2500]+$/u.test(t)) return true;
    return false;
  }

  // Build token groups from message content for rendering.
  function getMessageTokenGroups(): TokenGroup[] {
      if (!message.content || message.content.length === 0) {
          const text = message.text || '';
          return text ? [{ classes: '', tokens: tokenizeAndCodify(text) }] : [];
      }
      return message.content.map(part => ({
          classes: (part.classes || []).join(' '),
          tokens: tokenizeAndCodify(part.text || '')
      })).filter(group => group.tokens.length > 0);
  }

  let tokenGroups = $derived(getMessageTokenGroups());

  function handleMention() {
      if (onMention) {
          onMention(message);
      }
  }

  function getIconType(part: { text: string }): PrefixIconType | null {
      return detectPrefixIcon(part.text);
  }

</script>

{#if bubbleMode}
  <!-- Bubble mode layout for private/query buffers -->
  {#if isDateChange}
    <!-- Date separator -->
    <div class="bubble-date-separator" data-testid="bufferline-row">
      <span class="bubble-date-text">
        <TokenGroupRenderer groups={tokenGroups} />
      </span>
    </div>
  {:else if isMiddle}
    <!-- Server/status message centered (not from either participant) -->
    <div class="bubble-middle-row" data-testid="bufferline-row">
      <div class={['bubble', { 'bubble-highlight': isHighlight }, 'bubble-middle-bg']}>
        <TokenGroupRenderer groups={tokenGroups} />
      </div>
    </div>
  {:else if isSelfMessage}
    <!-- Outgoing (self) — right-aligned -->
    <div class="bubble-row bubble-self" data-testid="bufferline-row">
      {#if isGroupStart}
        <div class="bubble-meta bubble-meta-self">
          <span class="bubble-nick">{message.prefixtext}</span>
          <span class="bubble-time">{message.shortTime}</span>
        </div>
      {/if}

      <div class={['bubble', { 'bubble-tail': isGroupStart }, { 'bubble-highlight': isHighlight }, 'bubble-self-bg']}>
        {#if metadata.length > 0}
          {#each metadata as meta, i (i)}
            <PluginEmbed plugin={meta} />
          {/each}
        {/if}

        <span dir="auto" class="message-content whitespace-pre-wrap break-words">
          <TokenGroupRenderer groups={tokenGroups} />
        </span>
      </div>
    </div>
  {:else}
    <!-- Incoming (other user) — left-aligned -->
    <div class="bubble-row bubble-other" data-testid="bufferline-row">
      {#if isGroupStart}
        <div class="bubble-meta bubble-meta-other">
          <span class="bubble-nick">{message.prefixtext}</span>
          <span class="bubble-time">{message.shortTime}</span>
        </div>
      {/if}

      <div class={['bubble', { 'bubble-tail': isGroupStart }, { 'bubble-highlight': isHighlight }, 'bubble-other-bg']}>
        {#if metadata.length > 0}
          {#each metadata as meta, i (i)}
            <PluginEmbed plugin={meta} />
          {/each}
        {/if}

        <span dir="auto" class="message-content whitespace-pre-wrap break-words">
          <TokenGroupRenderer groups={tokenGroups} />
        </span>
      </div>
    </div>
  {/if}
{:else}
  <!-- Traditional table layout for channels/servers -->
  {#if isDateChange}
    <tr class="bufferline date-change-row" data-testid="bufferline-row">
      <td colspan="3">
        <TokenGroupRenderer groups={tokenGroups} />
      </td>
    </tr>
  {:else}
    <tr class={['bufferline', { highlight: isHighlight }]} data-testid="bufferline-row">
      <td class="time">
        <span class="date compact-time" class:repeated-time={isRepeatedTime}>
          {#if message.shortTime.includes(':')}
            {@const parts = message.shortTime.split(':')}
            {parts[0]}<span class="time-delimiter">:</span>{parts.slice(1).join(':')}
          {:else}
            {message.shortTime}
          {/if}
        </span>
      </td>
      <td class="prefix">
        <span class="compact-prefix" class:repeated-prefix={isRepeatedPrefix}>
          <span onclick={handleMention} role="button" tabindex="0" class="mention-link" onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleMention(); } }}>
            {#if message.showHiddenBrackets}<span class="hidden-bracket">&lt;</span>{/if}
            {#each message.prefix as part, pi (pi)}
              {@const iconType = getIconType(part)}
              {#if iconType}
                {#if iconType === 'arrow-right'}
                  <ArrowRight class={(part.classes || []).join(' ')} width={12} height={12} />
                {:else if iconType === 'arrow-left'}
                  <ArrowLeft class={(part.classes || []).join(' ')} width={12} height={12} />
                {:else if iconType === 'chevron-left'}
                  <ChevronLeft class={(part.classes || []).join(' ')} width={12} height={12} />
                {:else if iconType === 'chevron-right'}
                  <ChevronRight class={(part.classes || []).join(' ')} width={12} height={12} />
                {:else if iconType === 'minus'}
                  <Minus class={(part.classes || []).join(' ')} width={12} height={12} />
                {/if}
              {:else}
                <span class="prefix-part {(part.classes || []).join(' ')}">{part.text}</span>
              {/if}
            {/each}
            {#if message.showHiddenBrackets}<span class="hidden-bracket">&gt;</span>{/if}
          </span>
        </span>
      </td>
      <td class="message" data-message={message.text}>
        <!-- Plugin embeds -->
        {#if metadata.length > 0}
          {#each metadata as meta, i (i)}
            <PluginEmbed plugin={meta} />
          {/each}
        {/if}

        <!-- Message content -->
        <span dir="auto" class="message-content whitespace-pre-wrap break-words">
          <TokenGroupRenderer groups={tokenGroups} />
        </span>
      </td>
    </tr>
  {/if}
{/if}

<style>
  /* ===== Traditional table layout styles ===== */
  .bufferline {
    line-height: var(--gb-line-height, 1.2);
    padding: 2px 0 1px 0;
  }



  .time {
    text-align: right;
    padding: 0 2px 0 6px;
    vertical-align: top;
    font-size: var(--font-size, 14px);
    font-family: var(--font-mono, monospace);
  }

  .time .compact-time {
    display: inline-flex;
    align-items: center;
  }

  @media (max-width: 640px) {
    .bufferline {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
    }

    .time, .prefix, .message {
      display: inline-flex;
      width: auto;
      max-width: none;
      padding: 0;
      vertical-align: top;
      border: none;
      font-size: var(--font-size, 14px);
      font-family: var(--font-mono, monospace);
    }

    .time {
      margin-right: 2px;
      padding-left: 4px;
    }

    .prefix {
      border-right: none;
      white-space: normal;
      text-align: left;
      overflow: visible;
      text-overflow: clip;
      padding: 0 3px 0 1px;
    }

    .prefix .compact-prefix {
      justify-content: flex-start;
      align-items: center;
    }

    .message {
      flex: 1;
      min-width: 0;
      flex-wrap: wrap;
      padding-left: 3px;
    }
  }

  .time .compact-time.repeated-time {
    color: var(--gb-repeated-time, #444);
    visibility: visible;
  }

  .date .time-delimiter {
    color: #cc843b;
  }

  .compact-time.repeated-time .time-delimiter {
    color: #666;
  }

  .prefix {
    max-width: 120px;
    padding: 0 4px 0 2px;
    vertical-align: top;
    white-space: nowrap;
    text-align: right;
    border-right: 1px solid var(--gb-border, var(--color-border));
    overflow: hidden;
    text-overflow: ellipsis;
    box-sizing: border-box;
    font-family: var(--font-mono, monospace);
    font-size: var(--font-size, 14px);
  }

  .prefix .compact-prefix {
    display: flex;
    justify-content: flex-end;
    align-items: center;
  }

  .prefix .compact-prefix.repeated-prefix {
    visibility: visible;
  }

  .message {
    padding: 1px 2px 1px 4px;
    vertical-align: middle;
    white-space: preserve-breaks;
    word-break: break-word;
    font-size: var(--font-size, 14px);
    font-family: var(--font-mono, monospace);
  }

  /* Global to reach into TokenGroupRenderer */
  :global(.irc-link) {
    color: oklch(62.3% 0.06 255);
    text-decoration: none;
  }

  :global(.irc-link:hover) {
    color: oklch(65% 0.12 255);
    text-decoration: underline;
  }

  :global(.irc-code) {
    font-family: var(--font-mono, monospace);
    background: var(--gb-inline-code-bg, rgba(255, 255, 255, 0.1));
    padding: 0 2px;
    border-radius: 2px;
  }

  /* ===== Bubble mode styles ===== */
  .bubble-row {
    display: flex;
    flex-direction: column;
    padding: 2px 0;
  }

  /* Meta row (nick + time) above bubble */
  .bubble-meta {
    display: flex;
    gap: 6px;
    align-items: baseline;
    font-size: 0.7em;
    line-height: 1.2;
    margin-bottom: 3px;
  }

  .bubble-meta-other {
    padding-left: 6px;
  }

  .bubble-meta-self {
    padding-right: 6px;
    justify-content: flex-end;
  }

  .bubble-nick {
    font-weight: 600;
    color: var(--gb-bubble-meta-color, var(--gb-text-muted));
  }

  .bubble-time {
    color: var(--gb-bubble-meta-color, var(--gb-text-muted));
    opacity: 0.8;
  }

  /* Bubble container alignment */
  .bubble-self {
    align-items: flex-end;
  }

  .bubble-other {
    align-items: flex-start;
  }

  /* Middle-aligned system messages (join/quit/away notices) */
  .bubble-middle-row {
    display: flex;
    justify-content: center;
    padding: 4px 0;
  }

  /* Bubble itself — Signal-style rounded, no tails */
  .bubble {
    max-width: 85%;
    padding: 8px 14px;
    border-radius: 20px;
    line-height: 1.45;
    font-size: 0.95em;
    position: relative;
    word-break: break-word;
  }

  /* Self-sent bubble: solid accent background, light text */
  .bubble-self-bg {
    background: var(--gb-bubble-self-bg, #4a90d9);
    color: var(--gb-bubble-self-text, #ffffff);
  }

  /* Other's bubble: solid distinct background, bright text */
  .bubble-other-bg {
    background: var(--gb-bubble-other-bg, var(--gb-surface-raised));
    color: var(--gb-bubble-other-text, var(--gb-text));
  }

  /* Middle-aligned system message bubble: solid, narrower, fully rounded */
  .bubble-middle-bg {
    background: var(--gb-bubble-middle-bg, var(--gb-border));
    color: var(--gb-bubble-middle-text, var(--gb-text-secondary));
    max-width: 70%;
    border-radius: 18px;
    padding: 6px 14px;
    font-size: 0.85em;
  }

  /* Highlight indicator on bubble */
  .bubble-highlight {
    box-shadow: 0 0 0 2px var(--gb-bubble-highlight-border, var(--gb-accent));
  }

  /* Date separator in bubble mode */
  .bubble-date-separator {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 14px 0;
    gap: 14px;
  }

  .bubble-date-separator::before,
  .bubble-date-separator::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--gb-border, #333);
  }

  .bubble-date-text {
    color: var(--gb-text-muted, #666);
    font-size: 0.7em;
    white-space: nowrap;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  /* Adjust links inside bubbles (global to reach into TokenGroupRenderer) */
  :global(.bubble .irc-link) {
    color: oklch(75% 0.15 250);
    text-decoration: underline;
  }

  :global(.bubble-self-bg .irc-link) {
    color: oklch(85% 0.05 220);
  }

  /* Adjust inline code in bubbles (global to reach into TokenGroupRenderer) */
  :global(.bubble .irc-code) {
    background: var(--gb-bubble-code-bg, rgba(255, 255, 255, 0.2));
    padding: 1px 4px;
    border-radius: 4px;
  }

  :global(.bubble-other-bg .irc-code) {
    background: var(--gb-bubble-code-bg-other, rgba(0, 0, 0, 0.15));
  }

  /* Reset WeeChat background color classes inside chat bubbles (global to reach into TokenGroupRenderer) */
  :global(.bubble [class*="cwb-"]),
  :global(.bubble [class*="ceb-"]),
  :global(.bubble [class*="cob-"]) {
    background-color: transparent !important;
  }

</style>
