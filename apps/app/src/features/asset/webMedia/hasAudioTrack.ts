/**
 * Whether a file has sound, asked in the page.
 *
 * Import needs this for every video, because a `<video>` will not say, and the
 * desktop app asks ffprobe in main. A browser build has no main: on the static
 * demo the request has nowhere to go, so every imported video used to be
 * marked silent, and its sound was missing from the preview and the export
 * alike. The container's own track list is the honest answer, and reading it
 * costs a few small range reads.
 */

import { ALL_FORMATS, Input } from "mediabunny";
import type { LocationEnv } from "../../../functions/mediaUrl";
import { sourceFor } from "./sourceFor";

export async function hasAudioTrack(localpath: string, env: LocationEnv): Promise<boolean> {
  const source = sourceFor(localpath, env);
  if (source == null) {
    return false;
  }
  const input = new Input({ source, formats: ALL_FORMATS });
  try {
    return (await input.getPrimaryAudioTrack()) != null;
  } catch {
    // A container Mediabunny cannot read is one the export cannot read either;
    // the picture still decoded in the `<video>`, so the clip stays usable.
    return false;
  } finally {
    input.dispose();
  }
}
