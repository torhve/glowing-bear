<script lang="ts">
  import { get } from 'svelte/store';
  import { connect } from '$lib/stores/connectionManager';
  import { connectionState, setConnectionStatus, setErrors, clearErrors } from '$lib/stores/connectionStore';
  import { settings, updateSettings } from '$lib/stores/settings';
  import { addToast } from '$lib/toast';

  import { parseRelayUrl } from '$lib/utils';
  import Zap from '@lucide/svelte/icons/zap';
  import Settings2 from '@lucide/svelte/icons/settings-2';
  import Rocket from '@lucide/svelte/icons/rocket';
  import Keyboard from '@lucide/svelte/icons/keyboard';
  import Download from '@lucide/svelte/icons/download';
  import MessageCircle from '@lucide/svelte/icons/message-circle';
import Eye from '@lucide/svelte/icons/eye';
import EyeOff from '@lucide/svelte/icons/eye-off';
import Lock from '@lucide/svelte/icons/lock';
import Key from '@lucide/svelte/icons/key';
 import Monitor from '@lucide/svelte/icons/monitor';
  import List from '@lucide/svelte/icons/list';
  import Save from '@lucide/svelte/icons/save';
  import FormInput from './FormInput.svelte';

  let hostField = $state('');
  let port = $state('443');
  let password = $state('');
  let tls = $state(false);
  let hostInvalid = $state(false);
  let showPassword = $state(false);
  let savepassword = $state(false);
  let autoconnect = $state(false);
  let shakePassword = $state(false);

  // Populate form fields from saved settings on mount
  $effect(() => {
    const s = get(settings);
    if (s.hostField) hostField = s.hostField;
    if (s.port) port = s.port;
    tls = s.tls || false;
    savepassword = s.savepassword || false;
    autoconnect = s.autoconnect || false;
    password = s.password || '';
  });

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
    console.log('handleConnect called, hostField:', hostField, 'hostInvalid:', hostInvalid);
    if (!hostField || hostField.trim() === '') {
      hostInvalid = true;
      console.log('validateHost failed, hostInvalid:', hostInvalid);
      return;
    }
    if (!validateHost()) {
      console.log('validateHost failed, hostInvalid:', hostInvalid);
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

<div class="min-h-screen bg-bg flex flex-col items-center overflow-y-auto py-12 px-4">
  <div class="w-full max-w-lg space-y-6">
    <div class="text-center mb-6">
      <img src="/glowing-bear.svg" alt="logo" class="w-20 h-20 mx-auto mb-2" />
      <h1 class="text-3xl font-bold text-text">Glowing Bear</h1>
      <p class="text-sm text-text-secondary mt-1">WeeChat web frontend</p>
    </div>

    <form
      onsubmit={(e) => { e.preventDefault(); handleConnect(); }}
      class="bg-surface rounded-lg p-6 space-y-4 border border-border"
    >
<div class="grid grid-cols-4 gap-2">
        <div class="col-span-3">
          <label for="host" class="block text-xs text-text-secondary mb-1">WeeChat relay hostname</label>
            <div class="relative">
              <Monitor size={16} class="absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary" />
              <FormInput
                 id="host"
                 data-testid="host-input"
                 type="text"
                 value={hostField}
                 oninput={(e: Event) => { hostField = (e.target as HTMLInputElement).value; validateHost(); handleHostChange(); }}
                 placeholder="Address"
                 extraClass={`pl-9 pr-3 ${hostInvalid ? 'border-danger' : ''}`}
                 autocapitalize="off"
               />
             </div>
        </div>
       <div class="min-w-[5rem]">
          <label for="port" class="block text-xs text-text-secondary mb-1">Port</label>
            <div class="relative">
              <List size={16} class="absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary" />
              <FormInput
                id="port"
                data-testid="port-input"
                type="text"
                value={port}
                oninput={(e: Event) => { port = (e.target as HTMLInputElement).value; handlePortChange(); }}
                placeholder="443"
                extraClass="pl-9 pr-3"
              />
            </div>
        </div>
      </div>

      <div>
        <label for="password" class="block text-xs text-text-secondary mb-1">WeeChat relay password</label>
        <div class="relative">
          <Key size={16} class="absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary" />
          <FormInput
            id="password"
            data-testid="password-input"
            type={showPassword ? 'text' : 'password'}
            value={password}
            oninput={(e: Event) => { password = (e.target as HTMLInputElement).value; }}
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

      <div class="flex items-center gap-2">
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

      <div class="flex items-center gap-2">
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
        <div class="flex items-center gap-2">
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

      {#if $connectionState.errors.errorMessage}
        <div data-testid="error-message" class="bg-danger/10 border border-danger rounded p-3 text-sm text-danger">
          Connection error: The client was unable to connect to the WeeChat relay
        </div>
      {/if}
      {#if $connectionState.errors.passwordError}
        <div data-testid="error-message" class="bg-danger/10 border border-danger rounded p-3 text-sm text-danger">
          Error: wrong password or token
        </div>
      {/if}
      {#if $connectionState.errors.tlsError}
        <div data-testid="error-message" class="bg-danger/10 border border-danger rounded p-3 text-sm text-danger">
          Secure connection error: Could not establish TLS connection
        </div>
      {/if}
      {#if $connectionState.errors.oldWeechatError}
        <div data-testid="error-message" class="bg-danger/10 border border-danger rounded p-3 text-sm text-danger">
          WeeChat version error: WeeChat version must be 2.9 or later
        </div>
      {/if}
      {#if $connectionState.errors.hashAlgorithmDisagree}
        <div data-testid="error-message" class="bg-danger/10 border border-danger rounded p-3 text-sm text-danger">
          Hash algorithm error: Please set relay.network.password_hash_algo to "pbkdf2+sha512" or "plain" in WeeChat
        </div>
      {/if}

        {#if $connectionState.status === 'connecting'}
         <div data-testid="connecting-state" class="text-center text-accent">Connecting...</div>
       {/if}

      <button
        data-testid="connect-button"
        type="submit"
        disabled={$connectionState.status === 'connecting' || hostInvalid}
        class="w-full px-4 py-2 bg-accent hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium rounded transition-colors"
      >
       {#if $connectionState.status === 'connecting'}
          <Zap size={16} class="inline-block mr-1 animate-pulse" />
          Connecting...
        {:else}
          <Zap size={16} class="inline-block mr-1" />
          Connect
        {/if}
      </button>
    </form>

<div class="space-y-2">
      <details class="bg-surface rounded border border-border">
        <summary class="px-4 py-2 text-sm font-medium text-text hover:text-white flex items-center gap-2">
          <Settings2 size={14} />Connection settings
        </summary>
        <div class="px-4 pb-3 text-sm text-text-secondary">
          Enter your WeeChat relay address above and click Connect.
        </div>
      </details>
      <details class="bg-surface rounded border border-border">
        <summary class="px-4 py-2 text-sm font-medium text-text hover:text-white flex items-center gap-2">
          <Rocket size={14} />Getting Started
        </summary>
        <div class="px-4 pb-3 text-sm text-text-secondary">
          WeeChat 2.9+ is required. Set up an encrypted relay with /relay add tls.weechat 9001
        </div>
      </details>
      <details class="bg-surface rounded border border-border">
        <summary class="px-4 py-2 text-sm font-medium text-text hover:text-white flex items-center gap-2">
          <Keyboard size={14} />Usage instructions
        </summary>
        <div class="px-4 pb-3 text-sm text-text-secondary">
          Alt+0-9: Quick switch buffer, Alt+J: Jump to buffer, Alt+` : Previous buffer, Alt+A: Next activity, Alt+Up/Down: Adjacent buffer, Alt+h: Clear unread, Alt+n: Toggle nicklist, Alt+l: Focus input, Alt+G: Search buffers, Double Esc: Disconnect, Tab: Nick completion, Readline: Ctrl+A/E/U/W/B/F/K
        </div>
      </details>
      <details class="bg-surface rounded border border-border">
        <summary class="px-4 py-2 text-sm font-medium text-text hover:text-white flex items-center gap-2">
          <Download size={14} />Install app
        </summary>
        <div class="px-4 pb-3 text-sm text-text-secondary">
          Chrome: Menu > Add to home screen. Desktop: Create application shortcuts.
        </div>
      </details>
      <details class="bg-surface rounded border border-border">
        <summary class="px-4 py-2 text-sm font-medium text-text hover:text-white flex items-center gap-2">
          <MessageCircle size={14} />Get involved
        </summary>
        <div class="px-4 pb-3 text-sm text-text-secondary">
          Check out our GitHub page or join #glowing-bear on libera.chat!
        </div>
      </details>
    </div>
  </div>
</div>
