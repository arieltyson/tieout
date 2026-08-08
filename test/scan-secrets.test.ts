/**
 * Exercises scripts/scan-secrets.sh against an isolated throwaway git repo
 * (never against this repo's own staging area) so the test can freely stage
 * fake secrets without risking a real commit.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const SCANNER = join(process.cwd(), 'scripts', 'scan-secrets.sh');

let repoDir: string;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' });
}

function stageFile(name: string, content: string): void {
  writeFileSync(join(repoDir, name), content);
  git('add', name);
}

function runScanner(): number {
  try {
    execFileSync(SCANNER, { cwd: repoDir, stdio: 'pipe' });
    return 0;
  } catch (err) {
    const status = (err as { status?: number }).status;
    return status ?? 1;
  }
}

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), 'scan-secrets-test-'));
  git('init', '-q');
  // Built from parts, not a literal — see note above the describe block.
  git('config', 'user.email', 'test' + '@example.com');
  git('config', 'user.name', 'test');
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

// Trigger strings below are assembled from separate string-literal pieces
// rather than written as one contiguous literal. This file's own source
// gets scanned by the real pre-commit hook when it's committed to THIS
// repo, and a phone-number-shaped literal written out in full would trip
// the exact scanner this file is testing. The concatenation only resolves
// to the trigger shape at runtime, inside the throwaway temp repo.
describe('scan-secrets.sh', () => {
  test('blocks a staged E.164 phone number', () => {
    const phone = '+1604' + '5551234';
    stageFile('leak.txt', `call me at ${phone} sometime\n`);
    expect(runScanner()).toBe(1);
  });

  test('blocks a staged dashed phone number', () => {
    const phone = '604-555' + '-1234';
    stageFile('leak.txt', `call me at ${phone} sometime\n`);
    expect(runScanner()).toBe(1);
  });

  test('blocks a staged email address', () => {
    const email = 'ariel' + '@example.com';
    stageFile('leak.txt', `contact ${email} for details\n`);
    expect(runScanner()).toBe(1);
  });

  test('blocks a staged Anthropic API key', () => {
    const key = 'sk-ant-' + 'abc123XYZ';
    stageFile('leak.txt', `ANTHROPIC_API_KEY=${key}\n`);
    expect(runScanner()).toBe(1);
  });

  test('allows the 555 placeholder in .env.example', () => {
    stageFile('.env.example', 'TIEOUT_ALLOWLIST=+15555550100\n');
    expect(runScanner()).toBe(0);
  });

  test('allows a commit with no secret patterns', () => {
    stageFile('README.md', '# Hello world\n');
    expect(runScanner()).toBe(0);
  });

  test('allows an empty staging area', () => {
    expect(runScanner()).toBe(0);
  });
});
