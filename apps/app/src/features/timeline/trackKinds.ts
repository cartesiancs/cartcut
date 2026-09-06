/**
 * How a track kind is named and drawn.
 *
 * Two surfaces name kinds — the track header column, which shows one as an
 * icon, and the toolbar's "Add track" menu, which offers all of them — and a
 * kind added to `TrackKind` has to reach both. Keeping the vocabulary here
 * means it is written once and a new kind is a one-line diff that
 * `trackKinds.test.ts` makes a reviewer see.
 *
 * `TRACK_KIND_TITLE` is derived from the label rather than written out a second
 * time: "Video" and "Video track" are the same word twice, and the pair going
 * out of step is exactly the drift this module exists to prevent.
 *
 * Data only, and no imports but a type — so it runs in the `node` suite along
 * with the rest of `features/timeline/`.
 */

import type { TrackKind } from "./tracks";

/**
 * Every kind, in the order a menu offers them.
 *
 * Not `KIND_STACK_ORDER`: that ranks rows in the composite, which is a fact
 * about painting and not about what a person is looking for in a list. The
 * order here is the familiar one — picture, sound, titles, then the two kinds
 * that hold something other than a clip.
 */
export const TRACK_KINDS: readonly TrackKind[] = [
  "video",
  "audio",
  "text",
  "effect",
  "group",
];

export const TRACK_KIND_ICON: Record<TrackKind, string> = {
  video: "movie",
  audio: "volume_up",
  text: "title",
  group: "folder",
  effect: "auto_awesome",
};

/** What a kind is called on its own, e.g. in a menu already headed "Add track". */
export const TRACK_KIND_LABEL: Record<TrackKind, string> = {
  video: "Video",
  audio: "Audio",
  text: "Text",
  group: "Group",
  effect: "Effect",
};

/** The same name where it has to stand alone, e.g. a row's tooltip. */
export const TRACK_KIND_TITLE: Record<TrackKind, string> = Object.fromEntries(
  TRACK_KINDS.map((kind) => [kind, `${TRACK_KIND_LABEL[kind]} track`]),
) as Record<TrackKind, string>;
