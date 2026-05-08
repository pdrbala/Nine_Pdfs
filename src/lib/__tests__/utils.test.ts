import { describe, expect, it } from 'vitest';
import { upgradeHttpUrl } from '$lib/utils';

describe('url utilities', () => {
  it('upgrades insecure http urls for secure rendering contexts', () => {
    expect(upgradeHttpUrl('http://example.test/cover.jpg')).toBe('https://example.test/cover.jpg');
  });

  it('keeps secure and empty urls stable', () => {
    expect(upgradeHttpUrl('https://example.test/cover.jpg')).toBe('https://example.test/cover.jpg');
    expect(upgradeHttpUrl('')).toBeNull();
    expect(upgradeHttpUrl(null)).toBeNull();
  });
});
