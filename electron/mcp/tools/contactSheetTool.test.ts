/**
 * `get_contact_sheet` hands the agent what the sheet is missing. Dropped here,
 * a sheet with no graphics (the editor behind a terminal) or no picture (a
 * video still decoding) read to an agent as its own edit's fault.
 */

import { describe, expect, it, vi } from "vitest";

const sheet = { pngBase64: "AAAA", atMs: [1000], columns: 1, rows: 1, width: 320, height: 202 };
let answer: Record<string, unknown> = sheet;

vi.mock("../bridge", () => ({ requestEditor: vi.fn(async () => answer) }));
vi.mock("../contactSheet", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../contactSheet")>()),
  writeSheet: vi.fn(() => "/tmp/sheet.png"),
}));

import { registerReadTools } from "./read";
import type { Registrar } from "./define";

async function call(args: Record<string, unknown>) {
  const handlers = new Map<string, (args: unknown) => Promise<any>>();
  const define = ((name: string, _config: unknown, handler: (args: unknown) => Promise<any>) => {
    handlers.set(name, handler);
  }) as unknown as Registrar;
  registerReadTools(define);
  const result = await handlers.get("get_contact_sheet")!(args);
  return JSON.parse(result.content[0].text);
}

describe("get_contact_sheet", () => {
  it("passes the sheet's warning on", async () => {
    answer = { ...sheet, warning: "The editor window did not paint in time." };
    expect((await call({ atMs: [1000] })).warning).toBe("The editor window did not paint in time.");
  });

  it("adds nothing to a complete sheet", async () => {
    answer = sheet;
    expect("warning" in (await call({ atMs: [1000] }))).toBe(false);
  });
});
