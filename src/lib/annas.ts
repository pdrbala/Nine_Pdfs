const ANNAS_BASE_URL = 'https://annas-archive.gl';

const ANNAS_PROXY_CHAIN: ((url: string) => string)[] = [
  (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
  (url) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(url)}`,
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url) => `https://thingproxy.freeboard.io/fetch/${url}`
];

const ANNAS_PROXY_TIMEOUT_MS = 8000;

async function fetchWithTimeout(target: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(target, {
      method: 'GET',
      signal: controller.signal,
      headers: { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' }
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAnnasHtml(url: string): Promise<string> {
  let lastError: unknown = null;
  for (const buildAttempt of ANNAS_PROXY_CHAIN) {
    const attempt = buildAttempt(url);
    try {
      const res = await fetchWithTimeout(attempt, ANNAS_PROXY_TIMEOUT_MS);
      if (!res.ok) {
        lastError = new Error(`HTTP ${res.status}`);
        continue;
      }
      const html = await res.text();
      if (html && html.includes('js-vim-focus')) {
        return html;
      }
      lastError = new Error('proxy returned page without anchors');
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Anna's Archive indisponível");
}

const FORMAT_PATTERN = /^(PDF|EPUB|MOBI|AZW3?|DJVU|CBZ|CBR|FB2|TXT|RTF|DOC|DOCX|HTML|ZIP|RAR|7Z)$/i;
const SIZE_PATTERN = /^\d+(\.\d+)?\s*[KMG]B$/i;
const YEAR_PATTERN = /^(1[5-9]\d{2}|20\d{2}|21\d{2})$/;
const LANG_PATTERN = /\[([a-z]{2,3})\]/;

export interface AnnasResult {
  md5: string;
  title: string;
  detailUrl: string;
  authors: string;
  publisher: string;
  description: string;
  coverUrl: string | null;
  filePath: string;
  language: string;
  fileFormat: string;
  size: string;
  year: string;
  contentType: string;
  rawMeta: string;
}

export interface AnnasSearchOptions {
  lang?: string | string[];
  ext?: string | string[];
  sort?: string;
  page?: number;
}

function asList(value: string | string[] | undefined): string[] {
  if (!value) return [];
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return value.filter(Boolean);
}

export function buildAnnasSearchUrl(query: string, opts: AnnasSearchOptions = {}): string {
  const params = new URLSearchParams();
  params.append('q', query);
  asList(opts.lang).forEach((value) => params.append('lang', value));
  asList(opts.ext).forEach((value) => params.append('ext', value));
  if (opts.sort) {
    params.append('sort', opts.sort);
  }
  if (opts.page) {
    params.append('page', String(opts.page));
  }
  return `${ANNAS_BASE_URL}/search?${params.toString()}`;
}

function classOf(node: Element): string {
  return node.getAttribute('class') || '';
}

function findDescendant(
  node: Element,
  predicate: (el: Element) => boolean,
  selector = '*'
): Element | null {
  const matches = node.querySelectorAll(selector);
  for (const el of Array.from(matches)) {
    if (predicate(el)) {
      return el;
    }
  }
  return null;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function parseMetaLine(meta: string): {
  language: string;
  fileFormat: string;
  size: string;
  year: string;
  contentType: string;
} {
  const out = { language: '', fileFormat: '', size: '', year: '', contentType: '' };
  const parts = meta
    .split('·')
    .map((part) => part.trim())
    .filter(Boolean);

  for (const part of parts) {
    const clean = part.replace(/^[^\w\[]+/, '').trim();
    if (!out.language && LANG_PATTERN.test(clean)) {
      out.language = clean;
      continue;
    }
    if (!out.fileFormat && FORMAT_PATTERN.test(clean)) {
      out.fileFormat = clean.toUpperCase();
      continue;
    }
    if (!out.size && SIZE_PATTERN.test(clean)) {
      out.size = clean;
      continue;
    }
    if (!out.year && YEAR_PATTERN.test(clean)) {
      out.year = clean;
      continue;
    }
    if (!out.contentType && /[a-z]/i.test(clean) && !LANG_PATTERN.test(clean)) {
      out.contentType = clean;
    }
  }

  return out;
}

function extractResult(content: Element, coverAnchor: Element | null): AnnasResult | null {
  const titleAnchor = findDescendant(
    content,
    (el) => el.tagName === 'A' && classOf(el).split(/\s+/).includes('js-vim-focus'),
    'a'
  );
  if (!titleAnchor) {
    return null;
  }

  const href = titleAnchor.getAttribute('href') || '';
  if (!href.includes('/md5/')) {
    return null;
  }

  const md5 = href.split('/md5/')[1]?.split(/[?#]/)[0] ?? '';
  if (!md5) {
    return null;
  }

  const title = collapseWhitespace(titleAnchor.textContent || '');

  const authorsParts: string[] = [];
  const publisherParts: string[] = [];

  for (const anchor of Array.from(content.querySelectorAll('a'))) {
    const aHref = anchor.getAttribute('href') || '';
    if (!aHref.startsWith('/search?q=')) continue;

    const iconSpan = anchor.querySelector('span');
    const iconClass = iconSpan?.getAttribute('class') || '';
    const text = collapseWhitespace(anchor.textContent || '');
    if (!text) continue;

    if (iconClass.includes('mdi--user-edit')) {
      authorsParts.push(text);
    } else if (iconClass.includes('mdi--company')) {
      publisherParts.push(text);
    }
  }

  const filePathNode = findDescendant(
    content,
    (el) => {
      const cls = classOf(el);
      return cls.includes('text-gray-500') && cls.includes('font-mono');
    },
    'div'
  );
  const filePath = filePathNode ? collapseWhitespace(filePathNode.textContent || '') : '';

  const descriptionNode = findDescendant(
    content,
    (el) => {
      const cls = classOf(el);
      return cls.includes('text-gray-600') && cls.includes('leading-[1.3]');
    },
    'div'
  );
  const description = descriptionNode ? collapseWhitespace(descriptionNode.textContent || '') : '';

  const metaNode = findDescendant(
    content,
    (el) => {
      const cls = classOf(el);
      return (
        cls.includes('text-gray-800') &&
        cls.includes('font-semibold') &&
        cls.includes('leading-[1.2]') &&
        cls.includes('mt-2')
      );
    },
    'div'
  );

  let rawMeta = '';
  if (metaNode) {
    const ownText = Array.from(metaNode.childNodes)
      .filter((child) => child.nodeType === 3)
      .map((child) => child.textContent || '')
      .join(' ');
    rawMeta = collapseWhitespace((ownText || metaNode.textContent || '').replace(/·\s*$/, ''));
  }
  const parsedMeta = rawMeta ? parseMetaLine(rawMeta) : null;

  let coverUrl: string | null = null;
  if (coverAnchor) {
    const img = coverAnchor.querySelector('img');
    coverUrl = img?.getAttribute('src') || null;
  }

  const detailUrl = `${ANNAS_BASE_URL}${href.startsWith('/') ? href : `/${href}`}`;

  return {
    md5,
    title,
    detailUrl,
    authors: authorsParts.join(', '),
    publisher: publisherParts.join(', '),
    description,
    coverUrl,
    filePath,
    language: parsedMeta?.language || '',
    fileFormat: parsedMeta?.fileFormat || '',
    size: parsedMeta?.size || '',
    year: parsedMeta?.year || '',
    contentType: parsedMeta?.contentType || '',
    rawMeta
  };
}

export function parseAnnasSearchHtml(html: string): AnnasResult[] {
  if (typeof DOMParser === 'undefined') {
    return [];
  }

  const doc = new DOMParser().parseFromString(html, 'text/html');
  const titleAnchors = Array.from(doc.querySelectorAll('a.js-vim-focus'));
  const results: AnnasResult[] = [];
  const seen = new Set<string>();

  for (const titleAnchor of titleAnchors) {
    const href = titleAnchor.getAttribute('href') || '';
    if (!href.includes('/md5/')) continue;

    let content: Element | null = titleAnchor.parentElement;
    for (let i = 0; i < 5; i++) {
      if (!content) break;
      const cls = classOf(content);
      if (cls.includes('flex') && cls.includes('flex-col') && cls.includes('justify-around')) {
        break;
      }
      content = content.parentElement;
    }
    if (!content) continue;

    let coverAnchor: Element | null = null;
    const sibling = content.parentElement;
    if (sibling) {
      for (const child of Array.from(sibling.querySelectorAll('a'))) {
        if (child === titleAnchor) continue;
        const childHref = child.getAttribute('href') || '';
        if (childHref.startsWith('/md5/')) {
          coverAnchor = child;
          break;
        }
      }
    }

    const result = extractResult(content, coverAnchor);
    if (!result || seen.has(result.md5)) continue;
    seen.add(result.md5);
    results.push(result);
  }

  return results;
}

export async function fetchAnnasSearch(
  query: string,
  opts: AnnasSearchOptions = {}
): Promise<AnnasResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const url = buildAnnasSearchUrl(trimmed, opts);
  const html = await fetchAnnasHtml(url);
  if (!html) return [];

  return parseAnnasSearchHtml(html);
}
