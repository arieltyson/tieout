/**
 * Tool dispatch with grant enforcement.
 *
 * Every tool declares the permissions it needs. An agent declares what it
 * holds. This module is the only place the two meet, and it is what turns
 * least privilege from a comment into something a test can assert.
 *
 * Until this existed, `toolsFor` was defined and never called: every agent
 * received every tool it was handed, and the grants were decoration. The
 * README claimed otherwise, which is the sort of gap that only shows up
 * when someone goes looking.
 */
import type { Grant, ToolDefinition } from './define.js';
import { toolsFor } from './define.js';

export type AgentKind =
  | 'orchestrator'
  | 'categorizer'
  | 'reconciler'
  | 'anomalyHunter'
  | 'receiptChaser';

/**
 * What each agent may do. Deliberately narrow.
 *
 * The receipt chaser holds no write grant of any kind, which is the
 * property worth asserting: an agent whose job is chasing paperwork should
 * never be able to alter the books, and now it structurally cannot.
 */
export const AGENT_GRANTS: Readonly<Record<AgentKind, readonly Grant[]>> = {
  orchestrator: ['ledger:read'],
  categorizer: ['ledger:read', 'vendor:read', 'vendor:write', 'propose'],
  reconciler: ['ledger:read', 'propose'],
  anomalyHunter: ['ledger:read', 'propose'],
  receiptChaser: ['ledger:read'],
};

export class GrantViolation extends Error {
  constructor(
    readonly agent: AgentKind,
    readonly tool: string,
    readonly missing: readonly Grant[],
  ) {
    super(
      `Agent "${agent}" was offered tool "${tool}", which requires `
        + `${missing.join(', ')}. That grant is not held.`,
    );
    this.name = 'GrantViolation';
  }
}

/** The tools an agent is permitted to see. Anything else is not offered. */
export function grantedTools(
  agent: AgentKind,
  tools: readonly ToolDefinition[],
): readonly ToolDefinition[] {
  return toolsFor(tools, AGENT_GRANTS[agent]);
}

/**
 * Throws if an agent is handed a tool it may not hold.
 *
 * `grantedTools` filters silently, which is right at runtime and wrong in a
 * test: a filter that quietly drops a tool the agent needed produces an
 * agent that mysteriously cannot do its job. This is the assertive version,
 * used where a mismatch means someone wired something up incorrectly.
 */
export function assertGranted(agent: AgentKind, tools: readonly ToolDefinition[]): void {
  const held = new Set(AGENT_GRANTS[agent]);
  for (const tool of tools) {
    const missing = tool.grants.filter((g) => !held.has(g));
    if (missing.length > 0) throw new GrantViolation(agent, tool.name, missing);
  }
}

export function holdsGrant(agent: AgentKind, grant: Grant): boolean {
  return AGENT_GRANTS[agent].includes(grant);
}
