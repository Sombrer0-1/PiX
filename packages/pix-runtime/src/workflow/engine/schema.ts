/**
 * The ObjectJsonSchema subset the workflow feature supports for `agent()`
 * structured output. The subset is deliberately narrow: only the keys
 * `type / properties / required / additionalProperties / items / enum /
 * const / oneOf` are allowed anywhere in the tree, the schema is
 * object-rooted, nested nodes may be `object` / `string` / `array` /
 * `number` / `integer` / `boolean`, and `enum` / `const` / `oneOf` values
 * are unvalidated data.
 * The gate throws `UNSUPPORTED_SCHEMA`; the capture tool re-validates
 * submitted values inside the nested session (a separate layer, not this
 * module).
 */

import { WorkflowError } from "./engine.js";

/**
 * The accepted subset shape. The type exposes the four structural keys;
 * `items` / `enum` / `const` / `oneOf` are accepted by the assertion at
 * runtime. The root must be `type: "object"`; nested nodes may be
 * `object` / `string` / `array` / `number` / `integer` / `boolean`. Nested
 * nodes allow only the keys
 * `type / properties / required / additionalProperties / items / enum /
 * const / oneOf`.
 */
/** Nested subset node: object / string / array / number / integer / boolean. */
export interface JsonSchemaNode {
  type: "object" | "string" | "array" | "number" | "integer" | "boolean";
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean | JsonSchemaNode;
}

export interface ObjectJsonSchema extends JsonSchemaNode {
  type: "object";
}

const SCHEMA_KEYS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "oneOf",
]);

const NESTED_TYPES = new Set(["object", "string", "array", "number", "integer", "boolean"]);

function unsupported(detail: string): WorkflowError {
  return new WorkflowError(`schema is outside the supported subset: ${detail}`, "UNSUPPORTED_SCHEMA");
}

/**
 * Subset gate for a caller-provided schema: validates the shape and throws
 * `WorkflowError` with code `UNSUPPORTED_SCHEMA` on the first violation.
 * `enum` / `const` / `oneOf` values are unvalidated data — presence is
 * allowed, contents are not inspected.
 */
export function assertObjectJsonSchema(schema: unknown): asserts schema is ObjectJsonSchema {
  checkSchema(schema, "schema");
}

function checkSchema(value: unknown, path: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw unsupported(`${path} must be an object with type "object"`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!SCHEMA_KEYS.has(key)) {
      throw unsupported(
        `${path}: key ${JSON.stringify(key)} is not allowed (allowed: type/properties/required/additionalProperties/items/enum/const/oneOf)`,
      );
    }
  }
  if (path === "schema") {
    if (record.type !== "object") {
      throw unsupported(
        `${path}.type must be "object" (the capture tool takes an object; put number/boolean/integer on nested fields, not the root)`,
      );
    }
  } else if (typeof record.type !== "string" || !NESTED_TYPES.has(record.type)) {
    throw unsupported(
      `${path}.type must be "object", "string", "array", "number", "integer", or "boolean"`,
    );
  }
  if (record.properties !== undefined) {
    if (typeof record.properties !== "object" || record.properties === null || Array.isArray(record.properties)) {
      throw unsupported(`${path}.properties must be an object of schemas`);
    }
    for (const [key, sub] of Object.entries(record.properties)) {
      checkSchema(sub, `${path}.properties.${key}`);
    }
  }
  if (record.required !== undefined) {
    if (!Array.isArray(record.required) || !record.required.every((item) => typeof item === "string")) {
      throw unsupported(`${path}.required must be an array of strings`);
    }
  }
  if (record.additionalProperties !== undefined) {
    const additionalProperties = record.additionalProperties;
    if (typeof additionalProperties !== "boolean") {
      checkSchema(additionalProperties, `${path}.additionalProperties`);
    }
  }
  if (record.items !== undefined) {
    const items = record.items;
    if (Array.isArray(items)) {
      items.forEach((item, index) => checkSchema(item, `${path}.items[${index}]`));
    } else {
      checkSchema(items, `${path}.items`);
    }
  }
  // enum / const / oneOf carry unvalidated JSON data — presence is allowed.
}
