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

// Core upload logic: sends base64 data to Imgur API
function doUpload(
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

        xhr.onload = () => {
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
                } catch {
                    reject(new Error('Upload failed: invalid response'));
                }
            } else {
                reject(new Error('Upload failed: HTTP ' + xhr.status));
            }
        };

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

// Upload an image to Imgur. Accepts a File or a base64 data URL string.
export function uploadImage(
    input: File | string | null,
    progressCallback?: (percent: number) => void,
): Promise<UploadResult> {
    if (!input) {
        return Promise.reject(new Error('No image provided'));
    }

    // If given a File, read it as data URL first
    if (input instanceof File) {
        if (!input.type.match(/image.*/)) {
            return Promise.reject(new Error('File is not an image'));
        }

        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (event) => {
                const base64 = ((event.target?.result as string).split(',')[1] || '');
                doUpload(base64, progressCallback).then(resolve).catch(reject);
            };
            reader.onerror = () => reject(new Error('Failed to read file'));
            reader.readAsDataURL(input);
        });
    }

    // String input — accept data URLs or raw base64
    const str = input as string;
    if (str.startsWith('data:')) {
        const base64 = str.split(',')[1] || str;
        return doUpload(base64, progressCallback);
    }

    // Raw base64
    return doUpload(str, progressCallback);
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
