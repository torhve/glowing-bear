import { settings } from '$lib/stores/settings';
import { get } from 'svelte/store';

const DEFAULT_CLIENT_ID = '164efef8979cd4b';

export interface UploadResult {
    link: string;
    deletehash: string;
}

// Get Imgur auth settings from the settings store synchronously
function getImgurSettings() {
    const s = get(settings);
    return { iToken: s.iToken || '', iAlb: s.iAlb || '' };
}

// Set the appropriate Authorization header on an XHR request
function setAuthHeader(xhr: XMLHttpRequest) {
    const { iToken } = getImgurSettings();
    if (iToken.length >= 38) {
        xhr.setRequestHeader('Authorization', 'Bearer ' + iToken);
    } else {
        xhr.setRequestHeader('Authorization', 'Client-ID ' + DEFAULT_CLIENT_ID);
    }
    xhr.setRequestHeader('Accept', 'application/json');
}

// Parse Imgur API response and resolve/reject based on result
function parseUploadResponse(
    xhr: XMLHttpRequest,
    resolve: (val: UploadResult) => void,
    reject: (err?: Error) => void,
) {
    if (xhr.status === 200) {
        try {
            const response = JSON.parse(xhr.responseText);
            if (response.data && response.data.link) {
                resolve({
                    link: response.data.link.replace(/^http:/, 'https:'),
                    deletehash: response.data.deletehash || '',
                });
            } else {
                reject(new Error('Upload failed: no link in response'));
            }
        } catch (err) {
            console.error('[imgur] upload error:', err);
            reject(new Error('Upload failed: invalid response'));
        }
    } else {
        reject(new Error('Upload failed: HTTP ' + xhr.status));
    }
}

// Upload raw binary data to Imgur. Sends the file bytes directly with proper Content-Type.
function doUploadBinary(
    file: File,
    progressCallback?: (percent: number) => void,
): Promise<UploadResult> {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', 'https://api.imgur.com/3/image', true);
        setAuthHeader(xhr);
        xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');

        const { iToken, iAlb } = getImgurSettings();
        if (iToken.length >= 38 && iAlb.length >= 6) {
            // For binary uploads, album is sent as a header, not in FormData
            xhr.setRequestHeader('X-Imgur-Album', iAlb);
        }

        xhr.onload = () => parseUploadResponse(xhr, resolve, reject);

        if ('upload' in xhr) {
            xhr.upload.onprogress = (event) => {
                if (event.lengthComputable && progressCallback) {
                    progressCallback(Math.round(event.loaded / event.total * 100));
                }
            };
        }

        // Read file as ArrayBuffer for raw binary upload
        const reader = new FileReader();
        reader.onload = () => {
            xhr.send(reader.result as ArrayBuffer);
        };
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsArrayBuffer(file);
    });
}

// Upload base64-encoded image data to Imgur via FormData.
function doUploadBase64(
    base64data: string,
    progressCallback?: (percent: number) => void,
): Promise<UploadResult> {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', 'https://api.imgur.com/3/image', true);
        setAuthHeader(xhr);

        const { iToken, iAlb } = getImgurSettings();
        const fd = new FormData();
        fd.append('image', base64data);
        fd.append('type', 'base64');
        if (iToken.length >= 38 && iAlb.length >= 6) {
            fd.append('album', iAlb);
        }

        xhr.onload = () => parseUploadResponse(xhr, resolve, reject);

        if ('upload' in xhr) {
            xhr.upload.onprogress = (event) => {
                if (event.lengthComputable && progressCallback) {
                    progressCallback(Math.round(event.loaded / event.total * 100));
                }
            };
        }

        xhr.send(fd);
    });
}

// Upload an image to Imgur. Accepts a File (binary upload) or base64 data URL string.
export function uploadImage(
    input: File | string | null,
    progressCallback?: (percent: number) => void,
): Promise<UploadResult> {
    if (!input) {
        return Promise.reject(new Error('No image provided'));
    }

    // File objects: send as raw binary (no FileReader.readAsDataURL hang on iOS)
    if (input instanceof File) {
        if (!input.type.match(/image.*/)) {
            return Promise.reject(new Error('File is not an image'));
        }
        return doUploadBinary(input, progressCallback);
    }

    // String input — accept data URLs or raw base64
    const str = input as string;
    if (str.startsWith('data:')) {
        const base64 = str.split(',')[1] || str;
        return doUploadBase64(base64, progressCallback);
    }

    // Raw base64
    return doUploadBase64(str, progressCallback);
}

// Delete an uploaded image from Imgur using its deletehash
export function deleteImage(deletehash: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('DELETE', `https://api.imgur.com/3/image/${deletehash}`, true);
        setAuthHeader(xhr);

        xhr.onload = () => {
            if (xhr.status === 200) {
                resolve();
            } else {
                reject(new Error(`Delete failed: HTTP ${xhr.status}`));
            }
        };

        xhr.onerror = () => reject(new Error('Network error during delete'));
        xhr.send();
    });
}
