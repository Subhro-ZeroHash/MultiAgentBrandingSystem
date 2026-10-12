import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { joinArgs, joinClips, lastFrame, shrinkVideo } from './video-edit.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

/** A small test-pattern clip, with or without a tone. */
function clip(seconds: number, withAudio: boolean): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'video-edit-test-'));
  const out = join(dir, 'clip.mp4');
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `testsrc=size=270x480:rate=24:duration=${seconds}`,
    ...(withAudio ? ['-f', 'lavfi', '-i', `sine=duration=${seconds}`] : []),
    '-pix_fmt',
    'yuv420p',
    '-shortest',
    out,
  ]);
  const data = readFileSync(out);
  rmSync(dir, { recursive: true, force: true });
  return data;
}

function probe(data: Buffer): { seconds: number; audio: boolean } {
  const dir = mkdtempSync(join(tmpdir(), 'video-edit-test-'));
  const file = join(dir, 'probe.mp4');
  writeFileSync(file, data);
  const out = JSON.parse(
    execFileSync('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_type:format=duration',
      '-of',
      'json',
      file,
    ]).toString(),
  );
  rmSync(dir, { recursive: true, force: true });
  return {
    seconds: Number(out.format.duration),
    audio: out.streams.some((s: { codec_type: string }) => s.codec_type === 'audio'),
  };
}

describe('joinArgs', () => {
  it('drops sound from the graph when not every clip has it', () => {
    const args = joinArgs(['a.mp4', 'b.mp4'], [3, 4], 1080, 1920, false, 'out.mp4');
    const graph = args[args.indexOf('-filter_complex') + 1]!;
    expect(graph).toContain('[0:v]trim=duration=3');
    expect(graph).toContain('[1:v]trim=duration=4');
    expect(graph).toContain('[v0][v1]concat=n=2:v=1:a=0[v]');
    expect(graph).not.toContain(':a]');
  });
});

describe.skipIf(!hasFfmpeg)('joinClips and lastFrame (real ffmpeg)', () => {
  it('joins clips in order, cut to their planned length, keeping sound', async () => {
    const joined = await joinClips([clip(3, true), clip(3, true)], [2, 3], 270, 480);
    const result = probe(joined.data);
    expect(joined.durationSeconds).toBeCloseTo(5, 1);
    expect(result.seconds).toBeCloseTo(5, 0);
    expect(result.audio).toBe(true);
  });

  it('still joins when one clip is silent, without sound', async () => {
    const joined = await joinClips([clip(2, true), clip(2, false)], [2, 2], 270, 480);
    expect(probe(joined.data).audio).toBe(false);
  });

  it("takes a clip's last frame as a JPEG", async () => {
    const frame = await lastFrame(clip(2, false));
    expect(frame.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  });

  it('shrinks a reel to 480p for Gemini', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'video-edit-test-'));
    const big = join(dir, 'big.mp4');
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=1280x720:rate=24:duration=2',
      '-pix_fmt',
      'yuv420p',
      big,
    ]);
    const small = await shrinkVideo(readFileSync(big));
    rmSync(dir, { recursive: true, force: true });
    const file = join(mkdtempSync(join(tmpdir(), 'video-edit-test-')), 'small.mp4');
    writeFileSync(file, small);
    const height = execFileSync('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'v',
      '-show_entries',
      'stream=height',
      '-of',
      'csv=p=0',
      file,
    ])
      .toString()
      .trim();
    expect(height).toBe('480');
  });
});
