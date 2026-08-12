import { describe, expect, it } from 'vitest';
import { extractJsonObject } from './ollama.llm.js';

/**
 * These cases are transcripts, not inventions: each `raw` below is a shape a
 * local gemma4 actually returned against this codebase's own prompts. The
 * previous first-`{`-to-last-`}` regex failed on most of them, and those
 * failures reached users as "JSON parse failed: Expected property name or
 * '}'" and "No JSON found in response: json".
 */
describe('extractJsonObject', () => {
  it('parses a bare object', () => {
    expect(extractJsonObject('{"ok": true}')).toEqual({ ok: true });
  });

  it('parses a markdown-fenced object', () => {
    expect(extractJsonObject('```json\n{"ok": true}\n```')).toEqual({ ok: true });
  });

  it('survives a stray leading brace before a fenced object', () => {
    // The exact thinking-mode output that produced "Expected property name
    // or '}' in JSON at position 1".
    const raw = 'json\n{```json\n{\n  "ok": true\n}\n```';
    expect(extractJsonObject(raw)).toEqual({ ok: true });
  });

  it('ignores prose before and after the object', () => {
    const raw = 'Here is the result:\n```json\n{"items": [1, 2]}\n```\nHope that helps!';
    expect(extractJsonObject(raw)).toEqual({ items: [1, 2] });
  });

  it('keeps braces that appear inside string values', () => {
    const raw = '{"caption": "use {this} template", "n": 1}';
    expect(extractJsonObject(raw)).toEqual({ caption: 'use {this} template', n: 1 });
  });

  it('keeps escaped quotes inside string values', () => {
    const raw = '{"caption": "she said \\"hi\\"", "n": 1}';
    expect(extractJsonObject(raw)).toEqual({ caption: 'she said "hi"', n: 1 });
  });

  it('handles nested objects and arrays', () => {
    const raw = '```json\n{"items":[{"a":{"b":2}},{"c":3}]}\n```';
    expect(extractJsonObject(raw)).toEqual({ items: [{ a: { b: 2 } }, { c: 3 }] });
  });

  it('never returns the truncated outer object when generation was cut short', () => {
    // A truncated response is structurally identical to the stray-brace case
    // above — an unbalanced outer brace wrapping a balanced inner one — so
    // this can still hand back an inner fragment. What it must never do is
    // return something that passes for the intended shape: the caller's
    // `req.parse` rejects the fragment and the call is retried. Pinning that
    // the outer `items` object never comes back half-built.
    const truncated = '{"items": [{"a": 1}, {"b"';
    expect(extractJsonObject(truncated)).not.toHaveProperty('items');
  });

  it('returns undefined when there is no JSON at all', () => {
    // "No JSON found in response: json" — the model emitted only the fence
    // language tag.
    expect(extractJsonObject('json')).toBeUndefined();
    expect(extractJsonObject('I could not answer that.')).toBeUndefined();
  });
});
