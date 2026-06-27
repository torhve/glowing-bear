<script lang="ts">
      import type { TokenGroup } from '$lib/linkTokens';

      let {
        groups
      }: {
        groups: TokenGroup[];
      } = $props();
    </script>

    <style>
          /* WebKit/WKWebView doesn't respect white-space: pre-wrap on inline spans
               inside table cells — \n in text is silently collapsed.
               white-space-collapse: preserve-breaks forces \n → line break while
               keeping other whitespace behavior normal (collapsing spaces).
               Requires white-space: normal (overrides inherited pre-wrap from parent).
               overflow-wrap: anywhere wraps long unbroken strings at word boundaries,
               with mid-word fallback only when overflow would occur.
               Supported: WebKit (Safari 15.4+), Firefox (113+), Chrome (114+). */
          .token-group {
            white-space: normal;
            white-space-collapse: preserve-breaks;
            overflow-wrap: anywhere;
          }

          /* Also apply to link anchors so long URLs wrap inside token groups */
          .irc-link {
            overflow-wrap: anywhere;
          }
    </style>

    {#each groups as group, gi (gi)}
          <!-- scoped CSS handles wrapping and line-break preservation for all engines -->
          <span class="token-group {group.classes}">
            {#each group.tokens as token, ti (ti)}
              {#if token.type === 'link'}
                <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
                <a href={token.value} target="_blank" rel="noopener noreferrer" class="irc-link">{token.value}</a>
              {:else if token.type === 'code'}
                <span class="hidden-bracket">{token.delimiter}</span>
                <code class="irc-code">{token.value}</code>
                <span class="hidden-bracket">{token.delimiter}</span>
              {:else}
                {token.value}
              {/if}
            {/each}
          </span>
        {/each}
