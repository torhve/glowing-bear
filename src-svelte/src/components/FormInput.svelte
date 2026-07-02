<script lang="ts">
  import { untrack } from 'svelte';
  import type { HTMLInputTypeAttribute, KeyboardEventHandler, EventHandler } from 'svelte/elements';

  let {
    id,
    value = '',
    type = 'text',
    placeholder = '',
    extraClass = '',
    disabled = false,
    autocapitalize = 'off',
    onkeydown = undefined,
    oninput = undefined,
    onblur = undefined,
    size = 'md',
    variant = 'default',
    'data-testid': dataTestId = ''
  } = $props<{
    id: string;
    value?: string | number | readonly string[];
    type?: HTMLInputTypeAttribute;
    placeholder?: string;
    extraClass?: string;
    disabled?: boolean;
    autocapitalize?: string;
    onkeydown?: KeyboardEventHandler<HTMLInputElement>;
    oninput?: EventHandler<Event, HTMLInputElement>;
    onblur?: EventHandler<FocusEvent, HTMLInputElement>;
    size?: 'sm' | 'md' | 'lg';
    variant?: 'default' | 'search';
    'data-testid'?: string;
  }>();

  function getSizeClass(s: 'sm' | 'md' | 'lg'): string {
    switch (s) {
      case 'sm': return 'py-1 text-xs';
      case 'md': return 'py-1.5 text-sm';
      case 'lg': return 'py-2 text-base';
    }
  }

  function getVariantClass(v: 'default' | 'search'): string {
    return v === 'search' ? 'pl-8' : 'pl-3';
  }

  // Local state for one-way value binding (avoids bind:value issues with Playwright .fill()).
  let internalValue = $state(untrack(() => value ?? ''));

  // Sync from parent prop when it changes externally (e.g. reset).
  $effect(() => {
    if (internalValue !== value) internalValue = value ?? '';
  });

  const combinedClass = $derived(`form-input w-full bg-input-bg border border-border rounded text-text focus:outline-none focus:border-accent hover:border-text-muted placeholder-text-muted transition-colors ${getSizeClass(size)} ${getVariantClass(variant)} ${extraClass}`);

  function handleInput(e: Event) {
    const target = e.target as HTMLInputElement;
    internalValue = target.value;
    oninput?.(e);
  }
</script>

<input
  {id}
  {type}
  value={internalValue}
  {placeholder}
  {disabled}
  autocapitalize={autocapitalize}
  onkeydown={onkeydown}
  oninput={handleInput}
  onblur={onblur}
  class={combinedClass}
  data-testid={dataTestId || id}
/>
