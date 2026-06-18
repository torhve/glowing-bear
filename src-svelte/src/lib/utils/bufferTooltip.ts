import { mount, unmount } from 'svelte';
import type { Attachment } from 'svelte/attachments';
import Tooltip from '$components/Tooltip.svelte';
import type { BufferData } from '$lib/types';

// Mounted component instance with accessible root DOM element.
type MountInstance = { element: Element };

// Creates an attachment that mounts a Tooltip component to document.body
// positioned next to the hovered buffer item, escaping overflow clipping.
export function tooltipAttachment(buffer: BufferData): Attachment<HTMLDivElement> {
  return (element) => {
    let instance: MountInstance | null = null;

    // Position tooltip after mount, deferred to next microtask so element is available.
    function showTooltip() {
      if (instance) return;
      const rect = element.getBoundingClientRect();
      const mounted = mount(Tooltip, {
        target: document.body,
        props: { buffer }
      }) as MountInstance;
      instance = mounted;
      // Capture reference for the microtask in case hideTooltip unmounts first.
      const ref = mounted;
      queueMicrotask(() => {
        const el = ref.element as HTMLElement;
        if (!el) return;
        el.style.position = 'fixed';
        el.style.left = `${rect.right + 4}px`;
        el.style.top = `${rect.top}px`;
      });
    }

    function hideTooltip() {
      if (instance) {
        unmount(instance);
        instance = null;
      }
    }

    element.addEventListener('mouseenter', showTooltip);
    element.addEventListener('mouseleave', hideTooltip);
    element.addEventListener('focusin', showTooltip);
    element.addEventListener('focusout', hideTooltip);

    return () => {
      element.removeEventListener('mouseenter', showTooltip);
      element.removeEventListener('mouseleave', hideTooltip);
      element.removeEventListener('focusin', showTooltip);
      element.removeEventListener('focusout', hideTooltip);
      hideTooltip();
    };
  };
}
