/**
 * The loop that makes this a messaging app: poll, decide, reply.
 *
 * Everything it touches is injected, so the whole service runs against the
 * synthetic message database and a recording sender with nothing sent to
 * anybody. That is how it is tested and how it is demonstrated.
 *
 * The ordering here is the security property. A row is filtered, the sender
 * is checked against the allowlist, and only then is anything parsed. No
 * token is spent and no command is interpreted on behalf of somebody who
 * is not allowed to issue one.
 */
import type { CheckpointStore } from '../store/checkpoint.js';
import type { AuditLog } from '../store/audit-log.js';
import { parseCommand, type Command } from './commands.js';
import { describeInbound, readNewRows, toInboundMessages, type InboundMessage } from './listener.js';
import { HELP_REPLY, statusReply, whyReply } from './replies.js';
import type { MessageSender } from './sender.js';

export interface ServiceDeps {
  readonly dbPath: string;
  readonly salt: string;
  readonly allowlist: ReadonlySet<string>;
  readonly replyHandle: string;
  readonly sender: MessageSender;
  readonly checkpoints?: CheckpointStore | undefined;
  readonly audit?: AuditLog | undefined;
  /** Runs a close. Injected so the service can be tested without a model. */
  readonly runClose: (period: string, dry: boolean) => Promise<string>;
  readonly onLog?: (line: string) => void;
}

export interface Handled {
  readonly rowid: number;
  readonly command: Command['kind'];
  readonly reply: string;
}

export interface PollResult {
  readonly lastRowId: number;
  readonly handled: readonly Handled[];
  readonly droppedCount: number;
}

/**
 * Decides what a single message means and what to say back.
 *
 * Exported separately from the polling so intent handling can be tested
 * without a database anywhere near it.
 */
export async function handleCommand(
  command: Command,
  deps: ServiceDeps,
  period = '2026-06',
): Promise<string> {
  switch (command.kind) {
    case 'close':
      return deps.runClose(command.period, command.dry);

    case 'status': {
      const parked = deps.checkpoints?.awaitingApproval() ?? [];
      const run = parked[0];
      if (run === undefined) return 'No close is running.';
      return statusReply(run.state, run.period, deps.checkpoints?.undecided(run.runId).length ?? 0);
    }

    case 'why': {
      const runs = deps.checkpoints?.awaitingApproval() ?? [];
      const runId = runs[0]?.runId;
      if (runId === undefined || deps.audit === undefined) {
        return whyReply(command.id, []);
      }
      return whyReply(command.id, deps.audit.evidenceFor(runId, [command.id]));
    }

    case 'approve':
    case 'reject': {
      const runs = deps.checkpoints?.awaitingApproval() ?? [];
      const run = runs[0];
      if (run === undefined || deps.checkpoints === undefined) {
        return 'Nothing is waiting for a decision.';
      }
      let applied = 0;
      let ignored = 0;
      for (const index of command.ids) {
        const proposal = run.proposals[index - 1];
        if (proposal === undefined) {
          ignored += 1;
          continue;
        }
        const took = deps.checkpoints.applyDecision(run.runId, {
          idempotencyKey: proposal.idempotencyKey,
          proposalId: proposal.id,
          kind: command.kind === 'approve' ? 'approved' : 'rejected',
          decidedBy: 'message',
        });
        if (took) applied += 1;
        else ignored += 1;
      }
      const verb = command.kind === 'approve' ? 'Approved' : 'Rejected';
      return ignored > 0
        ? `${verb} ${applied}. ${ignored} already decided or out of range.`
        : `${verb} ${applied}.`;
    }

    case 'cancel':
      return 'Cancelled. Nothing was applied.';

    case 'unrecognized':
      // Deliberately not sent to a model. An unrecognised command from an
      // allowlisted sender is far more likely a typo than a request needing
      // interpretation, and guessing at intent is how an agent does
      // something nobody asked for.
      return HELP_REPLY;
  }
  return HELP_REPLY;
}

/** One pass over anything newer than the last row seen. */
export async function pollOnce(
  deps: ServiceDeps,
  afterRowId: number,
  now = new Date(),
): Promise<PollResult> {
  const log = deps.onLog ?? (() => {});
  const rows = readNewRows(deps.dbPath, afterRowId);
  const { messages, dropped } = toInboundMessages(rows, {
    salt: deps.salt,
    allowlist: deps.allowlist,
  });

  const handled: Handled[] = [];
  for (const message of messages) {
    log(describeInbound(message));
    const command = parseCommand(message.body, now);
    const reply = await handleCommand(command, deps);
    await deps.sender.send(deps.replyHandle, reply);
    handled.push({ rowid: message.rowid, command: command.kind, reply });
  }

  const lastRowId = rows.reduce((max, r) => Math.max(max, r.rowid), afterRowId);
  return { lastRowId, handled, droppedCount: dropped.length };
}

/**
 * Polls until stopped.
 *
 * The cursor advances past every row examined, including dropped ones. A
 * cursor that only advanced past handled messages would re-examine every
 * tapback forever, and one bad row would wedge the service permanently.
 */
export class MessageService {
  private lastRowId: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;

  constructor(
    private readonly deps: ServiceDeps,
    startAfterRowId = 0,
    private readonly intervalMs = 2000,
  ) {
    this.lastRowId = startAfterRowId;
  }

  get cursor(): number {
    return this.lastRowId;
  }

  async tick(now = new Date()): Promise<PollResult> {
    const result = await pollOnce(this.deps, this.lastRowId, now);
    this.lastRowId = result.lastRowId;
    return result;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      try {
        await this.tick();
      } catch (error) {
        // A failed poll must not kill the service. The database may be
        // briefly locked while Messages writes to it, which is ordinary.
        this.deps.onLog?.(`poll failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (this.running) this.timer = setTimeout(() => void loop(), this.intervalMs);
    };
    void loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
