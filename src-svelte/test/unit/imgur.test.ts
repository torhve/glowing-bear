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
    onerror: ((e: unknown) => void) | null;
    readAsDataURL: ReturnType<typeof vi.fn>;
    readAsArrayBuffer: ReturnType<typeof vi.fn>;
};

const mockFileReader = vi.fn(() => {
    actualReader = {
        onload: null,
        onerror: null,
        readAsDataURL: vi.fn(),
        readAsArrayBuffer: vi.fn(),
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
    onerror: ((this: XMLHttpRequest) => void) | null;
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
        onerror: null,
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
            onerror: null,
            upload: {
                onprogress: null,
            },
        };
    });

    it('uploads File as raw binary via readAsArrayBuffer', async () => {
        const { uploadImage } = await import('$lib/imgur');
        const file = new File(['test'], 'test.png', { type: 'image/png' });
        const result = uploadImage(file, () => {});

        expect(mockFileReader).toHaveBeenCalled();
        expect(actualReader?.readAsArrayBuffer).toHaveBeenCalled();

        // Simulate FileReader reading the array buffer
        const fakeBuffer = new ArrayBuffer(10);
        actualReader!.onload!({ target: { result: fakeBuffer } } as unknown as ProgressEvent);

        // Verify XHR was configured for binary upload
        expect(actualXhr.open).toHaveBeenCalledWith('POST', 'https://api.imgur.com/3/image', true);
        expect(actualXhr.setRequestHeader).toHaveBeenCalledWith('Accept', 'application/json');
        expect(actualXhr.setRequestHeader).toHaveBeenCalledWith('Content-Type', 'image/png');

        actualXhr.status = 200;
        actualXhr.responseText = JSON.stringify({ data: { link: 'http://i.imgur.com/test.png', deletehash: 'dh123' } });
        actualXhr.onload!();

        const res = await result;
        expect(res.link).toBe('https://i.imgur.com/test.png');
        expect(res.deletehash).toBe('dh123');
    });

    it('uses client ID when no iToken configured (binary)', async () => {
        const { uploadImage } = await import('$lib/imgur');
        const file = new File(['test'], 'test.png', { type: 'image/png' });
        void uploadImage(file, () => {});
        actualReader!.onload!({ target: { result: new ArrayBuffer(1) } } as unknown as ProgressEvent);
        actualXhr.status = 200;
        actualXhr.responseText = JSON.stringify({ data: { link: 'http://imgur.com/img', deletehash: 'dh' } });
        actualXhr.onload!();

        expect(actualXhr.setRequestHeader).toHaveBeenCalledWith('Authorization', 'Client-ID 164efef8979cd4b');
    });

    it('sets album header for authenticated binary uploads', async () => {
        mockSettingsSubscribe.mockImplementation((fn: (val: Record<string, unknown>) => void) => {
            fn({ iToken: 'a'.repeat(40), iAlb: 'alb1234567' });
            return () => {};
        });
        // Re-import to pick up new settings mock
        const { uploadImage } = await import('$lib/imgur');
        const file = new File(['test'], 'test.png', { type: 'image/png' });
        void uploadImage(file, () => {});
        actualReader!.onload!({ target: { result: new ArrayBuffer(1) } } as unknown as ProgressEvent);

        expect(actualXhr.setRequestHeader).toHaveBeenCalledWith('X-Imgur-Album', 'alb1234567');
        // Restore default mock
        mockSettingsSubscribe.mockImplementation((fn: (val: Record<string, unknown>) => void) => {
            fn({ iToken: '', iAlb: '' });
            return () => {};
        });
    });

    it('handles API error response (binary)', async () => {
        const { uploadImage } = await import('$lib/imgur');
        const file = new File(['test'], 'test.png', { type: 'image/png' });
        const result = uploadImage(file, () => {});
        actualReader!.onload!({ target: { result: new ArrayBuffer(1) } } as unknown as ProgressEvent);

        actualXhr.status = 401;
        actualXhr.responseText = JSON.stringify({ status: 401, data: null });
        actualXhr.onload!();

        await expect(result).rejects.toThrow('Upload failed');
    });

    it('handles missing link in response (binary)', async () => {
        const { uploadImage } = await import('$lib/imgur');
        const file = new File(['test'], 'test.png', { type: 'image/png' });
        const result = uploadImage(file, () => {});
        actualReader!.onload!({ target: { result: new ArrayBuffer(1) } } as unknown as ProgressEvent);

        actualXhr.status = 200;
        actualXhr.responseText = JSON.stringify({ data: {} });
        actualXhr.onload!();

        await expect(result).rejects.toThrow('Upload failed');
    });

    it('reports progress during binary upload', async () => {
        const { uploadImage } = await import('$lib/imgur');
        const progressCb = vi.fn();
        const file = new File(['test'], 'test.png', { type: 'image/png' });
        void uploadImage(file, progressCb);
        actualReader!.onload!({ target: { result: new ArrayBuffer(1) } } as unknown as ProgressEvent);

        const progressEvent = { lengthComputable: true, loaded: 50, total: 100 };
        actualXhr.upload.onprogress!(progressEvent as unknown as ProgressEvent);
        expect(progressCb).toHaveBeenCalledWith(50);
    });

    it('skips progress when not computable (binary)', async () => {
        const { uploadImage } = await import('$lib/imgur');
        const progressCb = vi.fn();
        const file = new File(['test'], 'test.png', { type: 'image/png' });
        void uploadImage(file, progressCb);
        actualReader!.onload!({ target: { result: new ArrayBuffer(1) } } as unknown as ProgressEvent);

        actualXhr.upload.onprogress!({ lengthComputable: false } as unknown as ProgressEvent);
        expect(progressCb).not.toHaveBeenCalled();
    });

    it('rejects for non-image files', async () => {
        const { uploadImage } = await import('$lib/imgur');
        const file = new File(['test'], 'test.txt', { type: 'text/plain' });
        await expect(uploadImage(file, () => {})).rejects.toThrow('not an image');
    });

    it('rejects null input', async () => {
        const { uploadImage } = await import('$lib/imgur');
        await expect(uploadImage(null as unknown as File, () => {})).rejects.toThrow('No image provided');
    });

    it('accepts base64 data URL string input (FormData upload)', async () => {
        const { uploadImage } = await import('$lib/imgur');
        const result = uploadImage('data:image/png;base64,abc123', () => {});

        // Should not use FileReader for string input
        expect(mockFileReader).not.toHaveBeenCalled();
        expect(actualXhr.open).toHaveBeenCalledWith('POST', 'https://api.imgur.com/3/image', true);

        actualXhr.status = 200;
        actualXhr.responseText = JSON.stringify({ data: { link: 'http://i.imgur.com/frombase64.png', deletehash: 'dh456' } });
        actualXhr.onload!();

        const res = await result;
        expect(res.link).toBe('https://i.imgur.com/frombase64.png');
        expect(res.deletehash).toBe('dh456');
    });

    it('accepts raw base64 string (no data: prefix)', async () => {
        const { uploadImage } = await import('$lib/imgur');
        const result = uploadImage('rawBase64Data', () => {});

        expect(mockFileReader).not.toHaveBeenCalled();
        expect(actualXhr.open).toHaveBeenCalledWith('POST', 'https://api.imgur.com/3/image', true);

        actualXhr.status = 200;
        actualXhr.responseText = JSON.stringify({ data: { link: 'http://i.imgur.com/rawbase64.png', deletehash: 'dh789' } });
        actualXhr.onload!();

        const res = await result;
        expect(res.link).toBe('https://i.imgur.com/rawbase64.png');
    });

    it('handles FileReader read error for binary upload', async () => {
        const { uploadImage } = await import('$lib/imgur');
        const file = new File(['test'], 'test.png', { type: 'image/png' });
        const result = uploadImage(file, () => {});

        actualReader!.onerror!(new Error('Read failed'));

        await expect(result).rejects.toThrow('Failed to read file');
    });
});

describe('deleteImage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        actualXhr = {
            open: vi.fn(),
            setRequestHeader: vi.fn(),
            send: vi.fn(),
            status: 0,
            responseText: '',
            onload: null,
            onerror: null,
            upload: {
                onprogress: null,
            },
        };
    });

    it('deletes image successfully via DELETE request', async () => {
        const { deleteImage } = await import('$lib/imgur');
        const promise = deleteImage('testDeleteHash');

        expect(actualXhr.open).toHaveBeenCalledWith('DELETE', 'https://api.imgur.com/3/image/testDeleteHash', true);
        expect(actualXhr.setRequestHeader).toHaveBeenCalledWith('Authorization', 'Client-ID 164efef8979cd4b');

        actualXhr.status = 200;
        actualXhr.responseText = JSON.stringify({ data: true });
        actualXhr.onload!();

        await expect(promise).resolves.toBeUndefined();
    });

    it('rejects on API error during delete', async () => {
        const { deleteImage } = await import('$lib/imgur');
        const promise = deleteImage('badDeleteHash');

        actualXhr.status = 404;
        actualXhr.responseText = JSON.stringify({ status: 404, data: null });
        actualXhr.onload!();

        await expect(promise).rejects.toThrow('Delete failed');
    });
});
