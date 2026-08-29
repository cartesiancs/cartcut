/**
 * The tools Claude Code sees, assembled from `./tools/*`.
 *
 * The definitions used to live here in one file. They moved out when the
 * surface grew past cut editing — `apps/app/src/features/agent/registry.ts`
 * already documented validation as living "in `electron/mcp/tools/*`", so this
 * is the layout that was always intended.
 *
 * **This file stays as the barrel; there is no `tools/index.ts`.** Both would
 * resolve for `import … from "./tools"`, and `main/` is never cleaned — there
 * is no clean script, and `npm run compile` is a `tsc -w`. A stale
 * `main/mcp/tools.js` left behind by an earlier build would shadow
 * `main/mcp/tools/index.js` at require time and silently ship the old tool
 * list. Keeping the barrel here makes that unrepresentable, and `server.ts`
 * needs no edit.
 *
 * Three things shape the tool descriptions more than anything else:
 *
 *  - **Output is capped.** Claude Code warns at 10,000 tokens of tool output
 *    and truncates at 25,000. Every list is paged and every projection is a
 *    whitelist (`apps/app/src/features/agent/serialize.ts`).
 *  - **Batch beats loop.** `remove_ranges`, `add_subtitles`, `add_media` and
 *    `add_keyframes` take arrays because the alternative — one call per cut,
 *    per caption, per clip — costs a round trip and an undo step each, and an
 *    agent that has to undo forty times to take back one instruction may as
 *    well not have undo.
 *  - **Times are absolute timeline milliseconds**, except where a name says
 *    `source`. Transcripts are the one place the two diverge, and
 *    `get_transcript` resolves that before the agent ever sees it.
 *
 * Tool definitions sit in every request's context, so a new description earns
 * its length. `remove_ranges` and `get_transcript` are long because the agent
 * genuinely cannot use them otherwise; `move_track` is three lines.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineRegistrar } from "./tools/define";
import { registerReadTools } from "./tools/read";
import { registerCutTools } from "./tools/cut";
import { registerMediaTools } from "./tools/media";
import { registerTextTools } from "./tools/text";
import { registerTrackTools } from "./tools/tracks";
import { registerAnimationTools } from "./tools/animation";
import { registerFxTools } from "./tools/fx";
import { registerPlanTools } from "./tools/plan";
import { registerGroupTools } from "./tools/groups";
import { registerMetaTools } from "./tools/meta";
import type { Registrar } from "./tools/define";

/** Every family, in the order they appear to the agent. */
export function registerToolsWith(define: Registrar) {
  registerReadTools(define);
  registerCutTools(define);
  registerMediaTools(define);
  registerTextTools(define);
  registerTrackTools(define);
  registerAnimationTools(define);
  registerFxTools(define);
  registerGroupTools(define);
  registerMetaTools(define);
  registerPlanTools(define);
}

export function registerTools(server: McpServer) {
  registerToolsWith(defineRegistrar(server));
}
