/**
 * Playing a clip louder than its file.
 *
 * `HTMLMediaElement.volume` is capped at 1.0, so it cannot express the boost
 * half of a -60..+12 dB level. The way past it is a WebAudio `GainNode`, which
 * `timeline/audio.ts#MAX_VOLUME_DB` named as the prerequisite for raising the
 * ceiling and which this module is.
 *
 * The whole design is one rule:
 *
 *   > **A handle gets a gain node the first time it is asked for more than
 *   > unity, and keeps it for the rest of its life.**
 *
 * Lazy rather than universal, because `createMediaElementSource` is a one-way
 * door. It can be called once per element, it cannot be undone, and from that
 * moment the element's sound reaches the speakers only through the graph, so a
 * graph that is wrong or unconnected silences the clip outright.
 * `timeline/audioLevel.ts` refused to build a master bus for exactly that
 * reason. Attaching only where a boost was actually asked for keeps that risk
 * inside the clips whose level the user just raised, instead of putting it
 * under every clip in every project.
 *
 * The crossover is free. At the moment a rising envelope passes 0 dB the two
 * paths are the same number: `handle.volume` is 1 and the node's gain is 1, so
 * there is no step to hear. Verified in this Electron build, along with the two
 * facts the rule rests on: a `file://` media element on a `file://` page is
 * **not** CORS-tainted here, so the graph carries sound rather than silence;
 * and `handle.volume` multiplies *before* the node, which is why the level is
 * moved wholesale onto the node rather than split across the two.
 */

import type { GainSink, MediaHandle } from "../timeline/playback";
import { writeVolume } from "../timeline/playback";
import { sharedAudioContext } from "./audioContext";

/**
 * The node carrying each boosted handle's level.
 *
 * A `WeakMap` so a handle that is dropped takes its entry with it. The entry is
 * not the owner of anything the garbage collector cannot reclaim on its own:
 * `release` disconnects eagerly anyway, because a still-connected source keeps
 * the context doing work for a clip nobody can hear.
 */
const nodes = new WeakMap<object, GainNode>();
/** Handles that must never be offered the graph again. */
const refused = new WeakSet<object>();

/**
 * Route one handle through the shared context, or answer `null`.
 *
 * `null` means "play it the ordinary way this time". Every reason to fail is
 * temporary except the last: there may be no context yet, the context may still
 * be suspended because nothing has been clicked, or the element may not be a
 * real media element at all (a suite's plain object). Only a throw from
 * `createMediaElementSource` is permanent, and it is remembered so the failure
 * costs one attempt rather than one per frame.
 *
 * **The suspended check is not politeness.** Attaching to a suspended context
 * routes the element into a graph that passes nothing, so the clip goes silent
 * and stays silent until something resumes it. Refusing to attach leaves it
 * playing at unity, which is the whole ordering of the rules here: quieter than
 * asked for beats silent.
 */
function attach(handle: MediaHandle): GainNode | null {
  const key = handle as unknown as object;
  const existing = nodes.get(key);
  if (existing != null) {
    return existing;
  }
  if (refused.has(key)) {
    return null;
  }
  const context = sharedAudioContext();
  if (context == null || context.state !== "running") {
    return null;
  }
  if (typeof (handle as any).addEventListener !== "function") {
    // Not a real media element. A suite's `MediaHandle` is a plain object, and
    // `createMediaElementSource` would throw on it once per frame.
    refused.add(key);
    return null;
  }
  try {
    const source = context.createMediaElementSource(handle as any);
    const gain = context.createGain();
    source.connect(gain);
    gain.connect(context.destination);
    nodes.set(key, gain);
    return gain;
  } catch {
    // Already sourced by someone else, or the element is not one this context
    // will take. Either way it will never work, so stop asking.
    refused.add(key);
    return null;
  }
}

/**
 * Write a handle's linear gain, using the graph only once it is needed.
 *
 * The `GainSink` the preview passes to `syncPlayback`. It is called on every
 * animation frame for every loaded clip, so both branches compare before
 * writing: assigning `volume`, and assigning `gain.value`, are each a real
 * state change to the engine however redundant the value is.
 */
export const gainSink: GainSink = (handle, gain) => {
  const key = handle as unknown as object;
  const attached = nodes.get(key);

  // The common case, and the one that must cost nothing: a clip at or below
  // unity that has never been boosted plays exactly the way it did before this
  // module existed.
  if (attached == null && gain <= 1) {
    writeVolume(handle, gain);
    return;
  }

  const node = attached ?? attach(handle);
  if (node == null) {
    writeVolume(handle, gain);
    return;
  }

  // The level lives entirely on the node from here, because `handle.volume`
  // multiplies before it and splitting one number across the two would make
  // the product depend on the order the two writes happened to land in.
  if (handle.volume !== 1) {
    handle.volume = 1;
  }
  if (node.gain.value !== gain) {
    node.gain.value = gain;
  }
};

/**
 * Let go of a handle's graph, if it had one.
 *
 * Called where the handle itself is released. Disconnecting is not optional
 * tidying: the source node holds a reference to the element, so an undisconnected
 * graph keeps a released clip's decoder alive and audible.
 */
export function releaseGain(handle: MediaHandle): void {
  const key = handle as unknown as object;
  const node = nodes.get(key);
  if (node == null) {
    return;
  }
  try {
    node.disconnect();
  } catch {
    // Already disconnected. Nothing to do and nothing to report.
  }
  nodes.delete(key);
}
