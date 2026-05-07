import type { AmazonBook } from '$lib/amazon';
import type { ParsedCitation, SearchResult } from '$lib/types';

export type AmazonCheckStatus = 'matched' | 'pending' | 'unavailable';

export interface AmazonCheckScore {
  status: AmazonCheckStatus;
  score: number | null;
  label: string;
  reasons: string[];
}

const STOPWORDS = new Set([
  'a',
  'o',
  'as',
  'os',
  'de',
  'do',
  'da',
  'dos',
  'das',
  'e',
  'em',
  'para',
  'por',
  'um',
  'uma',
  'the',
  'and',
  'of',
  'book',
  'livro',
  'edicao',
  'edition'
]);

export function buildAmazonReferenceQuery(citation: ParsedCitation, fallback = ''): string {
  const title = normalizeText([citation.title, citation.subtitle].filter(Boolean).join(' '));
  const firstAuthor = citation.authors.find((author) => author.lastName && author.lastName !== 'ET AL.');
  const author = firstAuthor
    ? normalizeText(`${firstAuthor.firstName} ${titleCase(firstAuthor.lastName)}`)
    : '';

  return normalizeText([title || fallback, author, citation.year || ''].filter(Boolean).join(' '));
}

export function scoreAmazonMatch(result: SearchResult, amazonBook: AmazonBook | null): AmazonCheckScore {
  if (!amazonBook) {
    return {
      status: 'unavailable',
      score: null,
      label: 'Amazon Check',
      reasons: ['Amazon indisponível']
    };
  }

  const resultIsbns = extractIsbns(result);
  const amazonIsbns = [amazonBook.isbn10, amazonBook.isbn13].filter(Boolean).map(cleanIsbn);
  const titleScore = tokenSimilarity(result.title, amazonBook.title) ?? 0;
  const authorScore = tokenSimilarity(getResultAuthors(result).join(' '), amazonBook.authors.map((author) => author.name).join(' '));
  const yearScore = compareYears(result.year || result.publishedDate, amazonBook.publicationDate);
  const publisherScore = tokenSimilarity(getResultPublisher(result), amazonBook.publisher || '');
  const isbnScore = compareIsbns(resultIsbns, amazonIsbns);

  const weightedParts: Array<{ value: number; weight: number; reason: string }> = [
    { value: titleScore, weight: 0.58, reason: 'título' }
  ];

  if (authorScore !== null) {
    weightedParts.push({ value: authorScore, weight: 0.22, reason: 'autor' });
  }
  if (yearScore !== null) {
    weightedParts.push({ value: yearScore, weight: 0.08, reason: 'ano' });
  }
  if (publisherScore !== null) {
    weightedParts.push({ value: publisherScore, weight: 0.05, reason: 'editora' });
  }
  if (isbnScore !== null) {
    weightedParts.push({ value: isbnScore, weight: 0.24, reason: 'ISBN' });
  }

  const totalWeight = weightedParts.reduce((sum, part) => sum + part.weight, 0);
  const weightedScore = weightedParts.reduce((sum, part) => sum + part.value * part.weight, 0) / totalWeight;
  const exactIsbn = isbnScore === 1;
  const mismatchedIsbn = isbnScore === 0;
  let score = Math.round(weightedScore * 100);

  if (exactIsbn && titleScore >= 0.34) {
    score = Math.max(score, 92);
  }
  if (!exactIsbn && !mismatchedIsbn && authorScore === null && yearScore === null && publisherScore === null) {
    score = Math.min(score, 86);
  }
  if (titleScore < 0.34 && !exactIsbn) {
    score = Math.min(score, 45);
  }
  if (mismatchedIsbn) {
    score = Math.min(score, 64);
  }

  const reasons = weightedParts
    .filter((part) => part.value >= 0.72)
    .map((part) => `${part.reason} compatível`);

  if (!reasons.length && score > 0) {
    reasons.push('compatibilidade parcial');
  }

  return {
    status: 'matched',
    score: clampScore(score),
    label: 'Amazon Check',
    reasons
  };
}

export function createPendingAmazonCheck(): AmazonCheckScore {
  return {
    status: 'pending',
    score: null,
    label: 'Amazon Check',
    reasons: ['consultando Amazon']
  };
}

function normalizeText(value: string | number | null | undefined): string {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleCase(value: string): string {
  return value
    .toLowerCase()
    .replace(/\p{L}+/gu, (entry) => `${entry.charAt(0).toUpperCase()}${entry.slice(1)}`);
}

function normalizeForCompare(value: string | number | null | undefined): string {
  return normalizeText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ');
}

function tokenize(value: string | number | null | undefined): string[] {
  return normalizeForCompare(value)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

function tokenSimilarity(left: string | number | null | undefined, right: string | number | null | undefined): number | null {
  const leftTokens = new Set(tokenize(left));
  const rightTokens = new Set(tokenize(right));

  if (!leftTokens.size || !rightTokens.size) {
    return null;
  }

  if (normalizeForCompare(left) === normalizeForCompare(right)) {
    return 1;
  }

  let hits = 0;
  leftTokens.forEach((token) => {
    if (rightTokens.has(token)) {
      hits += 1;
    }
  });

  const precision = hits / leftTokens.size;
  const recall = hits / rightTokens.size;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  const leftJoined = Array.from(leftTokens).join(' ');
  const rightJoined = Array.from(rightTokens).join(' ');
  const containmentBoost =
    leftJoined.includes(rightJoined) || rightJoined.includes(leftJoined) ? 0.12 : 0;

  return Math.min(1, f1 + containmentBoost);
}

function getResultAuthors(result: SearchResult): string[] {
  const authors = result.authors?.length ? result.authors : result.author ? [result.author] : [];
  return authors.map((author) => normalizeText(author)).filter(Boolean);
}

function getResultPublisher(result: SearchResult): string {
  const extra = result.extra || {};
  const publisher = extra.publisher || extra.annasPublisher || extra.publicationTitle || '';
  return normalizeText(String(publisher || ''));
}

function compareYears(left: unknown, right: unknown): number | null {
  const leftYear = pickYear(left);
  const rightYear = pickYear(right);

  if (!leftYear || !rightYear) {
    return null;
  }

  return leftYear === rightYear ? 1 : Math.abs(Number(leftYear) - Number(rightYear)) <= 1 ? 0.72 : 0;
}

function pickYear(value: unknown): string | null {
  const match = String(value || '').match(/\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/);
  return match?.[1] || null;
}

function extractIsbns(result: SearchResult): string[] {
  const values: string[] = [];
  collectIsbnValues(result.extra, values);
  return Array.from(new Set(values.map(cleanIsbn).filter(Boolean)));
}

function collectIsbnValues(value: unknown, output: string[]): void {
  if (!value || typeof value !== 'object') {
    return;
  }

  Object.entries(value as Record<string, unknown>).forEach(([key, entry]) => {
    if (/isbn/i.test(key)) {
      if (Array.isArray(entry)) {
        entry.forEach((item) => output.push(String(item || '')));
      } else {
        output.push(String(entry || ''));
      }
      return;
    }

    if (entry && typeof entry === 'object') {
      collectIsbnValues(entry, output);
    }
  });
}

function cleanIsbn(value: string | null | undefined): string {
  return String(value || '').replace(/[^0-9X]/gi, '').toUpperCase();
}

function compareIsbns(left: string[], right: string[]): number | null {
  if (!left.length || !right.length) {
    return null;
  }

  return left.some((entry) => right.includes(entry)) ? 1 : 0;
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, value));
}
