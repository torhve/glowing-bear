<script lang="ts">
  type InputTypeValue = 'text' | 'password' | 'email' | 'number' | 'tel' | 'url' | 'search' | 'date' | 'time' | 'datetime-local' | 'month' | 'week' | 'color' | 'range' | 'file';

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
    size = 'md',
    variant = 'default',
    'data-testid': dataTestId = ''
  } = $props<{
    id: string;
    value?: string | number | readonly string[];
    type?: InputTypeValue;
    placeholder?: string;
    extraClass?: string;
    disabled?: boolean;
    autocapitalize?: string;
    onkeydown?: (e: KeyboardEvent) => void;
    oninput?: (e: Event) => void;
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

  const combinedClass = $derived(`w-full bg-input-bg border border-border rounded text-text focus:outline-none focus:border-accent placeholder-text-muted ${getSizeClass(size)} ${getVariantClass(variant)} ${extraClass}`);
</script>

<input
  {id}
  {type}
  {value}
  {placeholder}
  {disabled}
  autocapitalize={autocapitalize}
  onkeydown={onkeydown}
  oninput={oninput}
  class={combinedClass}
  data-testid={dataTestId || id}
/>
