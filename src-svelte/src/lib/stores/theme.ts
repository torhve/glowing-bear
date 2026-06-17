import { writable } from 'svelte/store';
import { getThemeColors, type ThemeColors } from './themeColors';

export const themes = [
    'dark',
    'light',
    'black',
    'dark-spacious',
    'blue',
    'blue-modern',
    'base16-default',
    'base16-light',
    'base16-mocha',
    'base16-ocean-dark',
    'base16-solarized-dark',
    'base16-solarized-light',
] as const;

export type Theme = typeof themes[number];

export const themeStore = writable<Theme>('dark');

function injectThemeCSSVariables(colors: ThemeColors) {
    const styleId = 'themeCSSVariables';
    let styleEl = document.getElementById(styleId) as HTMLStyleElement;
    if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = styleId;
        document.head.appendChild(styleEl);
    }

    const vars: string[] = [];
    const map: Record<string, keyof ThemeColors> = {
        '--gb-bg': 'bg',
        '--gb-surface': 'surface',
        '--gb-surface-raised': 'surfaceRaised',
        '--gb-border': 'border',
        '--gb-text': 'text',
        '--gb-text-secondary': 'textSecondary',
        '--gb-text-muted': 'textMuted',
        '--gb-accent': 'accent',
        '--gb-accent-hover': 'accentHover',
        '--gb-ribbon': 'ribbon',
        '--gb-ribbon-light': 'ribbonLight',
        '--gb-danger': 'danger',
        '--gb-success': 'success',
        '--gb-warning': 'warning',
        '--gb-unread': 'unread',
        '--gb-notification': 'notification',
        '--gb-highlight': 'highlight',
        '--gb-input-bg': 'inputBg',
    };

    for (const [cssVar, key] of Object.entries(map)) {
        vars.push(`${cssVar}: ${colors[key]};`);
    }

    for (const [name, hex] of Object.entries(colors.weechatForeground)) {
        vars.push(`--gb-cof-${name}: ${hex};`);
    }

    for (const [name, hex] of Object.entries(colors.weechatBackground)) {
        vars.push(`--gb-cob-${name}: ${hex};`);
    }

    styleEl.textContent = `:root {\n  ${vars.join('\n  ')}\n}`;
}

function ensureThemeLinkElement(theme: Theme) {
    const existingLink = document.getElementById('themeCSS') as HTMLLinkElement;
    if (existingLink) {
        existingLink.href = `/css/themes/${theme}.css`;
    } else {
        const link = document.createElement('link');
        link.id = 'themeCSS';
        link.rel = 'stylesheet';
        link.href = `/css/themes/${theme}.css`;
        document.head.appendChild(link);
    }
}

export function setTheme(theme: Theme) {
    themeStore.set(theme);
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('gb_theme', theme);

    const colors = getThemeColors(theme);
    injectThemeCSSVariables(colors);
    ensureThemeLinkElement(theme);
}

export function loadTheme(): Theme {
    const stored = localStorage.getItem('gb_theme') as Theme | null;
    if (stored && themes.includes(stored)) {
        return stored;
    }
    return 'dark';
}

export function initTheme() {
    const theme = loadTheme();
    themeStore.set(theme);
    document.documentElement.setAttribute('data-theme', theme);

    const colors = getThemeColors(theme);
    injectThemeCSSVariables(colors);
    ensureThemeLinkElement(theme);
}
