/**
 * A JSON Schema object, as the `ToolShape` the MCP registrar wants.
 *
 * An extension declares its tool's arguments in its `package.json`, which can
 * only hold data, and the SDK's `registerTool` wants zod. This is the one
 * place that gap is bridged.
 *
 * Deliberately small. It understands the keywords a tool's arguments actually
 * use and turns anything else into `z.any()` with a note, rather than
 * refusing: a tool whose third optional field uses a keyword this does not
 * know should still work, because the alternative is an extension that cannot
 * offer its tool at all over a detail Claude Code would have coped with.
 *
 * **Never let a `z.infer` reach a handler signature and never build a
 * discriminated union here.** `mcp/tools/define.ts` records the measurement:
 * one inferred `registerTool` costs about ten seconds of `tsc` and seventeen
 * exhaust the compiler's heap. Returning a plain `Record<string, ZodTypeAny>`
 * is what keeps that erased.
 */

import { z } from "zod";

export type ToolShape = Record<string, z.ZodTypeAny>;

type JsonSchema = Record<string, unknown>;

export type ConversionResult = {
  shape: ToolShape;
  /** Keywords that were not understood, for the extension's log. */
  warnings: string[];
};

function convertValue(schema: unknown, at: string, warnings: string[]): z.ZodTypeAny {
  if (schema == null || typeof schema !== "object") {
    warnings.push(at + ": not a schema object, accepting anything");
    return z.any();
  }

  const node = schema as JsonSchema;
  const description = typeof node.description === "string" ? node.description : undefined;
  const describe = (type: z.ZodTypeAny) => (description == null ? type : type.describe(description));

  if (Array.isArray(node.enum) && node.enum.length > 0) {
    const values = node.enum;
    if (values.every((value) => typeof value === "string")) {
      // `z.enum` needs a non-empty tuple, which a runtime array is not, so the
      // cast is unavoidable. The guard above is what makes it true.
      return describe(z.enum(values as [string, ...string[]]));
    }
    return describe(z.union([z.string(), z.number(), z.boolean()]));
  }

  switch (node.type) {
    case "string": {
      let type = z.string();
      if (typeof node.minLength === "number") {
        type = type.min(node.minLength);
      }
      if (typeof node.maxLength === "number") {
        type = type.max(node.maxLength);
      }
      return describe(type);
    }

    case "number":
    case "integer": {
      let type = node.type === "integer" ? z.number().int() : z.number();
      if (typeof node.minimum === "number") {
        type = type.min(node.minimum);
      }
      if (typeof node.maximum === "number") {
        type = type.max(node.maximum);
      }
      return describe(type);
    }

    case "boolean":
      return describe(z.boolean());

    case "array": {
      const items = node.items == null ? z.any() : convertValue(node.items, at + "[]", warnings);
      let type = z.array(items);
      if (typeof node.minItems === "number") {
        type = type.min(node.minItems);
      }
      if (typeof node.maxItems === "number") {
        type = type.max(node.maxItems);
      }
      return describe(type);
    }

    case "object": {
      const properties = (node.properties ?? {}) as JsonSchema;
      const required = Array.isArray(node.required) ? node.required.map(String) : [];
      const shape: ToolShape = {};
      for (const [key, value] of Object.entries(properties)) {
        const converted = convertValue(value, at + "." + key, warnings);
        shape[key] = required.includes(key) ? converted : converted.optional();
      }
      return describe(z.object(shape));
    }

    default:
      warnings.push(at + ": unknown type " + JSON.stringify(node.type) + ", accepting anything");
      return describe(z.any());
  }
}

/**
 * The top-level shape, which is what `registerTool` takes.
 *
 * A tool's `inputSchema` has to be an object schema: the arguments of a call
 * are named. A schema that is anything else gets an empty shape, so the tool
 * still registers and simply takes no arguments, rather than registering
 * something the SDK will reject at call time.
 */
export function jsonSchemaToToolShape(schema: unknown): ConversionResult {
  const warnings: string[] = [];

  if (schema == null || typeof schema !== "object") {
    return { shape: {}, warnings };
  }

  const node = schema as JsonSchema;
  if (node.type !== undefined && node.type !== "object") {
    warnings.push("inputSchema: a tool's arguments must be an object, so it was ignored");
    return { shape: {}, warnings };
  }

  const properties = (node.properties ?? {}) as JsonSchema;
  const required = Array.isArray(node.required) ? node.required.map(String) : [];
  const shape: ToolShape = {};

  for (const [key, value] of Object.entries(properties)) {
    const converted = convertValue(value, key, warnings);
    shape[key] = required.includes(key) ? converted : converted.optional();
  }

  return { shape, warnings };
}
