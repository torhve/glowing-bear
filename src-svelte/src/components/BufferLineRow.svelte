<script lang="ts">
  import type { BufferLine, EmbedCallbackContext, PluginMetadata } from '$lib/types';
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
  import { DEBUG_METADATA } from '$lib/debug';

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
      let content: string | ((this: EmbedCallbackContext) => void) = '';

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
          // TikTok embed requires async oembed fetch + document.write() script.
          // Return a callback function so PluginEmbed can execute it lazily
          // when the user clicks "Show".
          if (embedMatch.name === 'TikTok') {
            content = function() {
              const el = this.getElement();
              if (!el) return;
              // Fetch oembed HTML which contains the embed markup + script tag.
              // The script uses document.write(), so we load everything inside
              // a sandboxed srcdoc iframe for proper execution.
              fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`)
                .then((r) => r.json())
                .then((data) => {
                  const iframe = document.createElement('iframe');
                  iframe.className = 'embed';
                  iframe.width = '100%';
                  iframe.height = '650px';
                  iframe.frameBorder = '0';
                  iframe.sandbox = 'allow-scripts allow-popups';
                  // Combine the oembed HTML with the TikTok embed script.
                  // Break up <script> to prevent Svelte parser confusion.
                  iframe.srcdoc = data.html + `<scr` + `ipt src="https://www.tiktok.com/embed.js"></scr` + `ipt>`;

                  el.innerHTML = '';
                  el.appendChild(iframe);
                })
                .catch((e) => {
                  console.error('[TikTok embed] fetch failed:', e);
                });
            };
          }
          else {
            content = url;
          }
        }
      }

      if (name) {
        if (DEBUG_METADATA) {
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
    <div class="bubble-date-separator flex items-center justify-center" data-testid="bufferline-row">
      <span class="bubble-date-text text-[0.7em] whitespace-nowrap uppercase tracking-widest">
        <TokenGroupRenderer groups={tokenGroups} />
      </span>
    </div>
  {:else if isMiddle}
    <!-- Server/status message centered (not from either participant) -->
    <div class="bubble-middle-row flex justify-center" data-testid="bufferline-row">
      <div class={['bubble max-w-[70%] rounded-[18px] leading-[1.45] text-[0.85em] relative break-words', { 'bubble-highlight': isHighlight }, 'bubble-middle-bg']}>
        <TokenGroupRenderer groups={tokenGroups} />
      </div>
    </div>
  {:else if isSelfMessage}
    <!-- Outgoing (self) — right-aligned -->
    <div class="bubble-row flex flex-col bubble-self items-end" data-testid="bufferline-row">
      {#if isGroupStart}
        <div class="bubble-meta flex items-baseline pr-1.5 justify-end">
          <span class="bubble-nick font-semibold">{message.prefixtext}</span>
          <span class="bubble-time opacity-80">{message.shortTime}</span>
        </div>
      {/if}

      <div class={['bubble max-w-[85%] rounded-[20px] leading-[1.45] text-[0.95em] relative break-words', { 'bubble-tail': isGroupStart }, { 'bubble-highlight': isHighlight }, 'bubble-self-bg']}>
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
    <div class="bubble-row flex flex-col bubble-other items-start" data-testid="bufferline-row">
      {#if isGroupStart}
        <div class="bubble-meta flex items-baseline pl-1.5">
          <span class="bubble-nick font-semibold">{message.prefixtext}</span>
          <span class="bubble-time opacity-80">{message.shortTime}</span>
        </div>
      {/if}

      <div class={['bubble max-w-[85%] rounded-[20px] leading-[1.45] text-[0.95em] relative break-words', { 'bubble-tail': isGroupStart }, { 'bubble-highlight': isHighlight }, 'bubble-other-bg']}>
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
      <td class="time text-right align-top font-mono" style="width: 80px;">
        <span class="date inline-flex items-center compact-time" class:repeated-time={isRepeatedTime}>
          {#if message.shortTime.includes(':')}
            {@const parts = message.shortTime.split(':')}
            {parts[0]}<span class="time-delimiter text-amber-400">:</span>{parts.slice(1).join(':')}
          {:else}
            {message.shortTime}
          {/if}
        </span>
      </td>
      <td class="prefix max-w-[120px] align-top whitespace-nowrap text-right overflow-hidden truncate font-mono">
        <span class="compact-prefix flex justify-end items-center" class:repeated-prefix={isRepeatedPrefix}>
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
      <td class="message align-middle font-mono" data-message={message.text}>
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
  /* ===== Dynamic sizing — cannot be expressed as Tailwind utilities ===== */
  .bufferline {
    line-height: var(--gb-line-height, 1.2);
  }

  .time,
  .prefix,
  .message {
    font-size: var(--font-size, 14px);
  }

  /* Table layout cell padding — overridable by themes via --spacing-* vars */
  .time {
    padding: var(--spacing-line-padding-y) var(--spacing-line-padding-x);
  }

  .prefix {
    padding: var(--spacing-line-padding-y) var(--spacing-message-padding-left) var(--spacing-line-padding-y) var(--spacing-line-padding-x);
  }

  .message {
    width: 100%;
    padding: var(--spacing-line-padding-y) var(--spacing-message-padding-right) var(--spacing-line-padding-y) var(--spacing-message-padding-left);
  }

  /* ===== Mobile responsive overrides ===== */
  /* Switch from table-cell to inline layout so text wraps under time+nick */
  @media (max-width: 640px) {
    .bufferline {
      display: block;
    }

    .time {
      display: inline-block;
      padding: 0;
      padding-left: var(--spacing-line-padding-x);
      vertical-align: top;
      border: none;
      margin-right: 2px;
    }

    .prefix {
      display: inline;
      padding: 0;
      padding-right: 5px;
      white-space: normal;
      text-align: left;
      overflow: visible;
      text-overflow: clip;
      max-width: none;
      border: none;
    }

    .prefix .compact-prefix {
      justify-content: flex-start;
      align-items: center;
    }

    .message {
      display: inline;
      padding: 0;
      width: auto;
      max-width: none;
    }
  }

  /* ===== Table layout structural rules (not expressible as Tailwind utilities) ===== */
  .time .compact-time {
    display: inline-flex;
    align-items: center;
  }

  .date .time-delimiter {
    color: #cc843b;
  }

  .prefix .compact-prefix {
    display: flex;
    justify-content: flex-end;
    align-items: center;
  }

  /* ===== Theme-aware colors — fallbacks are dark-theme values ===== */
  .time .compact-time.repeated-time {
    color: var(--gb-repeated-time);
    visibility: visible;
  }

  .compact-time.repeated-time .time-delimiter {
    color: #666;
  }

  /* Prefix divider — only on desktop (border-collapse table layout) */
  @media (min-width: 641px) {
    .prefix {
      border-right: 1px solid color-mix(in srgb, var(--gb-accent) 40%, transparent);
    }
  }

  .prefix .compact-prefix.repeated-prefix {
    visibility: visible;
  }

  /* Nick/time meta row colors */
  .bubble-nick {
    font-weight: 600;
    color: var(--gb-bubble-meta-color, var(--gb-text-muted));
  }

  .bubble-time {
    color: var(--gb-bubble-meta-color, var(--gb-text-muted));
    opacity: 0.8;
  }

  .bubble-date-separator::before,
  .bubble-date-separator::after {
    content: '';
    height: 1px;
    background: var(--gb-border);
  }

  .bubble-date-text {
    color: var(--gb-text-muted);
    font-size: 0.7em;
    white-space: nowrap;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  /* ===== WeeChat protocol class overrides (must reach into TokenGroupRenderer) ===== */
  :global(.irc-link) {
    color: var(--gb-link);
    text-decoration: none;
  }

  :global(.irc-link:hover) {
    color: var(--gb-link-hover);
    text-decoration: underline;
  }

  :global(.irc-code) {
    font-family: var(--font-mono, monospace);
    background: var(--gb-inline-code-bg, rgba(255, 255, 255, 0.1));
    padding: 0 2px;
    border-radius: 2px;
  }

  :global(.bubble .irc-link) {
    color: var(--gb-link-bubble);
    text-decoration: underline;
  }

  :global(.bubble-self-bg .irc-link) {
    color: var(--gb-link-bubble-self, var(--gb-bubble-self-text));
  }

  :global(.bubble .irc-code) {
    background: var(--gb-bubble-code-bg, rgba(255, 255, 255, 0.2));
    padding: 1px 4px;
    border-radius: 4px;
  }

  :global(.bubble-other-bg .irc-code) {
    background: var(--gb-bubble-code-bg-other, rgba(0, 0, 0, 0.15));
  }

  /* Highlighted text — nick mention or highlightWords match */
  :global(.bufferline .highlight) {
    font-weight: bold;
    color: var(--gb-highlight-text, #ffcc00);
  }

  :global(.bubble .highlight) {
    font-weight: bold;
    color: var(--gb-highlight-text-bubble, var(--gb-accent, #ffcc00));
  }

  /* ===== Bubble mode styles ===== */
  /* Base bubble container — Signal-style rounded, no tails */
  .bubble {
    position: relative;
    word-break: break-word;
    padding: var(--spacing-bubble-inner-padding, 8px 14px);
  }

  .bubble-row {
    display: flex;
    flex-direction: column;
    padding-block: var(--spacing-bubble-gap, 2px);
  }

  /* Meta row (nick + time) above bubble */
  .bubble-meta {
    display: flex;
    gap: var(--spacing-bubble-meta-gap, 6px);
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
    padding-block: var(--spacing-bubble-gap, 4px);
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
    border-radius: 18px;
    padding: var(--spacing-bubble-inner-padding, 6px 14px);
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
    padding-block: var(--spacing-date-separator-padding-y, 14px);
    gap: var(--spacing-bubble-meta-gap, 14px);
  }

  .bubble-date-separator::before,
  .bubble-date-separator::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--gb-border, #333);
  }

  /* Reset WeeChat background classes inside chat bubbles */
  :global(.bubble [class*="cwb-"]),
  :global(.bubble [class*="ceb-"]),
  :global(.bubble [class*="cob-"]) {
    background-color: transparent !important;
  }

      /* Mobile: override desktop flex containers so time+prefix flow inline with message */
      @media (max-width: 640px) {
        .time .compact-time,
        .prefix .compact-prefix {
          display: inline;
        }
      }
    </style>
