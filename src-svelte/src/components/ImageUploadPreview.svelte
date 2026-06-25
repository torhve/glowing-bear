<script lang="ts">
  import BaseDialog from '$components/BaseDialog.svelte';
  import X from '@lucide/svelte/icons/x';
  import Loader2 from '@lucide/svelte/icons/loader-2';
  import CheckCircle from '@lucide/svelte/icons/check-circle';
  import AlertCircle from '@lucide/svelte/icons/alert-circle';
  import { uploadImage, deleteImage } from '$lib/imgur';
  import { addToast } from '$lib/toast';

  interface PreviewItem {
    id: number;
    name: string;
    size: number;
    dataUrl: string;
    file?: File;
    progress: number;
    status: 'loading' | 'preview' | 'uploading' | 'success' | 'error';
    result?: { link: string; deletehash: string };
    error?: string;
  }

  let {
    images = [] as PreviewItem[],
    onInsert = () => {},
    onClose = () => {},
  }: {
    images?: PreviewItem[];
    onInsert?: (urls: string[]) => void;
    onClose?: () => void;
  } = $props();

  // Hold ref to BaseDialog component to access its <dialog> element
  let baseDialogRef = $state<{ dialog: HTMLDialogElement | undefined }>();
  let dialog = $derived(baseDialogRef?.dialog);
export { dialog };

  let isUploading = $state(false);
  let currentUploadIndex = $state(0);

  // Format file size for display
  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  // Remove a single image from the preview list, revoking object URL if it came from a File
  function removeImage(id: number) {
    const idx = images.findIndex(i => i.id === id);
    if (idx === -1) return;
    const removed = images[idx];
    if (removed?.file) URL.revokeObjectURL(removed.dataUrl);
    images.splice(idx, 1);
  }

  // Upload all queued images sequentially
  async function handleUploadAll() {
    if (images.length === 0) {
      handleClose();
      return;
    }
    isUploading = true;
    currentUploadIndex = 0;

    for (let i = 0; i < images.length; i++) {
      currentUploadIndex = i;
      const img = images[i];
      if (!img || img.status === 'loading') continue;

      img.status = 'uploading';
      img.progress = 0;

       try {
         const result = await uploadImage(img.file || img.dataUrl, (pct: number) => {
           img.progress = pct;
         });
        img.status = 'success';
        img.result = result;
      } catch (err) {
        img.status = 'error';
        img.error = err instanceof Error ? err.message : 'Upload failed';
      }
    }

    isUploading = false;

    // Collect successful URLs and notify
    const urls = images.filter(i => i.status === 'success' && i.result).map(i => i.result!.link);
    if (urls.length > 0) {
      onInsert(urls);
      addToast(`${urls.length} image${urls.length > 1 ? 's' : ''} uploaded to Imgur`, { type: 'success', duration: 8000 });
    } else {
      addToast('All uploads failed', { type: 'error', duration: 8000 });
    }
  }

  // Delete an uploaded image via its deletehash
  async function handleDelete(id: number) {
    const img = images.find(i => i.id === id);
    if (!img?.result?.deletehash) return;

    try {
      await deleteImage(img.result.deletehash);
      removeImage(id);
      addToast('Image deleted from Imgur', { type: 'info', duration: 4000 });
    } catch {
      addToast('Failed to delete image', { type: 'error' });
    }
  }

  // Close dialog and revoke all object URLs to prevent memory leaks
  function handleClose() {
    for (const img of images) {
      if (img.file) URL.revokeObjectURL(img.dataUrl);
    }
    onClose();
  }

  let phase = $derived(
    isUploading
      ? 'uploading'
      : images.some(i => i.status === 'loading')
        ? 'loading'
        : images.some(i => i.status !== 'preview')
          ? 'complete'
          : 'preview'
  );
</script>

<BaseDialog bind:this={baseDialogRef} id="image-upload-preview" labelledby="preview-title">
  <div class="image-upload-content flex flex-col max-h-[85vh]">
    <!-- Header -->
    <div class="image-upload-header flex items-center justify-between px-6 py-4 border-b border-border">
      <h3 id="preview-title" class="text-lg font-bold text-text">
        {phase === 'loading' ? 'Reading files...' : phase === 'preview' ? 'Preview images' : phase === 'uploading' ? 'Uploading...' : 'Upload results'}
      </h3>
      <button
        type="button"
        popovertarget="image-upload-preview"
        popovertargetaction="hide"
        onclick={handleClose}
        class="text-text-secondary hover:text-text p-1 rounded transition-colors"
        aria-label="Close"
        data-testid="preview-close"
      >
        <X size={18} />
      </button>
    </div>

    <!-- Content area -->
    <div class="image-upload-body px-6 py-4 overflow-y-auto flex-1">
      {#if images.length === 0}
        <p class="text-text-muted text-sm italic">No images to upload</p>
      {:else}
        <div class="grid grid-cols-2 sm:grid-cols-3 gap-4">
          {#each images as img (img.id)}
            <div
              class="preview-item-card rounded-lg border border-border bg-input-bg overflow-hidden"
              data-testid="preview-item"
            >
              <!-- Thumbnail -->
              <div class="preview-thumbnail aspect-square bg-bg/50 relative">
                {#if img.status === 'loading'}
                  <div class="preview-loading absolute inset-0 flex items-center justify-center">
                    <Loader2 size={24} class="text-text-muted animate-spin" />
                  </div>
                {:else if img.dataUrl}
                  <img src={img.dataUrl} alt={img.name} class="preview-image w-full h-full object-contain p-2" />
                {/if}
                {#if img.status === 'uploading'}
                  <!-- Progress overlay -->
                  <div class="preview-progress-overlay absolute inset-0 bg-black/60 flex items-center justify-center">
                    <div class="text-center text-white px-2">
                      <Loader2 size={24} class="mx-auto mb-2 animate-spin" />
                      <span class="text-sm font-medium">{img.progress}%</span>
                    </div>
                  </div>
                {/if}
              </div>

              <!-- Meta info -->
              <div class="preview-meta px-3 py-2 text-xs space-y-1">
                <p class="preview-file-name text-text truncate" title={img.name}>{img.name}</p>
                <p class="preview-file-size text-text-muted">{formatSize(img.size)}</p>

                <!-- Status indicator -->
                {#if img.status === 'success' && img.result}
                  <div class="flex items-center gap-1 text-success">
                    <CheckCircle size={14} />
                    <span class="truncate" title={img.result.link}>{img.result.link}</span>
                  </div>
                  {#if img.result.deletehash}
                    <button
                      type="button"
                      onclick={() => handleDelete(img.id)}
                      class="text-danger hover:underline text-xs mt-1"
                      data-testid="delete-image-button"
                    >
                      Delete from Imgur
                    </button>
                  {/if}
                {:else if img.status === 'error'}
                  <div class="flex items-center gap-1 text-danger">
                    <AlertCircle size={14} />
                    <span>{img.error || 'Upload failed'}</span>
                  </div>
                {/if}
              </div>

              <!-- Per-image remove (preview phase only) -->
              {#if phase === 'preview'}
                <button
                  type="button"
                  onclick={() => removeImage(img.id)}
                  class="absolute top-2 right-2 text-text-muted hover:text-danger bg-surface/80 rounded-full p-1"
                  aria-label="Remove image"
                  data-testid="remove-preview"
                >
                  <X size={14} />
                </button>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Footer actions -->
    <div class="image-upload-footer px-6 py-4 border-t border-border flex justify-between items-center">
      <span class="image-upload-summary text-sm text-text-muted">
        {phase === 'loading' ? 'Reading files...' : images.filter(i => i.status === 'success').length + '/' + images.length + ' uploaded'}
      </span>

      <div class="flex gap-2">
        {#if phase === 'loading'}
          <button
            type="button"
            popovertarget="image-upload-preview"
            popovertargetaction="hide"
            onclick={handleClose}
            class="px-4 py-2 border border-border text-text hover:bg-border rounded text-sm transition-colors flex items-center gap-2"
            data-testid="cancel-loading-button"
          >
            <Loader2 size={16} class="animate-spin" />
            Reading files...
          </button>
        {:else if phase === 'preview'}
          <button
            type="button"
            onclick={handleClose}
            class="px-4 py-2 border border-border text-text hover:bg-border rounded text-sm transition-colors"
            data-testid="discard-all-button"
          >
            Discard all
          </button>
          <button
            type="button"
            onclick={handleUploadAll}
            disabled={images.length === 0}
            class="px-4 py-2 bg-accent hover:bg-accent-hover disabled:bg-border disabled:cursor-not-allowed text-white rounded text-sm font-medium transition-colors"
            data-testid="upload-all-button"
          >
            Upload all
          </button>
        {:else if phase === 'uploading'}
          <button
            type="button"
            popovertarget="image-upload-preview"
            popovertargetaction="hide"
            class="px-4 py-2 border border-border text-text hover:bg-border rounded text-sm transition-colors flex items-center gap-2"
            data-testid="cancel-upload-button"
          >
            <Loader2 size={16} class="animate-spin" />
            Uploading {currentUploadIndex + 1}/{images.length}...
          </button>
        {:else}
          <button
            type="button"
            popovertarget="image-upload-preview"
            popovertargetaction="hide"
            onclick={handleClose}
            class="px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded text-sm font-medium transition-colors"
            data-testid="done-button"
          >
            Done
          </button>
        {/if}
      </div>
    </div>
  </div>
</BaseDialog>