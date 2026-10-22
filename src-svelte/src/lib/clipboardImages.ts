/**
 * The clipboard's image content, read the way each browser exposes it.
 *
 * Three strategies in a fixed order. The order is a browser fact, not a preference,
 * and it is the reason this file exists rather than a shorter handler:
 *
 *  1. `DataTransfer.files` — Firefox on macOS exposes pasted images only here, and
 *     its clipboard files are ephemeral: the browser collects them once the event
 *     handler returns, so their content has to start reading synchronously, inside
 *     the handler, not after an `await`.
 *  2. `DataTransfer.items` + `getAsFile()` — Chrome and Chrome-like browsers.
 *  3. `DataTransfer.items` + `getAsString()` — Safari, where `getAsFile()` returns
 *     null for an image item but the string is still there.
 *
 * The event stays with the caller. `preventDefault()` and the text fallback are the
 * handler's decision about what a paste means; a reader that took the event would
 * have to own both.
 */

/**
 * The one image test every clipboard, paste and drop surface uses.
 *
 * Browsers report pasted and dropped images as `image/<subtype>`, including
 * `image/svg+xml` and `image/heic`, and every one of those matches.
 * It replaces the file filter's unanchored "image" regex, which also matched a MIME
 * merely *contains* "image" anywhere — a shape no clipboard reports, but a shape a
 * dropped file's reported type is free to have.
 */
export function isImageType(type: string): boolean {
    return type.startsWith('image/');
}

/** Keep only the image files in a list of dropped or picked files. */
export function filterImages(files: File[]): File[] {
    return files.filter((file) => isImageType(file.type));
}

/**
 * Whether the clipboard holds image content, without starting any read.
 *
 * A handler that is going to ignore the images anyway must not begin reading them:
 * the global paste listener uses this to decide whether to leave the event alone.
 */
export function hasClipboardImages(data: DataTransfer): boolean {
    if (filterImages(Array.from(data.files)).length > 0) return true;

    const items = data.items;
    if (!items) return false;
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item && isImageType(item.type)) return true;
    }
    return false;
}

export interface ClipboardImages {
    /**
     * Images whose bytes the caller can hand straight to the uploader. Empty for the
     * Firefox path: there the content is read into `dataUrls` instead, because the
     * file itself does not outlive the event handler.
     */
    files: File[];
    /** True when the clipboard held image content, so the paste is not a text paste. */
    found: boolean;
    /**
     * `data:` URLs for images that arrived as content rather than as a usable file
     * (Firefox's clipboard files, Safari's `getAsString` strings). Reading starts when
     * `readClipboardImages` is called, not when this promise is awaited.
     */
    dataUrls: Promise<string[]>;
}

/**
 * Read the clipboard's images in the three-strategy order above.
 *
 * `note` receives the debug trail; the caller supplies it so this module stays
 * independent of the debug flag that switches the log on.
 */
export function readClipboardImages(
    data: DataTransfer,
    note?: (...args: unknown[]) => void
): ClipboardImages {
    const log = note ?? (() => undefined);

    // Strategy 1: clipboardData.files. Read immediately — see the file comment.
    const allFiles = Array.from(data.files);
    const files = filterImages(allFiles);
    log(
        'clipboardData.files:',
        allFiles.length,
        'total,',
        files.length,
        'images',
        allFiles.map((f) => ({ name: f.name, type: f.type }))
    );
    if (files.length > 0) {
        log('using strategy 1 (files), reading immediately to avoid GC');
        return {
            files: [],
            found: true,
            dataUrls: Promise.all(files.map(readAsDataURL)).then((urls) =>
                urls.filter((url) => url.length > 0)
            ),
        };
    }

    // Strategy 2+3: the items API (Chrome, Safari).
    const items = data.items;
    if (!items) {
        log('no clipboardData.items, falling back to getData');
        return { files: [], found: false, dataUrls: Promise.resolve([]) };
    }

    const imageFiles: File[] = [];
    const imageStrings: Array<Promise<string | null>> = [];

    log('clipboardData.items count:', items.length);
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        log('item[' + i + ']:', item?.kind, item?.type);
        if (!item || !isImageType(item.type)) continue;

        const file = item.getAsFile();
        if (file) {
            log(
                'item[' + i + '] getAsFile() succeeded:',
                file.name,
                file.type,
                file.size + ' bytes'
            );
            imageFiles.push(file);
        } else {
            log('item[' + i + '] getAsFile() returned null, falling back to getAsString');
            imageStrings.push(
                new Promise((resolve) => {
                    item.getAsString((s) => {
                        log('getAsString callback:', s ? 'got ' + s.substring(0, 60) + '...' : 'null');
                        resolve(s);
                    });
                })
            );
        }
    }

    log('collected:', imageFiles.length, 'files,', imageStrings.length, 'promises');
    return {
        files: imageFiles,
        found: imageFiles.length > 0 || imageStrings.length > 0,
        dataUrls: Promise.all(imageStrings).then((resolved) =>
            resolved.filter((s): s is string => typeof s === 'string' && s.length > 0)
        ),
    };
}

/**
 * One clipboard file as a `data:` URL. A failed read yields nothing: a paste whose
 * content is gone is treated as no image, not as an error the composer has to show.
 */
function readAsDataURL(file: File): Promise<string> {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => resolve('');
        reader.readAsDataURL(file);
    });
}
