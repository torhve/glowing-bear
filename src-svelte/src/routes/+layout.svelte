<script lang="ts">
  import '../app.css';

  let { children } = $props();

  $effect(() => {
    import('virtual:pwa-register').then(({ registerSW }) => {
      registerSW({ immediate: true });
    }).catch(() => {
      // PWA registration not available (e.g., dev mode, or plugin not configured)
    });
  });
</script>

{@render children()}
