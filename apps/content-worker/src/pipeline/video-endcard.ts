import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Burns the campaign's closing message onto the end of a rendered clip.
 *
 * Done here rather than by asking the video model for on-screen text, for the
 * reason `composeVideoBrief` already documents: video-diffusion models render
 * text unreliably and this pipeline has no vision-QA pass to catch a
 * misspelled headline. ffmpeg draws exactly the string it is given, every
 * time, which is the only way an advertisement can carry a brand's own words.
 *
 * Deliberately a filter over the existing frames rather than a concatenated
 * card: concat needs the two segments to agree on codec, resolution, frame
 * rate, pixel format and timebase, and a mismatch there fails at mux time
 * with a message that has nothing to do with the text. Drawing over the tail
 * of the clip the provider already returned cannot desync.
 */

/** How long the message holds at the end of the clip. Long enough to read a
 *  short headline aloud, short enough not to eat a 4-6s ad. */
const ENDCARD_SECONDS = 2;

/**
 * Chars per line before wrapping. Paired with the `w/14` headline size below:
 * DejaVu Sans averages a little over half an em per glyph, so ~18 characters
 * fills roughly 80% of the frame and leaves a margin down both sides. Checked
 * against a real render, not calculated — 24 put "50% off — today only:" hard
 * against both edges.
 */
const MAX_LINE_CHARS = 18;

const FFMPEG_TIMEOUT_MS = 120_000;

export interface EndCardText {
  /** The campaign line — what the ad is actually saying. */
  headline: string;
  /** The closing ask, drawn smaller beneath the headline. */
  cta?: string | undefined;
}

/**
 * Greedy wrap on whitespace. drawtext has no wrapping of its own — it renders
 * one line per literal newline and lets anything longer run off the frame —
 * so the break points have to be decided before ffmpeg sees the string.
 *
 * A single word longer than the limit is left alone rather than hyphenated:
 * an overflowing word is ugly, a word broken in the wrong place is wrong, and
 * a real headline rarely contains one.
 */
export function wrapText(text: string, maxChars: number = MAX_LINE_CHARS): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    if (!current) {
      current = word;
    } else if (`${current} ${word}`.length <= maxChars) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  lines.push(current);

  return lines;
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    // stderr is where ffmpeg writes everything, progress included, so it is
    // captured for the error message rather than streamed to our own logs.
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} timed out after ${FFMPEG_TIMEOUT_MS}ms`));
    }, FFMPEG_TIMEOUT_MS);

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      reject(new Error(`${command} exited ${code}: ${stderr.trim().split('\n').slice(-5).join(' ')}`));
    });
  });
}

/**
 * Builds the filter chain. Split out from `addEndCard` so the string can be
 * asserted in a test without spawning ffmpeg or needing a real clip.
 *
 * Text reaches drawtext through `textfile=` rather than `text=`: the value is
 * brand copy from a model, so it can contain the `:`, `'` and `\` that
 * drawtext's own parser treats as syntax. A file has no such grammar, which
 * removes the escaping question instead of trying to win it.
 *
 * `expansion=none` closes the one hole a file does not: drawtext still runs
 * its own `%`/`%{}` substitution over whatever it reads, so a "50% off"
 * headline — the single most likely thing an offer campaign will ever say —
 * warns "Stray %" and drops the character. None of this pipeline's text is
 * ever meant as a template, so expansion is turned off outright rather than
 * escaped around.
 */
export function buildEndCardFilter(
  headlineFile: string,
  ctaFile: string | null,
  fontFile: string,
  startSeconds: number,
): string {
  // Every element is gated on the same `enable` window, so nothing is drawn
  // until the ad reaches its closing beat.
  const shown = `between(t,${startSeconds.toFixed(3)},99999)`;

  const filters = [
    // A scrim rather than a hard cut to a card: the product stays on screen
    // behind the words, which is what an ad's end frame is for.
    `drawbox=x=0:y=0:w=iw:h=ih:color=black@0.55:t=fill:enable='${shown}'`,
    `drawtext=textfile='${headlineFile}':fontfile='${fontFile}':expansion=none:` +
      // Sized off frame width so this holds at any resolution the providers
      // snap to, not just the 1080x1920 the request asks for.
      `fontsize=w/14:fontcolor=white:line_spacing=12:` +
      `x=(w-text_w)/2:y=(h-text_h)/2${ctaFile ? '-h/12' : ''}:enable='${shown}'`,
  ];

  if (ctaFile) {
    filters.push(
      `drawtext=textfile='${ctaFile}':fontfile='${fontFile}':expansion=none:` +
        `fontsize=w/26:fontcolor=white@0.85:` +
        `x=(w-text_w)/2:y=(h+text_h)/2+h/14:enable='${shown}'`,
    );
  }

  return filters.join(',');
}

/**
 * Returns the clip with the end card burnt in. Callers treat a throw as
 * "post the original" — see `generate-video.ts` — so this never has to
 * produce a fallback of its own.
 */
export async function addEndCard(
  video: Buffer,
  text: EndCardText,
  durationSeconds: number,
  fontFile: string,
): Promise<Buffer> {
  const headline = wrapText(text.headline).join('\n');
  if (!headline) throw new Error('end card has no headline text to draw');
  const cta = text.cta ? wrapText(text.cta).join('\n') : '';

  const dir = await mkdtemp(join(tmpdir(), 'endcard-'));
  try {
    const input = join(dir, 'in.mp4');
    const output = join(dir, 'out.mp4');
    const headlineFile = join(dir, 'headline.txt');
    const ctaFile = cta ? join(dir, 'cta.txt') : null;

    await Promise.all([
      writeFile(input, video),
      writeFile(headlineFile, headline, 'utf8'),
      ...(ctaFile ? [writeFile(ctaFile, cta, 'utf8')] : []),
    ]);

    // Never negative: a clip shorter than the card holds the message for its
    // whole length rather than starting before it exists.
    const start = Math.max(0, durationSeconds - ENDCARD_SECONDS);

    await run('ffmpeg', [
      '-y',
      '-i',
      input,
      '-vf',
      buildEndCardFilter(headlineFile, ctaFile, fontFile, start),
      // Audio copied untouched — the filter is video-only, and re-encoding it
      // would be spend for no change. `-movflags +faststart` puts the moov
      // atom first so Instagram can begin reading before the whole file
      // lands.
      '-c:a',
      'copy',
      '-movflags',
      '+faststart',
      output,
    ]);

    return await readFile(output);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
