/**
 * Money as integer minor units (cents). $12.34 is Cents(1234), never a
 * float. Floating-point dollars is the single most common bug in amateur
 * fintech code — every sum, FX conversion, and balance check in this system
 * runs through this type so that class of bug is structurally impossible
 * rather than something to remember to avoid.
 */
import { z } from 'zod';

export type Cents = number & { readonly __brand: 'Cents' };

export function cents(n: number): Cents {
  if (!Number.isInteger(n)) {
    throw new Error(`Non-integer cents: ${n}`);
  }
  return n as Cents;
}

/**
 * The ONLY sanctioned way to get a `Cents` out of parsed JSON.
 *
 * Reasserting the brand with `value as unknown as Cents` after validating
 * elsewhere works right up until someone reuses the cast on a schema that
 * forgot `.int()` — and `Cents` is the single mechanism standing between
 * this system and a floating-point money bug, so that guarantee must not be
 * something a loader can quietly opt out of. Validating and branding in one
 * expression means the integer check cannot be separated from the brand.
 *
 * Use `PositiveCentsSchema` for amounts that must also be non-zero.
 */
export const CentsSchema = z.number().int().transform(cents);

export const PositiveCentsSchema = z.number().int().positive().transform(cents);

const DECIMAL_PATTERN = /^(-?)(\d+)(?:\.(\d{1,2}))?$/;

/**
 * Parses a decimal string ("12.34", "12", "-0.05") into Cents. Parsing is
 * done on the string directly — never via `parseFloat` — so no binary
 * floating-point rounding is ever introduced.
 */
export function fromDecimal(s: string): Cents {
  const match = DECIMAL_PATTERN.exec(s.trim());
  if (!match) {
    throw new Error(`Cannot parse as currency: ${JSON.stringify(s)}`);
  }
  const [, sign, whole, frac = ''] = match;
  const magnitude = Number(whole + frac.padEnd(2, '0'));
  const value = sign === '-' ? -magnitude : magnitude;
  // Normalize -0 (e.g. from "-0.00") to 0 — a negative-zero amount would
  // otherwise display as "-$0.00".
  return cents(value === 0 ? 0 : value);
}

/** Formats Cents back to a display string, e.g. Cents(1234) -> "$12.34". */
export function toDisplay(c: Cents): string {
  const negative = c < 0;
  const abs = Math.abs(c);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  return `${negative ? '-' : ''}$${whole}.${frac}`;
}

export function sum(xs: readonly Cents[]): Cents {
  return cents(xs.reduce((a: number, b: Cents) => a + b, 0));
}
