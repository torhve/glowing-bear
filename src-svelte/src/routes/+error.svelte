<script lang="ts">
  import { page } from '$app/state';
  import { base } from '$app/paths';
  import { initTheme } from '$lib/stores/theme';

  // app.css hides <body> until the app marks itself ready
  // (body:not([data-app-ready])). Only +page.svelte sets that attribute, and an
  // unmatched URL never mounts it, so this page renders fully hidden unless it
  // opts in the same way.
  $effect(() => {
    initTheme();
    document.body.setAttribute('data-app-ready', 'true');
  });
</script>

<div class="min-h-screen flex items-center justify-center p-4" data-testid="error-page">
  <div class="bg-panel border border-border rounded p-6 max-w-md w-full space-y-3">
    <div class="flex items-center gap-2">
      <img src={`${base}/glowing-bear.svg`} class="w-5 h-5" alt="" />
      <span class="text-sm font-medium text-text">Glowing Bear</span>
      <span class="ml-auto text-sm text-text-muted font-mono">{page.status}</span>
    </div>

    <h1 class="text-lg font-semibold text-text">
      {page.status === 404 ? 'Page not found' : 'Something went wrong'}
    </h1>

    {#if page.status !== 404 && page.error?.message}
      <p class="text-sm text-text-secondary">{page.error.message}</p>
    {/if}

    {#if page.status === 404}
      <p class="text-sm text-text-secondary">
        Glowing Bear is a single-page app. The connection screen lives at
        <code class="text-text">{base}/</code> and everything else happens inside it, so there
        is no deeper page to link to from here.
      </p>
    {:else}
      <p class="text-sm text-text-secondary">
        The app failed while rendering. Reloading from the connection screen is the quickest
        way to recover.
      </p>
    {/if}

    <!-- A full page load is deliberate here: either the router failed to match this URL or the
         app failed to render it, so re-enter from a clean load instead of navigating
         client-side. -->
    <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
    <a href={`${base}/`} data-sveltekit-reload data-testid="error-home-link" class="inline-block px-4 py-2 bg-accent hover:bg-accent-hover text-white font-medium rounded transition-colors">
      Back to Glowing Bear
    </a>
  </div>
</div>
