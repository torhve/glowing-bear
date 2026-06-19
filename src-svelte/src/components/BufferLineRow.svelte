<script lang="ts">
  import type { BufferLine, PluginMetadata } from '$lib/types';
  import { tokenizeAndCodify, type Token } from '$lib/linkTokens';
  import PluginEmbed from '$components/PluginEmbed.svelte';
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Minus from '@lucide/svelte/icons/minus';
  import { detectPrefixIcon, type PrefixIconType } from '$lib/utils/prefixIcons';
  import { imageExts, videoExts, audioExts, normalizeImageUrl } from '$lib/utils/mediaExtensions';
  import { detectEmbedUrl } from '$lib/utils/urlEmbeds';

  let {
    message,
    index,
    messages,
    noembed,
    onMention
  }: {
    message: BufferLine;
    index: number;
    messages: BufferLine[];
    noembed: boolean;
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

  const urlRegex = /(?:(?:https?|ftp):\/\/|www\.|ftp\.)\S*[^\s.;,(){}<>[\]]/gi;

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
        console.log(`[buildMetadata] url="${url}" name="${name}" content="${content}" nsfw=${/nsfw/i.test(message.text)}`);
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
    return msg.text.startsWith('\u001943\u2500') || msg.text.startsWith('\u00194\u2500') || msg.text.startsWith('\u0019');
  }

  interface TokenGroup {
      classes: string;
      tokens: Token[];
  }

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

{#if isDateChange}
  <tr class="bufferline date-change-row" data-testid="bufferline-row">
    <td colspan="3">
      {#each tokenGroups as group}
        <span class="{group.classes}">
          {#each group.tokens as token}
            {#if token.type === 'link'}
              <a href={token.value} target="_blank" rel="noopener noreferrer" class="irc-link">{token.value}</a>
            {:else if token.type === 'code'}
              <span class="hidden-bracket">{token.delimiter}</span>
              <code>{token.value}</code>
              <span class="hidden-bracket">{token.delimiter}</span>
            {:else}
              {token.value}
            {/if}
          {/each}
        </span>
      {/each}
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
          {#if message.showHiddenBrackets}<span class="hidden-bracket">{'<'}</span>{/if}
          {#each message.prefix as part}
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
              <span class="{(part.classes || []).join(' ')}">{part.text}</span>
            {/if}
          {/each}
          {#if message.showHiddenBrackets}<span class="hidden-bracket">{'>'}</span>{/if}
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
      <span dir="auto" class="whitespace-pre-wrap break-words">
        {#each tokenGroups as group}
          <span class="{group.classes}">
            {#each group.tokens as token}
              {#if token.type === 'link'}
                <a href={token.value} target="_blank" rel="noopener noreferrer" class="irc-link">{token.value}</a>
              {:else if token.type === 'code'}
                <span class="hidden-bracket">{token.delimiter}</span>
                <code>{token.value}</code>
                <span class="hidden-bracket">{token.delimiter}</span>
              {:else}
                {token.value}
              {/if}
            {/each}
          </span>
        {/each}
      </span>
    </td>
  </tr>
{/if}

<style>
  .bufferline {
    line-height: 1;
    padding: 2px 0;
  }

  .bufferline.highlight {
    font-weight: bold;
  }

  .time {
    text-align: right;
    padding: 0 2px 0 4px;
    vertical-align: top;
  }

  @media (max-width: 640px) {
    .bufferline {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
    }

    .time, .prefix, .message {
      display: inline-flex;
      width: auto;
      max-width: none;
      padding: 0;
      vertical-align: baseline;
      border: none;
    }

    .time {
      margin-right: 2px;
    }

    .prefix {
      border-right: none;
      white-space: normal;
      text-align: left;
      overflow: visible;
      text-overflow: clip;
      font-family: inherit;
    }

    .prefix .compact-prefix {
      justify-content: flex-start;
    }

    .message {
      padding-left: 2px;
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
    padding: 0 3px 0 1px;
    vertical-align: top;
    white-space: nowrap;
    text-align: right;
    border-right: 1px solid var(--gb-border, var(--color-border));
    overflow: hidden;
    text-overflow: ellipsis;
    box-sizing: border-box;
    font-family: monospace;
    font-size: 0.9em;
  }

  .bufferline.highlight .prefix {
    font-weight: normal;
  }

  .prefix .compact-prefix {
    display: flex;
    justify-content: flex-end;
  }

  .prefix .compact-prefix.repeated-prefix {
    visibility: visible;
  }

  .message {
    padding: 1px 2px 0 2px;
    vertical-align: top;
    white-space: preserve-breaks;
    word-break: break-word;
  }

  .irc-link {
    color: #3b82f6;
  }

</style>
