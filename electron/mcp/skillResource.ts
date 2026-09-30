/**
 * The `cartcut-editing` skill, served by the bridge itself.
 *
 * The skill ships through the plugin marketplace and through `npx skills add`,
 * and a user who ran only the ⚡ panel's `claude mcp add` line has the tools
 * without the rules for using them. MCP gives a server no view of which skills
 * its client has installed, so the bridge does not guess: it serves the same
 * file as a resource and its instructions tell the model to read it when the
 * skill is not in its own list. The model can see that list; we cannot.
 *
 * The URI follows the Skills extension (SEP-2640): `skill://<name>/SKILL.md`,
 * with the directory segment equal to the frontmatter `name`. The extension
 * itself is not declared, because declaring it commits the server to
 * `skills/list` and `skills/get` over a protocol revision SDK 1.30 does not
 * speak. Adopting it later adds methods and leaves this URI where it is.
 *
 * No electron import, so the suite can run it against the repository.
 */

import { promises as fsp } from "fs";
import path from "path";

export const SKILL_NAME = "cartcut-editing";

export const SKILL_URI = `skill://${SKILL_NAME}/SKILL.md`;

/**
 * Where the skill sits under the app root. `plugins/` is packed into
 * `app.asar`, so this one path holds in development and in a packaged build.
 * Moving the skill directory breaks this route as well as the two installers.
 */
export const SKILL_RELATIVE_PATH = `plugins/${SKILL_NAME}/skills/${SKILL_NAME}/SKILL.md`;

/** The agents the ⚡ panel has a tab for, by their skills CLI `-a` id. */
export type SkillAgent = "claude-code" | "codex";

/** The line the ⚡ panel hands out for installing the skill on its own. */
export function skillAddCommand(agent: SkillAgent): string {
  return `npx skills add cartesiancs/cartcut --skill ${SKILL_NAME} -a ${agent} -g`;
}

/** Appended to the server's instructions. */
export const SKILL_FALLBACK_INSTRUCTION = `If the ${SKILL_NAME} skill is not in your skill list, read the MCP resource ${SKILL_URI} before the first edit and follow it.`;

const MIME_TYPE = "text/markdown";

export function skillFilePath(appRoot: string): string {
  return path.join(appRoot, SKILL_RELATIVE_PATH);
}

/** A type alias, not an interface: the SDK's result has an index signature. */
export type SkillResourceContents = {
  contents: { uri: string; mimeType: string; text: string }[];
};

/** The part of `McpServer` this needs, so a test can hand in a fake. */
export interface ResourceRegistrar {
  registerResource(
    name: string,
    uri: string,
    metadata: { title: string; description: string; mimeType: string },
    read: (uri: URL) => Promise<SkillResourceContents>,
  ): unknown;
}

/**
 * Register the skill as one resource, read from disk on every request so a
 * dev build serves the file as it is now rather than as it was at launch.
 */
export function registerSkillResource(
  registrar: ResourceRegistrar,
  appRoot: string,
): void {
  const file = skillFilePath(appRoot);
  registrar.registerResource(
    SKILL_NAME,
    SKILL_URI,
    {
      title: "Cartcut editing skill",
      description:
        "How to edit in Cartcut through these tools. Read it before the first edit when the cartcut-editing skill is not installed.",
      mimeType: MIME_TYPE,
    },
    async () => ({
      contents: [
        {
          uri: SKILL_URI,
          mimeType: MIME_TYPE,
          text: await fsp.readFile(file, "utf8"),
        },
      ],
    }),
  );
}
