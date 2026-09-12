/**
 * Verbatim port of calculate_checksums() from tools/stadium.c (non-european variant —
 * Sour Crystal builds base10). SPEC.md §3.3. Every build ends with `tools/stadium`, so
 * patching any species byte invalidates all three derived regions.
 *
 * The four steps are order-dependent: the bank-match bits, the base block's own CRC, the
 * half-bank checksums and their CRC, and only then the global checksum — which sums the
 * bytes the earlier steps just wrote.
 */
export const ROM_SIZE = 0x200000;
const BANK_SIZE = 0x4000;
const NUM_BANKS = 128;
const GLOBAL_OFF = 0x014e;
const N64PS3_OFF = ROM_SIZE - (8 + NUM_BANKS * 2 * 2); // 0x1FFDF8
const BASE_OFF = N64PS3_OFF - (8 + NUM_BANKS / 8); // 0x1FFDE0
const CRC_POLY = 0xc387;
const CRC_INIT = 0xfefe;
const CRC_INIT_BASE = 0xacde;

/** The 128 stock Crystal bank CRCs the base block's match bits are compared against. */
// prettier-ignore
const BASE0_CRCS = [
  0x9650, 0x8039, 0x2D8F, 0xD75A, 0xAC50, 0x5D55, 0xE94B, 0x9886,
  0x2A46, 0xB5AC, 0xC3D3, 0x79C4, 0xCE55, 0xA95E, 0xEF78, 0x9B50,
  0x82BA, 0x8716, 0x5895, 0xAD33, 0x4EF0, 0xE434, 0xC521, 0xBFB1,
  0xB352, 0xA497, 0xCA84, 0xD3F5, 0x3C79, 0xB61A, 0xAE1B, 0xF314,
  0x00B3, 0x7C0A, 0x1018, 0x7F6B, 0x1CFF, 0x15AF, 0x4078, 0xE473,
  0x081C, 0x4B9D, 0x2FFC, 0xD9D0, 0x2CBA, 0xCD8C, 0x004C, 0x773C,
  0xF040, 0x3585, 0xF924, 0x6FD5, 0xC5E4, 0xD918, 0x1228, 0x1C86,
  0x21C0, 0x77F3, 0x6206, 0x0110, 0x152F, 0x0F74, 0xCEDF, 0xBBFE,
  0xE382, 0x5C15, 0xFD4D, 0x954C, 0xD2D9, 0xCA2F, 0x14B1, 0x9D2F,
  0x172C, 0xEA0C, 0x4EAD, 0x604B, 0x0659, 0xF4C5, 0x4168, 0xD151,
  0x58C7, 0x99BF, 0x77D3, 0xCDEC, 0x61B5, 0x1A48, 0xD614, 0x7FB0,
  0x91D5, 0x812A, 0x812A, 0x82B2, 0xDCE2, 0x9067, 0x6DB3, 0x3DC7,
  0xDCB8, 0xA1CE, 0x9C21, 0x4A23, 0xB50F, 0x63E6, 0xE78A, 0x9238,
  0x644D, 0x1BD6, 0xB5B6, 0x1AB9, 0x9D07, 0xC849, 0x6992, 0x10CA,
  0x4453, 0xA3A1, 0x5A18, 0xAFE0, 0x7F2B, 0xFC38, 0xFC38, 0xBA98,
  0x5AEB, 0xFC38, 0xFC38, 0xFC38, 0xFC38, 0xEFAD, 0x6D83, 0xFC38
];

const CRC_TABLE = Uint16Array.from({ length: 256 }, (_, i) => {
  let rem = 0;
  for (let c = i, bit = 0; bit < 8; bit++, c >>= 1) {
    rem = (rem >> 1) ^ ((rem ^ c) & 1 ? CRC_POLY : 0);
  }
  return rem;
});

function crc(init: number, buf: Uint8Array): number {
  let v = init;
  for (const b of buf) v = (v >> 8) ^ CRC_TABLE[(v & 0xff) ^ b];
  return v;
}

function setU16BE(rom: Uint8Array, off: number, v: number): void {
  rom[off] = (v >> 8) & 0xff;
  rom[off + 1] = v & 0xff;
}

function sum(buf: Uint8Array): number {
  let s = 0;
  for (const b of buf) s += b;
  return s;
}

/** Rewrites the three derived regions in place. */
export function calculateChecksums(rom: Uint8Array): Uint8Array {
  if (rom.length !== ROM_SIZE) throw new Error(`ROM is ${rom.length} bytes, want ${ROM_SIZE}`);
  setU16BE(rom, GLOBAL_OFF, 0);

  const baseTotal = 8 + NUM_BANKS / 8;
  rom.fill(0, BASE_OFF, BASE_OFF + baseTotal);
  rom.set(new TextEncoder().encode('base\x01\x00'), BASE_OFF);
  for (let i = 0; i < NUM_BANKS / 8; i++) {
    let bits = 0;
    for (let j = 0; j < 8; j++) {
      const bank = i * 8 + j;
      const c = crc(CRC_INIT, rom.subarray(bank * BANK_SIZE, (bank + 1) * BANK_SIZE));
      bits |= (c === BASE0_CRCS[bank] ? 1 : 0) << j;
    }
    rom[BASE_OFF + 8 + i] = bits;
  }
  setU16BE(rom, BASE_OFF + 6, crc(CRC_INIT_BASE, rom.subarray(BASE_OFF, BASE_OFF + baseTotal)));

  const n64Total = 8 + NUM_BANKS * 2 * 2;
  rom.fill(0, N64PS3_OFF, N64PS3_OFF + n64Total);
  rom.set(new TextEncoder().encode('N64PS3'), N64PS3_OFF);
  const half = BANK_SIZE / 2;
  for (let i = 0; i < NUM_BANKS * 2; i++) {
    setU16BE(rom, N64PS3_OFF + 8 + i * 2, (CRC_INIT + sum(rom.subarray(i * half, (i + 1) * half))) & 0xffff);
  }
  setU16BE(rom, N64PS3_OFF + 6, crc(CRC_INIT, rom.subarray(N64PS3_OFF + 8, N64PS3_OFF + n64Total)));

  setU16BE(rom, GLOBAL_OFF, sum(rom) & 0xffff);
  return rom;
}
