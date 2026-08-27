import { buildCostEvent } from '../pricing.js';
import type { ProviderContext, ProviderResult } from '../types.js';
import type { GeneratedVideo, VideoGenerateRequest, VideoGenService } from '../video.js';

const MODEL = 'stub-placeholder';

/**
 * A genuinely valid, tiny, playable MP4 (320x180, 1 second, solid colour) —
 * built once with ffmpeg during development and checked in as a fixture, the
 * same category of artifact as a checked-in test image. Never generated at
 * runtime: the adapter must not depend on ffmpeg (or any encoder) being
 * present on whatever machine runs it, the same reasoning `stub.image.ts`
 * gets from `sharp` being an actual npm dependency rather than a shelled-out
 * binary.
 */
const STUB_MP4_BASE64 =
  'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMXbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAA+gAAQAAAQAA' +
  'AAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAA' +
  'AkJ0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAA' +
  'AAAAAAAAAAAAAABAAAAAAUAAAAC0AAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAAAAABAAAAAAG6bWRpYQAAACBtZGhk' +
  'AAAAAAAAAAAAAAAAAABAAAAAQABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABZW1p' +
  'bmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAASVzdGJsAAAAwXN0c2QA' +
  'AAAAAAAAAQAAALFhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAUAAtABIAAAASAAAAAAAAAABFUxhdmM2Mi4xMS4xMDAgbGli' +
  'eDI2NAAAAAAAAAAAAAAAGP//AAAAN2F2Y0MBZAAM/+EAGmdkAAys2UFBn58BEAAAAwAQAAADACDxQplgAQAGaOvjyyLA/fj4AAAA' +
  'ABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAABeoAAAAAAAAABhzdHRzAAAAAAAAAAEAAAABAABAAAAAABxzdHNjAAAAAAAAAAEA' +
  'AAABAAAAAQAAAAEAAAAUc3RzegAAAAAAAAL1AAAAAQAAABRzdGNvAAAAAAAAAAEAAANHAAAAYXVkdGEAAABZbWV0YQAAAAAAAAAh' +
  'aGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAsaWxzdAAAACSpdG9vAAAAHGRhdGEAAAABAAAAAExhdmY2Mi4zLjEwMAAA' +
  'AAhmcmVlAAAC/W1kYXQAAAKtBgX//6ncRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY1IHIzMjIyIGIzNTYwNWEgLSBILjI2' +
  'NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDI1IC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1s' +
  'IC0gb3B0aW9uczogY2FiYWM9MSByZWY9MyBkZWJsb2NrPTE6MDowIGFuYWx5c2U9MHgzOjB4MTEzIG1lPWhleCBzdWJtZT03IHBz' +
  'eT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0x' +
  'IGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9NiBsb29rYWhlYWRf' +
  'dGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29u' +
  'c3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTMgYl9weXJhbWlkPTIgYl9hZGFwdD0xIGJfYmlhcz0wIGRpcmVjdD0xIHdlaWdodGI9' +
  'MSBvcGVuX2dvcD0wIHdlaWdodHA9MiBrZXlpbnQ9MjUwIGtleWludF9taW49MSBzY2VuZWN1dD00MCBpbnRyYV9yZWZyZXNoPTAg' +
  'cmNfbG9va2FoZWFkPTQwIHJjPWNyZiBtYnRyZWU9MSBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVw' +
  'PTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAAEBliIQAFf/+7M9+BTcDXsvPBW/fp145jTpoZ4rq/03qFxGMOPJbgANxLbQv' +
  'E4loXcX/ASUAAAeAQmOLZTJZvGlx';

export interface StubVideoConfig {
  /** Artificial latency, ms — lets a client's per-stage progress be exercised
   *  without waiting on a real render. */
  latencyMs?: number;
}

/**
 * Deterministic placeholder generator for video — see `StubImageAdapter`'s
 * header for the full reasoning; this is its video counterpart.
 *
 * One real limitation, called out rather than hidden: the returned bytes are
 * always the same fixed 320x180, 1-second fixture regardless of what was
 * requested. Rendering an arbitrary resolution/duration placeholder would
 * need a real encoder, which is exactly the dependency this adapter exists to
 * avoid taking on. What this proves — storage, the DB row, the cost ledger —
 * doesn't need the pixels to match; a real resolution/duration check belongs
 * against the real LTX adapter, not this one.
 */
export class StubVideoAdapter implements VideoGenService {
  readonly provider = 'stub';
  private readonly fixture = Buffer.from(STUB_MP4_BASE64, 'base64');

  constructor(private readonly config: StubVideoConfig = {}) {}

  private async delay(): Promise<void> {
    const ms = this.config.latencyMs ?? 0;
    if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async generate(
    _req: VideoGenerateRequest,
    _ctx?: ProviderContext,
  ): Promise<ProviderResult<GeneratedVideo>> {
    const startedAt = Date.now();
    await this.delay();

    return {
      value: {
        data: this.fixture,
        mediaType: 'video/mp4',
        width: 320,
        height: 180,
        durationSeconds: 1,
        model: MODEL,
      },
      cost: buildCostEvent({
        provider: this.provider,
        model: MODEL,
        operation: 'video:generate',
        videoSeconds: 1,
        // Explicit, same reasoning as StubImageAdapter: a stub must never
        // contribute spend even if a rate is later added for this model id.
        costMicroUsd: 0,
        latencyMs: Date.now() - startedAt,
      }),
    };
  }
}
