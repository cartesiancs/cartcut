/**
 * Compiling an inline program to tell its author what is wrong with it.
 *
 * `validatePreset` checks everything that can be checked by reading the text.
 * What it cannot catch is GLSL itself: a typo, a type mismatch, a call to a
 * function that does not exist. Those surface only from the driver, and only as
 * a log against the wrapped shader, whose line numbers mean nothing to the
 * author. This compiles each stage the compositor would compile, the same way,
 * and maps every reported line back into the author's file.
 *
 * Its own WebGL context, created on first use and kept. Not the compositor's:
 * checking a program must not disturb the frame the preview is drawing, and the
 * compositor caches failed compiles on purpose, which is the wrong behaviour for
 * a tool whose job is to recompile drafts.
 *
 * The log parsing is pure and tested under `environment: "node"`; the compile
 * itself is reached only where there is a GL context, and `checkCompiles`
 * answers `null` where there is none so the caller can say "not checked".
 */

import type { Diagnostic } from "../../fx/inlineProgram";
import {
  authorLineOf,
  vertexShaderFor,
  wrapFragmentShader,
  type WrapInput,
} from "../../fx/glslWrap";
import type { FxPreset, FxShaderKind } from "../../fx/presetTypes";

/**
 * One reported problem, as ANGLE and most drivers print it:
 * `ERROR: 0:12: 'foo' : undeclared identifier`.
 */
const LOG_LINE = /^(ERROR|WARNING):\s*\d+:(\d+):\s*(.*)$/;

/**
 * Turn a GL info log into diagnostics against the author's file.
 *
 * A line the host wrote (the preamble, the epilogue) is still reported, with no
 * line number: an error there means the author redeclared something the host
 * supplies, and saying so without a line is better than dropping it.
 */
export function parseCompileLog(
  log: string,
  file: string,
  wrap: WrapInput | null,
): { errors: Diagnostic[]; warnings: Diagnostic[] } {
  const errors: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];
  for (const raw of log.split(/\r?\n/)) {
    const text = raw.replace(/\0/g, "").trim();
    if (text === "") {
      continue;
    }
    const match = LOG_LINE.exec(text);
    if (match == null) {
      // A line with no location, such as "1 compilation errors". Kept when it
      // is the only thing the driver said.
      continue;
    }
    const wrappedLine = Number(match[2]);
    const line = wrap == null ? null : authorLineOf(wrap, wrappedLine);
    const diagnostic: Diagnostic = {
      file,
      ...(line != null ? { line } : {}),
      message: match[3].trim(),
    };
    (match[1] === "ERROR" ? errors : warnings).push(diagnostic);
  }
  if (errors.length === 0 && warnings.length === 0 && log.trim() !== "") {
    errors.push({ file, message: log.replace(/\0/g, "").trim() });
  }
  return { errors, warnings };
}

let checkGl: WebGLRenderingContext | null | undefined;

function context(): WebGLRenderingContext | null {
  if (checkGl !== undefined) {
    return checkGl;
  }
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    checkGl = canvas.getContext("webgl") as WebGLRenderingContext | null;
  } catch {
    checkGl = null;
  }
  return checkGl;
}

function compileStage(
  gl: WebGLRenderingContext,
  type: number,
  source: string,
): { shader: WebGLShader | null; log: string } {
  const shader = gl.createShader(type);
  if (shader == null) {
    return { shader: null, log: "could not create a shader object" };
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    return { shader, log: gl.getShaderInfoLog(shader) ?? "" };
  }
  const log = gl.getShaderInfoLog(shader) ?? "compile failed";
  gl.deleteShader(shader);
  return { shader: null, log };
}

/**
 * Compile every fragment stage of a validated shader preset, and link each with
 * the vertex shader the compositor would use. `null` when there is no GL here.
 */
export function checkCompiles(
  preset: FxPreset,
): { errors: Diagnostic[]; warnings: Diagnostic[] } | null {
  if (preset.render.type !== "shader") {
    return { errors: [], warnings: [] };
  }
  const gl = context();
  if (gl == null) {
    return null;
  }

  const kind = preset.kind as FxShaderKind;
  const textureUniforms = (preset.render.textures ?? []).map((t) => t.uniform);
  const vertexSource = vertexShaderFor(
    kind,
    preset.render.vertex != null ? preset.sources[preset.render.vertex] : undefined,
  );
  const vertex = compileStage(gl, gl.VERTEX_SHADER, vertexSource);
  const errors: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];
  if (vertex.shader == null) {
    errors.push({
      file: preset.render.vertex ?? "vertex",
      message: vertex.log.trim(),
    });
    return { errors, warnings };
  }

  const names = [
    ...(preset.render.passes ?? []).map((pass) => pass.source),
    preset.render.source,
  ];
  for (const name of names) {
    const wrap: WrapInput = {
      kind,
      source: preset.sources[name] ?? "",
      textureUniforms,
    };
    const fragment = compileStage(gl, gl.FRAGMENT_SHADER, wrapFragmentShader(wrap));
    if (fragment.shader == null) {
      const parsed = parseCompileLog(fragment.log, name, wrap);
      errors.push(...parsed.errors);
      warnings.push(...parsed.warnings);
      continue;
    }
    const program = gl.createProgram();
    if (program != null) {
      gl.attachShader(program, vertex.shader);
      gl.attachShader(program, fragment.shader);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        errors.push({
          file: name,
          message: "link: " + (gl.getProgramInfoLog(program) ?? "failed").trim(),
        });
      }
      gl.deleteProgram(program);
    }
    gl.deleteShader(fragment.shader);
  }
  gl.deleteShader(vertex.shader);
  return { errors, warnings };
}
