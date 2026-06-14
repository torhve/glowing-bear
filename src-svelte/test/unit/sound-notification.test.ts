import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { playNotificationSound } from '$lib/notifications';

// Mock settings to return soundnotification: true
vi.mock('$lib/stores/settings', () => ({
    settings: {
        subscribe(fn: (s: any) => void) {
            fn({ soundnotification: true });
            return () => {};
        }
    }
}));

// Mock localStorage
const localStorageMock = {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
    length: 0,
    key: vi.fn(),
} as unknown as Storage;

Object.defineProperty(globalThis, 'localStorage', {
    value: localStorageMock,
    writable: true,
    configurable: true,
});

describe('Sound Notification', () => {
    let mockAudioPlay: ReturnType<typeof vi.fn>;
    let AudioMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        mockAudioPlay = vi.fn().mockReturnValue(Promise.resolve());

        AudioMock = vi.fn(() => ({
            volume: 0.5,
            play: mockAudioPlay,
        }));

        vi.stubGlobal('Audio', AudioMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.clearAllMocks();
    });

    it('creates Audio with correct source path', () => {
        playNotificationSound();
        expect(AudioMock).toHaveBeenCalledWith('/assets/audio/sonar.mp3');
    });

    it('calls play on the audio element', () => {
        playNotificationSound();
        expect(mockAudioPlay).toHaveBeenCalled();
    });

    it('handles audio playback errors gracefully', async () => {
        const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        
        mockAudioPlay.mockReturnValue(Promise.reject(new Error('Playback failed')));

        playNotificationSound();

        // Wait for the promise rejection to be caught
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(consoleWarnSpy).toHaveBeenCalled();
        consoleWarnSpy.mockRestore();
    });
});
