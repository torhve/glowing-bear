<script lang="ts">
  import { settings, updateSettings } from '#lib/stores/settings.ts';
  import type { ProtocolPreference } from '#lib/types.ts';
  import { get } from 'svelte/store';
  import { requestNotificationPermission, isNotificationSupported } from '#lib/notifications.ts';
  import { type ThemeSlot } from '#lib/stores/theme.ts';
  import { themes, themeLabels, isTheme } from '#lib/themes.ts';
  import { weechatVersion, relayApiVersion } from '#lib/stores/models.ts';
  import { activeTransport } from '#lib/stores/connectionStore.ts';
  import { clamp } from '#lib/num.ts';
  import { FONT_SIZE_DEFAULT_CSS, FONT_SIZE_DEFAULT_PX, parseFontSizePx } from '#lib/fontSize.ts';
  import { FONT_FAMILY_DEFAULT_CSS } from '#lib/fontFamily.ts';
  import BaseDialog from '#components/BaseDialog.svelte';
  import Palette from '@lucide/svelte/icons/palette';
  import Monitor from '@lucide/svelte/icons/monitor';
  import Bell from '@lucide/svelte/icons/bell';
  import Sliders from '@lucide/svelte/icons/sliders-horizontal';
  import Plug from '@lucide/svelte/icons/plug';
  import X from '@lucide/svelte/icons/x';
  import Check from '@lucide/svelte/icons/check';
  import Undo2 from '@lucide/svelte/icons/undo-2';
  import Type from '@lucide/svelte/icons/type';
  import Hash from '@lucide/svelte/icons/hash';
  import Code from '@lucide/svelte/icons/code';
  import Users from '@lucide/svelte/icons/users';
  import ListFilter from '@lucide/svelte/icons/list-filter';
  import ImageOff from '@lucide/svelte/icons/image-off';
  import FolderTree from '@lucide/svelte/icons/folder-tree';
  import Keyboard from '@lucide/svelte/icons/keyboard';
  import ArrowLeftRight from '@lucide/svelte/icons/arrow-left-right';
  import MessageCircle from '@lucide/svelte/icons/message-circle';
  import SmilePlus from '@lucide/svelte/icons/smile-plus';
  import CopyX from '@lucide/svelte/icons/copy-x';
  import Eye from '@lucide/svelte/icons/eye';
  import Volume2 from '@lucide/svelte/icons/volume-2';
  import Sigma from '@lucide/svelte/icons/sigma';
  import Image from '@lucide/svelte/icons/image';
  import Lock from '@lucide/svelte/icons/lock';
  import LogIn from '@lucide/svelte/icons/log-in';
  import Cog from '@lucide/svelte/icons/cog';
  import { version as appVersion } from '../../../package.json';
  import FormInput from '#components/FormInput.svelte';
  import FormSelect from '#components/FormSelect.svelte';
  import FormTextarea from '#components/FormTextarea.svelte';
  import ToggleOption from '#components/ToggleOption.svelte';
  import { FORM_FIELD_CLASS } from '#lib/formControlClass.ts';
  import type { LucideIcon } from '@lucide/svelte';

  // About footer line: app version always; relay version + transport only
  // once known (API relays report the Relay API version; legacy relays don't).
  let versionLine = $derived(
    `Glowing Bear version ${appVersion} (${__GIT_COMMIT__})` +
      ($weechatVersion.length
        ? ` · WeeChat ${$weechatVersion.join('.')}` +
          ($activeTransport === 'api' && $relayApiVersion
            ? ` · Relay API ${$relayApiVersion}`
            : $activeTransport === 'legacy'
            ? ' · legacy WebSocket'
            : '')
        : ''),
  );

  let notifSupported = $derived(isNotificationSupported());

  let notifPermissionStatus = $derived($settings.notificationPermission);

  // Font size slider state synced with settings store
  // The bounds belong to the slider and the text field at the same time, and the
  // slider's own min and max are the same pair as these. The *value rule* is not
  // here: `lib/fontSize.ts` owns it, because the same string is also read by
  // `+page.svelte` as a CSS length and the two readings must not disagree.
  const FONT_SIZE_MIN = 6;
  const FONT_SIZE_MAX = 36;

  let fontSizePx = $state(FONT_SIZE_DEFAULT_PX);

  // Sync slider position from settings store
  $effect(() => {
    const px = parseFontSizePx($settings.fontsize);
    fontSizePx = px === null ? FONT_SIZE_DEFAULT_PX : clamp(px, FONT_SIZE_MIN, FONT_SIZE_MAX);
  });

  // The slots are settings and `+page.svelte` is the only writer of the applied
  // palette, so the modal never touches `data-theme` itself: a reset, a slot edit and
  // an OS flip all reach the document through the same code.
  function handleThemeSlotChange(slot: ThemeSlot, value: string) {
    if (!isTheme(value)) return;
    updateSettings(slot === 'dark' ? { themeDark: value } : { themeLight: value });
  }

  function handleNotificationPermission() {
    requestNotificationPermission();
  }

  function resetSettings() {
    updateSettings({
      themeDark: 'dark',
      themeLight: 'light',
      fontsize: '14px',
      // An empty family is not "no font": it means nothing is written over the
      // stylesheet's own `--font-mono`, so the reset lands on the same family a
      // fresh install gets instead of a stack this modal invented.
      fontfamily: '',
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
      showNicklist: true,
      stylizePrivateChats: false,
      enableEmojify: true,
      enableFormatting: true,
      warnDuplicateLinks: true
    });
  }

  // Toggle save-password checkbox: when unchecked, clear stored password from settings.
  function toggleSavePassword() {
    const s = get(settings);
    if (!s.savepassword) {
      updateSettings({ savepassword: true });
    } else {
      updateSettings({ savepassword: false, password: '' });
    }
  }
</script>

{#snippet sectionHeader(title: string, Icon: LucideIcon)}
  <h3 class="settings-section-header text-base font-bold text-accent uppercase tracking-wide mb-3 flex items-center gap-2"><Icon size={14} />{title}</h3>
{/snippet}

<BaseDialog id="settings-modal" labelledby="settings-title">
  <div class="settings-modal-content flex flex-col max-h-[85vh]">
    <div class="settings-header px-6 py-4 border-b border-border flex items-center justify-between">
      <h2 id="settings-title" class="text-lg font-bold text-white">Settings</h2>
      <div class="flex items-center space-x-2">
        <span class="settings-version text-xs text-text-muted">{versionLine}</span>
        <button
          type="button"
          data-testid="settings-modal-close"
          popovertarget="settings-modal"
          popovertargetaction="hide"
          class="text-text-secondary hover:text-white p-1 rounded transition-colors"
          aria-label="Close settings"
        ><X size={18} /></button>
      </div>
    </div>

    <div class="settings-body flex-1 overflow-y-auto p-6 space-y-6">
      <section class="settings-section" data-settings-section="appearance">
        {@render sectionHeader('Appearance', Palette)}
        <div class="space-y-3">
          <div>
            <label for="theme-dark-selector" class="block text-sm text-text-secondary mb-1">Theme for dark mode</label>
            <FormSelect
              id="theme-dark-selector"
              value={$settings.themeDark}
              onchange={(e) => handleThemeSlotChange('dark', e.currentTarget.value)}
            >
              {#each themes as theme (theme)}
                <option value={theme}>{themeLabels[theme]}</option>
              {/each}
            </FormSelect>
          </div>

          <div>
            <label for="theme-light-selector" class="block text-sm text-text-secondary mb-1">Theme for light mode</label>
            <FormSelect
              id="theme-light-selector"
              value={$settings.themeLight}
              onchange={(e) => handleThemeSlotChange('light', e.currentTarget.value)}
            >
              {#each themes as theme (theme)}
                <option value={theme}>{themeLabels[theme]}</option>
              {/each}
            </FormSelect>
            <p class="mt-1 text-xs text-text-muted">
              Glowing Bear follows the system's light/dark setting and uses the matching theme.
              Pick the same theme in both to keep one look whatever the system does.
            </p>
          </div>

          <div>
            <label for="font-family" class="block text-sm text-text-secondary mb-1 flex items-center gap-1"><Type size={14} class="shrink-0" />Font Family</label>
            <!--
              Not FormInput: this field shares the surface the selects and the textarea
              use, and FormInput would add hover, placeholder and transition classes plus
              its own size-derived padding. `settings-option-rows-contract.test.ts` pins
              that difference so it stays a decision rather than an accident.
            -->
            <input
              id="font-family"
              data-testid="font-family-input"
              type="text"
              value={$settings.fontfamily}
              oninput={(e: Event) => updateSettings({ fontfamily: (e.target as HTMLInputElement).value })}
              placeholder={FONT_FAMILY_DEFAULT_CSS}
              class={FORM_FIELD_CLASS}
            />
          </div>

          <div>
            <label for="font-size" class="block text-sm text-text-secondary mb-1 flex items-center gap-1"><Hash size={14} class="shrink-0" />Font Size</label>
            <div class="flex flex-col gap-1">
              <div class="flex items-center gap-2">
                <input
                  id="font-size-slider"
                  data-testid="font-size-slider"
                  type="range"
                  min={FONT_SIZE_MIN}
                  max={FONT_SIZE_MAX}
                  step={1}
                  bind:value={fontSizePx}
                  oninput={() => updateSettings({ fontsize: fontSizePx + 'px' })}
                  class="flex-1 accent-accent cursor-pointer"
                />
                <span class="font-size-label text-xs text-text-muted w-8 text-right">{fontSizePx}px</span>
              </div>
              <FormInput
                id="font-size"
                data-testid="font-size-input"
                type="text"
                value={$settings.fontsize}
                oninput={(e: Event) => {
                  const val = (e.target as HTMLInputElement).value!;
                  const px = parseFontSizePx(val);
                  if (px !== null) {
                    fontSizePx = clamp(px, FONT_SIZE_MIN, FONT_SIZE_MAX);
                  }
                  updateSettings({ fontsize: val });
                }}
                placeholder={FONT_SIZE_DEFAULT_CSS}
                extraClass="w-20"
              />
            </div>
          </div>

          <div>
            <label for="custom-css" class="block text-sm text-text-secondary mb-1 flex items-center gap-1"><Code size={14} class="shrink-0" />Custom CSS</label>
            <FormTextarea
              id="custom-css"
              data-testid="custom-css-textarea"
              value={$settings.customCSS}
              oninput={(e) => updateSettings({ customCSS: e.currentTarget.value })}
              rows={4}
              placeholder="/* Your custom CSS here */"
            />
          </div>
        </div>
      </section>

      <section class="settings-section" data-settings-section="display">
        {@render sectionHeader('Display', Monitor)}
        <div class="space-y-2">
          <ToggleOption id="show-nicklist" name="showNicklist" icon={Users} checked={$settings.showNicklist}
            onchange={() => updateSettings({ showNicklist: !$settings.showNicklist })}>
            Show nicklist
          </ToggleOption>

          <ToggleOption id="noembed" name="noembed" icon={ImageOff} checked={$settings.noembed}
            onchange={() => updateSettings({ noembed: !$settings.noembed })}>
            Hide embedded content by default
          </ToggleOption>

          <ToggleOption id="orderbyserver" name="orderbyserver" icon={FolderTree} checked={$settings.orderbyserver}
            onchange={() => updateSettings({ orderbyserver: !$settings.orderbyserver })}>
            Hierarchical buffer view (group by server)
          </ToggleOption>

          <ToggleOption id="stylize-private-chats" name="stylizePrivateChats" icon={MessageCircle}
            checked={$settings.stylizePrivateChats} testid="stylizePrivateChats-checkbox"
            onchange={() => updateSettings({ stylizePrivateChats: !$settings.stylizePrivateChats })}>
            Stylize private chats as bubbles
          </ToggleOption>
        </div>
      </section>

      <section class="settings-section" data-settings-section="behaviour">
        {@render sectionHeader('Behaviour', Cog)}
        <div class="space-y-2">
          <ToggleOption id="only-unread" name="onlyUnread" icon={ListFilter} checked={$settings.onlyUnread}
            onchange={() => updateSettings({ onlyUnread: !$settings.onlyUnread })}>
            Only show buffers with unread messages
          </ToggleOption>

          <ToggleOption id="readline-bindings" name="readlineBindings" icon={Keyboard} checked={$settings.readlineBindings}
            onchange={() => updateSettings({ readlineBindings: !$settings.readlineBindings })}>
            Enable readline keybindings (Ctrl+A/E/U/W/B/F)
          </ToggleOption>

          <ToggleOption id="enable-formatting" name="enableFormatting" icon={Type} checked={$settings.enableFormatting}
            testid="enableFormatting-checkbox"
            onchange={() => updateSettings({ enableFormatting: !$settings.enableFormatting })}>
            Enable text formatting (Ctrl+B/I/U/K)
          </ToggleOption>

          <ToggleOption id="enable-quick-keys" name="enableQuickKeys" icon={ArrowLeftRight} checked={$settings.enableQuickKeys}
            onchange={() => updateSettings({ enableQuickKeys: !$settings.enableQuickKeys })}>
            Use Alt+[0-9] to switch buffers
          </ToggleOption>

          <ToggleOption id="enable-emojify" name="enableEmojify" icon={SmilePlus} checked={$settings.enableEmojify}
            testid="enableEmojify-checkbox"
            onchange={() => updateSettings({ enableEmojify: !$settings.enableEmojify })}>
            Replace emoji shortcodes while typing (<code>:beer:</code> → 🍺)
          </ToggleOption>

          <ToggleOption id="warn-duplicate-links" name="warnDuplicateLinks" icon={CopyX}
            checked={$settings.warnDuplicateLinks !== false} testid="warn-duplicate-links"
            onchange={() => updateSettings({ warnDuplicateLinks: $settings.warnDuplicateLinks === false })}>
            Warn if trying to send a duplicate link
          </ToggleOption>
        </div>
      </section>

      <section class="settings-section" data-settings-section="notifications">
        {@render sectionHeader('Notifications', Bell)}
        <div class="space-y-2">
          <ToggleOption id="use-favico" name="useFavico" icon={Eye} checked={$settings.useFavico}
            testid="favico-checkbox" onchange={() => updateSettings({ useFavico: !$settings.useFavico })}>
            Display unread count in favicon
          </ToggleOption>

          <ToggleOption id="sound-notification" name="soundnotification" icon={Volume2} checked={$settings.soundnotification}
            testid="sound-checkbox"
            onchange={() => updateSettings({ soundnotification: !$settings.soundnotification })}>
            Play sound on notification
          </ToggleOption>

          {#if notifSupported}
            {#if notifPermissionStatus === 'granted'}
              <div class="notification-status granted flex items-center gap-2 py-1">
                <span         class="text-xs text-success font-medium transition-opacity">✓ Granted</span>
              </div>
            {:else if notifPermissionStatus === 'denied'}
              <div class="notification-status denied space-y-1">
                <div class="flex items-center gap-2 py-1">
                  <span class="text-xs text-danger font-medium">✕ Denied</span>
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

      <section class="settings-section" data-settings-section="advanced">
        {@render sectionHeader('Advanced', Sliders)}
        <div class="space-y-2">
          <ToggleOption id="enable-mathjax" name="enableMathjax" icon={Sigma} checked={$settings.enableMathjax}
            onchange={() => updateSettings({ enableMathjax: !$settings.enableMathjax })}>
            Enable LaTeX math rendering (KaTeX)
          </ToggleOption>

          <div>
            <label for="imgur-token" class="block text-sm text-text-secondary mb-1 flex items-center gap-1"><Image size={14} class="shrink-0" />Imgur API Token</label>
            <FormInput
              id="imgur-token"
              type="text"
              value={$settings.iToken}
              oninput={(e: Event) => updateSettings({ iToken: (e.target as HTMLInputElement).value })}
              placeholder="Your Imgur API token"
            />
          </div>

          <div>
            <label for="imgur-album" class="block text-sm text-text-secondary mb-1 flex items-center gap-1"><Image size={14} class="shrink-0" />Imgur Album Hash</label>
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

      <section class="settings-section" data-settings-section="connection">
        {@render sectionHeader('Connection', Plug)}
        <div class="space-y-2">
          <ToggleOption id="save-password" name="savepassword" icon={Lock} checked={$settings.savepassword}
            onchange={toggleSavePassword}>
            Save password in browser
          </ToggleOption>

          {#if $settings.savepassword}
            <ToggleOption id="auto-connect" name="autoconnect" icon={LogIn} checked={$settings.autoconnect}
              onchange={() => updateSettings({ autoconnect: !$settings.autoconnect })}>
              Automatically connect
            </ToggleOption>
          {/if}

          <label class="settings-option flex items-center justify-between py-2" data-settings-option="protocol">
            <span class="settings-option-label text-sm text-text flex items-center gap-2"><Plug size={14} class="text-text-secondary shrink-0" />Relay protocol</span>
            <select
              id="protocol-selector"
              data-testid="protocol-selector"
              class="bg-surface-raised text-text text-sm border border-border rounded px-2 py-1"
              value={$settings.protocol}
              onchange={(e) => updateSettings({ protocol: (e.target as HTMLSelectElement).value as ProtocolPreference })}
            >
              <option value="auto">Auto (API for WeeChat ≥4.10.1, legacy for older)</option>
              <option value="api">New API relay (WeeChat ≥4.10.1 only)</option>
              <option value="legacy">Legacy WebSocket (all versions, deprecated)</option>
            </select>
          </label>
        </div>
      </section>
    </div>

    <div class="settings-footer px-6 py-4 border-t border-border flex items-center justify-between">
      <button
        data-testid="reset-settings-button"
        type="button"
        onclick={resetSettings}
        class="px-3 py-1.5 text-sm text-danger hover:text-danger hover:bg-surface-raised rounded transition-colors"
      >
        <Undo2 size={16} class="inline-block mr-1" />
        Reset to Defaults
      </button>
      <button
        data-testid="done-settings-button"
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
