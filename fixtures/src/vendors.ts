/**
 * Vendor data for the ledger generator. Descriptors are deliberately messy —
 * real card processors mangle merchant names, and a fixture that only ever
 * emits clean names (`Notion`, `Google`) teaches nothing about categorization.
 *
 * Two pairs matter most, and both appear here:
 *  - `AMZN Mktp US*<token>` / `AMAZON BUSINESS` — one vendor, two descriptors.
 *    A system keyed on the raw string treats them as strangers.
 *  - `UBER *TRIP` / `UBER *EATS` — one brand, two GL codes. A normalizer that
 *    strips to `UBER` and memorizes one mapping mis-files the other.
 */
import type { Rng } from './rng.js';

export const UBER_TRIP_DESCRIPTOR = 'UBER   *TRIP HELP.UBER.CO';
export const UBER_EATS_DESCRIPTOR = 'UBER   *EATS';

const TOKEN_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A random Amazon-style order token, e.g. "2K4LM9XY3". Varies per charge, same vendor. */
export function randomOrderToken(rng: Rng, length = 9): string {
  let out = '';
  for (let i = 0; i < length; i++) out += TOKEN_CHARS[rng.int(0, TOKEN_CHARS.length - 1)];
  return out;
}

function fixed(descriptor: string): (rng: Rng) => string {
  return () => descriptor;
}

// --- Recurring subscriptions -------------------------------------------

export interface RecurringVendor {
  readonly key: string;
  readonly canonicalName: string;
  readonly glCode: string;
  readonly baseAmountCents: number;
  /** Day of month the bill usually lands. */
  readonly anchorDay: number;
  /** +/- days the actual charge date drifts, month to month. */
  readonly dayJitterDays: number;
  /** +/- fraction of normal usage-based variance (0 for flat-rate seats). */
  readonly amountJitterPct: number;
  readonly descriptor: (rng: Rng) => string;
}

export const RECURRING_VENDORS: readonly RecurringVendor[] = [
  { key: 'notion', canonicalName: 'Notion', glCode: '6010', baseAmountCents: 9600, anchorDay: 14, dayJitterDays: 1, amountJitterPct: 0, descriptor: fixed('PAYPAL *NOTIONLABS') },
  { key: 'workspace', canonicalName: 'Google Workspace', glCode: '6010', baseAmountCents: 14400, anchorDay: 3, dayJitterDays: 1, amountJitterPct: 0, descriptor: fixed('GOOGLE *WORKSPACE') },
  { key: 'gcp', canonicalName: 'Google Cloud', glCode: '5010', baseAmountCents: 82000, anchorDay: 5, dayJitterDays: 1, amountJitterPct: 0.08, descriptor: (rng) => `GOOGLE *CLOUD ${rng.int(1000000, 9999999)}` },
  { key: 'slack', canonicalName: 'Slack', glCode: '6010', baseAmountCents: 8800, anchorDay: 20, dayJitterDays: 1, amountJitterPct: 0.03, descriptor: fixed('SLACK   T02X4M9K1 SF') },
  { key: 'figma', canonicalName: 'Figma', glCode: '6010', baseAmountCents: 4500, anchorDay: 8, dayJitterDays: 1, amountJitterPct: 0, descriptor: fixed('FIGMA INC') },
  { key: 'zoom', canonicalName: 'Zoom', glCode: '6010', baseAmountCents: 6499, anchorDay: 11, dayJitterDays: 1, amountJitterPct: 0, descriptor: fixed('ZOOM.US SAN JOSE CA') },
  { key: 'aws', canonicalName: 'AWS', glCode: '5010', baseAmountCents: 156000, anchorDay: 2, dayJitterDays: 2, amountJitterPct: 0.10, descriptor: fixed('AWS  AMAZON WEB SERVICES') },
  { key: 'github', canonicalName: 'GitHub', glCode: '6010', baseAmountCents: 8400, anchorDay: 17, dayJitterDays: 1, amountJitterPct: 0.02, descriptor: fixed('GITHUB, INC.') },
  { key: 'linear', canonicalName: 'Linear', glCode: '6010', baseAmountCents: 9600, anchorDay: 9, dayJitterDays: 1, amountJitterPct: 0, descriptor: fixed('LINEAR ORBIT INC') },
  { key: 'wework', canonicalName: 'WeWork', glCode: '6040', baseAmountCents: 120000, anchorDay: 1, dayJitterDays: 1, amountJitterPct: 0.05, descriptor: fixed('WEWORK 1234 5TH AVE') },
  { key: 'datadog', canonicalName: 'Datadog', glCode: '5010', baseAmountCents: 34000, anchorDay: 6, dayJitterDays: 1, amountJitterPct: 0.06, descriptor: fixed('DATADOG INC') },
  { key: 'carta', canonicalName: 'Carta', glCode: '6050', baseAmountCents: 50000, anchorDay: 25, dayJitterDays: 1, amountJitterPct: 0, descriptor: fixed('CARTA INC') },
  { key: 'gusto', canonicalName: 'Gusto', glCode: '6050', baseAmountCents: 24000, anchorDay: 28, dayJitterDays: 1, amountJitterPct: 0, descriptor: fixed('GUSTO') },
  { key: 'linkedin-ads', canonicalName: 'LinkedIn Ads', glCode: '6060', baseAmountCents: 60000, anchorDay: 12, dayJitterDays: 2, amountJitterPct: 0.12, descriptor: fixed('LINKEDIN ADS') },
  { key: 'verizon', canonicalName: 'Verizon Wireless', glCode: '6080', baseAmountCents: 31000, anchorDay: 22, dayJitterDays: 1, amountJitterPct: 0, descriptor: fixed('VERIZON WIRELESS') },
];

/** Stop billing in the close month (June) — the "missing recurring" defect. */
export const MISSING_RECURRING_KEYS: ReadonlySet<string> = new Set(['linear', 'zoom', 'carta', 'verizon', 'datadog']);

/** Jump 40-80% in the close month — the "price anomaly" defect. */
export const PRICE_ANOMALY_KEYS: ReadonlySet<string> = new Set(['gcp', 'aws', 'linkedin-ads', 'slack', 'github', 'wework']);

// --- Vendor-alias groups: one entity, multiple descriptors --------------

export interface AliasVendorGroup {
  readonly key: string;
  readonly canonicalName: string;
  readonly glCode: string;
  readonly descriptors: readonly ((rng: Rng) => string)[];
  readonly amountRangeCents: readonly [number, number];
  readonly occurrences: number;
}

export const ALIAS_VENDOR_GROUPS: readonly AliasVendorGroup[] = [
  {
    key: 'amazon',
    canonicalName: 'Amazon',
    glCode: '6040',
    descriptors: [
      (rng) => `AMZN Mktp US*${randomOrderToken(rng)}`,
      (rng) => `AMZN Mktp US*${randomOrderToken(rng)}`,
      fixed('AMAZON BUSINESS'),
    ],
    amountRangeCents: [1899, 18999],
    occurrences: 5,
  },
  {
    key: 'blue-bottle',
    canonicalName: 'Blue Bottle Coffee',
    glCode: '6030',
    descriptors: [fixed('SQ *BLUE BOTTLE COFFE'), fixed('BLUE BOTTLE COFFEE')],
    amountRangeCents: [425, 875],
    occurrences: 3,
  },
];

// --- Long-tail one-off vendors, grouped loosely by category --------------

export interface LongTailVendor {
  readonly descriptor: (rng: Rng) => string;
  readonly glCode: string;
  readonly amountRangeCents: readonly [number, number];
}

export const LONG_TAIL_VENDORS: readonly LongTailVendor[] = [
  // Travel (6020)
  { descriptor: fixed('DELTA AIR 0062134489217'), glCode: '6020', amountRangeCents: [18900, 89000] },
  { descriptor: fixed('UNITED AIRLINES 0162239981'), glCode: '6020', amountRangeCents: [17900, 85000] },
  { descriptor: fixed('MARRIOTT HOTELS'), glCode: '6020', amountRangeCents: [21900, 68000] },
  { descriptor: fixed('HILTON HOTELS'), glCode: '6020', amountRangeCents: [19900, 61000] },
  { descriptor: fixed('AVIS RENT A CAR'), glCode: '6020', amountRangeCents: [8900, 24000] },
  { descriptor: fixed('LYFT   *RIDE'), glCode: '6020', amountRangeCents: [1200, 5800] },
  { descriptor: fixed(UBER_TRIP_DESCRIPTOR), glCode: '6020', amountRangeCents: [1400, 6200] },
  { descriptor: fixed('AMTRAK TRAINS'), glCode: '6020', amountRangeCents: [7900, 26000] },
  { descriptor: fixed('PARKWHIZ PARKING'), glCode: '6020', amountRangeCents: [1500, 4200] },
  // Meals (6030)
  { descriptor: fixed(UBER_EATS_DESCRIPTOR), glCode: '6030', amountRangeCents: [1800, 5600] },
  { descriptor: fixed('DOORDASH*RESTAURANT'), glCode: '6030', amountRangeCents: [1600, 5200] },
  { descriptor: fixed('SWEETGREEN #442'), glCode: '6030', amountRangeCents: [1200, 2400] },
  { descriptor: fixed('SQ *TARTINE BAKERY'), glCode: '6030', amountRangeCents: [850, 2600] },
  { descriptor: fixed('STARBUCKS #08123'), glCode: '6030', amountRangeCents: [450, 1200] },
  { descriptor: fixed('CHIPOTLE 2871'), glCode: '6030', amountRangeCents: [950, 1800] },
  { descriptor: fixed('SQ *TEAM DINNER EVENT'), glCode: '6030', amountRangeCents: [4500, 9800] },
  // Office Supplies (6040)
  { descriptor: fixed('STAPLES STORE #1423'), glCode: '6040', amountRangeCents: [1899, 24000] },
  { descriptor: fixed('OFFICE DEPOT #2210'), glCode: '6040', amountRangeCents: [1599, 18000] },
  { descriptor: fixed('COSTCO WHSE #445'), glCode: '6040', amountRangeCents: [4200, 32000] },
  // Professional Services (6050)
  { descriptor: fixed('CLERKY LEGAL DOCS'), glCode: '6050', amountRangeCents: [9900, 45000] },
  { descriptor: fixed('STRIPE ATLAS'), glCode: '6050', amountRangeCents: [50000, 50000] },
  { descriptor: fixed('UPWORK CONTRACTOR PMT'), glCode: '6050', amountRangeCents: [25000, 68000] },
  // Marketing (6060)
  { descriptor: fixed('FACEBOOK ADS'), glCode: '6060', amountRangeCents: [8000, 45000] },
  { descriptor: fixed('GOOGLE ADS-4471829'), glCode: '6060', amountRangeCents: [8000, 45000] },
  { descriptor: fixed('CANVA PRO'), glCode: '6060', amountRangeCents: [1299, 1299] },
  { descriptor: fixed('MAILCHIMP*EMAIL'), glCode: '6060', amountRangeCents: [2000, 9900] },
  // Equipment (6070)
  { descriptor: fixed('APPLE STORE R234'), glCode: '6070', amountRangeCents: [49900, 189900] },
  { descriptor: fixed('B&H PHOTO VIDEO'), glCode: '6070', amountRangeCents: [12900, 89900] },
  { descriptor: fixed('DELL BUSINESS SALES'), glCode: '6070', amountRangeCents: [89900, 189900] },
  { descriptor: fixed('LOGITECH.COM'), glCode: '6070', amountRangeCents: [4900, 24900] },
  // Telecom (6080)
  { descriptor: fixed('TWILIO INC'), glCode: '6080', amountRangeCents: [3200, 12000] },
  { descriptor: fixed('T-MOBILE*AUTOPAY'), glCode: '6080', amountRangeCents: [8500, 8500] },
  // Insurance (6090)
  { descriptor: fixed('NEXT INSURANCE'), glCode: '6090', amountRangeCents: [24000, 24000] },
  { descriptor: fixed('HISCOX SMALL BIZ'), glCode: '6090', amountRangeCents: [18000, 18000] },
  // Training (6100)
  { descriptor: fixed('UDEMY BUSINESS'), glCode: '6100', amountRangeCents: [3900, 3900] },
  { descriptor: fixed('COURSERA FOR BUSINESS'), glCode: '6100', amountRangeCents: [5900, 5900] },
  { descriptor: fixed('CONF REG - STRANGE LOOP'), glCode: '6100', amountRangeCents: [59900, 59900] },
];

/** Genuinely ambiguous descriptors — the correct answer is the escape hatch itself. */
export const AMBIGUOUS_VENDORS: readonly LongTailVendor[] = [
  { descriptor: fixed('SQUARE UP*MISC SVC'), glCode: '6900', amountRangeCents: [1500, 12000] },
  { descriptor: fixed('PAYMENT PROCESSING FEE'), glCode: '6900', amountRangeCents: [500, 4000] },
  { descriptor: fixed('VENDOR SVCS LLC'), glCode: '6900', amountRangeCents: [2000, 30000] },
  { descriptor: fixed('MISC CHARGE 88213'), glCode: '6900', amountRangeCents: [1000, 9000] },
  { descriptor: fixed('SETTLEMENT ADJ'), glCode: '6900', amountRangeCents: [500, 5000] },
];

// --- EUR travel-burst vendors: every one is a planted FX mismatch --------

export interface EurVendor {
  readonly descriptor: (rng: Rng) => string;
  readonly glCode: string;
  readonly originalAmountRangeCents: readonly [number, number];
}

export const EUR_TRAVEL_VENDORS: readonly EurVendor[] = [
  { descriptor: fixed('TRAINLINE EUROPE'), glCode: '6020', originalAmountRangeCents: [4500, 12000] },
  { descriptor: fixed('HOTEL LUTETIA PARIS'), glCode: '6020', originalAmountRangeCents: [58000, 92000] },
  { descriptor: fixed('DEUTSCHE BAHN'), glCode: '6020', originalAmountRangeCents: [3200, 9800] },
  { descriptor: fixed('CAFE DE FLORE PARIS'), glCode: '6030', originalAmountRangeCents: [1800, 4200] },
  { descriptor: fixed('TAXI G7 PARIS'), glCode: '6020', originalAmountRangeCents: [1200, 3800] },
  { descriptor: fixed(UBER_TRIP_DESCRIPTOR), glCode: '6020', originalAmountRangeCents: [1400, 3200] },
  { descriptor: fixed('AWS EU-WEST-1'), glCode: '5010', originalAmountRangeCents: [12000, 28000] },
];

/** Nominal USD-per-EUR rate posted for the whole Paris burst window. */
export const EUR_FX_RATE = 1.086;

// --- Explicit defect seeds -------------------------------------------
// Planted as fixed values rather than sampled from ranges so the target
// defect count is guaranteed regardless of seed, not merely probable.

export interface DuplicateSeed {
  readonly slug: string;
  readonly descriptor: string;
  readonly glCode: string;
  readonly amountRangeCents: readonly [number, number];
}

export const DUPLICATE_SEEDS: readonly DuplicateSeed[] = [
  { slug: 'staples', descriptor: 'STAPLES STORE #1423', glCode: '6040', amountRangeCents: [4200, 12000] },
  { slug: 'tartine', descriptor: 'SQ *TARTINE BAKERY', glCode: '6030', amountRangeCents: [1200, 2600] },
  { slug: 'apple', descriptor: 'APPLE STORE R234', glCode: '6070', amountRangeCents: [29900, 79900] },
  { slug: 'facebook-ads', descriptor: 'FACEBOOK ADS', glCode: '6060', amountRangeCents: [12000, 32000] },
  { slug: 'twilio', descriptor: 'TWILIO INC', glCode: '6080', amountRangeCents: [3200, 9800] },
];

export interface PolicyViolationSeed {
  readonly descriptor: string;
  readonly glCode: string;
  readonly amountCents: number;
  readonly rule: string;
}

/** Every amount here is confirmed to exceed its rule's threshold (fixtures/data/policy-rules.json). */
export const POLICY_VIOLATION_SEEDS: readonly PolicyViolationSeed[] = [
  { descriptor: 'DELL BUSINESS SALES', glCode: '6070', amountCents: 249900, rule: 'equipment-limit' },
  { descriptor: 'APPLE STORE R234', glCode: '6070', amountCents: 329900, rule: 'equipment-limit' },
  { descriptor: 'B&H PHOTO VIDEO', glCode: '6070', amountCents: 219900, rule: 'equipment-limit' },
  { descriptor: 'MARRIOTT HOTELS', glCode: '6020', amountCents: 92500, rule: 'single-txn-limit' },
  { descriptor: 'UPWORK CONTRACTOR PMT', glCode: '6050', amountCents: 145000, rule: 'single-txn-limit' },
  { descriptor: 'CLERKY LEGAL DOCS', glCode: '6050', amountCents: 89000, rule: 'single-txn-limit' },
  { descriptor: 'FACEBOOK ADS', glCode: '6060', amountCents: 82000, rule: 'single-txn-limit' },
  { descriptor: 'GOOGLE ADS-4471829', glCode: '6060', amountCents: 91000, rule: 'single-txn-limit' },
  { descriptor: 'SQ *TEAM DINNER EVENT', glCode: '6030', amountCents: 18400, rule: 'meals-daily-limit' },
  { descriptor: 'SQ *TEAM DINNER EVENT', glCode: '6030', amountCents: 21200, rule: 'meals-daily-limit' },
];

/** Same shape as a violation, but written to the approvals list — the contrast case. */
export const APPROVED_LARGE_SPEND_SEEDS: readonly PolicyViolationSeed[] = [
  { descriptor: 'DELL BUSINESS SALES', glCode: '6070', amountCents: 259900, rule: 'equipment-limit' },
  { descriptor: 'MARRIOTT HOTELS', glCode: '6020', amountCents: 88000, rule: 'single-txn-limit' },
  { descriptor: 'UPWORK CONTRACTOR PMT', glCode: '6050', amountCents: 160000, rule: 'single-txn-limit' },
];

export interface ReceiptMismatchSeed {
  readonly descriptor: string;
  readonly glCode: string;
  readonly amountCents: number;
  readonly receiptTotalCents: number;
}

export const RECEIPT_MISMATCH_SEEDS: readonly ReceiptMismatchSeed[] = [
  { descriptor: 'MARRIOTT HOTELS', glCode: '6020', amountCents: 68000, receiptTotalCents: 71200 },
  { descriptor: 'HILTON HOTELS', glCode: '6020', amountCents: 61000, receiptTotalCents: 58400 },
  { descriptor: 'B&H PHOTO VIDEO', glCode: '6070', amountCents: 89900, receiptTotalCents: 84900 },
  { descriptor: 'STAPLES STORE #1423', glCode: '6040', amountCents: 12400, receiptTotalCents: 10900 },
  { descriptor: 'SWEETGREEN #442', glCode: '6030', amountCents: 1850, receiptTotalCents: 1400 },
  { descriptor: 'AVIS RENT A CAR', glCode: '6020', amountCents: 18900, receiptTotalCents: 21200 },
  { descriptor: 'CLERKY LEGAL DOCS', glCode: '6050', amountCents: 24000, receiptTotalCents: 22500 },
  { descriptor: 'DELL BUSINESS SALES', glCode: '6070', amountCents: 129900, receiptTotalCents: 134900 },
  { descriptor: 'OFFICE DEPOT #2210', glCode: '6040', amountCents: 8900, receiptTotalCents: 7600 },
];

// --- Domestic travel bursts: clustered dates, no defects, just grouping work ---

export interface BurstLineItem {
  readonly day: number;
  readonly descriptor: string;
  readonly glCode: string;
  readonly amountCents: number;
}

export const NYC_CLIENT_VISIT_BURST: readonly BurstLineItem[] = [
  { day: 2, descriptor: 'DELTA AIR 0062134489217', glCode: '6020', amountCents: 41200 },
  { day: 2, descriptor: 'HILTON HOTELS', glCode: '6020', amountCents: 52800 },
  { day: 2, descriptor: 'LYFT   *RIDE', glCode: '6020', amountCents: 3400 },
  { day: 3, descriptor: 'SWEETGREEN #442', glCode: '6030', amountCents: 1650 },
  { day: 3, descriptor: 'STARBUCKS #08123', glCode: '6030', amountCents: 680 },
  { day: 3, descriptor: 'WEWORK 1234 5TH AVE', glCode: '6040', amountCents: 4500 },
  { day: 4, descriptor: 'LYFT   *RIDE', glCode: '6020', amountCents: 2900 },
  { day: 4, descriptor: 'HILTON HOTELS', glCode: '6020', amountCents: 52800 },
];

export const AUSTIN_CONFERENCE_BURST: readonly BurstLineItem[] = [
  { day: 22, descriptor: 'UNITED AIRLINES 0162239981', glCode: '6020', amountCents: 38900 },
  { day: 22, descriptor: 'MARRIOTT HOTELS', glCode: '6020', amountCents: 48900 },
  { day: 22, descriptor: 'CONF REG - STRANGE LOOP', glCode: '6100', amountCents: 59900 },
  { day: 23, descriptor: 'LYFT   *RIDE', glCode: '6020', amountCents: 1850 },
  { day: 23, descriptor: 'CHIPOTLE 2871', glCode: '6030', amountCents: 1420 },
  { day: 24, descriptor: 'STARBUCKS #08123', glCode: '6030', amountCents: 590 },
  { day: 24, descriptor: 'MARRIOTT HOTELS', glCode: '6020', amountCents: 48900 },
];
