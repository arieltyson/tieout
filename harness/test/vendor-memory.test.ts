import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { VendorMemory, prefilter, vendorStem } from '../src/memory/vendor-memory.js';

let memory: VendorMemory;

beforeEach(() => {
  memory = new VendorMemory(':memory:');
});

afterEach(() => {
  memory.close();
});

describe('vendorStem', () => {
  test('drops the order token that changes on every charge', () => {
    expect(vendorStem('GOOGLE *CLOUD 4471829')).toBe(vendorStem('GOOGLE *CLOUD 8199486'));
  });

  test('drops Amazon marketplace tokens', () => {
    expect(vendorStem('AMZN Mktp US*2K4LM9XY3')).toBe(vendorStem('AMZN Mktp US*BNXKKC8AV'));
  });

  test('keeps genuinely different merchants apart', () => {
    expect(vendorStem('GOOGLE *CLOUD 1')).not.toBe(vendorStem('GOOGLE *WORKSPACE'));
  });

  // The stem is intentionally blunt, and this is the case that proves it.
  // UBER TRIP and UBER EATS do NOT collapse, but if a future stem change
  // made them collapse, the conflict check below is what keeps the memory
  // correct rather than this function.
  test('is aggressive enough to be dangerous on its own', () => {
    expect(vendorStem('STAPLES STORE #1423')).toBe(vendorStem('STAPLES STORE #9999'));
  });
});

describe('exact matching', () => {
  test('an unseen descriptor is unknown', () => {
    expect(memory.lookup('NOTION LABS INC')).toBeUndefined();
  });

  test('a recorded descriptor is returned', () => {
    memory.record('NOTION LABS INC', '6010');
    expect(memory.lookup('NOTION LABS INC')).toMatchObject({ glCode: '6010', matchedOn: 'exact' });
  });

  test('confidence climbs with repetition', () => {
    memory.record('FIGMA INC', '6010');
    memory.record('FIGMA INC', '6010');
    memory.record('FIGMA INC', '6010');
    expect(memory.lookup('FIGMA INC')?.confidence).toBe(3);
  });

  test('a later correction overrides an earlier answer', () => {
    memory.record('CANVA PRO', '6010');
    memory.record('CANVA PRO', '6060');
    expect(memory.lookup('CANVA PRO')?.glCode).toBe('6060');
  });
});

describe('stem matching, the part that earns its keep', () => {
  test('a merchant whose suffix changes is still recognised', () => {
    // The whole reason stems exist. This descriptor never repeats exactly.
    memory.record('GOOGLE *CLOUD 4471829', '5010');
    const match = memory.lookup('GOOGLE *CLOUD 9999999');
    expect(match).toMatchObject({ glCode: '5010', matchedOn: 'stem' });
  });

  test('exact matches win over stem matches', () => {
    memory.record('AMZN Mktp US*AAAA', '6040');
    memory.record('AMZN Mktp US*BBBB', '6070');
    expect(memory.lookup('AMZN Mktp US*BBBB')?.matchedOn).toBe('exact');
    expect(memory.lookup('AMZN Mktp US*BBBB')?.glCode).toBe('6070');
  });
});

describe('the conflict check, which is what makes generalizing safe', () => {
  test('a stem with disagreeing evidence is never used again', () => {
    // Same stem, differing only in the numeric token.
    memory.record('SOMEBRAND STORE #1', '6020');
    expect(memory.lookup('SOMEBRAND STORE #7')).toMatchObject({ matchedOn: 'stem' });

    memory.record('SOMEBRAND STORE #2', '6030');
    expect(memory.isConflicted('SOMEBRAND STORE #9')).toBe(true);
    expect(memory.lookup('SOMEBRAND STORE #9')).toBeUndefined();
  });

  test('an exact match still works after its stem is conflicted', () => {
    memory.record('STAPLES STORE #1', '6040');
    memory.record('STAPLES STORE #2', '6070');
    expect(memory.isConflicted('STAPLES STORE #1')).toBe(true);
    // The stem is poisoned, but what we saw directly is still known.
    expect(memory.lookup('STAPLES STORE #1')).toMatchObject({
      glCode: '6040',
      matchedOn: 'exact',
    });
  });

  test('later agreement does not rehabilitate a conflicted stem', () => {
    memory.record('BRAND CO 1', '6020');
    memory.record('BRAND CO 2', '6030');
    memory.record('BRAND CO 3', '6020');
    memory.record('BRAND CO 4', '6020');
    // Once ambiguous, always ambiguous. Two accounts have genuinely used
    // this stem and no amount of agreement afterwards changes that.
    expect(memory.isConflicted('BRAND CO 5')).toBe(true);
    expect(memory.lookup('BRAND CO 5')).toBeUndefined();
  });

  test('the Uber trap: one brand, two accounts, no wrong answer', () => {
    memory.record('UBER   *TRIP HELP.UBER.CO', '6020');
    memory.record('UBER   *EATS', '6030');

    // Whatever the stems do, neither descriptor may be answered wrongly.
    expect(memory.lookup('UBER   *TRIP HELP.UBER.CO')?.glCode).toBe('6020');
    expect(memory.lookup('UBER   *EATS')?.glCode).toBe('6030');

    const unseen = memory.lookup('UBER   *SOMETHING NEW');
    if (unseen !== undefined) {
      throw new Error(
        `An unseen Uber descriptor resolved to ${unseen.glCode} on a ${unseen.matchedOn} match. `
          + 'Guessing here is exactly the failure the conflict check exists to prevent.',
      );
    }
  });
});

describe('prefilter', () => {
  const txn = (vendorDescriptor: string) => ({ id: vendorDescriptor, vendorDescriptor });

  test('splits transactions into known and unknown', () => {
    memory.record('FIGMA INC', '6010');
    const result = prefilter(memory, [txn('FIGMA INC'), txn('BRAND NEW VENDOR')]);
    expect(result.known).toHaveLength(1);
    expect(result.unknown).toHaveLength(1);
    expect(result.known[0]!.match.glCode).toBe('6010');
  });

  test('an empty memory sends everything to the model', () => {
    const result = prefilter(memory, [txn('A'), txn('B'), txn('C')]);
    expect(result.known).toEqual([]);
    expect(result.unknown).toHaveLength(3);
  });

  test('every transaction lands in exactly one bucket', () => {
    memory.record('FIGMA INC', '6010');
    const input = [txn('FIGMA INC'), txn('OTHER'), txn('THIRD')];
    const result = prefilter(memory, input);
    expect(result.known.length + result.unknown.length).toBe(input.length);
  });
});

describe('stats', () => {
  test('counts what it has learned and what it has given up on', () => {
    memory.record('ALPHA CO', '6010');
    memory.record('BETA CO', '6020');
    memory.record('BETA CO', '6030');
    const s = memory.stats();
    expect(s.exact).toBe(2);
    expect(s.conflicted).toBe(1);
  });
});
