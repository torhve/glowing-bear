import type { UploadResult } from '#lib/imgur.ts';

/**
 * One image the composer has accepted and is carrying to the upload.
 *
 * InputBar creates these and ImageUploadPreview renders them, so the shape is a
 * contract between two components — each used to declare its own identical copy,
 * which meant a field added on one side was invisible to the other until the two
 * stopped compiling against each other.
 *
 * `result` is Imgur's own response type rather than a local restatement of it,
 * because that is literally what is stored there.
 */
export interface PreviewItem {
    id: number;
    name: string;
    size: number;
    dataUrl: string;
    file?: File;
    progress: number;
    status: 'loading' | 'preview' | 'uploading' | 'success' | 'error';
    result?: UploadResult;
    error?: string;
}
