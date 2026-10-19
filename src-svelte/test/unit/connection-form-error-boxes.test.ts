/**
 * The connection form's error boxes, pinned before they are deduplicated.
 *
 * Eight failure causes each render their own box, and all eight open with the
 * identical tag: same `data-testid`, same wrapper class, only `data-error-type`
 * differing. That repetition is worth removing — but the attributes are the
 * contract. E2E specs reach these boxes through `[data-error-type="…"]` and
 * `getByTestId('error-message')`, and `connection-error` is a class name a user's
 * custom CSS can target, so a snippet that "tidies" the wrapper has to produce
 * these attributes exactly.
 *
 * Pinning all eight here rather than in E2E because each one needs a different
 * failure state to appear, and a unit mount can set each flag directly. What E2E
 * already covers (a real clock-skew failure, a real unreachable relay) stays
 * where it is; this covers the eight-at-once view no single live failure gives.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ConnectionForm from '#components/ConnectionForm.svelte';
import { clearErrors, setErrors } from '#lib/stores/connectionStore.ts';
import type { ConnectionError } from '#lib/types.ts';

vi.mock('#lib/stores/connectionManager.ts', () => ({
    connect: vi.fn(),
    pendingRetry: vi.fn(() => ({ active: false })),
    disconnect: vi.fn(),
    switchBuffer: vi.fn(),
    getSession: vi.fn(() => null),
}));

vi.mock('#lib/notifications.ts', () => ({
    createHighlight: vi.fn(),
    playNotificationSound: vi.fn(),
    updateTitle: vi.fn(),
    updateFavicon: vi.fn(),
    updateFavico: vi.fn(),
    startIndicatorOwner: () => () => {},
    refreshIndicators: vi.fn(),
    onDisconnect: vi.fn(),
}));

vi.mock('#lib/toast.ts', () => ({ addToast: vi.fn() }));

const components: Record<string, unknown>[] = [];

/** Mount once per test, then drive the error flags: the boxes are reactive. */
function render() {
    const target = document.createElement('div');
    document.body.appendChild(target);
    components.push(mount(ConnectionForm, { target, props: { onBack: () => {} } }));
    flushSync();
    return target;
}

function show(flags: Partial<ConnectionError>) {
    clearErrors();
    setErrors(flags);
    flushSync();
}

/**
 * Every cause the form explains with a box: the flag that raises it, the
 * `data-error-type` a test or a user stylesheet would use to find it, and the phrase
 * the box has to say. `securityError` is deliberately absent: the form has no box
 * for it, and a refactor must not invent one. The two causes with no phrase here are
 * the long-form ones, asserted by structure instead of by a sentence.
 */
const CAUSES: Array<[keyof ConnectionError, string, string?]> = [
    ['clockSkewError', 'clock-skew'],
    ['protocolUnansweredError', 'protocol-unanswered'],
    ['serverUnreachable', 'server-unreachable', 'Unable to reach WeeChat relay'],
    ['errorMessage', 'connection-error', 'unable to connect to the WeeChat relay'],
    ['passwordError', 'password-error', 'wrong password or token'],
    ['tlsError', 'tls-error', 'Could not establish TLS connection'],
    ['oldWeechatError', 'old-weechat', 'WeeChat version must be 3.x or later'],
    ['hashAlgorithmDisagree', 'hash-algorithm', 'relay.network.password_hash_algo'],
];

/** The wrapper every one of them shares, verbatim. */
const WRAPPER_CLASS = 'connection-error bg-danger/10 border border-danger rounded p-3 text-sm text-danger';

beforeEach(() => {
    clearErrors();
});

afterEach(async () => {
    clearErrors();
    for (const component of components.splice(0)) await unmount(component);
    document.body.replaceChildren();
});

describe('the connection form renders every failure cause the same way', () => {
    it('gives each cause one box with the shared wrapper and its own data-error-type', () => {
        const target = render();

        for (const [flag, errorType, phrase] of CAUSES) {
            show({ [flag]: true });

            const boxes = target.querySelectorAll('[data-error-type]');
            expect(boxes.length, `exactly one box for ${errorType}`).toBe(1);

            const box = boxes[0]!;
            expect(box.getAttribute('data-error-type'), errorType).toBe(errorType);
            expect(box.getAttribute('data-testid'), errorType).toBe('error-message');
            // The class string is what a user's custom CSS targets, so it is pinned
            // whole rather than token by token: this is one shared wrapper, not a
            // per-cause style.
            expect(box.className, errorType).toBe(WRAPPER_CLASS);
            // And the box still says the thing it is for.
            if (phrase) expect(box.textContent, errorType).toContain(phrase);
        }
    });

    it('explains a named cause without also showing the generic fallback', () => {
        // `errorMessage` is the catch-all. A named cause must not stack it on top,
        // which is the same rule the clock-skew E2E spec asserts against a live relay.
        const target = render();
        show({ passwordError: true });

        expect(target.querySelectorAll('[data-error-type="password-error"]').length).toBe(1);
        expect(target.querySelector('[data-error-type="connection-error"]')).toBeNull();
    });

    it('replaces the generic unreachable box when the transport itself is the answer', () => {
        const target = render();
        show({ serverUnreachable: true, protocolUnansweredError: true });

        const types = [...target.querySelectorAll('[data-error-type]')]
            .map((el) => el.getAttribute('data-error-type'));
        expect(types).toEqual(['protocol-unanswered']);
    });

    it('shows no box before a cause exists and none after it clears', () => {
        const target = render();
        expect(target.querySelectorAll('[data-error-type]').length).toBe(0);

        show({ tlsError: true });
        expect(target.querySelectorAll('[data-error-type]').length).toBe(1);

        // The box follows the flag. A wrapper that lingers after the cause is gone
        // would still satisfy every assertion above.
        clearErrors();
        flushSync();
        expect(target.querySelectorAll('[data-error-type]').length).toBe(0);
    });

    it('keeps what each box says, not just the box around it', () => {
        // Two of the eight are not one-liners: the clock-skew box carries a list of
        // things to try, and the pinned-protocol box carries two recovery buttons the
        // user can act on. A shared wrapper must not flatten those, so their contents
        // are pinned by what they contain rather than by how they are written.
        const target = render();

        show({ clockSkewError: true });
        const skew = target.querySelector('[data-error-type="clock-skew"]')!;
        expect(skew.textContent).toContain('relay.network.time_window');
        expect(skew.querySelectorAll('li').length).toBe(3);
        expect(skew.querySelector('code')?.textContent).toContain('relay.network.time_window');

        show({ protocolUnansweredError: true });
        const unanswered = target.querySelector('[data-error-type="protocol-unanswered"]')!;
        const recovery = [...unanswered.querySelectorAll('[data-testid^="protocol-recovery"]')]
            .map((el) => el.getAttribute('data-testid'));
        expect(recovery).toEqual(['protocol-recovery-auto', 'protocol-recovery-other']);

    });
});
