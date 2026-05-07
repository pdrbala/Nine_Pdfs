import type { CitationAuthor, CitationType, ParsedCitation, SparseCandidate } from '$lib/types';
import { normalizeForCompare, normalizeWhitespace, stripDiacritics, titleCaseName, tokenize } from '$lib/utils';

function extractIdentifiers(rawText: string): { doi: string | null; isbn: string | null } {
  const doiMatch = rawText.match(/\b(10\.\d{4,9}\/[\-._;()/:A-Z0-9]+)\b/i);
  const isbnMatch = rawText.match(
    /(?:ISBN(?:-1[03])?:?\s*)?((?:97[89][-\s]?)?\d(?:[-\s]?\d){8,16}[\dX])/i
  );

  return {
    doi: doiMatch ? doiMatch[1].trim() : null,
    isbn: isbnMatch ? isbnMatch[1].replace(/\s+/g, '') : null
  };
}

function splitAuthorAndBody(rawText: string): { authorsPart: string; bodyPart: string } {
  const text = normalizeWhitespace(rawText);
  const periodIndexes: number[] = [];

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '.') {
      periodIndexes.push(index);
    }
  }

  for (const periodIndex of periodIndexes) {
    const before = text.slice(0, periodIndex).trim();
    const after = text.slice(periodIndex + 1).trim();
    if (!before || !after || !before.includes(',')) {
      continue;
    }

    if (/^[A-Z\u00C0-\u00DD]\./.test(after)) {
      continue;
    }

    if (/^[A-Z\u00C0-\u00DD' -]+,\s*.+/.test(before)) {
      return {
        authorsPart: before,
        bodyPart: after
      };
    }
  }

  const fallbackIndex = text.indexOf('. ');
  if (fallbackIndex !== -1) {
    return {
      authorsPart: text.slice(0, fallbackIndex).trim(),
      bodyPart: text.slice(fallbackIndex + 1).trim()
    };
  }

  return {
    authorsPart: '',
    bodyPart: text
  };
}

function parseAuthors(authorsPart: string): CitationAuthor[] {
  const clean = normalizeWhitespace(authorsPart.replace(/\bet al\.?$/i, '').trim());
  if (!clean) {
    return [];
  }

  const authorBlocks = clean.split(/\s*;\s*/).filter(Boolean);
  const authors = authorBlocks.map((author) => {
    const normalizedAuthor = normalizeWhitespace(author.replace(/\.$/, ''));
    const parts = normalizedAuthor.split(',');
    if (parts.length >= 2) {
      return {
        lastName: normalizeWhitespace(parts[0]).toUpperCase(),
        firstName: titleCaseName(parts.slice(1).join(','))
      };
    }

    const fallbackParts = normalizedAuthor.split(' ');
    return {
      lastName: (fallbackParts.pop() || '').toUpperCase(),
      firstName: titleCaseName(fallbackParts.join(' '))
    };
  });

  if (/\bet al\.?$/i.test(authorsPart)) {
    authors.push({
      lastName: 'ET AL.',
      firstName: ''
    });
  }

  return authors.filter((author) => author.lastName || author.firstName);
}

function extractEdition(text: string): string | null {
  const match = text.match(/(?:^|\s)(\d+\s*\.\s*ed\.?)/i);
  return match ? normalizeWhitespace(match[1]) : null;
}

function detectCitationType(text: string): CitationType {
  if (/(disserta(?:ção|cao)|tese|thesis|dissertation)/i.test(text)) {
    return 'thesis';
  }

  if (/(revista|journal|peri(?:o|ó)dico|issn|doi|v\.\s*\d+|n\.\s*\d+)/i.test(text)) {
    return 'article';
  }

  if (/(editora|ed\.|isbn|cole(?:c|ç)(?:a|ã)o)/i.test(text)) {
    return 'book';
  }

  return 'unknown';
}

function extractPublicationTail(text: string): {
  city: string | null;
  publisher: string | null;
  year: string | null;
  matchedText: string | null;
} {
  const clean = normalizeWhitespace(text);
  const match = clean.match(
    /([A-Z\u00C0-\u00DD][A-Za-z\u00C0-\u00FF' -]{1,80})\s*:\s*([^,.;]{2,120}),\s*(\d{4})/
  );

  if (!match) {
    const yearOnly = clean.match(/(?:,|\s)(1[89]\d{2}|20\d{2}|21\d{2})(?:\.|$)/);
    return {
      city: null,
      publisher: null,
      year: yearOnly ? yearOnly[1] : null,
      matchedText: yearOnly ? yearOnly[0] : null
    };
  }

  return {
    city: normalizeWhitespace(match[1]),
    publisher: normalizeWhitespace(match[2]),
    year: match[3],
    matchedText: match[0]
  };
}

function stripCollectionInfo(text: string): string {
  let output = normalizeWhitespace(text);
  let previous = '';

  while (output !== previous) {
    previous = output;
    output = output.replace(/\s*\(([^()]*)\)\s*$/g, '').trim();
  }

  return output;
}

export function buildRawQuery(parsed: ParsedCitation): string {
  const authors = parsed.authors
    .filter((author) => author.lastName !== 'ET AL.')
    .map((author) => `${author.firstName} ${titleCaseName(author.lastName)}`.trim())
    .join(' ');

  return normalizeWhitespace(
    [authors, parsed.title, parsed.subtitle, parsed.year, parsed.isbn, parsed.doi]
      .filter(Boolean)
      .join(' ')
  );
}

export function parseCitation(rawText: string): ParsedCitation | null {
  const clean = normalizeWhitespace(rawText);
  if (!clean) {
    return null;
  }

  const identifiers = extractIdentifiers(clean);
  const split = splitAuthorAndBody(clean);
  const authors = parseAuthors(split.authorsPart);
  let body = stripCollectionInfo(split.bodyPart || clean);
  const edition = extractEdition(body);
  const publicationTail = extractPublicationTail(body);
  const type = detectCitationType(body);

  if (publicationTail.matchedText) {
    body = normalizeWhitespace(body.replace(publicationTail.matchedText, ''));
  }

  if (edition) {
    body = normalizeWhitespace(body.replace(edition, ''));
  }

  body = body
    .replace(/\bISBN(?:-1[03])?:?\s*[\dX-]+\b/gi, '')
    .replace(/\b10\.\d{4,9}\/[\-._;()/:A-Z0-9]+\b/gi, '')
    .replace(/\s+\.\s+/g, '. ')
    .replace(/\s+\.$/, '')
    .trim();

  const titleBlock = normalizeWhitespace(body.split(/\.\s+(?=[A-Z\u00C0-\u00DD])/)[0] || body);
  const titleParts = titleBlock.split(/\s*:\s*/);
  const title = normalizeWhitespace(titleParts.shift() || '').replace(/\.+$/, '');
  const subtitle = titleParts.length ? normalizeWhitespace(titleParts.join(': ')).replace(/\.+$/, '') : null;
  const year = publicationTail.year || clean.match(/\b(1[89]\d{2}|20\d{2}|21\d{2})\b/)?.[1] || null;

  const parsed: ParsedCitation = {
    authors,
    title,
    subtitle,
    year,
    publisher: publicationTail.publisher,
    city: publicationTail.city,
    edition,
    type,
    isbn: identifiers.isbn,
    doi: identifiers.doi,
    rawQuery: '',
    raw: clean
  };

  parsed.rawQuery = buildRawQuery(parsed);
  return parsed;
}

export function formatAuthorShort(author: CitationAuthor | null | undefined): string {
  if (!author) {
    return '';
  }

  const lastName = titleCaseName(author.lastName || '');
  const initials = (author.firstName || '')
    .split(' ')
    .filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}.`)
    .join('');

  return normalizeWhitespace(`${lastName}, ${initials}`);
}

export function formatAuthorsDisplay(authors: CitationAuthor[] | null | undefined): string {
  if (!authors || !authors.length) {
    return 'Autor não identificado';
  }

  const safeAuthors = authors.filter((author) => author.lastName !== 'ET AL.');
  if (!safeAuthors.length) {
    return 'et al.';
  }

  return safeAuthors
    .map((author) => {
      const lastName = titleCaseName(author.lastName || '');
      return normalizeWhitespace(`${author.firstName} ${lastName}`);
    })
    .join(', ');
}

export function getParsedSummaryParts(parsed: ParsedCitation | null): string[] {
  if (!parsed) {
    return [];
  }

  const parts: string[] = [];
  const titleLabel = parsed.subtitle ? `${parsed.title}: ${parsed.subtitle}` : parsed.title;
  if (titleLabel) {
    parts.push(`"${titleLabel}"`);
  }

  const authorPreview = parsed.authors
    .filter((author) => author.lastName !== 'ET AL.')
    .slice(0, 2)
    .map((author) => formatAuthorShort(author))
    .filter(Boolean)
    .join(' · ');

  if (authorPreview) {
    parts.push(authorPreview);
  }

  if (parsed.year) {
    parts.push(parsed.year);
  }

  if (parsed.type && parsed.type !== 'unknown') {
    parts.push(parsed.type);
  }

  if (parsed._parserSource === 'gemini_catalog') {
    parts.push('Gemini + catálogo');
  } else if (parsed._parserSource === 'catalog') {
    parts.push('catálogo online');
  } else if (parsed._parserSource === 'gemini') {
    parts.push('Gemini Flash-Lite');
  } else if (parsed._parserSource === 'local') {
    parts.push('parser local');
  }

  if (parsed._searchEnriched && parsed._searchCandidateSource) {
    parts.push(parsed._searchCandidateSource);
  }

  return parts;
}

export function markParserSource(
  parsed: ParsedCitation | null,
  parserSource: ParsedCitation['_parserSource']
): ParsedCitation | null {
  return parsed ? { ...parsed, _parserSource: parserSource } : parsed;
}

export function normalizeGeminiAuthors(
  authors: unknown,
  fallbackAuthors: CitationAuthor[] = []
): CitationAuthor[] {
  if (!Array.isArray(authors) || !authors.length) {
    return fallbackAuthors || [];
  }

  return authors
    .map((author) => {
      const raw =
        typeof author === 'string'
          ? { lastName: author, firstName: '' }
          : ((author ?? {}) as Record<string, unknown>);

      return {
        lastName: normalizeWhitespace(
          String(raw.lastName || raw.last || '')
        ).toUpperCase(),
        firstName: titleCaseName(String(raw.firstName || raw.first || ''))
      };
    })
    .filter((author) => author.lastName || author.firstName);
}

export function buildCitationFromParts(
  rawText: string,
  candidate: Partial<SparseCandidate> | Record<string, unknown> | null | undefined,
  fallbackParsed?: ParsedCitation | null
): ParsedCitation {
  const fallback =
    fallbackParsed ||
    parseCitation(rawText) || {
      authors: [],
      title: '',
      subtitle: null,
      year: null,
      publisher: null,
      city: null,
      edition: null,
      type: 'unknown' as CitationType,
      isbn: null,
      doi: null,
      rawQuery: '',
      raw: normalizeWhitespace(rawText)
    };

  const sourceCandidate = (candidate || {}) as Record<string, unknown>;
  const yearMatch = sourceCandidate.year
    ? String(sourceCandidate.year).match(/(1[89]\d{2}|20\d{2}|21\d{2})/)
    : null;

  const parsed: ParsedCitation = {
    authors: normalizeGeminiAuthors(sourceCandidate.authors, fallback.authors),
    title: normalizeWhitespace(String(sourceCandidate.title || fallback.title || '')),
    subtitle: normalizeWhitespace(String(sourceCandidate.subtitle || fallback.subtitle || '')) || null,
    year: yearMatch ? yearMatch[1] : fallback.year || null,
    publisher: normalizeWhitespace(String(sourceCandidate.publisher || fallback.publisher || '')) || null,
    city: normalizeWhitespace(String(sourceCandidate.city || fallback.city || '')) || null,
    edition: normalizeWhitespace(String(sourceCandidate.edition || fallback.edition || '')) || null,
    type:
      (normalizeWhitespace(String(sourceCandidate.type || fallback.type || 'unknown')) as CitationType) ||
      'unknown',
    isbn: normalizeWhitespace(String(sourceCandidate.isbn || fallback.isbn || '')) || null,
    doi: normalizeWhitespace(String(sourceCandidate.doi || fallback.doi || '')) || null,
    rawQuery: '',
    raw: normalizeWhitespace(rawText)
  };

  parsed.rawQuery = buildRawQuery(parsed);
  return parsed.title ? parsed : fallback;
}

export function safeJsonParse(text: string): unknown | null {
  const clean = normalizeWhitespace(
    String(text || '')
      .replace(/^```json/i, '')
      .replace(/^```/i, '')
      .replace(/```$/i, '')
  );

  if (!clean) {
    return null;
  }

  try {
    return JSON.parse(clean);
  } catch {
    return null;
  }
}

function splitLooseAuthorName(value: string): CitationAuthor | null {
  const clean = normalizeWhitespace(value);
  if (!clean) {
    return null;
  }

  if (/^et al\.?$/i.test(clean)) {
    return { lastName: 'ET AL.', firstName: '' };
  }

  if (clean.includes(',')) {
    const [lastName, ...firstParts] = clean.split(',');
    return {
      lastName: normalizeWhitespace(lastName).toUpperCase(),
      firstName: titleCaseName(firstParts.join(' '))
    };
  }

  const parts = clean.split(' ').filter(Boolean);
  if (parts.length === 1) {
    return { lastName: parts[0].toUpperCase(), firstName: '' };
  }

  const suffixes = new Set(['filho', 'junior', 'jr', 'neto']);
  let lastName = parts.pop() as string;
  if (parts.length && suffixes.has(normalizeForCompare(lastName))) {
    lastName = `${parts.pop()} ${lastName}`;
  }

  return {
    lastName: normalizeWhitespace(lastName).toUpperCase(),
    firstName: titleCaseName(parts.join(' '))
  };
}

export function normalizeLooseAuthors(value: unknown): CitationAuthor[] {
  if (!value) {
    return [];
  }

  const items = Array.isArray(value)
    ? value
    : String(value).split(/\s*;\s*|\s+\band\b\s+|\s+\be\b\s+/i);

  return items
    .map((item) => {
      if (!item) {
        return null;
      }

      if (typeof item === 'string') {
        return splitLooseAuthorName(item);
      }

      if (typeof item === 'object' && item && 'name' in item) {
        return splitLooseAuthorName(String((item as { name?: string }).name || ''));
      }

      const entry = item as Record<string, unknown>;
      return {
        lastName: normalizeWhitespace(
          String(entry.lastName || entry.last || entry.family || '')
        ).toUpperCase(),
        firstName: titleCaseName(String(entry.firstName || entry.first || entry.given || ''))
      };
    })
    .filter((author): author is CitationAuthor => Boolean(author && (author.lastName || author.firstName)));
}

export function isSparseCitation(parsed: ParsedCitation | null): boolean {
  if (!parsed || !parsed.title) {
    return false;
  }

  const hasAuthor = Array.isArray(parsed.authors)
    && parsed.authors.some((author) => author && author.lastName && author.lastName !== 'ET AL.');
  const hasExtraMetadata = [
    parsed.year,
    parsed.publisher,
    parsed.city,
    parsed.edition,
    parsed.isbn,
    parsed.doi
  ].some(Boolean);

  return !hasAuthor && !hasExtraMetadata && tokenize(`${parsed.title} ${parsed.subtitle || ''}`).length >= 2;
}

function mapSparseCandidateType(value: string): CitationType {
  const clean = normalizeForCompare(value);
  if (!clean) {
    return 'unknown';
  }

  if (/thesis|dissertation|tes[ei]|monograph/.test(clean)) {
    return 'thesis';
  }
  if (/article|journal|proceedings|posted content|report/.test(clean)) {
    return 'article';
  }
  if (/book|monograph|edited book|reference entry/.test(clean)) {
    return 'book';
  }

  return 'unknown';
}

export function createSparseCandidate(
  source: string,
  partial: Record<string, unknown>
): SparseCandidate {
  const yearMatch = partial.year
    ? String(partial.year).match(/(1[89]\d{2}|20\d{2}|21\d{2})/)
    : null;

  return {
    source,
    title: normalizeWhitespace(String(partial.title || '')),
    subtitle: normalizeWhitespace(String(partial.subtitle || '')) || null,
    authors: normalizeLooseAuthors(partial.authors),
    year: yearMatch ? yearMatch[1] : null,
    publisher: normalizeWhitespace(String(partial.publisher || '')) || null,
    city: normalizeWhitespace(String(partial.city || '')) || null,
    edition: normalizeWhitespace(String(partial.edition || '')) || null,
    type: mapSparseCandidateType(String(partial.type || '')),
    isbn: normalizeWhitespace(String(partial.isbn || '')) || null,
    doi: normalizeWhitespace(String(partial.doi || '')) || null,
    pageUrl: normalizeWhitespace(String(partial.pageUrl || '')) || null,
    score: 0
  };
}

export function scoreSparseCandidate(query: string, candidate: SparseCandidate): number {
  const queryTokens = new Set(tokenize(query));
  const titleText = normalizeWhitespace([candidate.title, candidate.subtitle].filter(Boolean).join(' '));
  const titleTokens = new Set(tokenize(titleText));

  if (!queryTokens.size || !titleTokens.size) {
    return 0;
  }

  let matches = 0;
  queryTokens.forEach((token) => {
    if (titleTokens.has(token)) {
      matches += 1;
    }
  });

  const queryNormalized = normalizeForCompare(query);
  const titleNormalized = normalizeForCompare(titleText);
  const exactish =
    queryNormalized &&
    titleNormalized &&
    (queryNormalized === titleNormalized ||
      titleNormalized.startsWith(queryNormalized) ||
      queryNormalized.startsWith(titleNormalized))
      ? 1
      : 0;
  const overlap = matches / Math.max(queryTokens.size, 1);
  const metadataBonus =
    (candidate.authors.length ? 0.12 : 0) +
    (candidate.year ? 0.05 : 0) +
    (candidate.publisher ? 0.03 : 0) +
    (candidate.isbn || candidate.doi ? 0.04 : 0);
  const sourceBonus =
    (
      {
        'Google Books': 0.08,
        'Open Library': 0.07,
        'Project Gutenberg': 0.065,
        'SciELO Brasil': 0.06,
        CrossRef: 0.05
      } as Record<string, number>
    )[candidate.source] || 0;

  return Number(Math.min(1.2, exactish * 0.45 + overlap * 0.45 + metadataBonus + sourceBonus).toFixed(3));
}

export function dedupeSparseCandidates(query: string, candidates: SparseCandidate[]): SparseCandidate[] {
  const bucket = new Map<string, SparseCandidate>();

  candidates.forEach((candidate) => {
    if (!candidate || !candidate.title) {
      return;
    }

    candidate.score = scoreSparseCandidate(query, candidate);
    const key = normalizeForCompare(
      [candidate.title, formatAuthorsDisplay(candidate.authors), candidate.year].join(' ')
    );

    if (!bucket.has(key) || (bucket.get(key)?.score || 0) < candidate.score) {
      bucket.set(key, candidate);
    }
  });

  return Array.from(bucket.values())
    .filter((candidate) => candidate.score >= 0.18)
    .sort((left, right) => right.score - left.score)
    .slice(0, 8);
}

export function attachSearchMetadata(
  parsed: ParsedCitation | null,
  candidates: SparseCandidate[],
  bestCandidate: SparseCandidate | null
): ParsedCitation | null {
  if (!parsed) {
    return null;
  }

  return {
    ...parsed,
    _searchEnriched: Boolean(bestCandidate),
    _searchCandidateCount: candidates.length,
    _searchCandidateSource: bestCandidate ? bestCandidate.source : '',
    _searchCandidateScore: bestCandidate ? bestCandidate.score : 0
  };
}

export function buildSparseCandidatePrompt(
  rawText: string,
  fallbackParsed: ParsedCitation,
  candidates: SparseCandidate[]
): string {
  const fallbackPreview = {
    title: fallbackParsed.title || null,
    subtitle: fallbackParsed.subtitle || null,
    authors: fallbackParsed.authors || [],
    year: fallbackParsed.year || null,
    publisher: fallbackParsed.publisher || null,
    city: fallbackParsed.city || null,
    edition: fallbackParsed.edition || null,
    type: fallbackParsed.type || 'unknown',
    isbn: fallbackParsed.isbn || null,
    doi: fallbackParsed.doi || null
  };

  const candidateLines = candidates
    .map((candidate, index) => {
      const authorLabel = formatAuthorsDisplay(candidate.authors) || 'sem autor';
      return `${index + 1}. ${candidate.title}${candidate.subtitle ? `: ${candidate.subtitle}` : ''} | ${authorLabel} | ${candidate.year || 's/ano'} | ${candidate.publisher || 's/editora'} | ${candidate.source} | score ${candidate.score}`;
    })
    .join('\n');

  return [
    `Raw input: ${rawText}`,
    `Local parser guess: ${JSON.stringify(fallbackPreview)}`,
    candidates.length ? `Catalog candidates:\n${candidateLines}` : 'Catalog candidates: none',
    'Task: return only JSON with keys authors, title, subtitle, year, publisher, city, edition, type, isbn, doi.',
    'If the input is sparse or title-only, choose the most likely exact work from the candidate list.',
    'Prefer book/catalog candidates when the input looks like a book title or a classic work.',
    'Do not replace a book with an article, review, essay, chapter, or thesis that merely discusses the book.',
    'Do not override author names explicitly present in the raw input with authors from an article about the work.',
    'Prefer candidates with strong title overlap and richer metadata.',
    'Do not invent fields unsupported by the input or candidates. Use null when unknown.'
  ].join('\n\n');
}

export function compareTitleOverlap(left: string, right: string): number {
  const leftTokens = new Set(tokenize(left));
  const rightTokens = new Set(tokenize(right));
  if (!leftTokens.size || !rightTokens.size) {
    return 0;
  }

  let matches = 0;
  leftTokens.forEach((token) => {
    if (rightTokens.has(token)) {
      matches += 1;
    }
  });

  return matches / Math.max(leftTokens.size, 1);
}

export function textContainsMeaningfulDifference(left: string, right: string): boolean {
  return normalizeForCompare(left) !== normalizeForCompare(right) && stripDiacritics(left) !== stripDiacritics(right);
}
