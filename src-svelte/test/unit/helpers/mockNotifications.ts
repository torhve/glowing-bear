import { vi } from 'vitest';
import type * as Notifications from '#lib/notifications.ts';

/**
 * Stand-in for `#lib/notifications.ts` in a unit test.
 *
 * The real module talks to the Notification API, the favicon canvas, the document
 * title and the Tauri notification plugin, so any test that touches a message
 * path has to replace it. Returning the module's own type is the point: a rename
 * or a removal in `notifications.ts` stops compiling here instead of leaving a
 * mock that quietly keeps exporting a name the app no longer has — which is what
 * happened to `createDM`, `createMention` and `updateFavicon`, all three still
 * hand-stubbed in several files and none of them an export of the real module.
 *
 * `startIndicatorOwner` is not a `vi.fn()`: the app holds the returned function
 * as an unsubscribe, so a bare mock would hand back `undefined` and the caller
 * would throw the moment it cleaned up.
 *
 * A test that asserts on one of these calls imports the name from the mocked
 * module and reads it through `vi.mocked(name)`, which keeps the spy's argument
 * types instead of losing them to a local `vi.fn()`.
 */
export function mockNotifications(): typeof Notifications {
    return {
        requestNotificationPermission: vi.fn(async () => true),
        isNotificationSupported: vi.fn(() => false),
        createHighlight: vi.fn(async () => {}),
        cancelAll: vi.fn(),
        applyDocumentTitle: vi.fn(),
        applyBadge: vi.fn(),
        startIndicatorOwner: vi.fn(() => () => {}),
        refreshIndicators: vi.fn(),
        updateTitle: vi.fn(),
        updateFavico: vi.fn(),
        playNotificationSound: vi.fn(),
        initNotifications: vi.fn(async () => {}),
        onDisconnect: vi.fn(),
    };
}
