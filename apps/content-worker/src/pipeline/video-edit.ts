import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The two ffmpeg jobs the Studio needs: joining rendered shots into one video
 * (storyboards, extensions) and taking a clip's last frame (to continue it).
 * Needs `ffmpeg` and `ffprobe` on the box (`apt install ffmpeg`).
 */

const FFMPEG_TIMEOUT_MS = 180_000;

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    // ffmpeg writes progress to stderr; keep it only for the error message.
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} timed out after ${FFMPEG_TIMEOUT_MS}ms`));
    }, FFMPEG_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        error.code === 'ENOENT'
          ? new Error(`${command} is not installed on this server (apt install ffmpeg)`)
          : error,
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(stdout);
      reject(
        new Error(`${command} exited ${code}: ${stderr.trim().split('\n').slice(-5).join(' ')}`),
      );
    });
  });
}

async function withTempDir<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'bmas-video-'));
  try {
    return await work(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function probe(file: string): Promise<{ seconds: number; hasAudio: boolean }> {
  const out = JSON.parse(
    await run('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_type:format=duration',
      '-of',
      'json',
      file,
    ]),
  ) as { streams?: Array<{ codec_type?: string }>; format?: { duration?: string } };
  return {
    seconds: Number(out.format?.duration ?? 0),
    hasAudio: (out.streams ?? []).some((s) => s.codec_type === 'audio'),
  };
}

/**
 * ffmpeg arguments that cut each input to its planned length, bring it to
 * one size and frame rate, and concatenate them. Sound is kept only when
 * every input has it: concat needs a stream from each, and one silent shot
 * shouldn't fail the whole join.
 */
export function joinArgs(
  inputs: string[],
  seconds: number[],
  width: number,
  height: number,
  withAudio: boolean,
  output: string,
): string[] {
  const chains = inputs.map((_, i) => {
    const video = `[${i}:v]trim=duration=${seconds[i]},setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=24[v${i}]`;
    const audio = `[${i}:a]atrim=duration=${seconds[i]},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo[a${i}]`;
    return withAudio ? `${video};${audio}` : video;
  });
  const streams = inputs.map((_, i) => (withAudio ? `[v${i}][a${i}]` : `[v${i}]`)).join('');
  const concat = `${streams}concat=n=${inputs.length}:v=1:a=${withAudio ? 1 : 0}[v]${withAudio ? '[a]' : ''}`;
  return [
    '-y',
    ...inputs.flatMap((file) => ['-i', file]),
    '-filter_complex',
    `${chains.join(';')};${concat}`,
    '-map',
    '[v]',
    ...(withAudio ? ['-map', '[a]', '-c:a', 'aac', '-b:a', '128k'] : []),
    // Two threads: the box has 1.9 GB of RAM and other services on it.
    ...['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-threads', '2'],
    ...['-pix_fmt', 'yuv420p', '-movflags', '+faststart', output],
  ];
}

/** Joins clips in order, each cut to at most its planned seconds. */
export async function joinClips(
  clips: Buffer[],
  seconds: number[],
  width: number,
  height: number,
): Promise<{ data: Buffer; durationSeconds: number }> {
  return withTempDir(async (dir) => {
    const inputs = await Promise.all(
      clips.map(async (clip, i) => {
        const file = join(dir, `in-${i}.mp4`);
        await writeFile(file, clip);
        return file;
      }),
    );
    const probes = await Promise.all(inputs.map(probe));
    const output = join(dir, 'out.mp4');
    await run(
      'ffmpeg',
      joinArgs(
        inputs,
        seconds,
        width,
        height,
        probes.every((p) => p.hasAudio),
        output,
      ),
    );
    return {
      data: await readFile(output),
      durationSeconds: probes.reduce((sum, p, i) => sum + Math.min(p.seconds, seconds[i]!), 0),
    };
  });
}

/** A reel cut down to send Gemini inline (it takes 20 MB a request): the
 *  first minute at 480p, which is plenty to read setting, camera and pace. */
export async function shrinkVideo(clip: Buffer): Promise<Buffer> {
  return withTempDir(async (dir) => {
    const input = join(dir, 'in.mp4');
    const output = join(dir, 'small.mp4');
    await writeFile(input, clip);
    await run('ffmpeg', [
      ...['-y', '-i', input, '-t', '60', '-vf', 'scale=-2:480'],
      ...['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-threads', '2'],
      ...['-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', output],
    ]);
    return readFile(output);
  });
}

/** The clip's final frame as a JPEG: the opening frame of its continuation. */
export async function lastFrame(clip: Buffer): Promise<Buffer> {
  return withTempDir(async (dir) => {
    const input = join(dir, 'in.mp4');
    const output = join(dir, 'last.jpg');
    await writeFile(input, clip);
    // Decodes the last second and keeps overwriting one image: the last frame.
    await run('ffmpeg', ['-y', '-sseof', '-1', '-i', input, '-update', '1', '-q:v', '2', output]);
    return readFile(output);
  });
}
