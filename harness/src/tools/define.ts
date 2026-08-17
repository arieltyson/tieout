/**
 * The tool definition pattern.
 *
 * One Zod schema produces both the JSON Schema sent to the model and the
 * TypeScript type used internally, so the two cannot drift. The `grants`
 * tag is what makes least privilege testable: a sub-agent is offered only
 * the tools its grants permit, and "the receipt chaser can't write to the
 * ledger" becomes an assertion rather than an intention.
 */
import { z } from 'zod';

export type Grant = 'ledger:read' | 'ledger:write' | 'vendor:read' | 'vendor:write' | 'propose';

export interface ToolContext {
  readonly runId: string;
  /** Appended to by the dispatcher; tools never write the audit log themselves. */
  readonly seq: number;
}

export interface ToolDefinition<S extends z.ZodType = z.ZodType, R = unknown> {
  readonly name: string;
  readonly description: string;
  readonly input: S;
  readonly grants: readonly Grant[];
  run(args: z.infer<S>, ctx: ToolContext): Promise<R> | R;
}

export function defineTool<S extends z.ZodType, R>(spec: ToolDefinition<S, R>): ToolDefinition<S, R> {
  return spec;
}

/**
 * Zod schema -> JSON Schema for the model. Uses Zod's own converter so the
 * shape the model sees is derived from the shape we validate against,
 * rather than hand-written alongside it.
 */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
  // The API requires a top-level object schema.
  if (json['type'] !== 'object') {
    throw new Error(`Tool input must be an object schema, got ${String(json['type'])}`);
  }
  return json;
}

export function toToolSpec(tool: ToolDefinition) {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: toJsonSchema(tool.input),
  };
}

/** Tools a given grant set may see. The dispatcher filters with this. */
export function toolsFor(
  tools: readonly ToolDefinition[],
  grants: readonly Grant[],
): readonly ToolDefinition[] {
  const held = new Set(grants);
  return tools.filter((t) => t.grants.every((g) => held.has(g)));
}
