/**
 * Validating a synthesis request where it is received.
 *
 * Its own file, with no Electron and no filesystem, because two boundaries
 * receive one: `ipc/ipcTts.ts` for the desktop app and the browser build's
 * port (`apps/app/src/features/tts/web/webTtsPort.ts`). One rule for both
 * means the same text and settings reach the engine, and so the same audio
 * comes back, whichever build asked.
 */

import { isVoiceId } from "./ttsManifest";
import type { SynthesisRequest } from "./ttsProtocol";
import { coerceLang } from "./ttsText";

/** Never below four: two denoising steps clip on a handful of samples. */
export const MIN_STEPS = 4;
export const MAX_STEPS = 8;

/**
 * Validate a request at the boundary, the `coerceX` half of the house rule.
 *
 * Everything downstream may then assume a usable voice, a known language and a
 * step count inside the range the model behaves in.
 */
export function coerceRequest(raw: {
  text?: unknown;
  voice?: unknown;
  lang?: unknown;
  speed?: unknown;
  steps?: unknown;
}): Omit<SynthesisRequest, "seed"> {
  const speed =
    typeof raw.speed === "number" && Number.isFinite(raw.speed)
      ? Math.min(2, Math.max(0.5, raw.speed))
      : 1.05;
  const steps =
    typeof raw.steps === "number" && Number.isFinite(raw.steps)
      ? Math.min(MAX_STEPS, Math.max(MIN_STEPS, Math.round(raw.steps)))
      : MIN_STEPS;

  return {
    text: typeof raw.text === "string" ? raw.text : "",
    voice: isVoiceId(raw.voice) ? raw.voice : "M1",
    lang: coerceLang(raw.lang),
    speed,
    steps,
  };
}
