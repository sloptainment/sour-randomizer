import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import test from 'node:test';
import { ROM_SIZE, calculateChecksums } from './stadium';

// The port self-check (SPEC.md §3.3): recomputing the checksums over the *unmodified*
// canonical ROM must reproduce it byte for byte. Validates the port against a real
// build without patching anything.
const CANONICAL = `${process.env.SC_BUILD_ROOT ?? `${homedir()}/var`}/sourcrystal/artifact/sourcrystal_debug.gbc`;

test('recomputing over the canonical ROM reproduces it byte for byte', (t) => {
  let canonical: Uint8Array;
  try {
    canonical = readFileSync(CANONICAL);
  } catch {
    return t.skip(`no canonical build at ${CANONICAL}`);
  }
  assert.equal(canonical.length, ROM_SIZE);
  const recomputed = calculateChecksums(Uint8Array.from(canonical));
  const differing = canonical.reduce((n, b, i) => n + (b === recomputed[i] ? 0 : 1), 0);
  assert.equal(differing, 0, `${differing} bytes differ — the port is wrong`);
});
