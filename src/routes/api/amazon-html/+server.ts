import type { RequestHandler } from './$types';

const AMAZON_PROXY_TIMEOUT_MS = 12000;
const ALLOWED_AMAZON_HOSTS = new Set([
  'amazon.com',
  'www.amazon.com',
  'amazon.com.br',
  'www.amazon.com.br',
  'amazon.co.uk',
  'www.amazon.co.uk',
  'amazon.ca',
  'www.amazon.ca',
  'amazon.de',
  'www.amazon.de',
  'amazon.es',
  'www.amazon.es',
  'amazon.fr',
  'www.amazon.fr',
  'amazon.it',
  'www.amazon.it',
  'amazon.com.mx',
  'www.amazon.com.mx',
  'amazon.co.jp',
  'www.amazon.co.jp',
  'amazon.com.au',
  'www.amazon.com.au',
  'amazon.in',
  'www.amazon.in'
]);

export const GET: RequestHandler = async ({ url, fetch }) => {
  const target = url.searchParams.get('url') || '';
  const parsedTarget = parseAmazonUrl(target);

  if (!parsedTarget) {
    return new Response('Amazon URL inválida', {
      status: 400,
      headers: { 'content-type': 'text/plain; charset=utf-8' }
    });
  }

  const attempts = [
    { via: 'direct', url: parsedTarget },
    { via: 'allorigins', url: `https://api.allorigins.win/raw?url=${encodeURIComponent(parsedTarget)}` },
    { via: 'corsproxy', url: `https://corsproxy.io/?url=${encodeURIComponent(parsedTarget)}` },
    { via: 'codetabs', url: `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(parsedTarget)}` }
  ];

  let lastError = 'Falha ao buscar Amazon';
  let lastStatus = 502;

  for (const attempt of attempts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AMAZON_PROXY_TIMEOUT_MS);

    try {
      const response = await fetch(attempt.url, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
          'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
        }
      });
      const html = await response.text();

      if (!response.ok) {
        lastStatus = response.status;
        lastError = html || `HTTP ${response.status}`;
        continue;
      }

      return new Response(html, {
        status: response.status,
        headers: {
          'content-type': response.headers.get('content-type') || 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-amazon-fetch-via': attempt.via,
          'x-amazon-final-url': attempt.via === 'direct' ? response.url || parsedTarget : parsedTarget
        }
      });
    } catch (unknownError) {
      lastStatus = 502;
      lastError = unknownError instanceof Error ? unknownError.message : 'Falha ao buscar Amazon';
    } finally {
      clearTimeout(timer);
    }
  }

  return new Response(lastError, {
    status: lastStatus >= 400 ? lastStatus : 502,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
};

function parseAmazonUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();

    if (parsed.protocol !== 'https:' || !ALLOWED_AMAZON_HOSTS.has(host)) {
      return null;
    }

    return parsed.toString();
  } catch {
    return null;
  }
}
