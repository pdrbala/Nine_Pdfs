// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  buildAmazonSearchUrl,
  parseAmazonBookDetailHtml,
  parseAmazonSearchHtml,
  pickOfficialAmazonCandidate
} from '$lib/amazon';

const searchFixture = `
  <div data-component-type="s-search-result" data-asin="B0SPONSORED1" data-index="1">
    <span class="puis-sponsored-label-text">Patrocinado</span>
    <div data-cy="title-recipe">
      <a href="/Resumo-Dom-Quixote/dp/B0SPONSORED1/ref=sr_1_1">
        <h2 aria-label="Resumo Dom Quixote"><span>Resumo Dom Quixote</span></h2>
      </a>
      <div class="a-row a-size-base a-color-secondary">
        Edição Português | por Leitor Anônimo | 2024
      </div>
    </div>
    <div data-cy="price-recipe">
      <a class="a-size-base a-link-normal a-text-bold">Kindle</a>
      <span class="a-price"><span class="a-offscreen">R$ 9,90</span></span>
    </div>
  </div>
  <div data-component-type="s-search-result" data-asin="8563560557" data-index="2">
    <div data-cy="title-recipe">
      <a href="/Caixa-Dom-Quixote-Miguel-Cervantes/dp/8563560557/ref=sr_1_2">
        <h2 aria-label="Caixa Dom Quixote"><span>Caixa Dom Quixote</span></h2>
      </a>
      <div class="a-row a-size-base a-color-secondary">
        Edição Português | por Miguel de Cervantes e Ernani Ssó | 5 dez. 2012
      </div>
    </div>
    <img class="s-image" src="https://m.media-amazon.com/images/I/91vMtIeykDL._AC_UY218_.jpg" />
    <div data-cy="reviews-block">
      <i data-cy="reviews-ratings-slot"><span class="a-icon-alt">4,8 de 5 estrelas</span></i>
      <a aria-label="1.995 classificações"><span>(1.995)</span></a>
    </div>
    <div data-cy="price-recipe">
      <a class="a-size-base a-link-normal a-text-bold">Capa Comum</a>
      <span class="a-price"><span class="a-offscreen">R$ 102,97</span></span>
    </div>
  </div>
`;

const detailFixture = `
  <html>
    <head>
      <link rel="canonical" href="https://www.amazon.com.br/dp/8563560557" />
    </head>
    <body>
      <input id="ASIN" value="8563560557" />
      <span id="productTitle"> Caixa Dom Quixote </span>
      <span id="productSubtitle"> Capa comum - 5 dezembro 2012 </span>
      <div id="bylineInfo">
        Edição Português
        <span class="author notFaded">
          <a href="/Miguel-de-Cervantes/e/B086HMJ6MH">Miguel de Cervantes</a>
          <span class="contribution"><span>(Autor), </span></span>
        </span>
        <span class="author notFaded">
          <a href="/s?field-author=Ernani+Sso">Ernani Ssó</a>
          <span class="contribution"><span>(Tradutor)</span></span>
        </span>
      </div>
      <span id="acrPopover" title="4,8 de 5 estrelas">
        <span class="a-icon-alt">4,8 de 5 estrelas</span>
      </span>
      <span id="acrCustomerReviewText" aria-label="1.995 Análises">(1.995)</span>
      <img id="landingImage" data-a-dynamic-image='{"https://img.test/full.jpg":[1000,1500]}' />
      <span id="tp_price_block_total_price_ww"><span class="a-offscreen">R$ 102,97</span></span>
      <span class="a-text-price"><span class="a-offscreen">R$ 159,90</span></span>
      <div id="availability"><span> Em estoque </span></div>
      <div id="bookDescription_feature_div">
        <div class="a-expander-content">
          O clássico fundador do romance moderno em nova tradução.
        </div>
      </div>
      <div id="wayfinding-breadcrumbs_feature_div">
        <a>Livros</a><a>Literatura e Ficção</a>
      </div>
      <div id="detailBullets_feature_div">
        <ul class="detail-bullet-list">
          <li><span class="a-list-item"><span class="a-text-bold">Editora : </span><span>Penguin-Companhia</span></span></li>
          <li><span class="a-list-item"><span class="a-text-bold">Data da publicação : </span><span>5 dezembro 2012</span></span></li>
          <li><span class="a-list-item"><span class="a-text-bold">Edição : </span><span>1ª</span></span></li>
          <li><span class="a-list-item"><span class="a-text-bold">Idioma : </span><span>Português</span></span></li>
          <li><span class="a-list-item"><span class="a-text-bold">Número de páginas : </span><span>1328 páginas</span></span></li>
          <li><span class="a-list-item"><span class="a-text-bold">ISBN-10 : </span><span>8563560557</span></span></li>
          <li><span class="a-list-item"><span class="a-text-bold">ISBN-13 : </span><span>978-8563560551</span></span></li>
          <li><span class="a-list-item"><span class="a-text-bold">Peso do produto : </span><span>1,3 Kilograms</span></span></li>
          <li><span class="a-list-item"><span class="a-text-bold">Dimensões : </span><span>20.4 x 13.4 x 7 cm</span></span></li>
          <li>
            <span class="a-list-item">
              <span class="a-text-bold"> Ranking dos mais vendidos: </span>
              Nº 3.769 em Livros
              <ul class="zg_hrsr">
                <li><span class="a-list-item">Nº 232 em <a>Clássicos de Ficção</a></span></li>
              </ul>
            </span>
          </li>
        </ul>
      </div>
    </body>
  </html>
`;

describe('amazon scraper', () => {
  it('builds a Brazilian Amazon books search URL', () => {
    const url = buildAmazonSearchUrl('Dom Quixote');

    expect(url).toContain('https://www.amazon.com.br/s?');
    expect(url).toContain('k=Dom+Quixote');
    expect(url).toContain('i=stripbooks');
  });

  it('parses search candidates and prefers the organic official product result', () => {
    const candidates = parseAmazonSearchHtml(searchFixture, {
      query: 'Dom Quixote',
      marketplace: 'com.br',
      baseUrl: 'https://www.amazon.com.br/s?k=Dom+Quixote&i=stripbooks'
    });
    const selected = pickOfficialAmazonCandidate(candidates);

    expect(candidates).toHaveLength(2);
    expect(selected?.asin).toBe('8563560557');
    expect(selected?.isSponsored).toBe(false);
    expect(selected?.authors).toEqual(['Miguel de Cervantes', 'Ernani Ssó']);
    expect(selected?.reviewCount).toBe(1995);
    expect(selected?.price?.currency).toBe('BRL');
    expect(selected?.officialSignals).toContain('canonical_dp_url');
  });

  it('extracts structured book details from the Amazon detail page', () => {
    const book = parseAmazonBookDetailHtml(detailFixture, {
      marketplace: 'com.br',
      baseUrl: 'https://www.amazon.com.br/dp/8563560557',
      extractedAt: '2026-05-07T00:00:00.000Z'
    });

    expect(book.title).toBe('Caixa Dom Quixote');
    expect(book.asin).toBe('8563560557');
    expect(book.publisher).toBe('Penguin-Companhia');
    expect(book.pages).toBe(1328);
    expect(book.isbn13).toBe('978-8563560551');
    expect(book.authors.map((author) => author.role)).toEqual(['Autor', 'Tradutor']);
    expect(book.categories).toContain('Clássicos de Ficção');
    expect(book.price?.amount).toBe(102.97);
    expect(book.confidence).toBeGreaterThan(0.8);
  });
});
