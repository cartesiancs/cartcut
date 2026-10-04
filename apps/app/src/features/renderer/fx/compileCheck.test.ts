import { describe, expect, it } from "vitest";
import { authorLineOf, wrapFragmentShader } from "../../fx/glslWrap";
import { parseCompileLog } from "./compileCheck";

const SOURCE = [
  "uniform float amount;",
  "vec4 effect(vec2 uv) {",
  "  return getSourceColor(uv) * amout;",
  "}",
].join("\n");

function wrappedLineOf(source: string, needle: string): number {
  const lines = wrapFragmentShader({ kind: "effect", source }).split("\n");
  return lines.findIndex((line) => line.includes(needle)) + 1;
}

describe("authorLineOf", () => {
  it("maps a wrapped line back to the author's line", () => {
    const wrap = { kind: "effect" as const, source: SOURCE };
    expect(authorLineOf(wrap, wrappedLineOf(SOURCE, "amout"))).toBe(3);
    expect(authorLineOf(wrap, wrappedLineOf(SOURCE, "uniform float amount"))).toBe(1);
  });

  it("counts leading blank lines the wrapper trimmed away", () => {
    const source = "\n\n" + SOURCE;
    const wrap = { kind: "effect" as const, source };
    expect(authorLineOf(wrap, wrappedLineOf(source, "amout"))).toBe(5);
  });

  it("answers null for a line the host wrote", () => {
    const wrap = { kind: "effect" as const, source: SOURCE };
    expect(authorLineOf(wrap, 1)).toBeNull();
    expect(authorLineOf(wrap, wrappedLineOf(SOURCE, "gl_FragColor"))).toBeNull();
  });

  it("follows the extra sampler lines a texture adds", () => {
    const wrap = {
      kind: "effect" as const,
      source: SOURCE,
      textureUniforms: ["noise", "grain"],
    };
    const lines = wrapFragmentShader(wrap).split("\n");
    const at = lines.findIndex((line) => line.includes("amout")) + 1;
    expect(authorLineOf(wrap, at)).toBe(3);
  });
});

describe("parseCompileLog", () => {
  it("turns an ANGLE log into author-relative diagnostics", () => {
    const wrap = { kind: "effect" as const, source: SOURCE };
    const at = wrappedLineOf(SOURCE, "amout");
    const log =
      "ERROR: 0:" + at + ": 'amout' : undeclared identifier\n" +
      "WARNING: 0:" + at + ": something mild\n" +
      "ERROR: 2 compilation errors.  No code generated.\n\0";
    expect(parseCompileLog(log, "main.frag", wrap)).toEqual({
      errors: [
        { file: "main.frag", line: 3, message: "'amout' : undeclared identifier" },
      ],
      warnings: [{ file: "main.frag", line: 3, message: "something mild" }],
    });
  });

  it("keeps an error on a host line, without a line number", () => {
    const wrap = { kind: "effect" as const, source: SOURCE };
    const log = "ERROR: 0:4: 'source' : redefinition";
    expect(parseCompileLog(log, "main.frag", wrap).errors).toEqual([
      { file: "main.frag", message: "'source' : redefinition" },
    ]);
  });

  it("keeps a log with no locations at all rather than dropping it", () => {
    expect(parseCompileLog("something broke", "main.frag", null).errors).toEqual([
      { file: "main.frag", message: "something broke" },
    ]);
  });
});
