import { mount, unmount } from 'svelte';
import type { Attachment } from 'svelte/attachments';
import Tooltip from '$components/Tooltip.svelte';
import type { BufferData } from '$lib/types';

// Creates an attachment that mounts a Tooltip component to document.body
// positioned next to the hovered buffer item, escaping overflow clipping.
export function tooltipAttachment(buffer: BufferData): Attachment<HTMLDivElement> {
  return (element) => {
    let instance: object | null = null;

    function showTooltip() {
      if (instance) return;
      const rect = element.getBoundingClientRect();
      instance = mount(Tooltip, {
        target: document.body,
        props: { buffer, x: rect.right + 4, y: rect.top }
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
