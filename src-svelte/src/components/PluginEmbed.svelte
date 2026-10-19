<script lang="ts">
  /* eslint-disable svelte/no-dom-manipulating */
  import { untrack } from 'svelte';
  import type { EmbedCallbackContext, PluginMetadata } from '#lib/types.ts';
  import { imageExts, videoExts, audioExts, normalizeImageUrl } from '#lib/utils/mediaExtensions.ts';
  import { buildEmbed, type EmbedRender } from '#lib/utils/urlEmbeds.ts';
  import Play from '@lucide/svelte/icons/play';
  import ImageIcon from '@lucide/svelte/icons/image';
  import AudioLines from '@lucide/svelte/icons/audio-lines';
  import ChevronUp from '@lucide/svelte/icons/chevron-up';
  import { DEBUG_PLUGIN } from '#lib/debug.ts';

  let { plugin }: { plugin: PluginMetadata } = $props();

  let embedRef = $state<HTMLDivElement | null>(null);
  let visible = $state(false);
  let contentInjected = $state(false);
  let autoVisible = $derived(plugin.visible);

  // Only settings changes should override manual toggles. Called functions also
  // track state reads unless untracked (notably contentInjected in showContent).
  $effect(() => {
    const shouldShow = autoVisible;
    untrack(() => {
      if (shouldShow) {
        showContent();
      } else {
        hideContent();
      }
    });
  });

  let isNsfw = $derived(plugin.nsfw);
  let content = $derived(plugin.content);
  let isString = $derived(typeof content === 'string');
  let isFunction = $derived(typeof content === 'function');

  // Media kind drives the collapsed-state icon: an image glyph for images,
  // play for video, a waveform for audio. Nothing is fetched until the user
  // clicks — the collapsed state stays a plain button.
  let kind = $derived(plugin.name === 'Image' ? 'image' : plugin.name === 'Video' ? 'video' : plugin.name === 'Audio' ? 'audio' : 'other');
  function injectImage(url: string) {
    if (!embedRef) {
      console.warn('[PluginEmbed] injectImage: embedRef is null, URL:', url);
      return;
    }
    if (DEBUG_PLUGIN) console.log('[PluginEmbed] injectImage: injecting image, url:', url);
    const img = document.createElement('img');
    img.className = 'embed';
    img.src = url;
    img.alt = 'Image preview';
    // No scrollIntoView on load. An image that grows after it loads is a layout
    // change, and the chat view's viewport owner decides what a layout change
    // means for the reader — see lib/chatViewport.ts. A row scrolling itself into
    // view would seize the viewport from a reader who had scrolled away.
    img.onload = () => {
      if (DEBUG_PLUGIN) console.log('[PluginEmbed] injectImage: image loaded successfully, url:', url);
    };
    img.onerror = () => {
      console.warn('[PluginEmbed] injectImage: image failed to load, url:', url);
    };
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    // no className on wrapper — .embed class on <img> provides sizing rules
    link.appendChild(img);
    embedRef.innerHTML = '';
    embedRef.appendChild(link);
  }

  function injectVideo(url: string) {
    if (!embedRef) return;
    const video = document.createElement('video');
    video.className = 'embed';
    video.controls = true;
    const source = document.createElement('source');
    source.src = url;
    video.appendChild(source);
    embedRef.innerHTML = '';
    embedRef.appendChild(video);
  }

  function injectAudio(url: string) {
    if (!embedRef) return;
    const audio = document.createElement('audio');
    audio.className = 'embed';
    audio.controls = true;
    const source = document.createElement('source');
    source.src = url;
    audio.appendChild(source);
    embedRef.innerHTML = '';
    embedRef.appendChild(audio);
  }

  // Put the embed table's answer into the page.
  // The permission attributes belong here and not in the table, because they are
  // how this app frames someone else's page, not what the embed is:
  //   player  — sandboxed, but allowed its own origin. Players such as YouTube and
  //             Twitch read their own cookies and storage, so without it they never
  //             initialize. Safe because their documents are cross-origin to ours,
  //             so the frame cannot reach our DOM. allow-popups and the media
  //             permissions are what fullscreen needs.
  //   script  — the gist and asciinema embeds call document.write(), which is
  //             ignored when their script is loaded into this document. They get a
  //             srcdoc frame with allow-scripts only: no allow-same-origin, so the
  //             document they write stays away from ours.
  //   plain   — Pastebin's embed page is written to be framed directly, which is
  //             how upstream has always had it. It is the one frame here with no
  //             sandbox.
  function injectEmbed(render: EmbedRender) {
    if (!embedRef) return;
    embedRef.innerHTML = '';

    if (render.kind === 'img') {
      const img = document.createElement('img');
      img.className = 'embed';
      img.src = render.src ?? '';
      img.alt = render.alt ?? '';
      embedRef.appendChild(img);
      return;
    }

    const iframe = document.createElement('iframe');
    iframe.className = 'embed';
    iframe.width = render.width ?? '100%';
    iframe.height = render.height ?? '315px';
    iframe.frameBorder = '0';
    if (render.frame === 'script') {
      iframe.sandbox = 'allow-scripts';
    } else if (render.frame === 'plain') {
      iframe.allowFullscreen = true;
    } else {
      iframe.sandbox = 'allow-scripts allow-same-origin allow-popups';
      iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
      iframe.allowFullscreen = true;
    }
    if (render.srcdoc) {
      iframe.srcdoc = render.srcdoc;
    } else {
      iframe.src = render.src ?? '';
    }
    embedRef.appendChild(iframe);
  }

  // Execute plugin-provided embed callback functions.
  // The callback receives a context object with getElement() to access
  // the DOM container. Callbacks may perform async operations (fetch)
  // that complete after this function returns.
  function loadAsyncEmbed() {
    if (!isFunction || !embedRef || !content) return;

    const context: EmbedCallbackContext = {
      getElement: () => embedRef
    };

    try {
      const fn = content as (this: EmbedCallbackContext) => void;
      fn.call(context);
    } catch (e) {
      console.error('[PluginEmbed] async embed error:', e);
    }
  }

  function processUrlContent(url: string) {
    if (!url || !embedRef) {
      console.warn('[PluginEmbed] processUrlContent: url or embedRef missing', { url, embedRef: !!embedRef });
      return;
    }
    if (DEBUG_PLUGIN) console.log('[PluginEmbed] processUrlContent: processing URL:', url);

    if (imageExts.test(url)) {
      // The same normalization BufferLineRow applies before it renders an image:
      // a Dropbox shared link has to ask for the file rather than Dropbox's own
      // page, and an http Imgur link is not served over plain http at all.
      injectImage(normalizeImageUrl(url));
      return;
    }

    if (videoExts.test(url)) {
      injectVideo(url);
      return;
    }

    if (audioExts.test(url)) {
      injectAudio(url);
      return;
    }

    // One table decides both what this URL is called and what it becomes, so the
    // label on the "Show …" button and the frame under it cannot disagree.
    const embed = buildEmbed(url);
    if (embed) {
      injectEmbed(embed);
      return;
    }

    if (DEBUG_PLUGIN) console.log('[PluginEmbed] processUrlContent: no handler matched for URL:', url);
  }

  function showContent() {
    if (DEBUG_PLUGIN) console.log('[PluginEmbed] showContent called', { isString, isFunction, content, contentInjected });
    visible = true;
    if (!contentInjected) {
      contentInjected = true;
      if (isString && content) {
        processUrlContent(content as string);
      } else if (isFunction && content) {
        loadAsyncEmbed();
      } else {
        console.warn('[PluginEmbed] showContent: no valid content to process', { isString, isFunction, content });
      }
    } else {
      if (DEBUG_PLUGIN) console.log('[PluginEmbed] showContent: content already injected, skipping');
    }
  }

  function hideContent() {
    visible = false;
    contentInjected = false;
    if (embedRef) {
      const video = embedRef.querySelector('video');
      if (video) video.pause();
      const audio = embedRef.querySelector('audio');
      if (audio) audio.pause();
      const iframe = embedRef.querySelector('iframe');
      if (iframe) {
        const innerHTML = embedRef.innerHTML;
        embedRef.innerHTML = innerHTML;
      }
    }
  }
</script>

<div class="embed-wrapper" class:shown={visible}>
  <button
    data-testid="show-embed"
    class="embed-show-btn show-btn m-1 px-3 py-1.5 rounded text-sm font-medium transition-colors {(!plugin.nsfw ? 'text-[var(--gb-link)] hover:text-[var(--gb-link-hover)]' : 'bg-warning/20 text-warning hover:bg-warning/30 hover:text-warning/90')}"
    class:hidden={visible}
    title={`Show ${plugin.name}`}
    aria-label={`Show ${plugin.name}`}
    onclick={showContent}
  >
    {#if kind === 'image'}
      <ImageIcon size={16} class="inline-block mr-1" />
    {:else if kind === 'audio'}
      <AudioLines size={16} class="inline-block mr-1" />
    {:else}
      <Play size={16} class="inline-block mr-1" />
    {/if}
    <span class="show-btn-text">Show {plugin.name}</span>
  </button>
  <div class="embed-area" class:visible>
    {#if isNsfw}
      <div class="embed nsfw-warning bg-warning/20 border border-warning/40 rounded p-2 text-sm text-warning">
        ⚠️ NSFW content hidden.
      </div>
    {:else}
      <div
        data-testid="plugin-embed"
        bind:this={embedRef}
        class="embed-container rounded overflow-hidden bg-surface my-1"
      ></div>
      <!-- Below the media, not overlaid on it. The wrapping div matters:
           .embed-container is inline-block for image embeds, so an inline-level
           button would otherwise flow beside the media instead of below it. -->
      <div>
        <button
          data-testid="hide-embed"
          class="embed-hide-btn mb-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors bg-surface-raised text-text-secondary hover:text-text hover:bg-surface"
          title="Collapse"
          aria-label="Collapse"
          onclick={hideContent}
        >
          <ChevronUp size={16} class="inline-block mr-1" />
          Collapse
        </button>
      </div>
    {/if}
  </div>
</div>

<style>
  :global(.embed) {
    max-width: 728px;
    max-height: 500px;
    overflow: hidden;
    box-sizing: border-box;
  }

  .embed-container {
    border: 10px solid var(--gb-border, var(--color-border));
    border-radius: 4px;
    box-sizing: border-box;
  }

  :global(.embed-container:has(img.embed)) {
    display: inline-block;
  }

  .show-btn.hidden {
    display: none;
  }


  .embed-area:not(.visible) {
    display: none;
  }

  @media (max-width: 640px) {
    .show-btn-text {
      display: none;
    }

    .show-btn {
      padding: 0.375rem;
    }

    .embed-wrapper.shown {
      width: 100%;
    }
  }
</style>
