/**
 * What the clipboard hands over as an image, in the order browsers expose it.
 *
 * These are the guarantees InputBar's paste handler depends on and cannot re-check
 * itself: Firefox's clipboard files must start reading inside the event handler, and
 * Safari reports an image item that `getAsFile()` cannot produce. Both are browser
 * facts the strategy order encodes, so they are pinned here rather than assumed by a
 * handler that reads through this module.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { filterImages, hasClipboardImages, isImageType, readClipboardImages } from '#lib/clipboardImages.ts';

interface FakeItem {
    kind: string;
    type: string;
    getAsFile: () => File | null;
    getAsString: (callback: (value: string | null) => void) => void;
}

/** A `DataTransfer` with only the parts the reader touches. */
function clipboard(data: {
    files?: File[];
    items?: FakeItem[] | null;
    text?: string;
}): DataTransfer {
    const items = data.items;
    const list = items
        ? Object.assign(items.slice(), { length: items.length })
        : null;
    return {
        files: data.files ?? [],
        items: list,
        getData: (kind: string) => (kind.startsWith('text') ? (data.text ?? '') : ''),
    } as unknown as DataTransfer;
}

function fileOfType(type: string, name = 'x'): File {
    return new File([new Uint8Array([1])], name, { type });
}

/** An image item Chrome can hand over as a file. */
function fileItem(type = 'image/png', file: File | null = fileOfType(type, 'shot.png')): FakeItem {
    return {
        kind: 'file',
        type,
        getAsFile: () => file,
        getAsString: (callback) => callback(null),
    };
}

/**
 * `FileReader` replaced by something that records when a read *starts*, because the
 * Firefox guarantee is about timing: a read begun after the event handler returned
 * reads a clipboard buffer the browser already collected.
 */
class RecordingFileReader {
    static reads: RecordingFileReader[] = [];

    result = '';
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    file: File | null = null;

    constructor() {
        RecordingFileReader.reads.push(this);
    }

    /**
     * The one read this test expects. Reading `reads[0]` directly is `undefined` under
     * `noUncheckedIndexedAccess`, and naming the broken invariant here is a better
     * failure than a suppressed type error.
     */
    static sole(): RecordingFileReader {
        const [only] = RecordingFileReader.reads;
        if (!only) {
            throw new Error(`expected exactly one FileReader read, got ${RecordingFileReader.reads.length}`);
        }
        return only;
    }

    readAsDataURL(file: File): void {
        this.file = file;
    }

    /** Resolve this read the way a successful load would. */
    finish(result: string): void {
        this.result = result;
        this.onload?.();
    }

    fail(): void {
        this.onerror?.();
    }
}

const realFileReader = globalThis.FileReader;

beforeEach(() => {
    RecordingFileReader.reads = [];
    vi.stubGlobal('FileReader', RecordingFileReader);
});

afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.FileReader = realFileReader;
});

it('answers the image question once, for every surface that asked it separately', () => {
    const types = [
        'image/png',
        'image/svg+xml',
        'image/heic',
        'image/jpeg',
        'text/plain',
        'application/pdf',
        '',
        // The regex the file filter used matched this, because it looked for "image"
        // anywhere in the type. A clipboard never reports it; a dropped file's type is
        // free to look like anything.
        'x-image/png',
    ];

    expect(types.map((type) => isImageType(type))).toEqual([
        true,
        true,
        true,
        true,
        false,
        false,
        false,
        false,
    ]);

    const files = types.map((type) => fileOfType(type, type || 'no-type'));
    expect(filterImages(files).map((f) => f.type)).toEqual([
        'image/png',
        'image/svg+xml',
        'image/heic',
        'image/jpeg',
    ]);
});

it('reads Firefox clipboard files synchronously, before the caller awaits anything', () => {
    const images = readClipboardImages(
        clipboard({ files: [fileOfType('image/png')], items: null, text: 'ignored' })
    );

    expect(images.found).toBe(true);
    // The file itself does not survive the event handler, so its content is what the
    // caller gets and the file list comes back empty.
    expect(images.files).toEqual([]);
    expect(RecordingFileReader.reads).toHaveLength(1);
    expect(RecordingFileReader.sole().file?.type).toBe('image/png');
});

it('keeps the Firefox files ahead of the items API when both carry content', () => {
    const images = readClipboardImages(
        clipboard({
            files: [fileOfType('image/png')],
            items: [fileItem()],
            text: 'ignored',
        })
    );

    expect(images.found).toBe(true);
    expect(images.files).toEqual([]);
    expect(RecordingFileReader.reads).toHaveLength(1);
});

it('hands a Chrome file to the caller and starts no read', async () => {
    const file = fileOfType('image/png', 'shot.png');
    const images = readClipboardImages(clipboard({ items: [fileItem('image/png', file)] }));

    expect(images.found).toBe(true);
    expect(images.files).toEqual([file]);
    expect(RecordingFileReader.reads).toHaveLength(0);
    await expect(images.dataUrls).resolves.toEqual([]);
});

it('falls back to getAsString when getAsFile returns null, the Safari case', async () => {
    const images = readClipboardImages(
        clipboard({
            items: [{
                kind: 'file',
                type: 'image/png',
                getAsFile: () => null,
                getAsString: (callback) => callback('data:image/png;base64,AAA'),
            }],
        })
    );

    expect(images.found).toBe(true);
    expect(images.files).toEqual([]);
    await expect(images.dataUrls).resolves.toEqual(['data:image/png;base64,AAA']);
});

it('counts an image whose content came back empty as no content, not as an error', async () => {
    const images = readClipboardImages(
        clipboard({
            items: [{
                kind: 'file',
                type: 'image/png',
                getAsFile: () => null,
                getAsString: (callback) => callback(null),
            }],
        })
    );

    // The paste is still consumed — the clipboard said "image" and this handler owns
    // that answer — but the caller gets nothing to preview.
    expect(images.found).toBe(true);
    await expect(images.dataUrls).resolves.toEqual([]);
});

it('yields nothing for a Firefox file whose read fails', async () => {
    const images = readClipboardImages(clipboard({ files: [fileOfType('image/png')] }));

    RecordingFileReader.sole().fail();
    await expect(images.dataUrls).resolves.toEqual([]);
});

it('resolves Firefox reads only once their content exists', async () => {
    const images = readClipboardImages(clipboard({ files: [fileOfType('image/png')] }));
    const first = RecordingFileReader.sole();

    const resolved = images.dataUrls.then((urls) => urls);
    first.finish('data:image/png;base64,AAA');

    await expect(resolved).resolves.toEqual(['data:image/png;base64,AAA']);
});

it('ignores non-image files but still takes the image item beside them', () => {
    const images = readClipboardImages(
        clipboard({
            files: [fileOfType('text/plain', 'notes.txt')],
            items: [fileItem('image/png')],
            text: 'notes',
        })
    );

    expect(images.found).toBe(true);
    expect(images.files).toHaveLength(1);
    expect(RecordingFileReader.reads).toHaveLength(0);
});

it('reports no images when the clipboard holds only text', () => {
    const images = readClipboardImages(
        clipboard({ items: [{ kind: 'file', type: 'text/plain', getAsFile: () => null, getAsString: (cb) => cb('hi') }], text: 'hi' })
    );

    expect(images.found).toBe(false);
    expect(RecordingFileReader.reads).toHaveLength(0);
});

it('reports no images when the items API is absent', () => {
    const images = readClipboardImages(clipboard({ items: null, text: 'hello' }));

    expect(images.found).toBe(false);
    expect(RecordingFileReader.reads).toHaveLength(0);
});

it('answers whether images exist without starting a read', () => {
    expect(hasClipboardImages(clipboard({ files: [fileOfType('image/png')] }))).toBe(true);
    expect(hasClipboardImages(clipboard({ items: [fileItem()] }))).toBe(true);
    expect(hasClipboardImages(clipboard({ files: [fileOfType('text/plain')], items: null }))).toBe(false);
    expect(hasClipboardImages(clipboard({ items: null, text: 'plain' }))).toBe(false);
    expect(RecordingFileReader.reads).toHaveLength(0);
});
