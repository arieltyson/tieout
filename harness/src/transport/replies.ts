/**
 * What the agent says back.
 *
 * A text message is a bad place for forty categorizations, so these are
 * deliberately short. The detail lives in the app and on the approval
 * cards; this is the part that has to fit on a lock screen.
 *
 * Kept pure and separate from the sender so the wording is testable. What a
 * system says to somebody is a decision, not a formatting detail.
 */
import type { Finding } from '../agents/anomaly-hunter.js';
import type { AuditRecord } from '../store/audit-log.js';
import type { RunState } from '../domain/close-run.js';

export interface CloseSummary {
  readonly period: string;
  readonly categorized: number;
  readonly findings: readonly Finding[];
  readonly needsReview: number;
  readonly blocked: number;
  readonly costUsd: number | null;
  readonly failedAgents: readonly string[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function closeReply(summary: CloseSummary): string {
  const lines = [
    `${summary.period}: ${plural(summary.categorized, 'transaction')} categorized, `
      + `${plural(summary.findings.length, 'finding')}.`,
  ];

  if (summary.blocked > 0) {
    // Said first because it means the run is not finished, whatever else
    // it managed. Burying it under a success line would be misleading.
    lines.push(`${plural(summary.blocked, 'proposal')} blocked by the verifiers and sent back.`);
  }

  const top = [...summary.findings]
    .sort((a, b) => (b.materialityCents ?? -1) - (a.materialityCents ?? -1))
    .slice(0, 3);
  if (top.length > 0) {
    lines.push('');
    top.forEach((f, i) => lines.push(`${i + 1}. ${f.summary}`));
    if (summary.findings.length > top.length) {
      lines.push(`…and ${summary.findings.length - top.length} more.`);
    }
  }

  if (summary.failedAgents.length > 0) {
    // Never silently omitted. A close that skipped a whole agent looks
    // identical to one that found nothing, unless it says so.
    lines.push('', `Incomplete: ${summary.failedAgents.join(', ')} did not finish.`);
  }

  lines.push('');
  lines.push(
    summary.needsReview > 0
      ? `${plural(summary.needsReview, 'item')} need you. Reply approve <ids> or why <id>.`
      : 'Nothing needs a decision.',
  );
  if (summary.costUsd !== null) lines.push(`Cost $${summary.costUsd.toFixed(2)}.`);

  return lines.join('\n');
}

export function statusReply(state: RunState, period: string, needsReview: number): string {
  switch (state) {
    case 'awaitingApproval':
      return needsReview === 0
        ? `${period} is ready and nothing needs you.`
        : `${period} is waiting on you. ${plural(needsReview, 'item')} to review.`;
    case 'complete':
      return `${period} is closed.`;
    case 'failed':
      return `${period} failed. Reply close ${period} to try again.`;
    case 'planning':
    case 'dispatched':
      return `${period} is running.`;
    case 'verifying':
      return `${period} is being verified.`;
    case 'applying':
      return `${period} is being applied.`;
  }
}

/**
 * The `why` reply.
 *
 * Answers with the tool calls that produced the claim, straight from the
 * audit log. This is the whole argument for an append only trail: every
 * conclusion traces to a computation that actually ran, and a person can
 * ask for it in a text message.
 */
export function whyReply(id: number, entries: readonly AuditRecord[]): string {
  if (entries.length === 0) {
    return `Nothing recorded for ${id}. Either it does not exist or the run was not audited.`;
  }
  const lines = [`Finding ${id} came from ${plural(entries.length, 'tool call')}:`];
  for (const entry of entries.slice(0, 5)) {
    lines.push(`• ${entry.tool} (${entry.durationMs}ms)${entry.isError ? ' — errored' : ''}`);
  }
  if (entries.length > 5) lines.push(`…and ${entries.length - 5} more.`);
  return lines.join('\n');
}

export function decisionReply(kind: 'approve' | 'reject', applied: number, ignored: number): string {
  const verb = kind === 'approve' ? 'Approved' : 'Rejected';
  if (applied === 0 && ignored > 0) {
    // Silence here reads as success, and a person would assume their
    // approval landed when it did not.
    return `Nothing to do. ${plural(ignored, 'item')} already decided.`;
  }
  const tail = ignored > 0 ? ` ${plural(ignored, 'item')} already decided.` : '';
  return `${verb} ${plural(applied, 'item')}.${tail}`;
}

export const HELP_REPLY = [
  'I understand:',
  '• close june   (or close 2026-06, add --dry to spend nothing)',
  '• status',
  '• approve 1-4  /  reject 2',
  '• why 3',
  '• cancel',
].join('\n');
