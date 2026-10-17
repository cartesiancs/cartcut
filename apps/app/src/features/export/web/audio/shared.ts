/**
 * The audio half of the desktop export, reused by the browser export.
 *
 * Two pieces of the desktop audio graph are already plain TypeScript with no
 * imports at all: the WSOLA time stretch a speed ramp's sound goes through,
 * and the volume envelope's breakpoints. They live on the `electron/` side
 * because `electron/` may never import `apps/app/src`, so this file reaches
 * across, the way `features/extension/shared.ts` does for the extension
 * protocol. One copy, so the two exports cannot drift apart.
 *
 * `sharedBoundary.test.ts` beside this fails if either file grows an import,
 * so a main-process change that pulls in `fs` is a test naming the rule rather
 * than a webpack error about a file nobody was editing.
 */

export {
  MAX_PCM_BYTES,
  stretchAudio,
  type StretchRequest,
} from "../../../../../../../electron/render/speedStretch";

export {
  envelopeFor,
  type EnvelopePoint,
} from "../../../../../../../electron/render/audioEnvelope";
