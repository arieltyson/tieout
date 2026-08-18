/**
 * Command parsing.
 *
 * Deterministic first, exactly as everywhere else in this system. `approve
 * 1-4` has one meaning, and spending a model call to discover it would be
 * slower, costlier, and occasionally wrong. The model is a fallback for
 * input this grammar does not recognise, not the first resort.
 */

export type Command =
  | { readonly kind: 'close'; readonly period: string; readonly dry: boolean }
  | { readonly kind: 'approve'; readonly ids: readonly number[] }
  | { readonly kind: 'reject'; readonly ids: readonly number[] }
  | { readonly kind: 'why'; readonly id: number }
  | { readonly kind: 'status' }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'unrecognized'; readonly text: string };

const MONTHS: Readonly<Record<string, string>> = {
  january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
  july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
  jan: '01', feb: '02', mar: '03', apr: '04', jun: '06', jul: '07',
  aug: '08', sep: '09', sept: '09', oct: '10', nov: '11', dec: '12',
};

/**
 * Expands `1-4, 7` into [1,2,3,4,7].
 *
 * Ranges are inclusive and reversed ranges are accepted, because somebody
 * typing on a phone will write `4-1`. Bounded at a hundred so a typo like
 * `1-99999` cannot turn into an enormous list of approvals.
 */
export function parseIdList(input: string): readonly number[] {
  const out = new Set<number>();
  for (const part of input.split(/[,\s]+/).filter(Boolean)) {
    const range = /^(\d+)\s*[-–]\s*(\d+)$/.exec(part);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      if (hi - lo > 100) return [];
      for (let i = lo; i <= hi; i += 1) out.add(i);
      continue;
    }
    if (/^\d+$/.test(part)) out.add(Number(part));
    else return [];
  }
  return [...out].sort((x, y) => x - y);
}

/** Turns "june", "2026-06", or "june 2026" into a period. */
export function parsePeriod(input: string, now = new Date()): string | null {
  const text = input.trim().toLowerCase();
  const iso = /^(\d{4})-(\d{2})$/.exec(text);
  if (iso) return text;

  const named = /^([a-z]+)(?:\s+(\d{4}))?$/.exec(text);
  if (named) {
    const month = MONTHS[named[1]!];
    if (!month) return null;
    // No year given means the most recent occurrence of that month, which
    // is what somebody texting "close june" in July means. Assuming the
    // current year would ask for a close that has not happened yet.
    const year = named[2] ? Number(named[2]) : now.getUTCFullYear();
    const candidate = `${year}-${month}`;
    if (!named[2] && candidate > isoMonth(now)) return `${year - 1}-${month}`;
    return candidate;
  }
  return null;
}

function isoMonth(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function parseCommand(input: string, now = new Date()): Command {
  const text = input.trim().replace(/\s+/g, ' ');
  const lowered = text.toLowerCase();

  if (lowered === 'status') return { kind: 'status' };
  if (lowered === 'cancel' || lowered === 'stop') return { kind: 'cancel' };

  const close = /^close\s+(.+?)(\s+--dry|\s+dry)?$/.exec(lowered);
  if (close) {
    const period = parsePeriod(close[1]!, now);
    if (period) return { kind: 'close', period, dry: close[2] !== undefined };
    return { kind: 'unrecognized', text };
  }

  const why = /^why\s+(\d+)$/.exec(lowered);
  if (why) return { kind: 'why', id: Number(why[1]) };

  const decision = /^(approve|reject)\s+(.+)$/.exec(lowered);
  if (decision) {
    const ids = parseIdList(decision[2]!);
    if (ids.length === 0) return { kind: 'unrecognized', text };
    return decision[1] === 'approve' ? { kind: 'approve', ids } : { kind: 'reject', ids };
  }

  return { kind: 'unrecognized', text };
}

/** True when the command changes something and should require a decision. */
export function isMutating(command: Command): boolean {
  return command.kind === 'approve' || command.kind === 'reject' || command.kind === 'cancel';
}
