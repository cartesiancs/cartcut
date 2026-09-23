/**
 * The handful of agent commands that exist for extensions.
 *
 * Registered into `features/agent/registry.ts` rather than into a table of
 * their own, so that an extension's edit and a Claude Code tool call take one
 * code path and land in one `commit`. The two that store data are the reason
 * this file exists at all; the rest are things the agent table never needed
 * and an extension does.
 *
 * **The owner is never a parameter.** `ext_set_element_data` writes under the
 * id of whoever made the request, which `dispatch.ts` stamps from the port the
 * request arrived on. Taking it as an argument would let one extension
 * overwrite another's data, and would let a Claude Code tool call write under
 * an extension's name.
 */

import { commit, declined } from "../agent/commit";
import { currentDoc, requireElement } from "../agent/context";
import { registerCommands } from "../agent/registry";
import { useTimelineStore } from "../../states/timelineStore";
import { renderOptionStore } from "../../states/renderOptionStore";
import { isTimelineLocked, timelineLockMessage } from "../../states/timelineLockStore";
import { elementExtData, setElementExtData } from "./elementData";
import { projectDataStore } from "./projectDataStore";
import type { JsonValue } from "../../@types/timeline";

/**
 * Who is asking, for the current command.
 *
 * Module state rather than a parameter because the commands are called through
 * the shared registry, whose signature is `(params) => unknown` and is pinned
 * by every existing caller. `dispatch.ts` sets it immediately before the call
 * and clears it immediately after, synchronously, so there is no interleaving:
 * the registry runs one command at a time on the renderer's single thread.
 */
let owner: string | null = null;

export function withExtensionOwner<T>(extId: string, run: () => T): T {
  const previous = owner;
  owner = extId;
  try {
    return run();
  } finally {
    owner = previous;
  }
}

export function currentExtensionOwner(): string | null {
  return owner;
}

function requireOwner(command: string): string {
  if (owner == null) {
    throw new Error(
      command + " is only available to an extension. Claude Code cannot read or write extension data.",
    );
  }
  return owner;
}

registerCommands({
  ext_get_element_data: (params: { elementId: string }) => {
    const extId = requireOwner("ext_get_element_data");
    const element = requireElement(currentDoc(), params.elementId);
    return { elementId: params.elementId, value: elementExtData(element, extId) };
  },

  ext_set_element_data: (params: { elementId: string; value: JsonValue | null }) => {
    const extId = requireOwner("ext_set_element_data");
    let refusal: string | null = null;

    const result = commit((doc) => {
      const outcome = setElementExtData(doc, params.elementId, extId, params.value ?? null);
      if (!outcome.ok) {
        refusal = outcome.reason;
        // Returning the input by identity is how a pure op declines, and it is
        // what stops a refused write from costing an undo step.
        return doc;
      }
      return outcome.document;
    }, "that clip already holds this value");

    if (refusal != null) {
      throw new Error(refusal);
    }
    return result;
  },

  ext_get_project_data: () => {
    const extId = requireOwner("ext_get_project_data");
    const stored = projectDataStore.getState().data;
    return { value: Object.prototype.hasOwnProperty.call(stored, extId) ? stored[extId] : null };
  },

  ext_set_project_data: (params: { value: JsonValue | null }) => {
    const extId = requireOwner("ext_set_project_data");
    const outcome = projectDataStore.getState().set(extId, params.value ?? null);
    if (!outcome.ok) {
      throw new Error(outcome.reason ?? "that value could not be stored");
    }
    return { ok: true };
  },

  /**
   * Playback, which the agent table never exposed.
   *
   * Refused while the timeline is locked, like every mutating command: a
   * caption session owns the playhead while it is open, and starting playback
   * under it would fight the reveal.
   */
  playback_play: () => {
    if (isTimelineLocked()) {
      return declined(timelineLockMessage());
    }
    useTimelineStore.getState().setPlay(true);
    return { isPlay: true };
  },

  playback_pause: () => {
    useTimelineStore.getState().setPlay(false);
    return { isPlay: false };
  },

  project_info: () => {
    const state = useTimelineStore.getState();
    const options = renderOptionStore.getState().options;
    return {
      fps: options?.fps ?? null,
      previewSize: options?.previewSize ?? null,
      playheadMs: Math.round(state.cursor),
      isPlay: state.control.isPlay,
      locked: isTimelineLocked(),
      trackCount: state.tracks.length,
      clipCount: Object.keys(state.timeline).length,
    };
  },
});
