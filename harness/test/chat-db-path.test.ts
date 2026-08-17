import { describe, expect, test } from 'vitest';
import {
  REAL_CHATDB_OPT_IN,
  RealChatDbRefused,
  isInsideRealMessagesDirectory,
  realMessagesDirectory,
  resolveChatDbPath,
} from '../src/transport/chat-db-path.js';

const HOME = '/Users/testuser';
const REAL = `${HOME}/Library/Messages/chat.db`;
const FIXTURE = '/tmp/tieout/fixtures/chat.db';

describe('the real Messages directory is recognised', () => {
  test('identifies the database itself', () => {
    expect(isInsideRealMessagesDirectory(REAL, HOME)).toBe(true);
  });

  test('identifies the directory', () => {
    expect(isInsideRealMessagesDirectory(realMessagesDirectory(HOME), HOME)).toBe(true);
  });

  test('identifies sidecar files that carry the same content', () => {
    // -wal and -shm hold un-checkpointed message data. Guarding only
    // chat.db would leave the actual bytes readable.
    expect(isInsideRealMessagesDirectory(`${REAL}-wal`, HOME)).toBe(true);
    expect(isInsideRealMessagesDirectory(`${REAL}-shm`, HOME)).toBe(true);
    expect(isInsideRealMessagesDirectory(`${HOME}/Library/Messages/Attachments/a.jpg`, HOME)).toBe(true);
  });

  test('sees through a relative traversal', () => {
    expect(
      isInsideRealMessagesDirectory(`${HOME}/Documents/../Library/Messages/chat.db`, HOME),
    ).toBe(true);
  });

  test('does not flag an unrelated path that merely looks similar', () => {
    expect(isInsideRealMessagesDirectory(`${HOME}/Library/MessagesBackup/chat.db`, HOME)).toBe(false);
    expect(isInsideRealMessagesDirectory(FIXTURE, HOME)).toBe(false);
  });
});

describe('resolveChatDbPath', () => {
  test('defaults to the fixture when nothing is requested', () => {
    expect(resolveChatDbPath({ fixturePath: FIXTURE, env: {}, home: HOME })).toBe(FIXTURE);
  });

  test('defaults to the fixture for an empty or whitespace request', () => {
    expect(resolveChatDbPath({ requested: '', fixturePath: FIXTURE, env: {}, home: HOME })).toBe(FIXTURE);
    expect(resolveChatDbPath({ requested: '   ', fixturePath: FIXTURE, env: {}, home: HOME })).toBe(FIXTURE);
  });

  test('allows an arbitrary path outside the Messages directory', () => {
    const other = '/tmp/some-other.db';
    expect(resolveChatDbPath({ requested: other, fixturePath: FIXTURE, env: {}, home: HOME })).toBe(other);
  });

  test('REFUSES the real database without the opt-in', () => {
    expect(() =>
      resolveChatDbPath({ requested: REAL, fixturePath: FIXTURE, env: {}, home: HOME }),
    ).toThrow(RealChatDbRefused);
  });

  test('refuses the -wal sidecar too', () => {
    expect(() =>
      resolveChatDbPath({ requested: `${REAL}-wal`, fixturePath: FIXTURE, env: {}, home: HOME }),
    ).toThrow(RealChatDbRefused);
  });

  test('refuses a traversal that lands inside Messages', () => {
    expect(() =>
      resolveChatDbPath({
        requested: `${HOME}/Documents/../Library/Messages/chat.db`,
        fixturePath: FIXTURE,
        env: {},
        home: HOME,
      }),
    ).toThrow(RealChatDbRefused);
  });

  test('the refusal explains how to opt in, so it is not a dead end', () => {
    try {
      resolveChatDbPath({ requested: REAL, fixturePath: FIXTURE, env: {}, home: HOME });
      throw new Error('should have refused');
    } catch (err) {
      expect(err).toBeInstanceOf(RealChatDbRefused);
      expect((err as Error).message).toContain(REAL_CHATDB_OPT_IN);
    }
  });

  test('allows the real database ONLY with the explicit opt-in', () => {
    const env = { [REAL_CHATDB_OPT_IN]: '1' };
    expect(resolveChatDbPath({ requested: REAL, fixturePath: FIXTURE, env, home: HOME })).toBe(REAL);
  });

  // The opt-in is compared against exactly "1". Treating any non-empty
  // value as consent means TIEOUT_ALLOW_REAL_CHATDB=0 reads as yes.
  test.each(['0', 'false', 'no', 'true', 'yes', ''])(
    'does not treat %o as consent',
    (value) => {
      expect(() =>
        resolveChatDbPath({
          requested: REAL,
          fixturePath: FIXTURE,
          env: { [REAL_CHATDB_OPT_IN]: value },
          home: HOME,
        }),
      ).toThrow(RealChatDbRefused);
    },
  );
});
