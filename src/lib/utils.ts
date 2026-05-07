import {
  DIRECT_SOURCE_PRIORITY,
  DIRECT_SOURCE_PRIORITY_MAP,
  SOURCE_CONFIDENCE_WEIGHTS,
  STOPWORDS
} from '$lib/constants';
import type { MaterialType, SearchProgress, SearchResult, SourceStatusEntry } from '$lib/types';

export function normalizeWhitespace(value: string | null | undefined): string {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function stripDiacritics(value: string | null | undefined): string {
  return normalizeWhitespace(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

export function normalizeForCompare(value: string | null | undefined): string {
  return stripDiacritics(value)
    .toLowerCase()
    .replace(/[‐‑‒–—―]/g, '-')
    .replace(/&/g, ' and ')
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function normalizeTitleForCompare(value: string | null | undefined): string {
  return normalizeForCompare(value)
    .replace(
      /\b(?:vol|volume|issue|number|numero|num|ed|edition|edicao|revised|revista|journal|artigo|paper)\b/g,
      ' '
    )
    .replace(/\b\d+(?:st|nd|rd|th)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(value: string | null | undefined): string[] {
  return normalizeForCompare(value)
    .split(' ')
    .filter((token) => token && token.length > 2 && !STOPWORDS.has(token));
}

export function titleCaseName(value: string | null | undefined): string {
  return normalizeWhitespace(value)
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map((chunk) => {
      if (/^(da|de|do|dos|das|e|van|von|del|della|di)$/i.test(chunk)) {
        return chunk;
      }
      return chunk.charAt(0).toUpperCase() + chunk.slice(1);
    })
    .join(' ');
}

export function makeManualUrl(baseUrl: string, params: Record<string, string>): string {
  const searchParams = new URLSearchParams(params);
  return `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}${searchParams.toString()}`;
}

export function getSourcePriority(sourceId: string | undefined): number {
  if (!sourceId) {
    return DIRECT_SOURCE_PRIORITY.length + 20;
  }
  return DIRECT_SOURCE_PRIORITY_MAP.has(sourceId)
    ? (DIRECT_SOURCE_PRIORITY_MAP.get(sourceId) as number)
    : DIRECT_SOURCE_PRIORITY.length + 20;
}

export function getSourceConfidenceWeight(sourceId: string | undefined): number {
  if (!sourceId) {
    return 0;
  }

  return SOURCE_CONFIDENCE_WEIGHTS[sourceId] || 0;
}

export function formatMaterialTypeLabel(value: MaterialType): string {
  const labels: Record<MaterialType, string> = {
    book: 'Livro',
    article: 'Artigo',
    thesis: 'Tese / dissertação',
    preprint: 'Preprint',
    report: 'Relatório',
    chapter: 'Capítulo',
    unknown: 'Tipo indefinido'
  };

  return labels[value] || labels.unknown;
}

export function getSearchProgress(
  sourceStatus: Record<string, SourceStatusEntry>,
  results: SearchResult[]
): SearchProgress {
  const entries = Object.values(sourceStatus);
  const total = entries.length;
  const finished = entries.filter((entry) => entry.status !== 'loading').length;
  const found = results.length;
  const percent = total ? Math.round((finished / total) * 100) : 0;

  return {
    total,
    finished,
    found,
    percent,
    remaining: Math.max(total - finished, 0)
  };
}
