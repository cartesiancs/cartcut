import { createStore } from "zustand/vanilla";

/**
 * Whether the preview's sound is switched off at the output.
 *
 * Session-only, like `playbackPreviewStore`: this is about the room the user is
 * sitting in, not the project, so it is not in the `.ngt` and it does not
 * survive a restart. An editor that opened silent because of a click made
 * yesterday would read as broken audio, with nothing on the timeline to say
 * why.
 *
 * It never touches the document. Each clip keeps its own level; the mute is
 * applied where the preview writes gain to its media handles
 * (`features/preview/outputMute.ts`), so export, which builds its audio in
 * FFmpeg from the document, does not see it.
 */
export interface IPreviewMuteStore {
  muted: boolean;
  toggle: () => void;
}

export const previewMuteStore = createStore<IPreviewMuteStore>((set, get) => ({
  muted: false,
  toggle: () => set({ muted: !get().muted }),
}));
