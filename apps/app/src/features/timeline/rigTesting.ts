/**
 * A stabilize rig built by hand, for the suites that test what the timeline
 * does to one without depending on `features/track/stabilizeOp.ts`.
 *
 * Shaped as the op leaves it: a zoom at the root on a 1920x1080 frame's
 * centre, a camera with a position track inside it, footage and a null in the
 * camera. The footage carries numbers that are not round, so "restored
 * exactly" is a real claim.
 */

import { bakeTrack } from "../animation/keyframes";
import { groupElement, imageElement, keys } from "../renderer/testing";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "./tracks";

const moving = () => {
  const x = keys([0, -30], [2000, 40]);
  const y = keys([0, 10], [2000, -20]);
  return { isActivate: true, x, y, ax: bakeTrack(x), ay: bakeTrack(y) };
};

export function riggedDoc(extra: Record<string, any> = {}): TimelineDocument {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [
      createTrack("v1", "video", 0),
      createTrack("gz", "group", 1),
      createTrack("gc", "group", 2),
      createTrack("gt", "group", 3),
      createTrack("a1", "audio", 4),
    ],
    elements: {
      zoom: groupElement({
        key: "zoom",
        name: "Stabilize",
        trackId: "gz",
        location: { x: 910, y: 490 },
        scale: 12,
        rig: "stabilize-zoom",
      } as any),
      cam: groupElement({
        key: "cam",
        name: "Camera",
        trackId: "gc",
        parentId: "zoom",
        location: { x: 30, y: -10 },
        animation: { ...groupElement().animation, position: moving() },
        rig: "stabilize-camera",
      } as any),
      foot: imageElement({
        key: "foot",
        trackId: "v1",
        parentId: "cam",
        location: { x: 12.345678901234, y: -7.654321098765 },
        width: 1920.5,
        height: 1080.25,
        rotation: 3.3,
      } as any),
      trk: groupElement({
        key: "trk",
        name: "Track",
        trackId: "gt",
        parentId: "cam",
        location: { x: 987.243683921096, y: 431.11 },
        animation: { ...groupElement().animation, position: moving() },
      } as any),
      ...extra,
    },
  } as any);
}

