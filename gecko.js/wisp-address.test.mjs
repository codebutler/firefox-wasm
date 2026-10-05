import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('native socket address parsing and output bounds', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wisp-address-'));
  try {
    const binary = join(dir, 'test');
    const build = spawnSync(process.env.CXX || 'c++', ['-std=c++17', '-Wall', '-Wextra', '-Werror', '-fsanitize=address,undefined', fileURLToPath(new URL('./wisp-address.test.cpp', import.meta.url)), '-o', binary], { encoding: 'utf8' });
    assert.equal(build.status, 0, build.stderr);
    const run = spawnSync(binary, [], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
