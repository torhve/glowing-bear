<script lang="ts">
  import type { PluginMetadata } from '$lib/types';
  import { sanitizeHtml } from '$lib/filters';
  import { onMount } from 'svelte';
  import { imageExts, videoExts, audioExts } from '$lib/utils/mediaExtensions';

  let { plugin }: { plugin: PluginMetadata } = $props();

  let embedRef = $state<HTMLDivElement | null>(null);
  let visible = $state(plugin.visible);
  let contentInjected = $state(false);

  $effect(() => { visible = plugin.visible; });

  onMount(() => {
    if (visible && !contentInjected) {
      contentInjected = true;
      setTimeout(() => {
        if (isString && content) {
          processUrlContent(content as string);
        } else if (isFunction && content) {
          loadAsyncEmbed();
        }
      }, 0);
    }
  });

  let isNsfw = $derived(plugin.nsfw);
  let content = $derived(plugin.content);
  let isString = $derived(typeof content === 'string');
  let isFunction = $derived(typeof content === 'function');

  function injectImage(url: string) {
    if (!embedRef) return;
    const img = document.createElement('img');
    img.className = 'embed';
    img.src = url;
    img.alt = 'Image preview';
    img.onload = () => {
      img.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    };
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.className = 'embed';
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

  function injectIframe(src: string, width = '100%', height = '315px') {
    if (!embedRef) return;
    const iframe = document.createElement('iframe');
    iframe.className = 'embed';
    iframe.src = src;
    iframe.width = width;
    iframe.height = height;
    iframe.frameBorder = '0';
    iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
    iframe.allowFullscreen = true;
    embedRef.innerHTML = '';
    embedRef.appendChild(iframe);
  }

  function loadAsyncEmbed() {
    if (!isFunction || !embedRef || !content) return;

    const context = {
      getElement: () => embedRef
    };

    try {
      const fn = content as () => void;
      fn.call(context);
    } catch (e) {
      console.error('Plugin embed error:', e);
    }
  }

  function processUrlContent(url: string) {
    if (!url || !embedRef) return;

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
      injectIframe(`https://clips.twitch.tv/embed?clip=${twitchClipMatch[1]}&parent=localhost&parent=127.0.0.1`, '640px', '277px');
      return;
    }

    const twitchVideoMatch = url.match(/twitch\.tv\/videos\/(\d+)/);
    if (twitchVideoMatch) {
      injectIframe(`https://player.twitch.tv/?video=${twitchVideoMatch[1]}&parent=localhost&parent=127.0.0.1`);
      return;
    }

    const twitchChannelMatch = url.match(/twitch\.tv\/([a-zA-Z0-9_]+)/);
    if (twitchChannelMatch && !twitchClipMatch) {
      injectIframe(`https://player.twitch.tv/?channel=${twitchChannelMatch[1]}&parent=localhost&parent=127.0.0.1`);
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

    const asciinemaMatch = url.match(/asciinema\.org\/a\/([a-zA-Z0-9]+)/);
    if (asciinemaMatch) {
      const script = document.createElement('script');
      script.src = `https://asciinema.org/a/${asciinemaMatch[1]}.js`;
      script.id = `asciicast-${asciinemaMatch[1]}`;
      embedRef.innerHTML = '';
      embedRef.appendChild(script);
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
      const script = document.createElement('script');
      script.src = `https://gist.github.com/${gistMatch[1]}/${gistMatch[2]}.js`;
      script.id = `gist-${gistMatch[1]}-${gistMatch[2]}`;
      embedRef.innerHTML = '';
      embedRef.appendChild(script);
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

    const tiktokMatch = url.match(/tiktok\.com\/@([^/]+)\/video\/[^/]+|vm\.tiktok\.com\/([^/]+)/);
    if (tiktokMatch) {
      const tiktokUrl = url.includes('vm.tiktok.com')
        ? `https://www.tiktok.com/@${url.split('/').pop()}`
        : url;
      const ref = embedRef;
      fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(tiktokUrl)}`)
        .then(r => r.json())
        .then(data => {
          if (!ref) return;
          const content = data.html?.substring(0, data.html?.indexOf('<script') ?? 0);
          ref.innerHTML = sanitizeHtml(content || '', { allowEmbeds: true });
          const script = document.createElement('script');
          script.src = 'https://www.tiktok.com/embed.js';
          ref.appendChild(script);
        })
        .catch(e => console.error('TikTok embed error:', e));
      return;
    }

    const allocineMatch = url.match(/allocine\.fr\/videokast\/video-([a-zA-Z0-9]+)/);
    if (allocineMatch) {
      injectIframe(`https://www.allocine.fr/_iframe/videokast/?video=${allocineMatch[1]}&result=media`, '100%', '100%');
      return;
    }
  }

  function showContent() {
    visible = true;
    if (!contentInjected) {
      contentInjected = true;
      // Defer to next microtask so bind:this resolves after Svelte renders
      setTimeout(() => {
        if (isString && content) {
          processUrlContent(content as string);
        } else if (isFunction && content) {
          loadAsyncEmbed();
        }
      }, 0);
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

{#if !visible}
  <div class="relative">
    <button
      data-testid="show-embed"
      class="{(!plugin.nsfw ? 'bg-blue-600 hover:bg-blue-700 text-white' : 'bg-yellow-600 hover:bg-yellow-700 text-white')} absolute top-1 right-1 z-10 btn btn-sm px-2 py-0.5 rounded cursor-pointer font-mono text-xs"
      onclick={showContent}
    >
      Show {plugin.name}
    </button>
  </div>
{:else}
  <div class="relative">
    {#if isNsfw}
      <div class="embed bg-yellow-900/30 border border-yellow-700 rounded p-2 text-sm text-yellow-200">
        ⚠️ NSFW content hidden.
      </div>
    {:else}
      <button
        data-testid="hide-embed"
        class="absolute top-1 right-1 z-10 btn btn-sm px-2 py-0.5 rounded cursor-pointer font-mono text-xs bg-gray-700 hover:bg-gray-600 text-gray-300"
        onclick={hideContent}
      >
        Hide {plugin.name}
      </button>
      <div
        data-testid="plugin-embed"
        bind:this={embedRef}
        class="embed rounded overflow-hidden bg-[#1a1a1a] border border-[#333333] my-1"
      ></div>
    {/if}
  </div>
{/if}

<style>
  .embed {
    max-width: 728px;
    max-height: 500px;
    overflow: hidden;
    border: 10px solid var(--gb-border, #444);
    border-radius: 4px;
    box-sizing: border-box;
  }

  .embed img {
    display: block;
    max-width: 100%;
    max-height: calc(500px - 20px);
    object-fit: contain;
    background-color: var(--gb-bg, #000);
  }
</style>
