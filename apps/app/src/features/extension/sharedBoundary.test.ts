import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The renderer bundles these two files, so what they import is the renderer's
 * problem.
 *
 * `shared.ts` explains why they live on the `electron/` side. The risk that
 * creates is that somebody adds `import { app } from "electron"` to one of
 * them while working on the main process, and discovers it as a webpack error
 * about `fs` that names a file they were not editing. This makes it a failing
 * test that names the rule instead.
 */
const ROOT = path.resolve(__dirname, "../../../../../electron/extension");

const SHARED_FILES = ["protocol.ts", "rpc.ts"];

/** What each may import. `protocol.ts` imports nothing at all. */
const ALLOWED: Record<string, string[]> = {
  "protocol.ts": [],
  "rpc.ts": ["./protocol"],
};

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function importsOf(source: string): string[] {
  const found: string[] = [];
  const pattern = /^\s*(?:import|export)[\s\S]*?from\s+["']([^"']+)["']/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) != null) {
    found.push(match[1]);
  }
  const bare = /^\s*import\s+["']([^"']+)["']/gm;
  while ((match = bare.exec(source)) != null) {
    found.push(match[1]);
  }
  return found;
}

describe("the shared protocol files", () => {
  for (const file of SHARED_FILES) {
    it(file + " imports only what the renderer can bundle", () => {
      const source = fs.readFileSync(path.join(ROOT, file), "utf8");
      expect(importsOf(source).sort()).toEqual([...ALLOWED[file]].sort());
    });

    it(file + " names no node builtin and no electron API in its code", () => {
      // Comments are stripped first. Both files discuss `node:crypto` and
      // `process` in prose explaining why they do not use them, and a check
      // that could not tell the two apart would forbid the explanation.
      const source = stripComments(fs.readFileSync(path.join(ROOT, file), "utf8"));
      for (const forbidden of ["require(", "node:", 'from "electron"', "process.", "__dirname"]) {
        expect([file, forbidden, source.includes(forbidden)]).toEqual([file, forbidden, false]);
      }
    });
  }

  it("is reachable from the renderer at the path shared.ts uses", async () => {
    const shared = await import("./shared");
    expect(typeof shared.createRpcEndpoint).toBe("function");
    expect(shared.PROTOCOL_VERSION).toBeTypeOf("number");
  });
});
