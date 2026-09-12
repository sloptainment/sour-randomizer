/**
 * The whole patcher. SPEC.md §5.2.
 *
 * The browser holds no structural knowledge of the ROM. The extract step knows the whole
 * canonical ROM and the hash proves the upload is that ROM, so the upload is a store and
 * never a source: this file may write a byte only at an address the extract step gave it,
 * and it knows nothing of modes, rules or species.
 */
import { ROM_SIZE, calculateChecksums } from './stadium';

async function sha1(rom: Uint8Array): Promise<string> {
	// the cast is a TS lib wart: Uint8Array<ArrayBufferLike> is not BufferSource, though
	// every Uint8Array that reaches here is backed by a plain ArrayBuffer.
	const digest = await crypto.subtle.digest('SHA-1', rom as unknown as BufferSource);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Returns null if this is the canonical build, or a user-facing reason if it is not.
 * A mismatch is a hard failure, never a warning: the offsets are meaningless against any
 * other build.
 */
export async function romProblem(rom: Uint8Array, expected: string): Promise<string | null> {
	if (rom.length !== ROM_SIZE) {
		return `That file is ${rom.length.toLocaleString()} bytes; the supported build is exactly ${ROM_SIZE.toLocaleString()}.`;
	}
	const hex = await sha1(rom);
	if (hex !== expected) return `That is not the supported build (SHA-1 ${hex}; expected ${expected}).`;
	return null;
}

/** A patched copy of `rom`, with the three derived checksum regions recomputed. */
export function patchRom(rom: Uint8Array, records: Map<number, Uint8Array>): Uint8Array {
	const patched = Uint8Array.from(rom);
	for (const [off, values] of records) patched.set(values, off);
	return calculateChecksums(patched);
}
