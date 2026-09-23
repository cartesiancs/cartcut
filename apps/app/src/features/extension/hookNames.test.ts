/**
 * The method names the two ends agree on.
 *
 * An export hook is sent by the renderer and answered by the extension host,
 * which is another process compiled from another tree. Nothing in the type
 * system connects the string `"export.willExport"` in one to the `case` label
 * in the other, so a rename in either is a hook that silently stops firing:
 * `askWillExport` fails open by design, so a vanished name looks exactly like
 * an extension with no objection.
 *
 * `hostMain.ts` cannot be imported here, so this reads it. That is crude and
 * it is the only thing that actually fails when the two drift.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const HOST_MAIN = path.resolve(__dirname, "../../../../../electron/extension/hostMain.ts");
const HOOKS = path.resolve(__dirname, "./exportHooks.ts");
const PROTOCOL = path.resolve(__dirname, "../../../../../electron/extension/protocol.ts");

function read(file: string): string {
  return fs.readFileSync(file, "utf8");
}

describe("the export hook names", () => {
  const sent = read(HOOKS);
  const handled = read(HOST_MAIN);
  const declared = read(PROTOCOL);

  for (const method of ["export.willExport", "export.didExport"]) {
    it(method + " is sent by the renderer", () => {
      expect(sent).toContain('"' + method + '"');
    });

    it(method + " is answered by the host", () => {
      expect(handled).toContain('case "' + method + '"');
    });

    it(method + " is in the protocol's method table", () => {
      expect(declared).toContain('"' + method + '"');
    });
  }

  it("sends nothing the host does not answer", () => {
    // Every `"export.*"` string in the hooks has to have a `case` on the other
    // side. A new hook added here without one would fail open and look like
    // every extension declining to object.
    const names = [...sent.matchAll(/"(export\.[a-zA-Z.]+)"/g)].map((match) => match[1]);
    expect(names.length).toBeGreaterThan(0);
    for (const name of new Set(names)) {
      expect([name, handled.includes('case "' + name + '"')]).toEqual([name, true]);
    }
  });
});
