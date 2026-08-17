/**
 * Vendor memory: merchant descriptors this system has categorized before.
 *
 * The first time you correct a merchant it is a correction. The second time
 * it should be a rule. Memory turns a categorization the model already paid
 * for into one the harness applies for free, so a familiar ledger gets
 * cheaper every time it is closed.
 *
 * THE HARD PART IS NOT STORAGE, IT IS KNOWING WHEN TO GENERALIZE.
 *
 * Exact descriptors are safe but nearly useless for the merchants that
 * matter. `GOOGLE *CLOUD 4471829` never appears twice, because the suffix
 * changes on every charge, so an exact key learns nothing about it.
 *
 * Generalizing is useful and dangerous. Strip enough of a descriptor and
 * `UBER *TRIP` and `UBER *EATS` collapse into `UBER`, which is one brand
 * covering a taxi ride and a food delivery that belong in different
 * accounts. A memory keyed on that stem would confidently misfile half of
 * them forever, and it would do so silently.
 *
 * The resolution is to stem aggressively and then refuse to trust any stem
 * whose evidence disagrees with itself. If every descriptor sharing a stem
 * has been categorized the same way, the stem is a rule. The moment two
 * disagree, the stem is marked in conflict and never used again, and only
 * exact matches serve that merchant. Crude generalization plus a conflict
 * check is safer than careful generalization with no check, because the
 * check fails loudly and cleverness fails quietly.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface VendorMatch {
  readonly glCode: string;
  readonly confidence: number;
  readonly matchedOn: 'exact' | 'stem';
}

/**
 * Reduces a descriptor to the part that identifies the merchant, dropping
 * order tokens, store numbers, and transaction ids.
 *
 * Deliberately blunt. Precision here is not what keeps the memory correct;
 * the conflict check is.
 */
export function vendorStem(descriptor: string): string {
  // Split on separators and drop any token containing a digit. Stripping
  // digits in place is not enough: `AMZN Mktp US*2K4LM9XY3` would leave
  // `K LM XY` behind and no two order tokens would ever agree, which
  // defeats the entire point of having a stem.
  return descriptor
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((token) => token.length > 0 && !/\d/.test(token))
    .join(' ')
    .trim();
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS vendor_exact (
  descriptor  TEXT PRIMARY KEY,
  gl_code     TEXT NOT NULL,
  confidence  INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS vendor_stem (
  stem        TEXT PRIMARY KEY,
  gl_code     TEXT NOT NULL,
  confidence  INTEGER NOT NULL DEFAULT 1,
  conflicted  INTEGER NOT NULL DEFAULT 0
);
`;

export class VendorMemory {
  private readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Records a categorization the system is confident in.
   *
   * An exact descriptor always learns. A stem learns only while its
   * evidence agrees; the first disagreement marks it conflicted and no
   * later agreement un-marks it, because a stem that has ever been
   * ambiguous is ambiguous.
   */
  record(descriptor: string, glCode: string): void {
    this.db
      .prepare(
        `INSERT INTO vendor_exact (descriptor, gl_code, confidence) VALUES (?, ?, 1)
         ON CONFLICT(descriptor) DO UPDATE SET
           confidence = confidence + 1,
           gl_code = excluded.gl_code`,
      )
      .run(descriptor, glCode);

    const stem = vendorStem(descriptor);
    if (stem.length === 0) return;

    const existing = this.db
      .prepare(`SELECT gl_code, conflicted FROM vendor_stem WHERE stem = ?`)
      .get(stem) as { gl_code: string; conflicted: number } | undefined;

    if (existing === undefined) {
      this.db
        .prepare(`INSERT INTO vendor_stem (stem, gl_code, confidence, conflicted) VALUES (?, ?, 1, 0)`)
        .run(stem, glCode);
      return;
    }
    // An optimization, not a safety property, and worth labelling as such.
    // Mutation testing showed removing this line fails no test: without it a
    // conflicted stem is simply re-marked conflicted on the next write, so
    // behaviour is identical. It skips pointless writes to a row that lookup
    // can never return. The safety comes from the conflicted = 0 filter in
    // lookup, which does fail tests when removed.
    if (existing.conflicted === 1) return;

    if (existing.gl_code === glCode) {
      this.db.prepare(`UPDATE vendor_stem SET confidence = confidence + 1 WHERE stem = ?`).run(stem);
    } else {
      // One brand, two accounts. Never trust this stem again.
      this.db.prepare(`UPDATE vendor_stem SET conflicted = 1 WHERE stem = ?`).run(stem);
    }
  }

  /** Exact match first, then an unconflicted stem. Undefined means ask the model. */
  lookup(descriptor: string): VendorMatch | undefined {
    const exact = this.db
      .prepare(`SELECT gl_code, confidence FROM vendor_exact WHERE descriptor = ?`)
      .get(descriptor) as { gl_code: string; confidence: number } | undefined;
    if (exact) return { glCode: exact.gl_code, confidence: exact.confidence, matchedOn: 'exact' };

    const stem = vendorStem(descriptor);
    if (stem.length === 0) return undefined;
    const byStem = this.db
      .prepare(`SELECT gl_code, confidence FROM vendor_stem WHERE stem = ? AND conflicted = 0`)
      .get(stem) as { gl_code: string; confidence: number } | undefined;
    if (byStem) return { glCode: byStem.gl_code, confidence: byStem.confidence, matchedOn: 'stem' };

    return undefined;
  }

  isConflicted(descriptor: string): boolean {
    const row = this.db
      .prepare(`SELECT conflicted FROM vendor_stem WHERE stem = ?`)
      .get(vendorStem(descriptor)) as { conflicted: number } | undefined;
    return row?.conflicted === 1;
  }

  stats(): { exact: number; stems: number; conflicted: number } {
    const one = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      exact: one(`SELECT COUNT(*) AS n FROM vendor_exact`),
      stems: one(`SELECT COUNT(*) AS n FROM vendor_stem WHERE conflicted = 0`),
      conflicted: one(`SELECT COUNT(*) AS n FROM vendor_stem WHERE conflicted = 1`),
    };
  }
}

export interface PrefilterResult<T> {
  /** Resolved from memory. These never reach the model. */
  readonly known: readonly { transaction: T; match: VendorMatch }[];
  /** Not in memory. These are what the model is asked about. */
  readonly unknown: readonly T[];
}

export function prefilter<T extends { vendorDescriptor: string }>(
  memory: VendorMemory,
  transactions: readonly T[],
): PrefilterResult<T> {
  const known: { transaction: T; match: VendorMatch }[] = [];
  const unknown: T[] = [];
  for (const transaction of transactions) {
    const match = memory.lookup(transaction.vendorDescriptor);
    if (match) known.push({ transaction, match });
    else unknown.push(transaction);
  }
  return { known, unknown };
}
