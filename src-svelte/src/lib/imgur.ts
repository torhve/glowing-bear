import { settings } from '$lib/stores/settings';

const DEFAULT_CLIENT_ID = '164efef8979cd4b';

interface UploadResult {
    link: string;
    deletehash: string;
}

export function uploadImage(
    file: File | null,
    progressCallback?: (percent: number) => void,
): Promise<UploadResult> {
    if (!file || !file.type.match(/image.*/)) {
        return Promise.reject(new Error('File is not an image'));
    }

    return new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = (event) => {
            const base64 = (event.target?.result as string).split(',')[1] || '';

            const xhr = new XMLHttpRequest();
            xhr.open('POST', 'https://api.imgur.com/3/image', true);

            // Auth header
            let iToken = '';
            let iAlb = '';
            const unsubSettings = settings.subscribe((s) => {
                iToken = s.iToken || '';
                iAlb = s.iAlb || '';
            });
            unsubSettings();

            if (iToken.length >= 38) {
                xhr.setRequestHeader('Authorization', 'Bearer ' + iToken);
            } else {
                xhr.setRequestHeader('Authorization', 'Client-ID ' + DEFAULT_CLIENT_ID);
            }

            xhr.setRequestHeader('Accept', 'application/json');

            const fd = new FormData();
            fd.append('image', base64);
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
        };

        reader.readAsDataURL(file);
    });
}
