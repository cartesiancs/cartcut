/**
 * One export's open files, shared by its picture and its sound.
 *
 * A clip used twice, or a video whose sound is mixed while its picture is
 * drawn, is one file: demuxed once, with its index read once. Decoders are not
 * shared (each clip owns its own, the rule `videoScope.ts` states for
 * `<video>`), only the container.
 *
 * **Source time zero.** A clip's `trim` is in ms from the start of its file.
 * FFmpeg's `-ss` and a `<video>`'s `currentTime` both count from the
 * container's start, the earliest timestamp of any track, while Mediabunny
 * hands out raw presentation timestamps. `zeroSec` is that start, added on the
 * way in and taken off on the way out. For an ordinary recording it is 0.
 *
 * Never below 0. A slightly negative first timestamp is an audio encoder's
 * priming (AAC's 1024 samples), which every decoder already drops; shifting by
 * it would move the picture 21ms early against the file's own `currentTime`.
 */

import { ALL_FORMATS, Input, type InputAudioTrack, type InputVideoTrack } from "mediabunny";
import type { LocationEnv } from "../../../functions/mediaUrl";
import { displayNameOf, sourceFor } from "./sourceFor";

export type OpenedMedia = {
  readonly input: Input;
  readonly name: string;
  readonly zeroSec: number;
  readonly video: InputVideoTrack | null;
  readonly audio: InputAudioTrack | null;
};

export type MediaInputs = {
  open(localpath: string): Promise<OpenedMedia>;
  dispose(): void;
};

export class MissingMediaError extends Error {
  constructor(readonly names: readonly string[]) {
    super(
      names.length === 1
        ? `Cannot export: ${names[0]} cannot be read in this browser. Import it again and retry.`
        : `Cannot export: ${names.length} files cannot be read in this browser (${names.join(", ")}). Import them again and retry.`,
    );
    this.name = "MissingMediaError";
  }
}

export function createMediaInputs(env: LocationEnv): MediaInputs {
  const opened = new Map<string, Promise<OpenedMedia>>();
  const inputs: Input[] = [];

  const openOne = async (localpath: string): Promise<OpenedMedia> => {
    const name = displayNameOf(localpath);
    const source = sourceFor(localpath, env);
    if (source == null) {
      throw new MissingMediaError([name]);
    }
    const input = new Input({ source, formats: ALL_FORMATS });
    inputs.push(input);
    const [video, audio] = await Promise.all([
      input.getPrimaryVideoTrack(),
      input.getPrimaryAudioTrack(),
    ]);
    const zeroSec = await input.getFirstTimestamp();
    return {
      input,
      name,
      zeroSec: Number.isFinite(zeroSec) && zeroSec > 0 ? zeroSec : 0,
      video,
      audio,
    };
  };

  return {
    open(localpath) {
      let entry = opened.get(localpath);
      if (entry == null) {
        entry = openOne(localpath);
        opened.set(localpath, entry);
      }
      return entry;
    },
    dispose() {
      for (const input of inputs) {
        input.dispose();
      }
      inputs.length = 0;
      opened.clear();
    },
  };
}
