import { createContext } from 'svelte';
import type { ChatScrollCommandsHolder } from '#lib/chatViewport.ts';

/**
 * Scoped bridge between the chat view and the siblings that express scroll
 * intent (the global key handler and the message composer).
 *
 * The value is one holder object created per page instance, never a
 * module-global singleton: a sibling can only reach the chat viewport of the
 * page it is rendered in, and a view that is not mounted simply leaves
 * `current` null.
 */
export const [getChatScrollCommands, setChatScrollCommands, hasChatScrollCommands] =
    createContext<ChatScrollCommandsHolder>();

/**
 * The holder for the current page, or an inert one when this component is
 * rendered outside a chat page: there is no viewport there to command, which is
 * the same state as a chat view that has unmounted. Must be called during
 * component initialisation.
 */
export function readChatScrollCommands(): ChatScrollCommandsHolder {
    return hasChatScrollCommands() ? getChatScrollCommands() : { current: null };
}
