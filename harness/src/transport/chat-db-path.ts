/**
 * Which `chat.db` the listener is allowed to open.
 *
 * The real `~/Library/Messages/chat.db` is the user's entire private
 * message history. This project develops and tests against a synthetic
 * fixture instead, and that is enforced here rather than left to whoever
 * writes the next caller.
 *
 * The rule:
 *
 *   - the default is always the synthetic fixture
 *   - any path inside the real Messages directory is REFUSED unless
 *     TIEOUT_ALLOW_REAL_CHATDB is explicitly set to "1"
 *   - the refusal is a thrown error, not a warning, because a warning in a
 *     log nobody reads is the same as no check at all
 *
 * Same shape as the `Cents` type and the scanner's --all mode: make the
 * unsafe thing hard to reach, then test that it is hard to reach.
 */
import { homedir } from 'node:os';
import { resolve, sep } from 'node:path';

export const REAL_CHATDB_OPT_IN = 'TIEOUT_ALLOW_REAL_CHATDB';

/** The directory holding the user's actual message history. */
export function realMessagesDirectory(home = homedir()): string {
  return resolve(home, 'Library', 'Messages');
}

export class RealChatDbRefused extends Error {
  constructor(readonly attemptedPath: string) {
    super(
      `Refusing to open ${attemptedPath}: it is inside the real Messages directory.\n`
        + `This project runs against a synthetic chat.db fixture so that private\n`
        + `message history never enters it. If you genuinely intend to read real\n`
        + `messages, set ${REAL_CHATDB_OPT_IN}=1 and grant Full Disk Access.`,
    );
    this.name = 'RealChatDbRefused';
  }
}

export function isInsideRealMessagesDirectory(path: string, home = homedir()): boolean {
  const target = resolve(path);
  const guarded = realMessagesDirectory(home);
  return target === guarded || target.startsWith(guarded + sep);
}

export interface ResolveOptions {
  /** Explicit path; falls back to the fixture when omitted. */
  readonly requested?: string | undefined;
  readonly fixturePath: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
}

/**
 * Returns the path the listener may open, or throws.
 *
 * Note the opt-in is checked against the exact string "1". Accepting any
 * truthy value means a stray `TIEOUT_ALLOW_REAL_CHATDB=0` reads as consent.
 */
export function resolveChatDbPath(options: ResolveOptions): string {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const requested = options.requested?.trim();

  if (!requested) return options.fixturePath;

  if (isInsideRealMessagesDirectory(requested, home)) {
    if (env[REAL_CHATDB_OPT_IN] !== '1') {
      throw new RealChatDbRefused(requested);
    }
  }
  return requested;
}
