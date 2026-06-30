<script lang="ts">
  import '../app.css';

  let { children } = $props();

  $effect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/service-worker.js');
    }
  });
</script>

{@render children()}
