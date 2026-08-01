#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DOCS_ORIGIN = 'https://docs.xxyy.io';
const PRODUCT_FEATURES_DIR = path.join('docs', 'product-features');
const PAGES_DIR = 'pages';
const ASSETS_DIR = 'assets';
const MANIFEST_FILE = 'manifest.jsonl';
const README_FILE = 'README.md';
const ASSET_MANIFEST_FILE = 'xxyy-docs-assets.json';
const ASSET_FILE_PREFIX = 'xxyy-docs-';
const CURATED_START = '<!-- xxyy-ask:curated-start -->';
const CURATED_END = '<!-- xxyy-ask:curated-end -->';
const FETCH_CONCURRENCY = 6;
const ASSET_FETCH_CONCURRENCY = 4;

const SITEMAPS = [
  {
    language: 'zh',
    url: `${DOCS_ORIGIN}/sitemap-pages.xml`,
  },
  {
    language: 'en',
    url: `${DOCS_ORIGIN}/en/sitemap-pages.xml`,
  },
];

export async function main() {
  const result = await syncXxyyDocs();
  process.stdout.write(
    [
      `Synced ${result.pageCount} docs.xxyy.io pages (${result.chinesePageCount} Chinese, ${result.englishPageCount} English).`,
      `Downloaded ${result.assetCount} official documentation assets (${formatBytes(result.assetBytes)}).`,
      `Wrote ${path.join(PRODUCT_FEATURES_DIR, PAGES_DIR)} and ${path.join(PRODUCT_FEATURES_DIR, MANIFEST_FILE)}.`,
      'Run `pnpm rag:ingest` to rebuild pgvector from the refreshed source files.',
    ].join('\n') + '\n',
  );
}

export async function syncXxyyDocs(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const productFeaturesDir = path.resolve(cwd, PRODUCT_FEATURES_DIR);
  const pagesDir = path.join(productFeaturesDir, PAGES_DIR);
  const assetsDir = path.join(productFeaturesDir, ASSETS_DIR);
  const manifestPath = path.join(productFeaturesDir, MANIFEST_FILE);
  const existingManifest = await readJsonLines(manifestPath);
  existingManifest.push(
    ...(await discoverUnmanifestedPages(
      pagesDir,
      new Set(existingManifest.map((entry) => entry.file)),
    )),
  );
  const existingSiteEntries = selectExistingSiteEntries(existingManifest);

  const sitemapGroups = await Promise.all(
    SITEMAPS.map(async (sitemap) => {
      const xml = await fetchRequired(fetchImpl, sitemap.url, (response) => response.text());
      const entries = parseSitemap(xml, sitemap.language);
      if (entries.length === 0) {
        throw new Error(`Documentation sitemap is empty: ${sitemap.url}`);
      }
      return entries;
    }),
  );
  const sitemapEntries = sitemapGroups.flat();
  assertUniqueSourceUrls(sitemapEntries);

  const remotePages = await mapWithConcurrency(
    sitemapEntries,
    FETCH_CONCURRENCY,
    async (sitemapEntry) => {
      const sourceMarkdownUrl = markdownUrlFor(sitemapEntry.sourceUrl);
      const [rawMarkdown, html] = await Promise.all([
        fetchRequired(fetchImpl, sourceMarkdownUrl, (response) => response.text()),
        fetchRequired(fetchImpl, sitemapEntry.sourceUrl, (response) => response.text()),
      ]);
      const markdown = stripGitbookMarkdownPreamble(rawMarkdown);
      const assetIds = extractAssetIds(markdown);
      const originalAssetUrls = extractOriginalAssetUrls(html);
      if (assetIds.length !== originalAssetUrls.length) {
        throw new Error(
          `Documentation asset count mismatch for ${sitemapEntry.sourceUrl}: Markdown=${assetIds.length}, HTML=${originalAssetUrls.length}`,
        );
      }

      return {
        ...sitemapEntry,
        assetIds,
        markdown,
        originalAssetUrls,
        sourceMarkdownUrl,
        title: extractPageTitle(markdown),
      };
    },
  );

  const remoteAssets = collectRemoteAssets(remotePages);
  const downloadedAssets = await mapWithConcurrency(
    [...remoteAssets.values()],
    ASSET_FETCH_CONCURRENCY,
    async (asset) => downloadAsset(fetchImpl, asset),
  );
  const assetsById = new Map(downloadedAssets.map((asset) => [asset.id, asset]));
  const syncTimestamp = now().toISOString();
  let nextOrder = getNextManifestOrder(existingManifest);
  const generatedPages = [];

  for (const remotePage of remotePages) {
    const existingEntry = existingSiteEntries.get(normalizeSourceUrl(remotePage.sourceUrl));
    const order = existingEntry?.order ?? nextOrder++;
    const file = existingEntry?.file ?? createPageFilename(order, remotePage.sourceUrl);
    const existingContent = await readOptionalFile(path.join(pagesDir, file));
    const curatedAppendix = extractCuratedAppendix(existingContent ?? '');
    const officialBody = cleanMarkdownArtifacts(
      rewriteAssetReferences(remotePage.markdown, assetsById),
    );
    const body = appendCuratedContent(officialBody, curatedAppendix);
    const derivedMetadata = derivePageMetadata(remotePage.sourceUrl, remotePage.language);
    const category = existingEntry?.category ?? derivedMetadata.category;
    const section = existingEntry?.section ?? derivedMetadata.section;
    const previousBody =
      existingContent === undefined ? undefined : stripFrontmatter(existingContent);
    const sourceUnchanged = previousBody?.trim() === body.trim();
    const lastmodUnchanged = (existingEntry?.lastmod ?? null) === remotePage.lastmod;
    const retrievedAt =
      sourceUnchanged && lastmodUnchanged && isNonEmptyString(existingEntry?.retrieved_at)
        ? existingEntry.retrieved_at
        : syncTimestamp;
    const manifestEntry = createManifestEntry({
      body,
      category,
      existingEntry,
      file,
      order,
      remotePage,
      retrievedAt,
      section,
    });
    const content = `${createFrontmatter(manifestEntry)}${body.trimEnd()}\n`;

    generatedPages.push({
      content,
      entry: manifestEntry,
      language: remotePage.language,
    });
  }

  const generatedFiles = new Set(generatedPages.map((page) => page.entry.file));
  const preservedEntries = existingManifest.filter((entry) => {
    if (generatedFiles.has(entry.file)) {
      return false;
    }
    return entry.site_page !== true;
  });
  const finalManifest = [...generatedPages.map((page) => page.entry), ...preservedEntries].sort(
    compareManifestEntries,
  );

  await mkdir(pagesDir, { recursive: true });
  await mkdir(assetsDir, { recursive: true });
  await Promise.all(
    generatedPages.map((page) =>
      atomicWriteFile(path.join(pagesDir, page.entry.file), page.content),
    ),
  );
  await Promise.all(
    downloadedAssets.map((asset) =>
      atomicWriteFile(path.join(assetsDir, asset.file), asset.content),
    ),
  );
  await pruneStaleSitePages(pagesDir, existingManifest, generatedFiles);
  await pruneStaleAssets(assetsDir, new Set(downloadedAssets.map((asset) => asset.file)));
  await atomicWriteFile(
    manifestPath,
    `${finalManifest.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
  );
  await atomicWriteFile(
    path.join(assetsDir, ASSET_MANIFEST_FILE),
    `${JSON.stringify(createAssetManifest(downloadedAssets, syncTimestamp), null, 2)}\n`,
  );
  await atomicWriteFile(
    path.join(productFeaturesDir, README_FILE),
    createKnowledgeReadme({
      assetCount: downloadedAssets.length,
      generatedPages,
      preservedEntries,
    }),
  );

  return {
    assetBytes: downloadedAssets.reduce((total, asset) => total + asset.content.byteLength, 0),
    assetCount: downloadedAssets.length,
    chinesePageCount: generatedPages.filter((page) => page.language === 'zh').length,
    englishPageCount: generatedPages.filter((page) => page.language === 'en').length,
    pageCount: generatedPages.length,
  };
}

export function parseSitemap(xml, language) {
  return [...xml.matchAll(/<url>([\s\S]*?)<\/url>/gu)].map((match) => {
    const block = match[1] ?? '';
    const sourceUrl = /<loc>([^<]+)<\/loc>/u.exec(block)?.[1];
    if (sourceUrl === undefined) {
      throw new Error('Documentation sitemap entry is missing <loc>.');
    }
    const lastmod = /<lastmod>([^<]+)<\/lastmod>/u.exec(block)?.[1] ?? null;
    return {
      language,
      lastmod,
      sourceUrl: normalizeSourceUrl(decodeXmlText(sourceUrl)),
    };
  });
}

export function markdownUrlFor(sourceUrl) {
  const url = new URL(sourceUrl);
  if (url.origin !== DOCS_ORIGIN) {
    throw new Error(`Unsupported documentation origin: ${sourceUrl}`);
  }
  if (url.pathname === '/') {
    return `${DOCS_ORIGIN}/readme.md`;
  }
  return `${normalizeSourceUrl(sourceUrl)}.md`;
}

export function stripGitbookMarkdownPreamble(markdown) {
  const normalized = markdown.replace(/\r\n/gu, '\n');
  if (!normalized.startsWith('> For the complete documentation index,')) {
    return normalized.trim() + '\n';
  }
  const separator = normalized.indexOf('\n\n');
  return `${normalized.slice(separator === -1 ? 0 : separator + 2).trim()}\n`;
}

export function extractPageTitle(markdown) {
  const title = /^#\s+(.+?)\s*$/mu
    .exec(markdown)?.[1]
    ?.replace(/[\u200B-\u200D\uFEFF]/gu, '')
    .trim();
  if (title === undefined || title.length === 0) {
    throw new Error('Documentation Markdown is missing a level-one heading.');
  }
  return title;
}

export function extractAssetIds(markdown) {
  return [
    ...new Set([...markdown.matchAll(/\/files\/([A-Za-z0-9_-]+)/gu)].map((match) => match[1])),
  ].filter((value) => value !== undefined);
}

export function extractOriginalAssetUrls(html) {
  const urls = [];
  for (const match of html.matchAll(/<img\b[^>]*>/gu)) {
    const tag = match[0];
    const rawSource = /\bsrc="([^"]+)"/u.exec(tag)?.[1];
    if (rawSource === undefined || !rawSource.includes('/~gitbook/image?url=')) {
      continue;
    }
    const proxyUrl = new URL(decodeHtmlAttribute(rawSource), DOCS_ORIGIN);
    const originalUrl = proxyUrl.searchParams.get('url');
    if (originalUrl === null) {
      throw new Error(`GitBook image proxy is missing its original URL: ${proxyUrl}`);
    }
    urls.push(originalUrl);
  }
  return urls;
}

export function createPageFilename(order, sourceUrl) {
  const url = new URL(sourceUrl);
  let slug = url.pathname.replace(/^\/+|\/+$/gu, '');
  if (slug.length === 0) {
    slug = 'welcome';
  }
  slug = slug
    .split('/')
    .map((segment) =>
      decodeURIComponent(segment)
        .replace(/[^A-Za-z0-9-]+/gu, '-')
        .replace(/-+/gu, '-')
        .replace(/^-+|-+$/gu, '')
        .toLowerCase(),
    )
    .filter((segment) => segment.length > 0)
    .join('__');
  return `${String(order).padStart(2, '0')}-${slug || 'page'}.md`;
}

export function extractCuratedAppendix(markdown) {
  const start = markdown.indexOf(CURATED_START);
  if (start === -1) {
    return '';
  }
  const end = markdown.indexOf(CURATED_END, start + CURATED_START.length);
  if (end === -1) {
    throw new Error(`Curated documentation block is missing ${CURATED_END}.`);
  }
  return markdown.slice(start, end + CURATED_END.length).trim();
}

export function rewriteAssetReferences(markdown, assetsById) {
  return markdown.replace(/\/files\/([A-Za-z0-9_-]+)/gu, (match, id) => {
    const asset = assetsById.get(id);
    if (asset === undefined) {
      throw new Error(`Missing downloaded documentation asset: ${id}`);
    }
    return `/assets/${asset.file}`;
  });
}

export function cleanMarkdownArtifacts(markdown) {
  return markdown.replace(/\[\s*\]\([^\r\n)]*\)/gu, ' ');
}

function appendCuratedContent(officialBody, curatedAppendix) {
  if (curatedAppendix.length === 0) {
    return `${officialBody.trim()}\n`;
  }
  return `${officialBody.trim()}\n\n${curatedAppendix}\n`;
}

function collectRemoteAssets(remotePages) {
  const assets = new Map();
  for (const page of remotePages) {
    page.assetIds.forEach((id, index) => {
      const originalUrl = page.originalAssetUrls[index];
      if (originalUrl === undefined) {
        throw new Error(`Missing source URL for documentation asset: ${id}`);
      }
      const existing = assets.get(id);
      if (existing !== undefined && existing.originalUrl !== originalUrl) {
        throw new Error(`Documentation asset ${id} resolves to multiple source URLs.`);
      }
      if (existing === undefined) {
        assets.set(id, {
          id,
          originalUrl,
          sourcePages: [page.sourceUrl],
        });
      } else if (!existing.sourcePages.includes(page.sourceUrl)) {
        existing.sourcePages.push(page.sourceUrl);
      }
    });
  }
  return assets;
}

async function downloadAsset(fetchImpl, asset) {
  const downloaded = await fetchRequired(fetchImpl, asset.originalUrl, async (response) => ({
    content: Buffer.from(await response.arrayBuffer()),
    contentType: normalizeContentType(response.headers.get('content-type')),
  }));
  const { content, contentType } = downloaded;
  if (!contentType.startsWith('image/')) {
    throw new Error(`Documentation asset ${asset.id} is not an image: ${contentType}`);
  }
  const extension = extensionForAsset(contentType, asset.originalUrl);
  return {
    ...asset,
    content,
    contentType,
    file: `${ASSET_FILE_PREFIX}${asset.id}.${extension}`,
    sha256: createHash('sha256').update(content).digest('hex'),
  };
}

function extensionForAsset(contentType, originalUrl) {
  const known = {
    'image/avif': 'avif',
    'image/gif': 'gif',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/svg+xml': 'svg',
    'image/webp': 'webp',
  };
  const extension = known[contentType];
  if (extension !== undefined) {
    return extension;
  }
  const pathnameExtension = path.extname(new URL(originalUrl).pathname).slice(1).toLowerCase();
  if (/^[a-z0-9]{2,5}$/u.test(pathnameExtension)) {
    return pathnameExtension;
  }
  throw new Error(`Unsupported documentation asset type: ${contentType}`);
}

function createManifestEntry({
  body,
  category,
  existingEntry,
  file,
  order,
  remotePage,
  retrievedAt,
  section,
}) {
  const pathname = new URL(remotePage.sourceUrl).pathname;
  const contentState = classifyPageContent(remotePage.title, body);
  return {
    order,
    title: remotePage.title,
    pathname,
    source_url: remotePage.sourceUrl,
    source_markdown_url: remotePage.sourceMarkdownUrl,
    language: remotePage.language,
    site_page: true,
    category,
    section,
    ...(Array.isArray(existingEntry?.breadcrumbs)
      ? { breadcrumbs: existingEntry.breadcrumbs }
      : {}),
    ...(Array.isArray(existingEntry?.children) ? { children: existingEntry.children } : {}),
    lastmod: remotePage.lastmod,
    retrieved_at: retrievedAt,
    file,
    content_chars: body.length,
    content_state: contentState,
    ingest: contentState === 'content',
    ...(existingEntry?.status === undefined ? {} : { status: existingEntry.status }),
    ...(Array.isArray(existingEntry?.supersedes) ? { supersedes: existingEntry.supersedes } : {}),
  };
}

function createFrontmatter(entry) {
  const lines = [
    '---',
    `title: ${JSON.stringify(entry.title)}`,
    `source_url: ${JSON.stringify(entry.source_url)}`,
    `source_markdown_url: ${JSON.stringify(entry.source_markdown_url)}`,
    `language: ${JSON.stringify(entry.language)}`,
    `category: ${JSON.stringify(entry.category)}`,
    `section: ${JSON.stringify(entry.section)}`,
    `lastmod: ${JSON.stringify(entry.lastmod ?? '')}`,
    `retrieved_at: ${JSON.stringify(entry.retrieved_at)}`,
    `content_state: ${JSON.stringify(entry.content_state)}`,
    `ingest: ${entry.ingest}`,
  ];
  if (entry.status !== undefined) {
    lines.push(`status: ${entry.status}`);
  }
  if (entry.supersedes !== undefined) {
    lines.push(`supersedes: ${JSON.stringify(entry.supersedes)}`);
  }
  lines.push('---', '');
  return `${lines.join('\n')}\n`;
}

export function classifyPageContent(title, body) {
  const normalizedTitle = String(title).normalize('NFKC').trim().toLowerCase();
  const normalizedBody = String(body).normalize('NFKC');
  if (
    normalizedTitle === 'page not found' ||
    (/^#\s+page not found\s*$/imu.test(normalizedBody) &&
      /does not exist|moved, renamed, or deleted/iu.test(normalizedBody))
  ) {
    return 'not_found';
  }

  const indexableText = normalizedBody
    .replace(/<!--[^]*?-->/gu, ' ')
    .replace(/<figure[^>]*>[^]*?<\/figure>/giu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/^#{1,6}\s+.*$/gmu, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
  return indexableText.length === 0 ? 'empty' : 'content';
}

function derivePageMetadata(sourceUrl, language) {
  const segments = new URL(sourceUrl).pathname.split('/').filter(Boolean);
  if (language === 'en') {
    const sectionKey = segments[1] ?? 'overview';
    const sections = {
      'chart-area': 'English / Chart area',
      dashboard: 'English / Dashboard',
      'feature-updates': 'English / Feature updates',
      meme: 'English / Meme scanner',
      monitor: 'English / Monitor',
      readme: 'English / Getting started',
      'telegram-support-group': 'English / Support',
      trades: 'English / Discovery',
      'trading-tokens': 'English / Trading tokens',
      'xxyy-pro-membership': 'English / XXYY Pro',
      'xxyy-terms': 'English / Legal',
    };
    return {
      category: 'English documentation',
      section: sections[sectionKey] ?? 'English / Product documentation',
    };
  }

  const pathname = new URL(sourceUrl).pathname;
  if (pathname === '/xxyy-api-can-kao-wen-dang') {
    return { category: '开发者文档', section: 'XXYY API' };
  }
  if (pathname === '/telegram-guan-fang-da-yi-qun') {
    return { category: '官方支持', section: 'Telegram 官方答疑群' };
  }
  if (pathname === '/changelog') {
    return { category: '产品更新', section: '功能更新' };
  }
  if (pathname.startsWith('/wang-zhan-xie-yi/')) {
    return { category: '网站协议', section: '网站协议' };
  }
  return { category: '中文产品文档', section: '产品文档' };
}

function createAssetManifest(assets, retrievedAt) {
  return {
    source: DOCS_ORIGIN,
    retrieved_at: retrievedAt,
    assets: [...assets]
      .sort((left, right) => left.file.localeCompare(right.file))
      .map((asset) => ({
        id: asset.id,
        file: asset.file,
        content_type: asset.contentType,
        bytes: asset.content.byteLength,
        sha256: asset.sha256,
        source_pages: [...asset.sourcePages].sort(),
      })),
  };
}

function createKnowledgeReadme({ assetCount, generatedPages, preservedEntries }) {
  const chinesePages = generatedPages.filter((page) => page.language === 'zh');
  const englishPages = generatedPages.filter((page) => page.language === 'en');
  const supplementalPages = preservedEntries.filter((entry) => entry.file?.endsWith('.md'));
  const lines = [
    '# XXYY 完整知识库',
    '',
    `本目录以 ${DOCS_ORIGIN}/ 为 XXYY 官方文档唯一来源，以 https://x.com/useXXYYio 为官方 X 更新唯一来源；客服群知识目录当前留空，只接收后续人工审核发布的聊天知识。`,
    '',
    '## 覆盖范围',
    '',
    `- 中文站：${chinesePages.length} 个页面。`,
    `- 英文站：${englishPages.length} 个页面。`,
    `- 官网合计：${generatedPages.length} 个页面，包含产品功能、API、Telegram 支持、功能更新、用户条款、隐私协议及英文文档。`,
    `- 官网媒体：${assetCount} 个图片资产已下载到 \`assets/\`，页面中的 GitBook 文件引用已改写为本地 \`/assets/\` 路径；OCR 覆盖状态见 \`enriched/media/manifest.json\`。`,
    '- 视频本身的字幕、音频转写、关键帧 OCR 状态，以及正文对视频知识的覆盖等级和证据 SHA，见 `enriched/videos/manifest.json`；`docs:audit` 会区分“视频未转写”和“知识确实缺失”。',
    '- 知识来源在入库时固定分类为 `official_docs`、`x_updates` 或 `admin_verified`；外部 GitHub 参考资料不进入正式知识库。',
    '',
    '## 文件',
    '',
    '- `pages/`：官网全量页面及额外客服知识，每页一个 Markdown 文件。',
    '- `manifest.jsonl`：页面来源、语言、模块、更新时间和本地文件映射。',
    '- `assets/xxyy-docs-assets.json`：官网图片资产的校验值及来源页面。',
    '- `external/`：历史外部参考资料，仅归档，不进入正式知识库。',
    '- `enriched/media/`：图片 OCR sidecar 与逐资产状态清单。',
    '- `enriched/videos/`：视频字幕、音频转写或关键帧 OCR sidecar，以及视频提取/正文知识覆盖双维度状态清单。',
    '- `enriched/reviewed/`：从官网内容派生并经人工校正的官方文档兜底。',
    '- `admin-verified/`：XXYY 客服群审核知识；当前为空，未来只写入通过人工审核和发布门禁的聊天知识。',
    '- 媒体 sidecar 会把原始图片或视频地址写入 chunk 元数据；检索命中解析文字时可同步返回对应媒体。',
    '- `xxyy-product-functions.md`：历史中文产品功能聚合归档；仅在 `pages/` 没有可入库页面时作为兼容兜底，不与逐页官网文档重复入库。',
    '- `xxyy-x-updates.md`：官方 X 历史更新聚合。',
    '- `sources/usexxyyio-x-posts.jsonl`：官方 X 帖子逐条原始数据。',
    '',
    '## 同步与入库',
    '',
    '```bash',
    'pnpm docs:sync',
    'pnpm docs:enrich:media',
    'pnpm docs:audit',
    'pnpm rag:ingest',
    '```',
    '',
    '官网同步以中英文 sitemap 为准，保留带 `xxyy-ask:curated-*` 标记且来源 URL 属于官网或官方 X 的补充页面。`app:dev -- --full-sync` 会依次执行官网同步、媒体 enrichment、审计、X 全量抓取和正式 ingest。',
    '',
    '## 中文页面',
    '',
    ...createPageIndex(chinesePages),
    '',
    '## English pages',
    '',
    ...createPageIndex(englishPages),
  ];
  if (supplementalPages.length > 0) {
    lines.push('', '## 额外知识页面', '', ...createManifestIndex(supplementalPages));
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function createPageIndex(pages) {
  return [...pages]
    .sort((left, right) => compareManifestEntries(left.entry, right.entry))
    .map(
      (page) =>
        `- [${escapeMarkdownLabel(page.entry.title)}](pages/${page.entry.file}) - ${page.entry.source_url}`,
    );
}

function createManifestIndex(entries) {
  return [...entries]
    .sort(compareManifestEntries)
    .map(
      (entry) =>
        `- [${escapeMarkdownLabel(entry.title ?? entry.file)}](pages/${entry.file}) - ${entry.source_url ?? 'local knowledge'}`,
    );
}

function selectExistingSiteEntries(entries) {
  const selected = new Map();
  for (const entry of entries) {
    if (!isDocsSourceUrl(entry.source_url)) {
      continue;
    }
    const key = normalizeSourceUrl(entry.source_url);
    const previous = selected.get(key);
    if (
      previous === undefined ||
      (previous.source_markdown_url === undefined && entry.source_markdown_url !== undefined)
    ) {
      selected.set(key, entry);
    }
  }
  return selected;
}

function assertUniqueSourceUrls(entries) {
  const seen = new Set();
  for (const entry of entries) {
    const normalized = normalizeSourceUrl(entry.sourceUrl);
    if (seen.has(normalized)) {
      throw new Error(`Duplicate documentation URL in sitemaps: ${entry.sourceUrl}`);
    }
    seen.add(normalized);
  }
}

async function fetchRequired(fetchImpl, url, readResponse = (response) => response) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        headers: {
          'user-agent': 'xxyy-ask-docs-sync/1.0',
        },
      });
      if (response.ok) {
        return await readResponse(response);
      }
      lastError = new Error(`HTTP ${response.status} while fetching ${url}`);
      if (response.status < 500 && response.status !== 429) {
        break;
      }
    } catch (error) {
      lastError = error;
    }
    if (attempt < 3) {
      await delay(200 * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Failed to fetch ${url}`);
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function readJsonLines(file) {
  const content = await readOptionalFile(file);
  if (content === undefined) {
    return [];
  }
  return content
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

async function readOptionalFile(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }
}

async function discoverUnmanifestedPages(pagesDir, manifestFiles) {
  let directoryEntries;
  try {
    directoryEntries = await readdir(pagesDir, { withFileTypes: true });
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }
    throw error;
  }

  const discovered = [];
  for (const directoryEntry of directoryEntries) {
    if (
      !directoryEntry.isFile() ||
      !directoryEntry.name.endsWith('.md') ||
      manifestFiles.has(directoryEntry.name)
    ) {
      continue;
    }
    const content = await readFile(path.join(pagesDir, directoryEntry.name), 'utf8');
    const metadata = parseSimpleFrontmatter(content);
    const numericPrefix = /^(\d+)-/u.exec(directoryEntry.name)?.[1];
    discovered.push({
      ...(numericPrefix === undefined ? {} : { order: Number(numericPrefix) }),
      title: metadata.title ?? extractPageTitle(stripFrontmatter(content)),
      ...(metadata.source_url === undefined ? {} : { source_url: metadata.source_url }),
      ...(metadata.source_markdown_url === undefined
        ? {}
        : { source_markdown_url: metadata.source_markdown_url }),
      ...(metadata.category === undefined ? {} : { category: metadata.category }),
      ...(metadata.section === undefined ? {} : { section: metadata.section }),
      ...(metadata.lastmod === undefined ? {} : { lastmod: metadata.lastmod }),
      ...(metadata.effective_at === undefined ? {} : { effective_at: metadata.effective_at }),
      ...(metadata.retrieved_at === undefined ? {} : { retrieved_at: metadata.retrieved_at }),
      ...(metadata.status === undefined ? {} : { status: metadata.status }),
      file: directoryEntry.name,
    });
  }
  return discovered;
}

function parseSimpleFrontmatter(content) {
  if (!content.startsWith('---')) {
    return {};
  }
  const end = /\r?\n---\r?\n/u.exec(content.slice(3));
  if (end === null) {
    return {};
  }
  const frontmatter = content.slice(3, 3 + end.index);
  const metadata = {};
  for (const line of frontmatter.split(/\r?\n/gu)) {
    const match = /^([A-Za-z_]+):\s*(.*?)\s*$/u.exec(line.trim());
    if (match?.[1] === undefined || match[2] === undefined || match[2].length === 0) {
      continue;
    }
    const rawValue = match[2];
    if (rawValue.startsWith('[') || rawValue.startsWith('{')) {
      continue;
    }
    let value = rawValue;
    if (
      (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
      (rawValue.startsWith("'") && rawValue.endsWith("'"))
    ) {
      value = rawValue.slice(1, -1);
    }
    metadata[match[1]] = value;
  }
  return metadata;
}

async function atomicWriteFile(file, content) {
  const temporaryFile = `${file}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporaryFile, content);
  await rename(temporaryFile, file);
}

async function pruneStaleSitePages(pagesDir, existingManifest, generatedFiles) {
  const staleFiles = existingManifest
    .filter((entry) => entry.site_page === true && !generatedFiles.has(entry.file))
    .map((entry) => entry.file)
    .filter((file) => typeof file === 'string' && path.basename(file) === file);
  await Promise.all(staleFiles.map((file) => rm(path.join(pagesDir, file), { force: true })));
}

async function pruneStaleAssets(assetsDir, generatedAssets) {
  const entries = await readdir(assetsDir, { withFileTypes: true });
  const staleAssets = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.startsWith(ASSET_FILE_PREFIX) &&
        entry.name !== ASSET_MANIFEST_FILE &&
        !generatedAssets.has(entry.name),
    )
    .map((entry) => entry.name);
  await Promise.all(staleAssets.map((file) => rm(path.join(assetsDir, file), { force: true })));
}

function getNextManifestOrder(entries) {
  return (
    entries.reduce(
      (maximum, entry) =>
        typeof entry.order === 'number' ? Math.max(maximum, entry.order) : maximum,
      0,
    ) + 1
  );
}

function stripFrontmatter(content) {
  if (!content.startsWith('---')) {
    return content;
  }
  const match = /\r?\n---\r?\n/u.exec(content.slice(3));
  if (match === null) {
    return content;
  }
  return content.slice(3 + match.index + match[0].length);
}

function compareManifestEntries(left, right) {
  const leftOrder = typeof left.order === 'number' ? left.order : Number.MAX_SAFE_INTEGER;
  const rightOrder = typeof right.order === 'number' ? right.order : Number.MAX_SAFE_INTEGER;
  return leftOrder - rightOrder || String(left.file).localeCompare(String(right.file));
}

function normalizeSourceUrl(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return '';
  }
  const url = new URL(value);
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/$/u, '');
}

function isDocsSourceUrl(value) {
  if (typeof value !== 'string') {
    return false;
  }
  try {
    return new URL(value).origin === DOCS_ORIGIN;
  } catch {
    return false;
  }
}

function normalizeContentType(value) {
  return (value ?? 'application/octet-stream').split(';', 1)[0].trim().toLowerCase();
}

function decodeHtmlAttribute(value) {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}

function decodeXmlText(value) {
  return decodeHtmlAttribute(value);
}

function escapeMarkdownLabel(value) {
  return String(value).replaceAll('[', '\\[').replaceAll(']', '\\]');
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isMissingFileError(error) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

function isDirectRun() {
  const invokedPath = process.argv[1];
  return invokedPath !== undefined && path.resolve(invokedPath) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}
