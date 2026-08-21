/**
 * The nested-session structured-output capture tool (design plan §4.6, layer 2).
 *
 * Only injected by AgentTaskRuntime when an item carries an outputSchema. The
 * worker's subset gate (layer 1, assertObjectJsonSchema) ran before the child
 * started; this tool re-validates the SUBMITTED value against the same
 * schema. A valid submit terminates the child session and writes the
 * validated object into the tool details (the spawner projects it, layer 3);
 * an invalid submit is an ordinary tool result with corrective text - no
 * throw, the model may retry.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TextContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { JsonSchemaNode, ObjectJsonSchema } from "./engine/schema.js";

export const STRUCTURED_OUTPUT_TOOL_NAME = "submit_workflow_result";

export const STRUCTURED_OUTPUT_PROMPT_GUIDELINES: readonly string[] = [
  "You MUST call submit_workflow_result to finish this run. A text-only answer does not complete it.",
  "The tool arguments ARE the JSON object and must match the required schema in the tool description.",
  "Call submit_workflow_result alone as your last action. Do not combine it with other tools in the same turn.",
];

/** Injected on the last allowed turn of a schema child that has not submitted yet. */
export const SCHEMA_CHILD_LAST_TURN_NUDGE =
  "This run is not complete. Your next action must be a single submit_workflow_result call whose arguments match the required schema. Do not write a text-only summary.";

/** Extra in-session prompts after a schema child stops without submitting (same nested session). */
export const SCHEMA_CHILD_SUBMIT_RECOVERIES = 2;

/** Injected when the nested session goes idle without a submit (early stop, not last-turn). */
export const SCHEMA_CHILD_EARLY_STOP_NUDGE =
  "You stopped without calling submit_workflow_result. Your next action must be a single submit_workflow_result call whose arguments match the required schema. Do not write a text-only summary.";

export interface StructuredOutputToolDetails {
  /** Present exactly on success: the capture-validated structured value. */
  structured?: unknown;
}

/** Nested-session system-prompt suffix so general-purpose agents cannot "conclude with a summary" and skip the capture tool. */
export function schemaChildCompletionPrompt(schema: ObjectJsonSchema): string {
  return [
    "This child run is not complete until you call submit_workflow_result with a JSON object matching the required schema.",
    "A text-only summary does not finish this run.",
    "Call submit_workflow_result alone as your last action; do not combine it with other tools in the same turn.",
    `Required schema:\n${JSON.stringify(schema, null, 2)}`,
  ].join("\n");
}

function toolDescription(schema: ObjectJsonSchema): string {
  return [
    "Submit the final structured result of this child run.",
    "The tool arguments ARE the JSON object and must match this schema:",
    JSON.stringify(schema, null, 2),
    "A failed validation is a normal tool result: fix the value and submit again.",
    "A successful submission ends this run. Call this tool alone; do not call further tools afterwards.",
  ].join("\n");
}

function textContent(text: string): TextContent {
  return { type: "text", text };
}

/** JSON text candidates: whole string, fenced ```json, or the outermost `{...}`. */
function jsonCandidates(text: string): string[] {
  const trimmed = text.trim();
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (value: string | undefined): void => {
    if (value === undefined) return;
    const next = value.trim();
    if (next === "" || seen.has(next)) return;
    seen.add(next);
    out.push(next);
  };
  add(trimmed);
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence?.[1] !== undefined) add(fence[1]);
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) add(trimmed.slice(start, end + 1));
  return out;
}

/**
 * Last-resort capture: if the child wrote a JSON object as text instead of
 * calling submit_workflow_result, and it validates against the schema, accept it.
 */
export function salvageStructuredFromText(schema: ObjectJsonSchema, text: string): unknown | undefined {
  for (const candidate of jsonCandidates(text)) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (validateNode(toNode(schema), value, "value") === undefined) {
        return value;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural deep equality for JSON data (no prototype traversal). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) {
      return false;
    }
    return aKeys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]));
  }
  return false;
}

/**
 * The gate accepts `items / enum / const / oneOf` keys at runtime even though
 * JsonSchemaNode only declares the structural keys; the capture validator
 * reads them through this local extension.
 */
type SchemaNode = JsonSchemaNode & {
  items?: JsonSchemaNode | JsonSchemaNode[];
  enum?: unknown[];
  const?: unknown;
  oneOf?: unknown[];
};

function toNode(schema: JsonSchemaNode): SchemaNode {
  return schema as SchemaNode;
}

/**
 * Validate a submitted value against one gate-passed subset node. Returns an
 * undefined (pass) or a corrective message naming the failing path.
 */
function validateNode(schema: SchemaNode, value: unknown, path: string): string | undefined {
  if (schema.const !== undefined) {
    return deepEqual(value, schema.const) ? undefined : `${path} must equal the required const value`;
  }
  if (schema.enum !== undefined && Array.isArray(schema.enum)) {
    return schema.enum.some((candidate) => deepEqual(value, candidate))
      ? undefined
      : `${path} must be one of the allowed enum values`;
  }
  if (schema.oneOf !== undefined && Array.isArray(schema.oneOf)) {
    let matches = 0;
    for (const option of schema.oneOf) {
      if (isPlainObject(option) && validateNode(toNode(option as unknown as JsonSchemaNode), value, path) === undefined) {
        matches++;
      }
    }
    return matches === 1 ? undefined : `${path} must match exactly one of the oneOf options`;
  }
  if (schema.type === "string") {
    return typeof value === "string" ? undefined : `${path} must be a string`;
  }
  if (schema.type === "number") {
    return typeof value === "number" && Number.isFinite(value) ? undefined : `${path} must be a finite number`;
  }
  if (schema.type === "integer") {
    return typeof value === "number" && Number.isInteger(value) ? undefined : `${path} must be an integer`;
  }
  if (schema.type === "boolean") {
    return typeof value === "boolean" ? undefined : `${path} must be a boolean`;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      return `${path} must be an array`;
    }
    if (schema.items === undefined) {
      return undefined;
    }
    if (Array.isArray(schema.items)) {
      for (const [index, sub] of schema.items.entries()) {
        const message = validateNode(toNode(sub as unknown as JsonSchemaNode), value[index], `${path}[${index}]`);
        if (message !== undefined) {
          return message;
        }
      }
      return undefined;
    }
    for (const [index, item] of value.entries()) {
      const message = validateNode(toNode(schema.items as unknown as JsonSchemaNode), item, `${path}[${index}]`);
      if (message !== undefined) {
        return message;
      }
    }
    return undefined;
  }
  if (!isPlainObject(value)) {
    return `${path} must be an object`;
  }
  const properties = schema.properties ?? {};
  for (const key of schema.required ?? []) {
    // Own-property check only: `in` would let prototype members like
    // "toString" masquerade as present required fields.
    if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined) {
      return `${path} is missing the required field ${JSON.stringify(key)}`;
    }
  }
  for (const [key, sub] of Object.entries(properties)) {
    if (key in value && value[key] !== undefined) {
      const message = validateNode(toNode(sub as unknown as JsonSchemaNode), value[key], `${path}.${key}`);
      if (message !== undefined) {
        return message;
      }
    }
  }
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        // Own-property check: `in` would let a prototype member of the
        // schema's properties object (e.g. "toString") masquerade as a
        // declared property and slip past additionalProperties:false.
        if (!Object.prototype.hasOwnProperty.call(properties, key)) {
          return `${path} has the unexpected field ${JSON.stringify(key)}`;
        }
      }
    } else {
      const additional = schema.additionalProperties as JsonSchemaNode;
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) {
          const message = validateNode(toNode(additional), value[key], `${path}.${key}`);
          if (message !== undefined) {
            return message;
          }
        }
      }
    }
  }
  return undefined;
}

/**
 * Create the submit_workflow_result ToolDefinition bound to a frozen
 * outputSchema. Only AgentTaskRuntime injects it (schema children only).
 */
export function createStructuredOutputTool(
  schema: ObjectJsonSchema,
): ToolDefinition {
  return {
    name: STRUCTURED_OUTPUT_TOOL_NAME,
    label: "Submit Workflow Result",
    description: toolDescription(schema),
    promptSnippet: "Submit the final structured result of this run against the required schema.",
    promptGuidelines: [...STRUCTURED_OUTPUT_PROMPT_GUIDELINES],
    // Advertise the real schema to the model. Layer-2 validateNode remains
    // authoritative; TypeBox Check on this schema is a first filter.
    parameters: Type.Unsafe(schema),
    executionMode: "sequential",
    async execute(_toolCallId, params): Promise<AgentToolResult<StructuredOutputToolDetails>> {
      const message = validateNode(toNode(schema), params, "value");
      if (message !== undefined) {
        // Ordinary tool result: no throw, no terminate - the model may retry.
        return {
          content: [textContent(`The submitted value does not match the required structured schema: ${message}`)],
          details: {},
        };
      }
      return {
        content: [textContent("Structured result submitted.")],
        details: { structured: params },
        terminate: true,
      };
    },
  };
}
