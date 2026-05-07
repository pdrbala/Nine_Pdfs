import { describe, expect, it } from 'vitest';
import { getFilenameFromDisposition } from '$lib/conversion/client';

describe('conversion client helpers', () => {
  it('prefers RFC 5987 UTF-8 filenames', () => {
    const filename = getFilenameFromDisposition(
      'attachment; filename="fallback.pdf"; filename*=UTF-8\'\'Sexo%20e%20temperamento.pdf'
    );

    expect(filename).toBe('Sexo e temperamento.pdf');
  });

  it('falls back to the uploaded EPUB basename', () => {
    expect(getFilenameFromDisposition(null, 'obra-teste.epub')).toBe('obra-teste.pdf');
  });
});

