// Draft holder for the message input.
//
// The draft deliberately lives outside InputBar: when the connection drops, +page.svelte
// swaps the chat view for the connection form and InputBar is destroyed along with its
// component state. Keeping the half-typed text here means a relay blip does not silently
// swallow a message the user had written but never sent.
let draft = '';

// Read the draft left behind by a previous InputBar instance.
export function readInputDraft(): string {
    return draft;
}

// Mirror the current input contents on every change, so the newest value is always
// available to the next InputBar instance.
export function writeInputDraft(value: string): void {
    draft = value;
}
