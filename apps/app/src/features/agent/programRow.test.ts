import { describe, expect, it } from "vitest";
import { coerceInlineProgram } from "../fx/inlineProgram";
import { programRow } from "./serialize";

describe("programRow", () => {
  it("reports an inline program in a few facts and none of its source", () => {
    const body = "vec4 effect(vec2 uv) { return getSourceColor(uv); }\n// " + "x".repeat(50_000);
    const result = coerceInlineProgram({
      kind: "effect",
      name: "Big",
      render: { type: "shader", fragment: body },
    });
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const row = programRow(result.program);
    expect(row).toEqual({
      hash: result.program.hash,
      name: "Big",
      renderType: "shader",
      bytes: body.length,
    });
    expect(JSON.stringify(row).length).toBeLessThan(200);
  });

  it("answers null for a clip with no program", () => {
    expect(programRow(undefined)).toBeNull();
    expect(programRow("junk")).toBeNull();
  });
});
