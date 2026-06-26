<script lang="ts">
  import { get } from 'svelte/store';
  import { connect } from '$lib/stores/connectionManager';
  import { connectionState, setConnectionStatus, setErrors, clearErrors } from '$lib/stores/connectionStore';
  import { settings, updateSettings } from '$lib/stores/settings';
  import { addToast } from '$lib/toast';
  import { isWindowsTauri } from '$lib/tauriWindow';

  import { parseRelayUrl, makeKeyboardActivatable } from '$lib/utils';
  import Zap from '@lucide/svelte/icons/zap';
  import Settings2 from '@lucide/svelte/icons/settings-2';
  import Rocket from '@lucide/svelte/icons/rocket';
  import Keyboard from '@lucide/svelte/icons/keyboard';
  import Download from '@lucide/svelte/icons/download';
  import MessageCircle from '@lucide/svelte/icons/message-circle';
import Globe from '@lucide/svelte/icons/globe';
import Eye from '@lucide/svelte/icons/eye';
import EyeOff from '@lucide/svelte/icons/eye-off';
import Lock from '@lucide/svelte/icons/lock';
import Key from '@lucide/svelte/icons/key';
 import Monitor from '@lucide/svelte/icons/monitor';
  import List from '@lucide/svelte/icons/list';
  import Save from '@lucide/svelte/icons/save';
  import Loader2 from '@lucide/svelte/icons/loader-2';
  import FormInput from './FormInput.svelte';
  import TauriTitlebar from './TauriTitlebar.svelte';
  import { DEBUG_FORM } from '$lib/debug';

  let hostField = $state('');
  let port = $state('443');
  let password = $state('');
  let tls = $state(false);
  let hostInvalid = $state(false);
  let showPassword = $state(false);
  let savepassword = $state(false);
  let autoconnect = $state(false);
  let shakePassword = $state(false);

  // Populate form fields from saved settings (reactive to store changes)
  $effect(() => {
    const s = $settings;
    if (s.hostField) hostField = s.hostField;
    if (s.port) port = s.port;
    tls = s.tls || false;
    savepassword = s.savepassword || false;
    autoconnect = s.autoconnect || false;
    password = s.password || '';
  });

  // Autoconnect is handled by +page.svelte's tryAutoConnect(). The ConnectionForm
  // only handles explicit user-initiated connections via handleConnect().
  // This prevents duplicate connection attempts on page load.

  $effect(() => {
    if (!hostField || hostField.trim() === '') {
      hostInvalid = false;
    }
  });

  $effect(() => {
    if ($connectionState.errors.passwordError) {
      shakePassword = true;
      setTimeout(() => { shakePassword = false; }, 500);
    }
  });

  let notificationToastShown = $state(false);

  $effect(() => {
    if ($connectionState.status === 'connected' && !notificationToastShown && $settings.notificationPermission === 'default') {
      notificationToastShown = true;
      const s = get(settings);
      if (s.notificationPermission === 'default') {
        addToast('Open Settings > Notifications to enable desktop notifications', {
          type: 'info',
          duration: 8000,
        });
      }
    }
  });

  function validateHost(): boolean {
    if (!hostField || hostField.trim() === '') {
      hostInvalid = false;
      return false;
    }
    if (hostField.startsWith('[') && hostField.endsWith(']')) {
      hostInvalid = false;
      return true;
    }
    const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
    const hostnameRegex = /^[a-zA-Z0-9.-]+$/;
    const hasPort = hostField.includes(':');
    const hasPath = hostField.includes('/');
    if (hasPort && hasPath) {
      hostInvalid = false;
      return true;
    }
    if (hasPort && !hasPath) {
      if (!ipv4Regex.test(hostField) && !hostnameRegex.test(hostField.split(':')[0] || '')) {
        hostInvalid = true;
        return false;
      }
    }
    if (!hasPort && !hasPath) {
      if (!ipv4Regex.test(hostField) && !hostnameRegex.test(hostField)) {
        hostInvalid = true;
        return false;
      }
    }
    hostInvalid = false;
    return true;
  }

  async function handleConnect() {
    if (DEBUG_FORM) console.log('handleConnect called, hostField:', hostField, 'hostInvalid:', hostInvalid);
    if (!hostField || hostField.trim() === '') {
      hostInvalid = true;
      if (DEBUG_FORM) console.log('validateHost failed, hostInvalid:', hostInvalid);
      return;
    }
    if (!validateHost()) {
      if (DEBUG_FORM) console.log('validateHost failed, hostInvalid:', hostInvalid);
      return;
    }
    clearErrors();
    setConnectionStatus('connecting');
    try {
      const { host: parsedHost, port: parsedPort, path: parsedPath } = parseRelayUrl(hostField, port);
      await connect(parsedHost, parsedPort, parsedPath, password, tls, false);
      updateSettings({
        hostField: parsedHost,
        port: parsedPort.toString(),
        tls,
        savepassword,
        autoconnect,
        ...(savepassword ? { password } : {})
      });
    } catch (e) {
      console.error('Connection failed:', e);
      setErrors({ errorMessage: true });
      setConnectionStatus('error');
      addToast('Connection failed. Check settings and try again.', { type: 'error', duration: 10000 });
    }
  }

  function handleHostChange() {
    updateSettings({ hostField });
  }

  function handlePortChange() {
    updateSettings({ port });
  }

  function toggleTLS() {
    updateSettings({ tls });
  }
</script>

<div
  role="presentation"
  class="connection-page min-h-[100vh] min-h-dvh bg-bg flex flex-col overflow-y-scroll"
  onkeydown={makeKeyboardActivatable(() => { if (!['INPUT','TEXTAREA','SELECT'].includes((document.activeElement as HTMLElement).tagName)) handleConnect(); })}
>
  <TauriTitlebar variant="standalone" />
  <div class="connection-content flex-1 flex items-start justify-center px-4 pt-6">
    <div class="connection-card w-full max-w-lg space-y-6">
      <div class="connection-branding text-center mb-6">
      <img src="/glowing-bear.svg" alt="logo" class="connection-logo w-20 h-20 mx-auto mb-2" />
      <h1 class="connection-title text-3xl font-bold text-text">Glowing Bear</h1>
      <p class="connection-subtitle text-sm text-text-secondary mt-1">WeeChat web frontend</p>
    </div>

    <form
      onsubmit={(e) => { e.preventDefault(); handleConnect(); }}
      class="connection-form bg-panel rounded-lg p-6 space-y-4 border border-border"
    >
<div class="connection-host-row grid grid-cols-4 gap-2">
        <div class="connection-host-field col-span-3">
          <label for="host" class="block text-xs text-text-secondary mb-1">WeeChat relay hostname</label>
            <div class="relative">
              <Monitor size={16} class="absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary" />
              <FormInput
                  id="host"
                  data-testid="host-input"
                  type="text"
                  value={hostField}
                  oninput={(e: Event) => { hostField = (e.target as HTMLInputElement).value; validateHost(); handleHostChange(); }}
                  onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); handleConnect(); } }}
                  placeholder="Address"
                  extraClass={`pl-9 pr-3 ${hostInvalid ? 'border-danger' : ''}`}
                  autocapitalize="off"
                />
             </div>
        </div>
        <div class="connection-port-field min-w-[5rem]">
          <label for="port" class="block text-xs text-text-secondary mb-1">Port</label>
            <div class="relative">
              <List size={16} class="absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary" />
               <FormInput
                 id="port"
                 data-testid="port-input"
                 type="text"
                 value={port}
                 oninput={(e: Event) => { port = (e.target as HTMLInputElement).value; handlePortChange(); }}
                 onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); handleConnect(); } }}
                 placeholder="443"
                 extraClass="pl-9 pr-3"
               />
            </div>
        </div>
      </div>

      <div class="connection-password-field">
        <label for="password" class="block text-xs text-text-secondary mb-1">WeeChat relay password</label>
        <div class="relative">
          <Key size={16} class="absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary" />
           <FormInput
             id="password"
             data-testid="password-input"
             type={showPassword ? 'text' : 'password'}
             value={password}
             oninput={(e: Event) => { password = (e.target as HTMLInputElement).value; }}
             onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); handleConnect(); } }}
             placeholder="Password"
             extraClass={`pl-9 pr-10 ${shakePassword ? 'shake' : ''}`}
           />
          <button
            type="button"
            data-testid="toggle-password-visibility"
            onclick={() => showPassword = !showPassword}
            class="absolute right-3 top-1/2 -translate-y-1/2 text-text-secondary hover:text-text transition-colors"
          >
            {#if showPassword}
              <EyeOff size={18} />
            {:else}
              <Eye size={18} />
            {/if}
          </button>
        </div>
      </div>

      <div class="connection-tls-row flex items-center gap-2">
        <input
          id="tls"
          data-testid="tls-checkbox"
          type="checkbox"
          bind:checked={tls}
          onchange={() => { toggleTLS(); }}
          class="mr-1"
        />
        <Lock size={16} class="text-text-secondary flex-shrink-0" />
        <label for="tls" class="text-sm text-text">
          Encryption. <strong class="text-white">Strongly recommended!</strong>
        </label>
      </div>

      <div class="connection-savepassword-row flex items-center gap-2">
        <input
          id="savepassword"
          data-testid="savepassword-checkbox"
          type="checkbox"
          bind:checked={savepassword}
          onchange={() => updateSettings({ savepassword })}
           class="mr-1"
         />
        <Save size={16} class="text-text-secondary flex-shrink-0" />
        <label for="savepassword" class="text-sm text-text">
          Save password in your browser
        </label>
      </div>

      {#if savepassword}
        <div class="connection-autoconnect-row flex items-center gap-2">
          <input
            id="autoconnect"
            data-testid="autoconnect-checkbox"
            type="checkbox"
            bind:checked={autoconnect}
            onchange={() => updateSettings({ autoconnect })}
            class="mr-1"
          />
          <Zap size={16} class="text-text-secondary flex-shrink-0" />
          <label for="autoconnect" class="text-sm text-text">
            Automatically connect
          </label>
        </div>
      {/if}

      {#if $connectionState.errors.serverUnreachable}
        <div data-testid="error-message" data-error-type="server-unreachable" class="connection-error bg-danger/10 border border-danger rounded p-3 text-sm text-danger">
          Unable to reach WeeChat relay at {hostField}:{port} — check that it is running and reachable
        </div>
      {/if}
      {#if $connectionState.errors.errorMessage}
        <div data-testid="error-message" data-error-type="connection-error" class="connection-error bg-danger/10 border border-danger rounded p-3 text-sm text-danger">
          Connection error: The client was unable to connect to the WeeChat relay
        </div>
      {/if}
      {#if $connectionState.errors.passwordError}
        <div data-testid="error-message" data-error-type="password-error" class="connection-error bg-danger/10 border border-danger rounded p-3 text-sm text-danger">
          Error: wrong password or token
        </div>
      {/if}
      {#if $connectionState.errors.tlsError}
        <div data-testid="error-message" data-error-type="tls-error" class="connection-error bg-danger/10 border border-danger rounded p-3 text-sm text-danger">
          Secure connection error: Could not establish TLS connection
        </div>
      {/if}
      {#if $connectionState.errors.oldWeechatError}
        <div data-testid="error-message" data-error-type="old-weechat" class="connection-error bg-danger/10 border border-danger rounded p-3 text-sm text-danger">
          WeeChat version error: WeeChat version must be 2.9 or later
        </div>
      {/if}
      {#if $connectionState.errors.hashAlgorithmDisagree}
        <div data-testid="error-message" data-error-type="hash-algorithm" class="connection-error bg-danger/10 border border-danger rounded p-3 text-sm text-danger">
          Hash algorithm mismatch: server requires an auth method this client cannot use. Set relay.network.password_hash_algo to "pbkdf2+sha512", "pbkdf2+sha256", "sha256", "sha512", or "plain". If using Tauri, enable TLS for secure context access.
        </div>
      {/if}

      <button
        data-testid="connect-button"
        type="submit"
        disabled={$connectionState.status === 'connecting' || hostInvalid}
        class="w-full px-4 py-2 bg-accent hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium rounded transition-colors btn-glow"
      >
       {#if $connectionState.status === 'connecting'}
           <Loader2 size={16} class="inline-block mr-1 animate-spin" />
           Connecting<span class="loading-dots"><span>.</span><span>.</span><span>.</span></span>
         {:else}
           <Zap size={16} class="inline-block mr-1" />
           Connect
         {/if}
      </button>
    </form>

<div class="info-accordion-container space-y-2">
      <details open class="info-accordion bg-panel rounded border border-border" data-info-section="about">
        <summary class="info-accordion-summary px-4 py-2 text-sm font-medium text-text hover:text-white transition-colors">
          <img src="/glowing-bear.svg" class="w-4 h-4" alt="" />About
        </summary>
        <div class="info-accordion-content px-4 pb-3 text-sm text-text-secondary space-y-2">
          <p>Glowing Bear is a free, open-source web frontend for WeeChat — no backend required.</p>
          <p>This is a complete rewrite from the original AngularJS codebase into Svelte 5 + TypeScript. The old version was hard to maintain and had next to no tests. Everything still runs entirely as static files in your browser, connecting directly to your WeeChat instance via WebSocket relay — zero intermediary server.</p>
          <p>Stack: SvelteKit 2, Svelte 5 runes, TypeScript, Tailwind CSS v4, Vite 6, Vitest, Playwright E2E testing, fflate, DOMPurify</p>
        </div>
      </details>
      <details class="info-accordion bg-panel rounded border border-border" data-info-section="connection">
        <summary class="info-accordion-summary px-4 py-2 text-sm font-medium text-text hover:text-white transition-colors">
          <Settings2 size={14} />Connection settings
        </summary>
        <div class="info-accordion-content px-4 pb-3 text-sm text-text-secondary">
          Enter your WeeChat relay address above and click Connect.
        </div>
      </details>
      <details class="info-accordion bg-panel rounded border border-border" data-info-section="getting-started">
        <summary class="info-accordion-summary px-4 py-2 text-sm font-medium text-text hover:text-white transition-colors">
          <Rocket size={14} />Getting Started
        </summary>
        <div class="info-accordion-content px-4 pb-3 text-sm text-text-secondary">
          WeeChat 2.9+ is required. Set up an encrypted relay with /relay add tls.weechat 9001
        </div>
      </details>
      {#if isWindowsTauri()}
        <details class="info-accordion bg-panel rounded border border-border" data-info-section="flags">
          <summary class="info-accordion-summary px-4 py-2 text-sm font-medium text-text hover:text-white transition-colors">
            <Globe size={14} />Flag emoji rendering on Windows
          </summary>
          <div class="info-accordion-content px-4 pb-3 text-sm text-text-secondary">
            <p>Windows doesn't include a font that renders country flag emojis by default. To see flag emojis properly, install <a href="https://github.com/Chasmical/flag-emojis-for-windows" target="_blank" rel="noopener noreferrer" class="text-accent underline hover:no-underline transition-colors">Flag Emojis for Windows</a>.</p>
          </div>
        </details>
      {/if}
      <details class="info-accordion bg-panel rounded border border-border" data-info-section="usage">
        <summary class="info-accordion-summary px-4 py-2 text-sm font-medium text-text hover:text-white transition-colors">
          <Keyboard size={14} />Usage instructions
        </summary>
        <div class="info-accordion-content px-4 pb-3 text-sm text-text-secondary space-y-3">
          <div>
            <p class="font-medium text-text mb-1">Navigation</p>
            <table class="w-full text-xs">
              <tbody>
                <tr><td class="py-0.5 pr-3 font-mono text-text-secondary whitespace-nowrap">Alt+0–9</td><td class="py-0.5">Quick switch buffer (0 = buffer 10)</td></tr>
                <tr><td class="py-0.5 pr-3 font-mono text-text-secondary whitespace-nowrap">Alt+J + 2 digits</td><td class="py-0.5">Jump to buffer by number</td></tr>
                <tr><td class="py-0.5 pr-3 font-mono text-text-secondary whitespace-nowrap">Alt+`</td><td class="py-0.5">Previous buffer</td></tr>
                <tr><td class="py-0.5 pr-3 font-mono text-text-secondary whitespace-nowrap">Alt+A</td><td class="py-0.5">Next buffer with activity</td></tr>
                <tr><td class="py-0.5 pr-3 font-mono text-text-secondary whitespace-nowrap">Alt+↑/↓</td><td class="py-0.5">Adjacent buffer</td></tr>
                <tr><td class="py-0.5 pr-3 font-mono text-text-secondary whitespace-nowrap">Escape</td><td class="py-0.5">Blur input / double-tap to disconnect</td></tr>
              </tbody>
            </table>
          </div>
          <div>
            <p class="font-medium text-text mb-1">Panels &amp; Search</p>
            <table class="w-full text-xs">
              <tbody>
                <tr><td class="py-0.5 pr-3 font-mono text-text-secondary whitespace-nowrap">Alt+n</td><td class="py-0.5">Toggle nicklist</td></tr>
                <tr><td class="py-0.5 pr-3 font-mono text-text-secondary whitespace-nowrap">Alt+L</td><td class="py-0.5">Focus input bar</td></tr>
                <tr><td class="py-0.5 pr-3 font-mono text-text-secondary whitespace-nowrap">Alt+G / Ctrl+G</td><td class="py-0.5">Search buffers</td></tr>
                <tr><td class="py-0.5 pr-3 font-mono text-text-secondary whitespace-nowrap">Alt+h</td><td class="py-0.5">Clear all unread</td></tr>
                <tr><td class="py-0.5 pr-3 font-mono text-text-secondary whitespace-nowrap">Hold Alt</td><td class="py-0.5">Show quick keys legend</td></tr>
              </tbody>
            </table>
          </div>
          <div>
            <p class="font-medium text-text mb-1">Input bar</p>
            <table class="w-full text-xs">
              <tbody>
                <tr><td class="py-0.5 pr-3 font-mono text-text-secondary whitespace-nowrap">Enter</td><td class="py-0.5">Send message</td></tr>
                <tr><td class="py-0.5 pr-3 font-mono text-text-secondary whitespace-nowrap">Shift+Enter</td><td class="py-0.5">Newline</td></tr>
                <tr><td class="py-0.5 pr-3 font-mono text-text-secondary whitespace-nowrap">Tab</td><td class="py-0.5">Nick completion</td></tr>
                <tr><td class="py-0.5 pr-3 font-mono text-text-secondary whitespace-nowrap">↑ / ↓</td><td class="py-0.5">Message history</td></tr>
                <tr><td class="py-0.5 pr-3 font-mono text-text-secondary whitespace-nowrap">Page Up/Down</td><td class="py-0.5">Scroll chat</td></tr>
              </tbody>
            </table>
          </div>
          <div>
            <p class="font-medium text-text mb-1">Readline bindings</p>
            <table class="w-full text-xs">
              <tbody>
                <tr><td class="py-0.5 pr-3 font-mono text-text-secondary whitespace-nowrap">Ctrl+A/E</td><td class="py-0.5">Start/end of line</td></tr>
                <tr><td class="py-0.5 pr-3 font-mono text-text-secondary whitespace-nowrap">Ctrl+U</td><td class="py-0.5">Delete from start of line to cursor</td></tr>
                <tr><td class="py-0.5 pr-3 font-mono text-text-secondary whitespace-nowrap">Ctrl+W</td><td class="py-0.5">Delete word before cursor</td></tr>
                <tr><td class="py-0.5 pr-3 font-mono text-text-secondary whitespace-nowrap">Ctrl+B/F</td><td class="py-0.5">Move back/forward one char</td></tr>
                <tr><td class="py-0.5 pr-3 font-mono text-text-secondary whitespace-nowrap">Ctrl+H</td><td class="py-0.5">Backspace</td></tr>
              </tbody>
            </table>
          </div>
          <div>
            <p class="font-medium text-text mb-1">Text formatting</p>
            <table class="w-full text-xs">
              <tbody>
                <tr><td class="py-0.5 pr-3 font-mono text-text-secondary whitespace-nowrap">Ctrl+B/I</td><td class="py-0.5">Bold / Italic</td></tr>
                <tr><td class="py-0.5 pr-3 font-mono text-text-secondary whitespace-nowrap">Ctrl+_</td><td class="py-0.5">Underline</td></tr>
                <tr><td class="py-0.5 pr-3 font-mono text-text-secondary whitespace-nowrap">Ctrl+Shift+R</td><td class="py-0.5">Reset formatting</td></tr>
                <tr><td class="py-0.5 pr-3 font-mono text-text-secondary whitespace-nowrap">Ctrl+K</td><td class="py-0.5">Color picker</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </details>
      <details class="info-accordion bg-panel rounded border border-border" data-info-section="install">
        <summary class="info-accordion-summary px-4 py-2 text-sm font-medium text-text hover:text-white transition-colors">
          <Download size={14} />Install app
        </summary>
        <div class="info-accordion-content px-4 pb-3 text-sm text-text-secondary">
          Chrome: Menu > Add to home screen. Desktop: Create application shortcuts.
        </div>
      </details>
      <details class="info-accordion bg-panel rounded border border-border" data-info-section="get-involved">
        <summary class="info-accordion-summary px-4 py-2 text-sm font-medium text-text hover:text-white transition-colors">
          <MessageCircle size={14} />Get involved
        </summary>
        <div class="info-accordion-content px-4 pb-3 text-sm text-text-secondary">
          Check out our GitHub page or join #glowing-bear on libera.chat!
        </div>
      </details>
    </div>
  </div>
  </div>
</div>
