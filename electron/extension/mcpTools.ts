/**
 * An extension's tools, offered to Claude Code alongside the built-in ones.
 *
 * Registered per MCP session, because `mcp/server.ts` builds a fresh
 * `McpServer` for every session and that is the only moment a tool list is
 * assembled. An extension that activates later reaches an open session through
 * `sendToolListChanged`, which the SDK exposes.
 *
 * Two constraints inherited from `mcp/tools/define.ts`, both load bearing:
 * the `Registrar` stays erased (an inferred `registerTool` costs ten seconds
 * of `tsc` each), and the committed list in `tools.test.ts` stays the built-in
 * list. Extension tools are runtime, so they are not in that list and adding
 * one is not a diff a reviewer has to see.
 */

import type { Registrar } from "../mcp/tools/define";
import { failure, json, mutating } from "../mcp/tools/define";
import { extensionTools, invokeExtensionTool } from "./host";
import { jsonSchemaToToolShape } from "./jsonSchemaToZod";

/**
 * `ext_<publisher>_<name>_<tool>`, all snake_case.
 *
 * Namespaced so that two extensions offering `summarize` are two tools rather
 * than a collision, and prefixed so a person reading a tool list can see at a
 * glance which tools are ours and which arrived with an extension.
 */
export function toolNameFor(extId: string, name: string): string {
  return "ext_" + extId.replace(/[^a-z0-9]+/g, "_") + "_" + name;
}

export function registerExtensionTools(define: Registrar): void {
  for (const { extId, tool } of extensionTools()) {
    const { shape, warnings } = jsonSchemaToToolShape(tool.inputSchema);
    if (warnings.length > 0) {
      console.warn("[extension] " + extId + "/" + tool.name + ": " + warnings.join("; "));
    }

    define(
      toolNameFor(extId, tool.name),
      {
        title: tool.name,
        description: tool.description,
        inputSchema: shape,
        // Mutating rather than read-only: an extension's tool is a stranger's
        // code and nothing here can know whether it edits. Claiming
        // `readOnlyHint` for something that turns out to cut the timeline is
        // the worse of the two wrong answers.
        annotations: mutating,
      },
      async (args: unknown) => {
        try {
          return json(await invokeExtensionTool(extId, tool.name, args));
        } catch (error) {
          return failure(error);
        }
      },
    );
  }
}
