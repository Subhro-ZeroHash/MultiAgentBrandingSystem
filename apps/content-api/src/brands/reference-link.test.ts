import { describe, expect, it } from 'vitest';
import { classifyReferenceLink } from './reference-link.js';

describe('classifyReferenceLink', () => {
  it('sends every YouTube link shape to Gemini as a watch link', () => {
    for (const link of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3s',
      'https://youtu.be/dQw4w9WgXcQ',
      'https://youtube.com/shorts/dQw4w9WgXcQ?feature=share',
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
    ]) {
      expect(classifyReferenceLink(link)).toEqual({
        kind: 'youtube',
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      });
    }
    expect(classifyReferenceLink('https://www.youtube.com/@somechannel').kind).toBe('refused');
  });

  it('refuses social posts and non-web links, with a reason', () => {
    for (const link of ['https://vm.tiktok.com/x/', 'ftp://host/file.mp4', 'not a link']) {
      const result = classifyReferenceLink(link);
      expect(result.kind).toBe('refused');
    }
  });

  it('turns Drive and Dropbox share links into direct downloads', () => {
    const drive = classifyReferenceLink(
      'https://drive.google.com/file/d/1AbC_d-9/view?usp=sharing',
    );
    expect(drive.kind === 'fetch' && drive.url.href).toBe(
      'https://drive.google.com/uc?export=download&id=1AbC_d-9',
    );
    const dropbox = classifyReferenceLink('https://www.dropbox.com/s/abc/reel.mp4?dl=0');
    expect(dropbox.kind === 'fetch' && dropbox.url.searchParams.get('dl')).toBe('1');
  });

  it('looks Instagram posts and reels up by shortcode, but not profiles', () => {
    for (const link of [
      'https://www.instagram.com/reel/C9abc-12/?igsh=xyz',
      'https://instagram.com/p/C9abc-12/',
      'https://www.instagram.com/someshop/reel/C9abc-12/',
    ]) {
      expect(classifyReferenceLink(link)).toEqual({ kind: 'instagram', shortcode: 'C9abc-12' });
    }
    expect(classifyReferenceLink('https://www.instagram.com/someshop/').kind).toBe('refused');
  });
});
