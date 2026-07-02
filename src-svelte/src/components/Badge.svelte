<script lang="ts">
  /**
     * Badge — Small pill-style indicator with optional icon and label.
     * Supports filled, outlined, and subtle-outline render modes across semantic color themes.
     */
  import type { Component } from 'svelte';

  type BadgeVariant = 'default' | 'success' | 'warning' | 'danger';
  type BadgeMode = 'filled' | 'outline' | 'subtle' | 'solid' | 'bright';

  let {
    variant = 'default',
    mode = 'filled',
    icon: Icon,
    class: extraClass = '',
    children,
    ...attrs
  } = $props<{
    variant?: BadgeVariant;
    mode?: BadgeMode;
    icon?: Component;
    class?: string;
    children?: import('svelte').Snippet;
    [key: string]: unknown;
  }>();

  /* Build Tailwind class string for any variant + mode combination */
  function badgeClassFor(variant: BadgeVariant, mode: BadgeMode): string {
    const colors: Record<BadgeVariant, string> = {
      default: 'surface-raised / border',
      success: 'success / success',
      warning: 'warning / warning',
      danger: 'danger / danger'
    };

    const [bgColor, borderColor] = colors[variant].split(' / ');

    switch (mode) {
      case 'filled':
        return `bg-${bgColor}/20 text-${bgColor}`;
      case 'outline':
        return `border border-${borderColor}/40 text-${borderColor}`;
      case 'subtle':
        return `bg-${bgColor}/5 text-${bgColor} outline outline-1 -outline-offset-1 outline-${borderColor}/15`;
      case 'solid':
        return `bg-${bgColor}/90 text-white`;
      case 'bright':
        return 'bg-violet-500 text-white';
    }
  }

  /* Derive the active class string from variant and render mode */
  let badgeClass = $derived(badgeClassFor(variant as BadgeVariant, mode as BadgeMode));
</script>

<span
  class="inline-flex items-center justify-center rounded-full px-2.5 py-0.5 text-sm whitespace-nowrap {badgeClass} {extraClass}"
  data-testid="badge"
  {...attrs}
>
  {#if Icon}
    <Icon size={14} class="-ms-1 me-1.5" />
  {/if}
  {#if children}
    {@render children()}
  {/if}
</span>
