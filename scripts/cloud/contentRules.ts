/**
 * The rules a cloud preset has to meet beyond what the app's validator checks.
 *
 * `presetValidate.ts` decides whether a preset loads. It does not decide
 * whether a shader compiles: a preset whose GLSL is wrong validates, downloads
 * and then renders as a pass-through with one `console.error`. Under WebGL1
 * most of those mistakes are a fixed list (a GLSL 3 builtin, a bitwise
 * operator, a loop bound read from a uniform), so they are caught here as text,
 * before anything is launched. `tests/e2e/cloud/renderThumbnails.ts` compiles
 * every stage for real and catches the rest.
 *
 * Shared by `checkContent.ts` and the thumbnail harness, which is why the
 * digest of an item's sources lives here too.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { declaredUniforms, reservedUniformsFor } from "../../apps/app/src/features/fx/glslWrap";

export type CloudPresetKind = "effect" | "transition" | "graphic";

export const CLOUD_KINDS: readonly CloudPresetKind[] = ["effect", "transition", "graphic"];

/** The folder under `server/content/` each kind is served from (`server/src/catalog.rs`). */
export const KIND_DIRS: Record<CloudPresetKind, string> = {
  effect: "effects",
  transition: "transitions",
  graphic: "graphics",
};

/** Kebab-case, so the slug reads the same as a folder, an id segment and a URL. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function cloudIdOf(kind: CloudPresetKind, slug: string): string {
  return "com.cartcut.cloud." + kind + "." + slug;
}

/** The names the server and the app look for, in the server's order of preference. */
export const THUMBNAIL_NAMES = ["thumbnail.webp", "thumbnail.png", "thumbnail.jpg", "thumbnail.jpeg"];

/**
 * A digest of everything in an item except its thumbnail.
 *
 * Recorded in `server/content/.thumbnails.json` when a thumbnail is rendered,
 * and compared on every check: a thumbnail drawn from an older version of the
 * shader still shows on the tile until somebody downloads the new one, and
 * nothing else would notice.
 */
export function sourcesDigest(dir: string): string {
  const hash = createHash("sha256");
  const walk = (base: string, prefix: string) => {
    for (const entry of fs.readdirSync(base, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const relative = prefix === "" ? entry.name : prefix + "/" + entry.name;
      const full = path.join(base, entry.name);
      if (entry.isDirectory()) {
        walk(full, relative);
        continue;
      }
      if (prefix === "" && THUMBNAIL_NAMES.includes(entry.name)) {
        continue;
      }
      hash.update(relative + "\0");
      hash.update(fs.readFileSync(full));
      hash.update("\0");
    }
  };
  walk(dir, "");
  return hash.digest("hex");
}

/** GLSL with comments removed and line structure kept, so a match still has a line number. */
export function stripGlslComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "");
}

export type TextProblem = { line: number; message: string };

function lineAt(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/**
 * Patterns that compile somewhere but not under WebGL1's GLSL ES 1.00.
 *
 * Each one has broken a shader that looked fine: `texture()` and `round()` are
 * GLSL 3, `%` and the bitwise operators are reserved words in 1.00, and `dFdx`
 * needs an extension the compositor never enables.
 */
const ES100_FORBIDDEN: { pattern: RegExp; message: string; fragmentOnly?: true }[] = [
  { pattern: /#\s*version\b/, message: "`#version` (the host compiles GLSL ES 1.00)" },
  { pattern: /#\s*extension\b/, message: "`#extension` (nothing enables one)" },
  { pattern: /\btexture\s*\(/, message: "`texture(` is GLSL 3; use `texture2D(`" },
  {
    pattern: /\b(texelFetch|textureLod|textureSize|texture2DLod|textureGrad)\s*\(/,
    message: "a GLSL 3 or extension texture function",
  },
  { pattern: /\b(dFdx|dFdy|fwidth)\s*\(/, message: "derivatives need OES_standard_derivatives" },
  {
    pattern: /\b(round|roundEven|trunc|tanh|sinh|cosh|asinh|acosh|atanh|isnan|isinf|inverse|transpose|determinant|outerProduct|floatBitsToInt|intBitsToFloat|packUnorm2x16)\s*\(/,
    message: "a builtin GLSL ES 1.00 does not have",
  },
  { pattern: /\b(uint|uvec[234])\b/, message: "unsigned types do not exist in GLSL ES 1.00" },
  { pattern: /\blayout\s*\(/, message: "`layout(` is GLSL 3" },
  { pattern: /\bvoid\s+main\s*\(/, message: "the host writes `main`; define the entry point instead", fragmentOnly: true },
  { pattern: /\bgl_FragColor\b/, message: "the host writes `gl_FragColor`; return from the entry point", fragmentOnly: true },
  { pattern: /\buniform\s+sampler2D\b/, message: "no textures in cloud presets: everything is procedural" },
  { pattern: /\bwhile\b|\bdo\s*\{/, message: "`while` loops are not allowed; use a `for` with a constant bound" },
  { pattern: /%/, message: "`%` is reserved in GLSL ES 1.00; use `mod()`" },
  { pattern: /<<|>>|(?<!\^)\^(?!\^)|~/, message: "bitwise operators are reserved in GLSL ES 1.00" },
  { pattern: /(?<![&])&(?![&])|(?<![|])\|(?![|])/, message: "bitwise operators are reserved in GLSL ES 1.00" },
  { pattern: /\b(float|vec[234]|int)\s*\[\s*\d*\s*\]\s*\(/, message: "array constructors are GLSL 3" },
  {
    pattern: /\bfloat\s+[A-Za-z_]\w*\s*=\s*-?\d+\s*;/,
    message: "an int literal assigned to a float; write `1.0`, not `1`",
  },
  {
    // The spec's words reserved for future use (section 3.6). Natural
    // variable names among them (`half`, `flat`, `input`, `cast`) fail to
    // compile with nothing in the message saying why.
    pattern:
      /\b(asm|class|union|enum|typedef|template|this|packed|goto|switch|default|inline|noinline|volatile|public|static|extern|external|interface|flat|long|short|double|half|fixed|unsigned|superp|input|output|[hdf]vec[234]|sampler1D|sampler3D|sampler1DShadow|sampler2DShadow|sampler2DRect|sampler3DRect|sampler2DRectShadow|sizeof|cast|namespace|using)\b/,
    message: "a word GLSL ES 1.00 reserves; rename the identifier",
  },
  { pattern: /\b\w*__\w*\b/, message: "identifiers containing `__` are reserved" },
];

const GLSL_TYPES = new Set(["float", "int", "bool", "vec2", "vec3", "vec4", "ivec2", "ivec3", "ivec4"]);

/**
 * `for` loops whose bound is not a constant expression. WebGL1 refuses those
 * at compile time (Appendix A of the ES 1.00 spec); the usual cause is a loop
 * that runs to a parameter. Loop to a constant ceiling and `break` instead.
 */
function loopBoundProblems(code: string): TextProblem[] {
  const constants = new Set<string>();
  for (const match of code.matchAll(/\bconst\s+(?:float|int)\s+([A-Za-z_]\w*)/g)) {
    constants.add(match[1]);
  }
  for (const match of code.matchAll(/#\s*define\s+([A-Za-z_]\w*)/g)) {
    constants.add(match[1]);
  }
  const problems: TextProblem[] = [];
  const loop = /\bfor\s*\(\s*(?:int|float)\s+([A-Za-z_]\w*)\s*=[^;]*;\s*([^;]*);/g;
  for (const match of code.matchAll(loop)) {
    const condition = match[2];
    const comparison = condition.match(/^\s*[A-Za-z_]\w*\s*(?:<=?|>=?|!=|==)\s*(.+)$/);
    const bound = comparison?.[1] ?? condition;
    const names = bound.match(/[A-Za-z_]\w*/g) ?? [];
    const loose = names.filter((name) => !constants.has(name) && !GLSL_TYPES.has(name));
    if (loose.length > 0) {
      problems.push({
        line: lineAt(code, match.index ?? 0),
        message: "loop bound `" + bound.trim() + "` is not a constant (" + loose.join(", ") + ")",
      });
    }
  }
  return problems;
}

/**
 * Globals whose initialiser reads a uniform. GLSL ES 1.00 requires a global
 * initialiser to be a constant expression, so `float t = time * 2.0;` outside a
 * function fails to compile.
 */
function globalInitialiserProblems(code: string, uniforms: Set<string>): TextProblem[] {
  const problems: TextProblem[] = [];
  let depth = 0;
  let statementStart = 0;
  for (let index = 0; index < code.length; index += 1) {
    const char = code[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      statementStart = index + 1;
    } else if (char === ";" && depth === 0) {
      const statement = code.slice(statementStart, index);
      const declaration = statement.match(
        /^\s*(?:const\s+)?(?:float|int|bool|vec[234]|ivec[234]|mat[234])\s+[A-Za-z_]\w*\s*=\s*([\s\S]+)$/,
      );
      if (declaration != null) {
        const read = (declaration[1].match(/[A-Za-z_]\w*/g) ?? []).filter((name) => uniforms.has(name));
        if (read.length > 0) {
          problems.push({
            line: lineAt(code, statementStart + (statement.length - statement.trimStart().length)),
            message: "a global initialiser reads `" + read.join("`, `") + "`; compute it inside a function",
          });
        }
      }
      statementStart = index + 1;
    }
  }
  return problems;
}

/** Everything wrong with one shader stage as text. `vertex` relaxes the fragment-only rules. */
export function glslProblems(
  source: string,
  kind: CloudPresetKind,
  stage: "fragment" | "vertex",
): TextProblem[] {
  const code = stripGlslComments(source);
  const problems: TextProblem[] = [];
  for (const { pattern, message, fragmentOnly } of ES100_FORBIDDEN) {
    if (stage === "vertex" && fragmentOnly === true) {
      continue;
    }
    const match = code.match(pattern);
    if (match != null) {
      problems.push({ line: lineAt(code, match.index ?? 0), message });
    }
  }
  problems.push(...loopBoundProblems(code));
  const declared = Object.keys(declaredUniforms(code));
  if (stage === "fragment") {
    // The host's preamble already declares these; a second declaration passes
    // the validator (a reserved name counts as bound) and then fails to compile.
    const reserved = reservedUniformsFor(kind);
    for (const name of declared.filter((name) => reserved.includes(name))) {
      problems.push({ line: 1, message: "redeclares the host's uniform `" + name + "`" });
    }
  }
  const uniforms = new Set([...declared, ...reservedUniformsFor(kind)]);
  problems.push(...globalInitialiserProblems(code, uniforms));
  return problems;
}

/** Names a stage may not use because its kind's host does not provide them. */
const UNAVAILABLE: Record<CloudPresetKind, { pattern: RegExp; message: string }[]> = {
  effect: [
    { pattern: /\bprogress\b/, message: "an effect has `time`, not `progress`" },
    { pattern: /\bgetFromColor\b|\bgetToColor\b/, message: "an effect reads `getSourceColor`" },
  ],
  transition: [
    { pattern: /\btime\b/, message: "a transition has no `time`; drive it from `progress`" },
    { pattern: /\bresolution\b/, message: "a transition has no `resolution`; use `ratio`" },
    { pattern: /\bintensity\b/, message: "a transition has no `intensity`" },
    { pattern: /\bgetSourceColor\b|\bgetOriginalColor\b/, message: "a transition reads `getFromColor`/`getToColor`" },
  ],
  graphic: [
    {
      pattern: /\bgetFromColor\b|\bgetToColor\b|\bgetSourceColor\b|\bgetOriginalColor\b/,
      message: "a graphic draws from nothing; it has no input picture",
    },
  ],
};

export function kindApiProblems(source: string, kind: CloudPresetKind): TextProblem[] {
  const code = stripGlslComments(source);
  const problems: TextProblem[] = [];
  for (const { pattern, message } of UNAVAILABLE[kind]) {
    const match = code.match(pattern);
    if (match != null) {
      problems.push({ line: lineAt(code, match.index ?? 0), message });
    }
  }
  return problems;
}

/**
 * Text a preset puts on screen or in the panel. The editing skill's rule for
 * on-screen text (no full stop, no em-dash) and CLAUDE.md's for every string
 * (no em-dash, no middle dot). A decimal point is not a full stop.
 */
export function displayTextProblems(text: string): string[] {
  const problems: string[] = [];
  if (/[.。](?=\s|$)/.test(text)) problems.push("ends a sentence with a full stop");
  if (text.includes("—")) problems.push("contains an em-dash");
  if (text.includes("·")) problems.push("contains a middle dot");
  return problems;
}
