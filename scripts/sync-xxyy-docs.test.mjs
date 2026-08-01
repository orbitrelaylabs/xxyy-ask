import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  classifyPageContent,
  cleanMarkdownArtifacts,
  createPageFilename,
  extractAssetIds,
  extractCuratedAppendix,
  extractOriginalAssetUrls,
  markdownUrlFor,
  parseSitemap,
  rewriteAssetReferences,
  stripGitbookMarkdownPreamble,
  syncXxyyDocs,
} from './sync-xxyy-docs.mjs';

describe('docs.xxyy.io sync helpers', () => {
  it('parses sitemap pages with optional lastmod values', () => {
    expect(
      parseSitemap(
        [
          '<urlset>',
          '<url><loc>https://docs.xxyy.io</loc><lastmod>2026-07-19T00:00:00.000Z</lastmod></url>',
          '<url><loc>https://docs.xxyy.io/changelog</loc></url>',
          '</urlset>',
        ].join(''),
        'zh',
      ),
    ).toEqual([
      {
        language: 'zh',
        lastmod: '2026-07-19T00:00:00.000Z',
        sourceUrl: 'https://docs.xxyy.io',
      },
      {
        language: 'zh',
        lastmod: null,
        sourceUrl: 'https://docs.xxyy.io/changelog',
      },
    ]);
  });

  it('uses GitBook root Markdown and stable flat filenames', () => {
    expect(markdownUrlFor('https://docs.xxyy.io')).toBe('https://docs.xxyy.io/readme.md');
    expect(markdownUrlFor('https://docs.xxyy.io/en')).toBe('https://docs.xxyy.io/en.md');
    expect(createPageFilename(101, 'https://docs.xxyy.io/en/chart-area/avg.-price-line')).toBe(
      '101-en__chart-area__avg-price-line.md',
    );
  });

  it('classifies useful, empty, and GitBook not-found pages for ingestion', () => {
    expect(classifyPageContent('Swap', '# Swap\n\nChoose a wallet and amount.')).toBe('content');
    expect(classifyPageContent('Trading on XXYY', '# Trading on XXYY')).toBe('empty');
    expect(
      classifyPageContent(
        'Page Not Found',
        '# Page Not Found\n\nThe URL `en` does not exist. This page may have been moved.',
      ),
    ).toBe('not_found');
  });

  it('extracts GitBook assets, rewrites them locally, and preserves curated blocks', () => {
    const markdown = [
      '> For the complete documentation index, see [llms.txt](https://docs.xxyy.io/llms.txt).',
      '',
      '# Page',
      '',
      '<figure><img src="/files/AssetOne" alt=""></figure>',
      '<a href="/files/AssetOne">icon</a>',
    ].join('\n');
    const original = 'https://assets.example/screenshot.png?token=public';
    const html = `<img data-testid="zoom-image" src="https://docs.xxyy.io/~gitbook/image?url=${encodeURIComponent(
      original,
    )}&amp;width=768">`;

    expect(extractAssetIds(markdown)).toEqual(['AssetOne']);
    expect(extractOriginalAssetUrls(html)).toEqual([original]);
    expect(stripGitbookMarkdownPreamble(markdown).startsWith('# Page')).toBe(true);
    expect(
      rewriteAssetReferences(markdown, new Map([['AssetOne', { file: 'local.png' }]])),
    ).toContain('/assets/local.png');
    expect(
      extractCuratedAppendix(
        '# Page\n\n<!-- xxyy-ask:curated-start -->\n客服补充\n<!-- xxyy-ask:curated-end -->\n',
      ),
    ).toContain('客服补充');
    expect(
      cleanMarkdownArtifacts(
        '支持5大公链，SOL BSC Base ETH[ ](https://x.com/hashtag/XLayer)Robinhood',
      ),
    ).toBe('支持5大公链，SOL BSC Base ETH Robinhood');
  });
});

describe('syncXxyyDocs', () => {
  it('syncs both languages and assets while retaining supplemental knowledge', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'xxyy-docs-sync-'));
    const productDir = path.join(cwd, 'docs', 'product-features');
    const pagesDir = path.join(productDir, 'pages');
    await mkdir(pagesDir, { recursive: true });
    await writeFile(
      path.join(pagesDir, '01-welcome.md'),
      [
        '---',
        'title: "Old welcome"',
        '---',
        '# Old welcome',
        '',
        '<!-- xxyy-ask:curated-start -->',
        '本地客服补充。',
        '<!-- xxyy-ask:curated-end -->',
        '',
      ].join('\n'),
    );
    await writeFile(path.join(pagesDir, '02-local.md'), '# Local support\n');
    await writeFile(
      path.join(productDir, 'manifest.jsonl'),
      [
        JSON.stringify({
          order: 1,
          title: 'Old welcome',
          source_url: 'https://docs.xxyy.io',
          source_markdown_url: 'https://docs.xxyy.io/readme.md',
          category: '产品概览',
          section: '产品概览',
          lastmod: 'old',
          retrieved_at: '2026-01-01T00:00:00.000Z',
          file: '01-welcome.md',
        }),
        JSON.stringify({
          order: 2,
          title: 'Local support',
          source_url: 'https://docs.xxyy.io',
          source_markdown_url: 'https://docs.xxyy.io/readme.md',
          file: '02-local.md',
        }),
        '',
      ].join('\n'),
    );

    const assetSource = 'https://assets.example/welcome.png?token=public';
    const fetchImpl = createFakeFetch(
      new Map([
        [
          'https://docs.xxyy.io/sitemap-pages.xml',
          responseFactory(
            '<urlset><url><loc>https://docs.xxyy.io</loc><lastmod>2026-07-19T00:00:00.000Z</lastmod></url></urlset>',
            'application/xml',
          ),
        ],
        [
          'https://docs.xxyy.io/en/sitemap-pages.xml',
          responseFactory(
            '<urlset><url><loc>https://docs.xxyy.io/en</loc></url></urlset>',
            'application/xml',
          ),
        ],
        [
          'https://docs.xxyy.io/readme.md',
          responseFactory(
            [
              '> For the complete documentation index, see [llms.txt](https://docs.xxyy.io/llms.txt).',
              '',
              '# 欢迎使用 XXYY',
              '',
              '<figure><img src="/files/AssetOne" alt=""></figure>',
            ].join('\n'),
            'text/markdown',
          ),
        ],
        [
          'https://docs.xxyy.io',
          responseFactory(
            `<html><img data-testid="zoom-image" src="https://docs.xxyy.io/~gitbook/image?url=${encodeURIComponent(
              assetSource,
            )}&amp;width=768"></html>`,
            'text/html',
          ),
        ],
        [
          'https://docs.xxyy.io/en.md',
          responseFactory('# Welcome to XXYY\n\nEnglish documentation.\n', 'text/markdown'),
        ],
        ['https://docs.xxyy.io/en', responseFactory('<html></html>', 'text/html')],
        [assetSource, responseFactory(Uint8Array.from([1, 2, 3]), 'image/png')],
      ]),
    );

    const result = await syncXxyyDocs({
      cwd,
      fetchImpl,
      now: () => new Date('2026-07-19T12:00:00.000Z'),
    });

    expect(result).toMatchObject({
      assetBytes: 3,
      assetCount: 1,
      chinesePageCount: 1,
      englishPageCount: 1,
      pageCount: 2,
    });
    const manifest = (await readFile(path.join(productDir, 'manifest.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(JSON.parse);
    expect(manifest).toHaveLength(3);
    expect(manifest[0]).toMatchObject({
      file: '01-welcome.md',
      language: 'zh',
      site_page: true,
      title: '欢迎使用 XXYY',
    });
    expect(manifest[1]).toMatchObject({ file: '02-local.md', order: 2 });
    expect(manifest[2]).toMatchObject({ file: '03-en.md', language: 'en', site_page: true });

    const welcome = await readFile(path.join(pagesDir, '01-welcome.md'), 'utf8');
    expect(welcome).toContain('/assets/xxyy-docs-AssetOne.png');
    expect(welcome).toContain('本地客服补充。');
    expect(welcome).not.toContain('For the complete documentation index');
    expect(await readFile(path.join(productDir, 'assets', 'xxyy-docs-AssetOne.png'))).toEqual(
      Buffer.from([1, 2, 3]),
    );
    expect(await readFile(path.join(productDir, 'README.md'), 'utf8')).toContain(
      '官网合计：2 个页面',
    );
  });
});

function createFakeFetch(factories) {
  return async (input) => {
    const url = String(input);
    const factory = factories.get(url);
    if (factory === undefined) {
      return new Response(`Unexpected URL: ${url}`, { status: 404 });
    }
    return factory();
  };
}

function responseFactory(body, contentType) {
  return () =>
    new Response(body, {
      headers: { 'content-type': contentType },
      status: 200,
    });
}
