<script lang="ts">
  import { settings, updateSettings } from '$lib/stores/settings';
  import { requestNotificationPermission, isNotificationSupported } from '$lib/notifications';
  import { themeStore, setTheme, themes } from '$lib/stores/theme';
  import { weechatVersion } from '$lib/stores/models';
import BaseDialog from '$components/BaseDialog.svelte';
  import Palette from '@lucide/svelte/icons/palette';
  import Monitor from '@lucide/svelte/icons/monitor';
  import Bell from '@lucide/svelte/icons/bell';
  import Sliders from '@lucide/svelte/icons/sliders-horizontal';
  import Plug from '@lucide/svelte/icons/plug';
  import X from '@lucide/svelte/icons/x';
  import Check from '@lucide/svelte/icons/check';
  import Undo2 from '@lucide/svelte/icons/undo-2';
  import FormInput from '$components/FormInput.svelte';

  let notifSupported = $derived(isNotificationSupported());

  let notifPermissionStatus = $derived($settings.notificationPermission);

  function handleThemeChange(theme: string) {
    setTheme(theme as typeof $themeStore);
    updateSettings({ theme });
  }

  $effect(() => {
    if ($settings.theme && $settings.theme !== $themeStore) {
      setTheme($settings.theme as typeof $themeStore);
    }
  });

  const appVersion = '0.11.0';

  const fontFamilies = [
    'Inconsolata, Consolas, Monaco, Ubuntu Mono, monospace',
    'Monaco, Menlo, Consolas, monospace',
    'Courier New, monospace',
    'Helvetica Neue, Arial, sans-serif',
    'sans-serif'
  ];

  function handleNotificationPermission() {
    requestNotificationPermission();
  }

  function resetSettings() {
    updateSettings({
      theme: 'dark',
      fontsize: '14px',
      fontfamily: fontFamilies[0],
      customCSS: '',
      iToken: '',
      iAlb: '',
      onlyUnread: false,
      noembed: true,
    orderbyserver: true,
      useFavico: true,
      soundnotification: true,
      enableMathjax: false,
      enableQuickKeys: true,
      readlineBindings: false,
      savepassword: false,
      autoconnect: false,
      showNicklist: true
    });
    setTheme('dark');
  }
</script>

<BaseDialog id="settings-modal" labelledby="settings-title">
  <div class="flex flex-col max-h-[85vh]">
    <div class="px-6 py-4 border-b border-border flex items-center justify-between">
      <h2 id="settings-title" class="text-lg font-bold text-white">Settings</h2>
      <div class="flex items-center space-x-2">
        <span class="text-xs text-text-muted">Glowing Bear version {appVersion} · WeeChat {$weechatVersion.join('.')}</span>
        <button
          type="button"
          data-testid="settings-modal-close"
          popovertarget="settings-modal"
          popovertargetaction="hide"
          class="text-text-secondary hover:text-white p-1 rounded"
          aria-label="Close settings"
        ><X size={18} /></button>
      </div>
    </div>

    <div class="flex-1 overflow-y-auto p-6 space-y-6">
      <section>
        <h3 class="text-sm font-bold text-text uppercase tracking-wide mb-3 flex items-center gap-2"><Palette size={14} />Appearance</h3>
        <div class="space-y-3">
          <div>
            <label for="theme-selector" class="block text-sm text-text-secondary mb-1">Theme</label>
            <select
              id="theme-selector"
              data-testid="theme-selector"
    value={$themeStore}
    onchange={(e) => handleThemeChange(e.currentTarget.value)}
              class="w-full px-3 py-2 bg-input-bg border border-border rounded text-text text-sm focus:outline-none focus:border-accent"
            >
              {#each themes as theme (theme)}
                <option value={theme}>{theme}</option>
              {/each}
            </select>
          </div>

          <div>
            <label for="font-family" class="block text-sm text-text-secondary mb-1">Font Family</label>
            <select
              id="font-family"
              value={$settings.fontfamily}
              onchange={(e) => updateSettings({ fontfamily: e.currentTarget.value })}
              class="w-full px-3 py-2 bg-input-bg border border-border rounded text-text text-sm focus:outline-none focus:border-accent"
            >
              {#each fontFamilies as family (family)}
                <option value={family}>{family.split(',')[0]}</option>
              {/each}
            </select>
          </div>

          <div>
             <label for="font-size" class="block text-sm text-text-secondary mb-1">Font Size</label>
             <FormInput
               id="font-size"
               type="text"
               value={$settings.fontsize}
               oninput={(e: Event) => updateSettings({ fontsize: (e.target as HTMLInputElement).value })}
               placeholder="14px"
             />
           </div>

          <div>
            <label for="custom-css" class="block text-sm text-text-secondary mb-1">Custom CSS</label>
            <textarea
              id="custom-css"
              data-testid="custom-css-textarea"
              value={$settings.customCSS}
              oninput={(e) => updateSettings({ customCSS: e.currentTarget.value })}
              rows={4}
              placeholder="/* Your custom CSS here */"
              class="w-full px-3 py-2 bg-input-bg border border-border rounded text-text text-sm font-mono focus:outline-none focus:border-accent"
            ></textarea>
          </div>
        </div>
      </section>

      <section>
        <h3 class="text-sm font-bold text-text uppercase tracking-wide mb-3 flex items-center gap-2"><Monitor size={14} />Display</h3>
        <div class="space-y-2">
          <label class="flex items-center justify-between py-2">
            <span class="text-sm text-text">Show nicklist</span>
            <input
              type="checkbox"
              checked={$settings.showNicklist}
              onchange={() => updateSettings({ showNicklist: !$settings.showNicklist })}
              class="w-4 h-4"
            />
          </label>

          <label class="flex items-center justify-between py-2">
            <span class="text-sm text-text">Only show buffers with unread messages</span>
            <input
              type="checkbox"
              checked={$settings.onlyUnread}
              onchange={() => updateSettings({ onlyUnread: !$settings.onlyUnread })}
              class="w-4 h-4"
            />
          </label>

          <label class="flex items-center justify-between py-2">
            <span class="text-sm text-text">Hide embedded content by default</span>
            <input
              type="checkbox"
              checked={$settings.noembed}
              onchange={() => updateSettings({ noembed: !$settings.noembed })}
              class="w-4 h-4"
            />
          </label>

          <label class="flex items-center justify-between py-2">
            <span class="text-sm text-text">Hierarchical buffer view (group by server)</span>
            <input
              type="checkbox"
              checked={$settings.orderbyserver}
              onchange={() => updateSettings({ orderbyserver: !$settings.orderbyserver })}
              class="w-4 h-4"
            />
          </label>

        <label class="flex items-center justify-between py-2">
            <span class="text-sm text-text">Enable readline keybindings (Ctrl+A/E/U/W/B/F)</span>
            <input
              type="checkbox"
              checked={$settings.readlineBindings}
              onchange={() => updateSettings({ readlineBindings: !$settings.readlineBindings })}
              class="w-4 h-4"
            />
          </label>

          <label class="flex items-center justify-between py-2">
            <span class="text-sm text-text">Use Alt+[0-9] to switch buffers</span>
            <input
              type="checkbox"
              checked={$settings.enableQuickKeys}
              onchange={() => updateSettings({ enableQuickKeys: !$settings.enableQuickKeys })}
              class="w-4 h-4"
            />
          </label>
        </div>
      </section>

      <section>
        <h3 class="text-sm font-bold text-text uppercase tracking-wide mb-3 flex items-center gap-2"><Bell size={14} />Notifications</h3>
        <div class="space-y-2">
          <label class="flex items-center justify-between py-2">
            <span class="text-sm text-text">Display unread count in favicon</span>
            <input
              type="checkbox"
              checked={$settings.useFavico}
              onchange={() => updateSettings({ useFavico: !$settings.useFavico })}
              data-testid="favico-checkbox"
              class="w-4 h-4"
            />
          </label>

          <label class="flex items-center justify-between py-2">
            <span class="text-sm text-text">Play sound on notification</span>
            <input
              type="checkbox"
              checked={$settings.soundnotification}
              onchange={() => updateSettings({ soundnotification: !$settings.soundnotification })}
              data-testid="sound-checkbox"
              class="w-4 h-4"
            />
          </label>

          {#if notifSupported}
             {#if notifPermissionStatus === 'granted'}
               <div class="flex items-center gap-2 py-1">
                 <span class="text-xs text-green-400 font-medium">✓ Granted</span>
               </div>
             {:else if notifPermissionStatus === 'denied'}
               <div class="space-y-1">
                 <div class="flex items-center gap-2 py-1">
                   <span class="text-xs text-red-400 font-medium">✕ Denied</span>
                 </div>
                 <p class="text-xs text-text-secondary">Permission was denied. Please enable notifications in your browser settings.</p>
               </div>
             {:else}
               <button
                  type="button"
                  onclick={handleNotificationPermission}
                  data-testid="request-notification-permission-button"
                  class="px-3 py-1.5 bg-accent hover:bg-accent-hover text-white text-sm rounded transition-colors"
                >
                  <Bell size={16} class="inline-block mr-1" />
                  Request Notification Permission
                </button>
             {/if}
           {/if}
        </div>
      </section>

      <section>
       <h3 class="text-sm font-bold text-text uppercase tracking-wide mb-3 flex items-center gap-2"><Sliders size={14} />Advanced</h3>
        <div class="space-y-2">
          <label class="flex items-center justify-between py-2">
            <span class="text-sm text-text">Enable LaTeX math rendering (KaTeX)</span>
            <input
              type="checkbox"
              checked={$settings.enableMathjax}
              onchange={() => updateSettings({ enableMathjax: !$settings.enableMathjax })}
              class="w-4 h-4"
            />
          </label>

         <div>
             <label for="imgur-token" class="block text-sm text-text-secondary mb-1">Imgur API Token</label>
             <FormInput
               id="imgur-token"
               type="text"
               value={$settings.iToken}
               oninput={(e: Event) => updateSettings({ iToken: (e.target as HTMLInputElement).value })}
               placeholder="Your Imgur API token"
             />
           </div>

           <div>
             <label for="imgur-album" class="block text-sm text-text-secondary mb-1">Imgur Album Hash</label>
             <FormInput
               id="imgur-album"
               type="text"
               value={$settings.iAlb}
               oninput={(e: Event) => updateSettings({ iAlb: (e.target as HTMLInputElement).value })}
               placeholder="Imgur album hash"
             />
           </div>
        </div>
      </section>

      <section>
        <h3 class="text-sm font-bold text-text uppercase tracking-wide mb-3 flex items-center gap-2"><Plug size={14} />Connection</h3>
        <div class="space-y-2">
          <label class="flex items-center justify-between py-2">
            <span class="text-sm text-text">Save password in browser</span>
            <input
              type="checkbox"
              checked={$settings.savepassword}
              onchange={() => updateSettings({ savepassword: !$settings.savepassword })}
              class="w-4 h-4"
            />
          </label>

          {#if $settings.savepassword}
            <label class="flex items-center justify-between py-2">
              <span class="text-sm text-text">Automatically connect</span>
              <input
                type="checkbox"
                checked={$settings.autoconnect}
                onchange={() => updateSettings({ autoconnect: !$settings.autoconnect })}
                class="w-4 h-4"
              />
            </label>
          {/if}
        </div>
      </section>
    </div>

    <div class="px-6 py-4 border-t border-border flex items-center justify-between">
      <button
        type="button"
        onclick={resetSettings}
        class="px-3 py-1.5 text-sm text-danger hover:text-danger hover:bg-surface-raised rounded transition-colors"
      >
        <Undo2 size={16} class="inline-block mr-1" />
        Reset to Defaults
      </button>
      <button
        type="button"
        popovertarget="settings-modal"
        popovertargetaction="hide"
        class="px-4 py-1.5 bg-accent hover:bg-accent-hover text-white text-sm rounded transition-colors"
      >
        <Check size={16} class="inline-block mr-1" />
        Done
      </button>
    </div>
  </div>
</BaseDialog>
