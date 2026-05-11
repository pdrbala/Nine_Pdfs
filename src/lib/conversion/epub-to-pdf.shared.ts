import { XMLParser } from 'fast-xml-parser';
import JSZip from 'jszip';
import type {
  EpubChapter,
  EpubMetadata,
  EpubToPdfOptions
} from '$lib/conversion/types';
import { DEFAULT_EPUB_TO_PDF_OPTIONS } from '$lib/conversion/types';
import { normalizeWhitespace } from '$lib/utils';

type XmlNode = Record<string, unknown>;

interface ManifestItem {
  id: string;
  href: string;
  mediaType: string;
  properties: string;
}

export interface ParsedEpub {
  metadata: EpubMetadata;
  chapters: EpubChapter[];
  coverImage: Uint8Array | null;
  coverImageMediaType: string | null;
  warnings: string[];
}

export const MAX_EPUB_BYTES = 80 * 1024 * 1024;

const TEXT_MEDIA_TYPES = new Set([
  'application/xhtml+xml',
  'text/html',
  'application/xml',
  'text/xml'
]);

const IMAGE_MEDIA_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png']);

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: false
});

function toArray<T>(value: T | T[] | null | undefined): T[] {
  if (Array.isArray(value)) {
    return value;
  }
  return value === null || value === undefined ? [] : [value];
}

function asNode(value: unknown): XmlNode {
  return value && typeof value === 'object' ? (value as XmlNode) : {};
}

function attr(node: unknown, name: string): string {
  const record = asNode(node);
  return normalizeWhitespace(String(record[`@_${name}`] || record[name] || ''));
}

function textValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string' || typeof value === 'number') {
    return normalizeWhitespace(String(value));
  }

  const record = asNode(value);
  return normalizeWhitespace(String(record['#text'] || record._ || ''));
}

function pickFirstText(node: XmlNode, keys: string[]): string {
  for (const key of keys) {
    const value = node[key];
    const text = textValue(Array.isArray(value) ? value[0] : value);
    if (text) {
      return text;
    }
  }
  return '';
}

function pickAllText(node: XmlNode, keys: string[]): string[] {
  return keys
    .flatMap((key) => toArray(node[key]))
    .map((entry) => textValue(entry))
    .filter(Boolean);
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function htmlToText(html: string): { title: string; text: string } {
  const withoutUnsafeBlocks = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ');

  const headingMatch = withoutUnsafeBlocks.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i);
  const titleMatch = withoutUnsafeBlocks.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = decodeEntities((headingMatch?.[1] || titleMatch?.[1] || '').replace(/<[^>]+>/g, ' '));

  const text = decodeEntities(
    withoutUnsafeBlocks
      .replace(/<\/(h[1-6]|p|div|section|article|blockquote|li|tr)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li[^>]*>/gi, '\n- ')
      .replace(/<[^>]+>/g, ' ')
  )
    .split('\n')
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean)
    .join('\n\n');

  return {
    title: normalizeWhitespace(title),
    text
  };
}

function normalizeZipPath(basePath: string, href: string): string {
  const decodedHref = decodeURIComponent(href);
  const hrefParts = decodedHref.startsWith('/')
    ? decodedHref.split('/')
    : [...basePath.split('/').slice(0, -1), ...decodedHref.split('/')];
  const normalized: string[] = [];

  hrefParts.forEach((part) => {
    if (!part || part === '.') {
      return;
    }
    if (part === '..') {
      normalized.pop();
      return;
    }
    normalized.push(part);
  });

  return normalized.join('/');
}

function getPackageDocument(parsed: unknown): XmlNode {
  const root = asNode(parsed);
  return asNode(root.package || root['opf:package']);
}

function getMetadata(packageDocument: XmlNode): EpubMetadata {
  const metadataNode = asNode(packageDocument.metadata);
  const title = pickFirstText(metadataNode, ['dc:title', 'title']) || 'EPUB convertido';
  const authors = pickAllText(metadataNode, ['dc:creator', 'creator']);

  return {
    title,
    authors,
    language: pickFirstText(metadataNode, ['dc:language', 'language']) || null,
    publisher: pickFirstText(metadataNode, ['dc:publisher', 'publisher']) || null,
    date: pickFirstText(metadataNode, ['dc:date', 'date']) || null
  };
}

function getManifestItems(packageDocument: XmlNode): ManifestItem[] {
  const manifestNode = asNode(packageDocument.manifest);
  return toArray(manifestNode.item)
    .map((item) => ({
      id: attr(item, 'id'),
      href: attr(item, 'href'),
      mediaType: attr(item, 'media-type').toLowerCase(),
      properties: attr(item, 'properties').toLowerCase()
    }))
    .filter((item) => item.id && item.href);
}

function getSpineIds(packageDocument: XmlNode): string[] {
  const spineNode = asNode(packageDocument.spine);
  return toArray(spineNode.itemref)
    .map((item) => attr(item, 'idref'))
    .filter(Boolean);
}

function getCoverImageId(packageDocument: XmlNode, manifestItems: ManifestItem[]): string {
  const metadataNode = asNode(packageDocument.metadata);
  const metaCover = toArray(metadataNode.meta).find((meta) => attr(meta, 'name').toLowerCase() === 'cover');
  const coverFromMeta = metaCover ? attr(metaCover, 'content') : '';
  if (coverFromMeta) {
    return coverFromMeta;
  }

  return manifestItems.find((item) => item.properties.split(/\s+/).includes('cover-image'))?.id || '';
}

export function sanitizePdfText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

export function sanitizeEpubPdfFilename(value: string): string {
  return (
    normalizeWhitespace(value)
      .replace(/[\/\\?%*:|"<>]/g, '')
      .replace(/\s+/g, '_')
      .slice(0, 80) || 'epub_convertido'
  );
}

async function readZipText(zip: JSZip, filename: string): Promise<string> {
  const file = zip.file(filename);
  if (!file) {
    throw new Error(`Arquivo ausente no EPUB: ${filename}`);
  }
  return file.async('text');
}

export async function parseEpub(bytes: Uint8Array): Promise<ParsedEpub> {
  if (!bytes.byteLength) {
    throw new Error('Arquivo EPUB vazio.');
  }
  if (bytes.byteLength > MAX_EPUB_BYTES) {
    throw new Error('EPUB maior que 80 MB. Reduza o arquivo antes de converter.');
  }

  const zip = await JSZip.loadAsync(bytes);
  if (zip.file('META-INF/encryption.xml')) {
    throw new Error('EPUB com criptografia/DRM nao suportado pelo conversor interno.');
  }

  const containerXml = await readZipText(zip, 'META-INF/container.xml');
  const container = asNode(xmlParser.parse(containerXml).container);
  const rootfiles = asNode(container.rootfiles);
  const rootfile = toArray(rootfiles.rootfile)[0];
  const packagePath = attr(rootfile, 'full-path');
  if (!packagePath) {
    throw new Error('OPF principal nao encontrado no EPUB.');
  }

  const packageXml = await readZipText(zip, packagePath);
  const packageDocument = getPackageDocument(xmlParser.parse(packageXml));
  const metadata = getMetadata(packageDocument);
  const manifestItems = getManifestItems(packageDocument);
  const manifestById = new Map(manifestItems.map((item) => [item.id, item]));
  const spineIds = getSpineIds(packageDocument);
  const warnings: string[] = [];

  const chapters: EpubChapter[] = [];
  for (const id of spineIds) {
    const item = manifestById.get(id);
    if (!item || !TEXT_MEDIA_TYPES.has(item.mediaType)) {
      continue;
    }

    const chapterPath = normalizeZipPath(packagePath, item.href);
    const chapterHtml = await readZipText(zip, chapterPath);
    const parsedChapter = htmlToText(chapterHtml);
    if (!parsedChapter.text) {
      warnings.push(`Capitulo sem texto extraivel: ${item.href}`);
      continue;
    }

    chapters.push({
      id,
      href: item.href,
      title: parsedChapter.title || `Capitulo ${chapters.length + 1}`,
      text: parsedChapter.text
    });
  }

  if (!chapters.length) {
    throw new Error('Nenhum capitulo XHTML/HTML com texto foi encontrado no EPUB.');
  }

  let coverImage: Uint8Array | null = null;
  let coverImageMediaType: string | null = null;
  const coverImageId = getCoverImageId(packageDocument, manifestItems);
  const coverItem = coverImageId ? manifestById.get(coverImageId) : null;
  if (coverItem && IMAGE_MEDIA_TYPES.has(coverItem.mediaType)) {
    const coverPath = normalizeZipPath(packagePath, coverItem.href);
    const coverFile = zip.file(coverPath);
    coverImage = coverFile ? await coverFile.async('uint8array') : null;
    coverImageMediaType = coverImage ? coverItem.mediaType : null;
  }

  return {
    metadata,
    chapters,
    coverImage,
    coverImageMediaType,
    warnings
  };
}

export function normalizeEpubToPdfOptions(
  partial: Partial<EpubToPdfOptions> = {}
): EpubToPdfOptions {
  const margin = Number(partial.margin);
  return {
    ...DEFAULT_EPUB_TO_PDF_OPTIONS,
    ...partial,
    pageSize: partial.pageSize === 'Letter' ? 'Letter' : 'A4',
    margin: Number.isFinite(margin)
      ? Math.min(Math.max(margin, 24), 96)
      : DEFAULT_EPUB_TO_PDF_OPTIONS.margin,
    includeCover: partial.includeCover !== false,
    includeToc: partial.includeToc !== false
  };
}
