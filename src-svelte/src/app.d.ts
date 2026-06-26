// Type declarations for Glowing Bear

// Build-time git commit hash injected by Vite's `define` in vite.config.ts.
declare const __GIT_COMMIT__: string;

declare module 'virtual:pwa-register' {
  export function registerSW(options?: {
    immediate?: boolean;
    onRegistered?: (registration: ServiceWorkerRegistration | undefined) => void;
    onRegisterError?: (error: unknown) => void;
  }): (reloadPage?: boolean) => Promise<void>;
}

declare module 'virtual:pwa-info' {
  export interface PwaInfo {
    webManifest: {
      linkTag: string;
    };
  }
  export const pwaInfo: PwaInfo | undefined;
}
