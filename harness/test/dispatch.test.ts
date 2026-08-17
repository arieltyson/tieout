import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { buildAnomalyTools } from '../src/tools/anomaly-tools.js';
import { buildCategorizerTools } from '../src/tools/categorizer-tools.js';
import { defineTool, type Grant } from '../src/tools/define.js';
import {
  AGENT_GRANTS,
  GrantViolation,
  assertGranted,
  grantedTools,
  holdsGrant,
  type AgentKind,
} from '../src/tools/dispatch.js';
import { loadLedger } from '../../fixtures/src/index.js';

const ledger = loadLedger();
const tool = (name: string, grants: readonly Grant[]) =>
  defineTool({ name, description: name, input: z.object({}), grants, run: () => ({}) });

const writeLedger = tool('write_ledger', ['ledger:write']);
const readLedger = tool('read_ledger', ['ledger:read']);
const propose = tool('propose_thing', ['propose']);

describe('least privilege is enforced, not merely declared', () => {
  // The property the README claims. Before dispatch existed, toolsFor was
  // never called and every agent saw every tool.
  test('the receipt chaser is offered zero tools that write to the ledger', () => {
    const offered = grantedTools('receiptChaser', [readLedger, writeLedger, propose]);
    expect(offered.map((t) => t.name)).toEqual(['read_ledger']);
    expect(offered.some((t) => t.grants.includes('ledger:write'))).toBe(false);
  });

  test('no agent anywhere holds a ledger write grant', () => {
    // Nothing in this system mutates a ledger. If that ever changes, this
    // is where it should be argued for rather than discovered.
    for (const agent of Object.keys(AGENT_GRANTS) as AgentKind[]) {
      expect(holdsGrant(agent, 'ledger:write')).toBe(false);
    }
  });

  test('the orchestrator cannot propose anything itself', () => {
    // It plans and synthesizes. Proposals come from specialists.
    expect(holdsGrant('orchestrator', 'propose')).toBe(false);
    expect(grantedTools('orchestrator', [propose])).toEqual([]);
  });

  test('only the categorizer may write vendor memory', () => {
    const writers = (Object.keys(AGENT_GRANTS) as AgentKind[]).filter((a) =>
      holdsGrant(a, 'vendor:write'),
    );
    expect(writers).toEqual(['categorizer']);
  });

  test('a tool requiring an unheld grant is filtered out, not silently run', () => {
    expect(grantedTools('receiptChaser', [propose])).toEqual([]);
  });
});

describe('assertGranted', () => {
  test('accepts a correctly wired agent', () => {
    expect(() => assertGranted('categorizer', [readLedger, propose])).not.toThrow();
  });

  test('throws when an agent is handed something it may not hold', () => {
    expect(() => assertGranted('receiptChaser', [writeLedger])).toThrow(GrantViolation);
  });

  test('the error names the agent, the tool, and the missing grant', () => {
    try {
      assertGranted('receiptChaser', [propose]);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GrantViolation);
      const message = (err as Error).message;
      expect(message).toContain('receiptChaser');
      expect(message).toContain('propose_thing');
      expect(message).toContain('propose');
    }
  });
});

describe('the real tool sets fit inside their agents grants', () => {
  test('every categorizer tool is one the categorizer may hold', () => {
    const tools = buildCategorizerTools(ledger, { categorizations: [] });
    expect(() => assertGranted('categorizer', tools)).not.toThrow();
    expect(grantedTools('categorizer', tools)).toHaveLength(tools.length);
  });

  test('every anomaly tool is one the anomaly hunter may hold', () => {
    const tools = buildAnomalyTools(ledger, [], { duplicateVerdicts: [], aliasGroups: [] });
    expect(() => assertGranted('anomalyHunter', tools)).not.toThrow();
  });

  test('the categorizer tool set would be rejected for the receipt chaser', () => {
    // Proof the filter discriminates rather than passing everything.
    const tools = buildCategorizerTools(ledger, { categorizations: [] });
    expect(() => assertGranted('receiptChaser', tools)).toThrow(GrantViolation);
    expect(grantedTools('receiptChaser', tools).length).toBeLessThan(tools.length);
  });
});
