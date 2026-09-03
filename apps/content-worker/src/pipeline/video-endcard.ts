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
 *
 * Visual design — advertising-grade end card:
 *   • Bottom-anchored scrim (58%-100% of frame height): the product stays
 *     visible above while every line of text — headline and CTA alike —
 *     sits inside the same solid dark band, so nothing is fighting a bright
 *     or busy background for contrast.
 *   • Headline in the bold weight at w/11: large enough to land on a mobile
 *     screen without leaning in, with a two-pixel drop-shadow for legibility.
 *   • CTA in a pill-shaped box: distinct from the headline, signals
 *     interactivity (even on a static screen), and gives the line its own
 *     visual weight without needing a second font.
 */

/** How long the message holds at the end of the clip. 2.5 s gives a viewer
 *  enough time to read a two-line headline aloud without eating too much of a
 *  4-6 s ad. */
const ENDCARD_SECONDS = 2.5;

/**
 * Chars per line before wrapping, paired with the `w/11` headline size below.
 *
 * 20 chars per line at the wider font size gives approximately the same
 * horizontal margin as 16 chars did at the old w/14 size — both keep text
 * away from the edges at 1080 px width. Counted in characters (the cheap
 * approximation): if a headline ever needs pixel-perfect measurement, use
 * ffprobe's drawtext metrics and wrap on text_w instead.
 */
const MAX_LINE_CHARS = 20;

const FFMPEG_TIMEOUT_MS = 120_000;

export interface EndCardText {
  /** The campaign line — what the ad is actually saying. */
  headline: string;
  /** The closing ask, drawn in a pill box beneath the headline. */
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
      reject(
        new Error(`${command} exited ${code}: ${stderr.trim().split('\n').slice(-5).join(' ')}`),
      );
    });
  });
}

/** Top of the scrim, as a fraction of frame height. Headline and CTA are both
 *  positioned relative to this so they always land inside the dark band
 *  regardless of how tall the wrapped text turns out to be. */
const SCRIM_TOP = 0.58;

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
 *
 * Headline and CTA are positioned with drawtext's own `text_h`/`text_w`
 * rather than hand-picked percentages, so a one-line headline centers
 * differently than a two-line one instead of both using the same fixed slot
 * — the earlier fixed-percentage layout put a two-line headline half inside
 * a lighter, low-opacity band and half in the solid one, which is what made
 * it hard to read against a busy background.
 *
 * Visual filter stack (applied bottom → top):
 *   1. Scrim           — solid dark band across the bottom of the frame.
 *   2. Headline text   — large, bold, centred within the scrim, with drop-shadow.
 *   3. CTA pill box    — rounded-rect drawn behind the CTA text.
 *   4. CTA text        — smaller, centred inside the pill.
 */
export function buildEndCardFilter(
  headlineFile: string,
  ctaFile: string | null,
  headlineFontFile: string,
  ctaFontFile: string,
  startSeconds: number,
): string {
  // Every element is gated on the same `enable` window, so nothing is drawn
  // until the ad reaches its closing beat.
  const shown = `between(t,${startSeconds.toFixed(3)},99999)`;

  // With a CTA, the headline sits in the upper part of the scrim (centred on
  // 70% of frame height) so the pill has its own clear space below it.
  // Without one, the headline is centred in the scrim as a whole.
  const headlineY = ctaFile ? '0.70*h-text_h/2' : `(${1 + SCRIM_TOP}*h-text_h)/2`;

  const filters = [
    // ── 1. Scrim ─────────────────────────────────────────────────────────────
    // One solid band, not a two-step gradient: it keeps the product shot
    // visible above while guaranteeing every line of text below it sits on
    // the same dark backdrop, whatever colour the model placed there.
    //
    // `iw`/`ih` here, not `w`/`h`: in drawtext, `w`/`h` are the frame's own
    // size, but in drawbox they mean the box's own width/height — sizing a
    // drawbox box off `h` when `h` is what's being computed is circular and
    // fails filter-graph init outright ("Error when evaluating the
    // expression"), taking every filter after it down with it. Confirmed
    // against this box's ffmpeg 6.1.1: `y=0.58*h` errors, `y=0.58*ih`
    // doesn't. Every drawbox box below uses `iw`/`ih` for the same reason;
    // the drawtext boxes correctly keep `w`/`h`.
    `drawbox=x=0:y=${SCRIM_TOP}*ih:w=iw:h=${1 - SCRIM_TOP}*ih:color=black@0.60:t=fill:enable='${shown}'`,

    // ── 2. Headline ──────────────────────────────────────────────────────────
    // Drop-shadow pair (shadow drawn first, then the white copy on top) gives
    // the text lift against any background the provider renders. Bold face
    // reads as an ad headline rather than body copy at this size.
    `drawtext=textfile='${headlineFile}':fontfile='${headlineFontFile}':expansion=none:` +
      `fontsize=w/11:fontcolor=black@0.55:line_spacing=10:` +
      // Shadow: offset 2 px down-right, 55 % opacity
      `x=(w-text_w)/2+2:y=${headlineY}+2:enable='${shown}'`,
    `drawtext=textfile='${headlineFile}':fontfile='${headlineFontFile}':expansion=none:` +
      `fontsize=w/11:fontcolor=white:line_spacing=10:` +
      `x=(w-text_w)/2:y=${headlineY}:enable='${shown}'`,
  ];

  if (ctaFile) {
    // ── 3. CTA pill box ──────────────────────────────────────────────────────
    // A translucent white-border pill framing the CTA text — width is fixed at
    // iw*0.55 (wider than most CTAs, narrower than the frame) so it has a
    // consistent presence without measuring the text. Centred horizontally,
    // and vertically centred at 90% of frame height — inside the scrim, with
    // clearance below the headline slot above.
    filters.push(
      `drawbox=x=(iw-iw*0.55)/2:y=0.90*ih-ih/28:w=iw*0.55:h=ih/14:` +
        `color=white@0.18:t=fill:enable='${shown}'`,
      // Pill border — drawn as a thin filled box on top of the fill (ffmpeg
      // drawbox's `t=` parameter is border thickness, not border vs fill).
      `drawbox=x=(iw-iw*0.55)/2:y=0.90*ih-ih/28:w=iw*0.55:h=ih/14:` +
        `color=white@0.55:t=2:enable='${shown}'`,
    );

    // ── 4. CTA text ──────────────────────────────────────────────────────────
    filters.push(
      `drawtext=textfile='${ctaFile}':fontfile='${ctaFontFile}':expansion=none:` +
        `fontsize=w/22:fontcolor=white:` +
        `x=(w-text_w)/2:y=0.90*h-text_h/2:enable='${shown}'`,
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
  headlineFontFile: string,
  ctaFontFile: string,
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
      buildEndCardFilter(headlineFile, ctaFile, headlineFontFile, ctaFontFile, start),
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
