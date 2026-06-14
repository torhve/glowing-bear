import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock settings before importing imgur to avoid localStorage access
const mockSettingsSubscribe = vi.fn((fn: (val: Record<string, unknown>) => void) => {
    fn({ iToken: '', iAlb: '' });
    return () => {};
});
vi.mock('$lib/stores/settings', () => ({
    settings: { subscribe: mockSettingsSubscribe },
}));

// Track the actual FileReader instance created
let actualReader: {
    onload: ((e: unknown) => void) | null;
    readAsDataURL: ReturnType<typeof vi.fn>;
};

const mockFileReader = vi.fn(() => {
    actualReader = {
        onload: null,
        readAsDataURL: vi.fn(),
    };
    return actualReader;
});
vi.stubGlobal('FileReader', mockFileReader);

// Track the actual XMLHttpRequest instance created
let actualXhr: {
    open: ReturnType<typeof vi.fn>;
    setRequestHeader: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    status: number;
    responseText: string;
    onload: ((this: XMLHttpRequest) => void) | null;
    upload: { onprogress: ((e: unknown) => void) | null };
};

const mockXhr = vi.fn(() => {
    actualXhr = {
        open: vi.fn(),
        setRequestHeader: vi.fn(),
        send: vi.fn(),
        status: 0,
        responseText: '',
        onload: null,
        upload: {
            onprogress: null,
        },
    };
    return actualXhr;
});
vi.stubGlobal('XMLHttpRequest', mockXhr);

describe('uploadImage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        actualXhr = {
            open: vi.fn(),
            setRequestHeader: vi.fn(),
            send: vi.fn(),
            status: 0,
            responseText: '',
            onload: null,
            upload: {
                onprogress: null,
            },
        };
    });

    it('reads file as base64 and uploads to Imgur API', async () => {
        const { uploadImage } = await import('$lib/imgur');
        const file = new File(['test'], 'test.png', { type: 'image/png' });
        const result = uploadImage(file, () => {});

        expect(mockFileReader).toHaveBeenCalled();

        actualReader.onload!({ target: { result: 'data:image/png;base64,abc123' } } as unknown as ProgressEvent);

        expect(actualXhr.open).toHaveBeenCalledWith('POST', 'https://api.imgur.com/3/image', true);
        expect(actualXhr.setRequestHeader).toHaveBeenCalledWith('Accept', 'application/json');

        actualXhr.status = 200;
        actualXhr.responseText = JSON.stringify({ data: { link: 'http://i.imgur.com/test.png', deletehash: 'dh123' } });
        actualXhr.onload!();

        const res = await result;
        expect(res.link).toBe('https://i.imgur.com/test.png');
        expect(res.deletehash).toBe('dh123');
    });

    it('uses client ID when no iToken configured', async () => {
        const { uploadImage } = await import('$lib/imgur');
        const file = new File(['test'], 'test.png', { type: 'image/png' });
        void uploadImage(file, () => {});
        actualReader.onload!({ target: { result: 'data:image/png;base64,abc' } } as unknown as ProgressEvent);
        actualXhr.status = 200;
        actualXhr.responseText = JSON.stringify({ data: { link: 'http://imgur.com/img', deletehash: 'dh' } });
        actualXhr.onload!();

        expect(actualXhr.setRequestHeader).toHaveBeenCalledWith('Authorization', 'Client-ID 164efef8979cd4b');
    });

    it('handles API error response', async () => {
        const { uploadImage } = await import('$lib/imgur');
        const file = new File(['test'], 'test.png', { type: 'image/png' });
        const result = uploadImage(file, () => {});
        actualReader.onload!({ target: { result: 'data:image/png;base64,abc' } } as unknown as ProgressEvent);

        actualXhr.status = 401;
        actualXhr.responseText = JSON.stringify({ status: 401, data: null });
        actualXhr.onload!();

        await expect(result).rejects.toThrow('Upload failed');
    });

    it('handles missing link in response', async () => {
        const { uploadImage } = await import('$lib/imgur');
        const file = new File(['test'], 'test.png', { type: 'image/png' });
        const result = uploadImage(file, () => {});
        actualReader.onload!({ target: { result: 'data:image/png;base64,abc' } } as unknown as ProgressEvent);

        actualXhr.status = 200;
        actualXhr.responseText = JSON.stringify({ data: {} });
        actualXhr.onload!();

        await expect(result).rejects.toThrow('Upload failed');
    });

    it('reports progress during upload', async () => {
        const { uploadImage } = await import('$lib/imgur');
        const progressCb = vi.fn();
        const file = new File(['test'], 'test.png', { type: 'image/png' });
        void uploadImage(file, progressCb);
        actualReader.onload!({ target: { result: 'data:image/png;base64,abc' } } as unknown as ProgressEvent);

        const progressEvent = { lengthComputable: true, loaded: 50, total: 100 };
        actualXhr.upload.onprogress!(progressEvent as unknown as ProgressEvent);
        expect(progressCb).toHaveBeenCalledWith(50);
    });

    it('skips progress when not computable', async () => {
        const { uploadImage } = await import('$lib/imgur');
        const progressCb = vi.fn();
        const file = new File(['test'], 'test.png', { type: 'image/png' });
        void uploadImage(file, progressCb);
        actualReader.onload!({ target: { result: 'data:image/png;base64,abc' } } as unknown as ProgressEvent);

        actualXhr.upload.onprogress!({ lengthComputable: false } as unknown as ProgressEvent);
        expect(progressCb).not.toHaveBeenCalled();
    });

    it('rejects for non-image files', async () => {
        const { uploadImage } = await import('$lib/imgur');
        const file = new File(['test'], 'test.txt', { type: 'text/plain' });
        await expect(uploadImage(file, () => {})).rejects.toThrow('not an image');
    });

    it('rejects undefined file', async () => {
        const { uploadImage } = await import('$lib/imgur');
        await expect(uploadImage(null as unknown as File, () => {})).rejects.toThrow('not an image');
    });
});
