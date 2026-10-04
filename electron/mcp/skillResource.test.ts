/**
 * The skill the bridge serves, against the file the installers ship.
 *
 * Read from the repository rather than a fixture: the thing that breaks this
 * route is the skill directory moving, and a fixture would move with nothing.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, mkdtempSync } from "fs";
import os from "os";
import path from "path";
import {
  SKILL_FALLBACK_INSTRUCTION,
  SKILL_NAME,
  SKILL_REFERENCES,
  referenceUri,
  SKILL_URI,
  registerSkillResource,
  skillAddCommand,
  skillFilePath,
  type ResourceRegistrar,
} from "./skillResource";

const REPO_ROOT = path.resolve(__dirname, "../..");

type Registered = Parameters<ResourceRegistrar["registerResource"]>;

function register(appRoot: string): Registered[] {
  const calls: Registered[] = [];
  registerSkillResource(
    { registerResource: (...args: Registered) => calls.push(args) },
    appRoot,
  );
  return calls;
}

describe("the skill file", () => {
  it("is where the bridge looks for it", () => {
    expect(existsSync(skillFilePath(REPO_ROOT))).toBe(true);
  });

  it("is named for the URI's directory, as SEP-2640 requires", () => {
    const text = readFileSync(skillFilePath(REPO_ROOT), "utf8");
    const name = /^---\n[\s\S]*?^name:\s*(.+)$/m.exec(text)?.[1].trim();
    expect(name).toBe(SKILL_NAME);
    expect(SKILL_URI).toBe(`skill://${name}/SKILL.md`);
  });
});

describe("the lines handed out", () => {
  it("installs this skill and no other, for the agent asked", () => {
    for (const agent of ["claude-code", "codex"] as const) {
      const command = skillAddCommand(agent);
      expect(command).toContain(`--skill ${SKILL_NAME} `);
      expect(command).toContain(` -a ${agent} `);
    }
  });

  it("points the model at the resource by its URI", () => {
    expect(SKILL_FALLBACK_INSTRUCTION).toContain(SKILL_URI);
  });
});

describe("registerSkillResource", () => {
  it("registers the skill at its URI, then each reference", () => {
    const calls = register(REPO_ROOT);
    expect(calls.map((call) => call[1])).toEqual([
      SKILL_URI,
      ...SKILL_REFERENCES.map(referenceUri),
    ]);
    const [name, uri, metadata] = calls[0];
    expect(name).toBe(SKILL_NAME);
    expect(uri).toBe(SKILL_URI);
    expect(metadata.mimeType).toBe("text/markdown");
  });

  it("serves the shipped file unchanged", async () => {
    const [, , , read] = register(REPO_ROOT)[0];
    const result = await read(new URL(SKILL_URI));
    expect(result.contents).toEqual([
      {
        uri: SKILL_URI,
        mimeType: "text/markdown",
        text: readFileSync(skillFilePath(REPO_ROOT), "utf8"),
      },
    ]);
  });

  it("serves each reference from beside the skill, as the skill names it", async () => {
    const skill = readFileSync(skillFilePath(REPO_ROOT), "utf8");
    const calls = register(REPO_ROOT).slice(1);
    for (const [index, relative] of SKILL_REFERENCES.entries()) {
      // The skill has to point at the file, or nothing tells a model to read it.
      expect(skill).toContain(relative);
      const [, uri, metadata, read] = calls[index];
      expect(metadata.mimeType).toBe("text/markdown");
      const result = await read(new URL(uri));
      expect(result.contents[0].text).toBe(
        readFileSync(path.join(path.dirname(skillFilePath(REPO_ROOT)), relative), "utf8"),
      );
    }
  });

  it("rejects when the file is missing, so the comparison above reads it", async () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), "cartcut-skill-"));
    const [, , , read] = register(empty)[0];
    await expect(read(new URL(SKILL_URI))).rejects.toThrow(/ENOENT/);
  });
});
