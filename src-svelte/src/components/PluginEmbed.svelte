<script lang="ts">
  /* eslint-disable svelte/no-dom-manipulating */
  import type { EmbedCallbackContext, PluginMetadata } from '$lib/types';
  import { imageExts, videoExts, audioExts } from '$lib/utils/mediaExtensions';
  import Play from '@lucide/svelte/icons/play';
  import X from '@lucide/svelte/icons/x';
  import { DEBUG_PLUGIN } from '$lib/debug';

  let { plugin }: { plugin: PluginMetadata } = $props();

  let embedRef = $state<HTMLDivElement | null>(null);
  let visible = $state(false);
  let contentInjected = $state(false);

  // React only to changes in the plugin.visible prop (settings toggle).
  // Does NOT read internal state (visible, contentInjected) — those are modified
  // by showContent/hideContent on user clicks, which would cause the effect to
  // re-run and undo user interactions.
  $effect(() => {
    if (plugin.visible) {
      showContent();
    } else {
      hideContent();
    }
  });

  let isNsfw = $derived(plugin.nsfw);
  let content = $derived(plugin.content);
  let isString = $derived(typeof content === 'string');
  let isFunction = $derived(typeof content === 'function');

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
    img.onload = () => {
      if (DEBUG_PLUGIN) console.log('[PluginEmbed] injectImage: image loaded successfully, url:', url);
      img.scrollIntoView({ block: 'nearest', inline: 'nearest' });
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

  // Create a sandboxed iframe for third-party embeds.
  // allow-scripts lets the embed player execute; allow-popups enables
  // YouTube fullscreen and similar features. No allow-same-origin keeps
  // the iframe isolated from the parent window (postMessage for cross-origin comms).
  function injectIframe(src: string, width = '100%', height = '315px') {
    if (!embedRef) return;
    const iframe = document.createElement('iframe');
    iframe.className = 'embed';
    iframe.src = src;
    iframe.width = width;
    iframe.height = height;
    iframe.frameBorder = '0';
    iframe.sandbox = 'allow-scripts allow-popups';
    iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
    iframe.allowFullscreen = true;
    embedRef.innerHTML = '';
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
      injectImage(url);
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

    const ytMatch = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    if (ytMatch) {
      injectIframe(`https://www.youtube.com/embed/${ytMatch[1]}`);
      return;
    }

    const twitchClipMatch = url.match(/clips\.twitch\.tv\/(\w+)/);
    if (twitchClipMatch) {
      // Use dynamic hostname so Twitch embed works on any deployed instance, not just localhost.
      const parent = window.location.hostname;
      injectIframe(`https://clips.twitch.tv/embed?clip=${twitchClipMatch[1]}&parent=${parent}`, '640px', '277px');
      return;
    }

    const twitchVideoMatch = url.match(/twitch\.tv\/videos\/(\d+)/);
    if (twitchVideoMatch) {
      const parent = window.location.hostname;
      injectIframe(`https://player.twitch.tv/?video=${twitchVideoMatch[1]}&parent=${parent}`);
      return;
    }

    const twitchChannelMatch = url.match(/twitch\.tv\/([a-zA-Z0-9_]+)/);
    if (twitchChannelMatch && !twitchClipMatch) {
      const parent = window.location.hostname;
      injectIframe(`https://player.twitch.tv/?channel=${twitchChannelMatch[1]}&parent=${parent}`);
      return;
    }

    const dmMatch = url.match(/dailymotion\.com\/video\/([a-zA-Z0-9]+)|dai\.ly\/([a-zA-Z0-9]+)/);
    if (dmMatch) {
      const id = dmMatch[1] || dmMatch[2];
      injectIframe(`https://www.dailymotion.com/embed/video/${id}`);
      return;
    }

    const streamableMatch = url.match(/streamable\.com\/([a-zA-Z0-9]+)/);
    if (streamableMatch) {
      injectIframe(`https://streamable.com/o/${streamableMatch[1]}`, '100%', '100%');
      return;
    }

    const spotifyMatch = url.match(/open\.spotify\.com\/(track|album|playlist|artist)\/([a-zA-Z0-9]+)/);
    if (spotifyMatch) {
      const type = spotifyMatch[1];
      const id = spotifyMatch[2];
      injectIframe(`https://open.spotify.com/embed/${type}/${id}`, '100%', '380px');
      return;
    }

    const scMatch = url.match(/soundcloud\.com\/([^?]+)/);
    if (scMatch) {
      injectIframe(`https://w.soundcloud.com/player/?url=${encodeURIComponent(url)}&auto_play=false&hide_related=true&show_comments=false&show_user=true&show_reposts=false&show_teaser=false`, '100%', '166px');
      return;
    }

    const mcMatch = url.match(/mixcloud\.com\/([^?]+)/);
    if (mcMatch) {
      injectIframe(`https://www.mixcloud.com/widgets/player/?url=${encodeURIComponent(url)}&light=1`, '100%', '100%');
      return;
    }

    const mapsMatch = url.match(/(?:maps\.google\.)|(?:google\..*\/maps)/);
    if (mapsMatch) {
      injectIframe(`https://www.google.com/maps?q=${encodeURIComponent(url)}&output=embed`, '100%', '250px');
      return;
    }

    const giphyMatch = url.match(/giphy\.com\/gifs\/[^/]*-([a-zA-Z0-9]+)?/);
    if (giphyMatch) {
      injectIframe(`https://giphy.com/embed/${giphyMatch[1]}`, '100%', '100%');
      return;
    }

    const yrMatch = url.match(/yr\.no\/place\/[^/]+\/[^/]+\/[^/]+\/#/);
    if (yrMatch) {
      const parts = url.split('/');
      if (parts.length >= 7) {
        const lat = parts[5];
        const lon = parts[6];
        const img = document.createElement('img');
        img.className = 'embed';
        img.src = `https://api.met.no/weatherapi/weathericon/2.0/legacymeteogram?lat=${lat}&lon=${lon}`;
        img.alt = 'Weather meteogram';
        embedRef.innerHTML = '';
        embedRef.appendChild(img);
      }
      return;
    }

    const gistMatch = url.match(/gist\.github\.com\/([^/]+)\/([a-zA-Z0-9]+)/);
    if (gistMatch) {
      // Gist embed scripts use document.write() which is ignored when loaded
      // asynchronously into the parent. A sandboxed iframe with srcdoc gives
      // the script a fresh document context where document.write() works.
      // Only allow-scripts (no allow-same-origin) keeps the iframe isolated
      // from the parent window.
      const iframe = document.createElement('iframe');
      iframe.className = 'embed';
      iframe.width = '100%';
      iframe.height = '300px';
      iframe.frameBorder = '0';
      iframe.sandbox = 'allow-scripts';
      // Break up the <script> tag string to prevent Svelte parser from
      // confusing it with an actual script block.
      const gistScriptSrc = `https://gist.github.com/${gistMatch[1]}/${gistMatch[2]}.js`;
      iframe.srcdoc = `<scr` + `ipt src="${gistScriptSrc}"></scr` + `ipt>`;
      embedRef.innerHTML = '';
      embedRef.appendChild(iframe);
      return;
    }

    const pastebinMatch = url.match(/pastebin\.com\/([a-zA-Z0-9]+)/);
    if (pastebinMatch) {
      const iframe = document.createElement('iframe');
      iframe.className = 'embed';
      iframe.src = `https://pastebin.com/embed/${pastebinMatch[1]}`;
      iframe.width = '100%';
      iframe.height = '350';
      iframe.frameBorder = '0';
      iframe.allowFullscreen = true;
      embedRef.innerHTML = '';
      embedRef.appendChild(iframe);
      return;
    }

    const allocineMatch = url.match(/allocine\.fr\/videokast\/video-([a-zA-Z0-9]+)/);
    if (allocineMatch) {
      injectIframe(`https://www.allocine.fr/_iframe/videokast/?video=${allocineMatch[1]}&result=media`, '100%', '100%');
      return;
    }

    // Asciinema terminal recordings use document.write() embed scripts,
    // so we load them inside a sandboxed iframe with srcdoc.
    const asciinemaMatch = url.match(/asciinema\.org\/a\/([0-9a-z]+)/);
    if (asciinemaMatch) {
      const iframe = document.createElement('iframe');
      iframe.className = 'embed';
      iframe.width = '100%';
      iframe.height = '300px';
      iframe.frameBorder = '0';
      iframe.sandbox = 'allow-scripts';
      // Break up <script> tag to prevent Svelte parser confusion.
      const scriptSrc = `https://asciinema.org/a/${asciinemaMatch[1]}.js`;
      iframe.srcdoc = `<scr` + `ipt src="${scriptSrc}"></scr` + `ipt>`;

      embedRef.innerHTML = '';
      embedRef.appendChild(iframe);
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
    onclick={showContent}
  >
    <Play size={16} class="inline-block mr-1" />
    <span class="show-btn-text">Show {plugin.name}</span>
  </button>
  <div class="embed-area" class:visible>
    {#if isNsfw}
      <div class="embed nsfw-warning bg-warning/20 border border-warning/40 rounded p-2 text-sm text-warning">
        ⚠️ NSFW content hidden.
      </div>
    {:else}
      <button
        data-testid="hide-embed"
        class="embed-hide-btn absolute top-1 right-1 z-10 px-2 py-1 rounded text-sm font-medium transition-colors bg-surface-raised text-text-secondary hover:text-text hover:bg-surface"
        onclick={hideContent}
      >
        <X size={14} class="inline-block mr-1" />
        Hide {plugin.name}
      </button>
      <div
        data-testid="plugin-embed"
        bind:this={embedRef}
        class="embed-container rounded overflow-hidden bg-surface my-1"
      ></div>
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
