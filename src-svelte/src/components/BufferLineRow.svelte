<script lang="ts">
  import type { BufferLine, PluginMetadata } from '$lib/types';
  import { tokenizeAndCodify, type Token } from '$lib/linkTokens';
  import PluginEmbed from '$components/PluginEmbed.svelte';

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
  let isPrivate = $derived(message.tags?.includes('private') ?? false);
  let isHighlight = $derived(message.highlight);
  let isSelf = $derived(message.tags?.includes('self') ?? false);
  let metadata = $derived(buildMetadata());

  const urlRegex = /(?:(?:https?|ftp):\/\/|www\.|ftp\.)\S*[^\s.;,(){}<>[\]]/gi;
  const imageExts = /\.(bmp|gif|ico|jpe?g|png|svg|svgz|tif|tiff|webp|avif)(\?[^#]*)?(#.*)?$/i;
  const videoExts = /\.(3gp|avi|flv|gifv|mkv|mp4|ogv|webm|wmv)(\?[^#]*)?(#.*)?$/i;
  const audioExts = /\.(flac|m4a|mid|MID|midi|mp3|oga|ogg|opus|spx|wav|wma)(\?[^#]*)?(#.*)?$/i;

  function normalizeImageUrl(url: string): string {
    if (/^https:\/\/www\.dropbox\.com\/s\/[a-z0-9]+\//i.test(url)) {
      const dbox_url = document.createElement("a");
      dbox_url.href = url;
      const base_url = dbox_url.protocol + '//' + dbox_url.host + dbox_url.pathname + '?';
      const dbox_params = (dbox_url.search || '').substring(1).split('&');
      let dl_added = false;
      for (let i = 0; i < dbox_params.length; i++) {
        const param = dbox_params[i];
        if (param?.split('=')[0] === "dl") {
          dbox_params[i] = "dl=1";
          dl_added = true;
        }
      }
      if (!dl_added) {
        dbox_params.push("dl=1");
      }
      return base_url + dbox_params.join('&');
    }
    if (/^http:\/\/(i\.)?imgur\.com\//i.test(url)) {
      return url.replace(/^http:/, "https:");
    }
    return url;
  }

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
      }

      if (name) {
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
    return msg.text.startsWith('\u00194\u2500') || msg.text.startsWith('\u0019');
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
              <!-- svelte-ignore htmlBindingContentTypeMismatch --><span class="hidden-bracket">{token.delimiter}</span>
              <code>{token.value}</code>
              <!-- svelte-ignore htmlBindingContentTypeMismatch --><span class="hidden-bracket">{token.delimiter}</span>
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
      <span class="date compact-time" class:repeated-time={isRepeatedTime}>{message.shortTime}</span>
    </td>
    <td class="prefix">
      <span class="compact-prefix" class:repeated-prefix={isRepeatedPrefix}>
        <span
          onclick={handleMention}
          role="button"
          tabindex="0"
          class="mention-link"
          onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleMention(); } }}
        >
          {#if message.showHiddenBrackets}<span class="hidden-bracket">{'<'}</span>{/if}{#each message.prefix as part}<span class="{(part.classes || []).join(' ')}">{part.text}</span>{/each}{#if message.showHiddenBrackets}<span class="hidden-bracket">{'>'}</span>{/if}
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
                <!-- svelte-ignore htmlBindingContentTypeMismatch --><span class="hidden-bracket">{token.delimiter}</span>
                <code>{token.value}</code>
                <!-- svelte-ignore htmlBindingContentTypeMismatch --><span class="hidden-bracket">{token.delimiter}</span>
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
  }

  .bufferline.highlight {
    font-weight: bold;
  }

  .time {
    text-align: right;
    padding: 0 1px 0 8px;
    vertical-align: top;
  }

  .time .compact-time.repeated-time {
    color: var(--gb-repeated-time, #444);
    visibility: visible;
  }

  .prefix {
    max-width: 120px;
    padding: 0 1px 0 6px;
    vertical-align: top;
    white-space: nowrap;
    text-align: right;
    border-right: 1px solid var(--gb-border, #444);
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .prefix .compact-prefix.repeated-prefix {
    color: var(--gb-repeated-prefix, #555);
    visibility: visible;
  }

  .message {
    width: 100%;
    padding: 0 2px;
    vertical-align: top;
    white-space: preserve-breaks;
    word-break: break-word;
  }

  .irc-link {
    color: #3b82f6;
  }

</style>
