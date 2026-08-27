import { describe, expect, it } from 'vitest';
import { validateVideo } from './generate-video.js';

/** A minimal, real MP4 header — 'ftyp' at byte offset 4, same as any real
 *  ISO-BMFF file, followed by padding so it clears the size floor. */
const validMp4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x20]),
  Buffer.from('ftypisom', 'ascii'),
  Buffer.alloc(2048),
]);

describe('validateVideo', () => {
  it('accepts a well-formed video within its requested duration', () => {
    expect(() => validateVideo(validMp4, 6, 6)).not.toThrow();
  });

  it('rejects a file too small to be a real video, likely a truncated download', () => {
    const truncated = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x20]), Buffer.from('ftypisom')]);
    expect(() => validateVideo(truncated, 6, 6)).toThrow(/truncated/);
  });

  it("rejects a buffer whose byte 4 isn't 'ftyp' — not a real MP4 container", () => {
    const notMp4 = Buffer.concat([Buffer.from('XXXXXXXX', 'ascii'), Buffer.alloc(2048)]);
    expect(() => validateVideo(notMp4, 6, 6)).toThrow(/not a valid MP4/);
  });

  it('rejects a zero or negative reported duration', () => {
    expect(() => validateVideo(validMp4, 0, 6)).toThrow(/outside the requested bound/);
  });

  it('rejects a duration meaningfully longer than what was requested', () => {
    expect(() => validateVideo(validMp4, 20, 6)).toThrow(/outside the requested bound/);
  });

  it('tolerates a small rounding overshoot rather than failing on it', () => {
    // Providers report actual rendered duration, which can round up slightly
    // past an integer request — this must not read as a provider bug.
    expect(() => validateVideo(validMp4, 6.4, 6)).not.toThrow();
  });
});
