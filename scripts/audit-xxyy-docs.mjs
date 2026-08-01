#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyPageContent } from './sync-xxyy-docs.mjs';
import { VIDEO_SOURCES } from './xxyy-video-sources.mjs';

const PRODUCT_DIR = path.join('docs', 'product-features');
const KNOWN_NON_CONTENT = new Map([
  ['/en', 'not_found'],
  ['/en/chart-area/avg.-price-line', 'empty'],
]);
export async function auditXxyyDocs(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const productDir = path.resolve(cwd, PRODUCT_DIR);
  const manifest = await readJsonLines(path.join(productDir, 'manifest.jsonl'));
  const errors = [];
  const notices = [];
  const warnings = [];
  const seenUrls = new Set();
  const counts = { content: 0, empty: 0, not_found: 0 };

  for (const entry of manifest) {
    if (typeof entry.file !== 'string' || !entry.file.endsWith('.md')) {
      errors.push(`Manifest entry has no Markdown file: ${JSON.stringify(entry)}`);
      continue;
    }
    if (typeof entry.source_url === 'string' && entry.site_page === true) {
      if (seenUrls.has(entry.source_url)) {
        errors.push(`Duplicate site URL: ${entry.source_url}`);
      }
      seenUrls.add(entry.source_url);
    }

    const file = path.join(productDir, 'pages', entry.file);
    let content;
    try {
      content = await readFile(file, 'utf8');
    } catch (error) {
      errors.push(`Missing page file: ${entry.file} (${errorMessage(error)})`);
      continue;
    }

    if (entry.site_page !== true) {
      continue;
    }
    const body = stripFrontmatter(content);
    const actualState = classifyPageContent(entry.title ?? '', body);
    counts[actualState] += 1;
    if (entry.content_state !== actualState) {
      errors.push(
        `${entry.file}: manifest content_state=${String(entry.content_state)} but actual=${actualState}`,
      );
    }
    if (entry.ingest !== (actualState === 'content')) {
      errors.push(`${entry.file}: ingest must be ${actualState === 'content'} for ${actualState}`);
    }
    if (actualState !== 'content') {
      const expected = KNOWN_NON_CONTENT.get(entry.pathname);
      if (expected !== actualState) {
        errors.push(`${entry.file}: unexpected ${actualState} page at ${String(entry.pathname)}`);
      } else {
        warnings.push(
          `${entry.file}: upstream page is ${actualState} and is excluded from ingestion`,
        );
      }
    }
  }

  const assets = await auditAssets(productDir, errors);
  await auditReviewedFallbacks(productDir, errors);
  const imageOcr = await auditImageOcr(productDir, assets, errors, warnings);
  const videos = await auditVideos(
    productDir,
    errors,
    notices,
    warnings,
    options.requireAllMedia ?? process.env.MEDIA_REQUIRE_ALL === 'true',
  );
  return {
    counts,
    errors,
    imageOcr,
    notices,
    pageCount: manifest.filter((entry) => entry.site_page === true).length,
    videos,
    warnings,
  };
}

async function auditAssets(productDir, errors) {
  const manifestPath = path.join(productDir, 'assets', 'xxyy-docs-assets.json');
  const assetManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!Array.isArray(assetManifest.assets)) {
    errors.push('Asset manifest does not contain an assets array.');
    return [];
  }
  for (const asset of assetManifest.assets) {
    if (typeof asset.file !== 'string' || typeof asset.sha256 !== 'string') {
      errors.push(`Invalid asset manifest entry: ${JSON.stringify(asset)}`);
      continue;
    }
    try {
      const content = await readFile(path.join(productDir, 'assets', asset.file));
      const sha256 = createHash('sha256').update(content).digest('hex');
      if (sha256 !== asset.sha256) {
        errors.push(`${asset.file}: SHA256 does not match the asset manifest.`);
      }
    } catch (error) {
      errors.push(`Missing asset file: ${asset.file} (${errorMessage(error)})`);
    }
  }
  return assetManifest.assets;
}

async function auditImageOcr(productDir, sourceAssets, errors, warnings) {
  const directory = path.join(productDir, 'enriched', 'media');
  const manifest = await readRequiredJson(
    path.join(directory, 'manifest.json'),
    'image OCR manifest',
    errors,
  );
  if (manifest === undefined || !Array.isArray(manifest.assets)) {
    if (manifest !== undefined) errors.push('Image OCR manifest has no assets array.');
    return { extracted: 0, noText: 0, total: 0 };
  }
  const resultsById = new Map(manifest.assets.map((entry) => [entry?.id, entry]));
  for (const source of sourceAssets) {
    const entry = resultsById.get(source.id);
    if (
      entry?.sha256 !== source.sha256 ||
      JSON.stringify(entry?.source_pages) !== JSON.stringify(source.source_pages)
    ) {
      errors.push(`${source.file}: image OCR result is missing or stale.`);
      continue;
    }
    if (entry.status === 'extracted') {
      if (typeof entry.output !== 'string' || typeof entry.output_sha256 !== 'string') {
        errors.push(`${source.file}: extracted OCR result has no verifiable output.`);
        continue;
      }
      await auditGeneratedFile({
        errors,
        expectedHash: entry.output_sha256,
        file: path.join(directory, entry.output),
        label: `enriched/media/${entry.output}`,
        requiredText: '## OCR 文字',
      });
    } else if (entry.status !== 'no_text') {
      errors.push(`${source.file}: unsupported OCR status ${String(entry.status)}.`);
    }
  }
  const summary = {
    extracted: manifest.assets.filter((entry) => entry.status === 'extracted').length,
    noText: manifest.assets.filter((entry) => entry.status === 'no_text').length,
    total: manifest.assets.length,
  };
  if (summary.noText > 0) {
    warnings.push(`${summary.noText} official images contain no reliably recognized text.`);
  }
  return summary;
}

async function auditVideos(productDir, errors, notices, warnings, requireAllMedia) {
  const directory = path.join(productDir, 'enriched', 'videos');
  const manifest = await readRequiredJson(
    path.join(directory, 'manifest.json'),
    'video enrichment manifest',
    errors,
  );
  if (manifest === undefined || !Array.isArray(manifest.videos)) {
    if (manifest !== undefined) errors.push('Video enrichment manifest has no videos array.');
    return { coveredByText: 0, extracted: 0, knowledgeCovered: 0, total: 0 };
  }
  const resultsById = new Map(manifest.videos.map((entry) => [entry?.id, entry]));
  if (resultsById.size !== manifest.videos.length) {
    errors.push('Video enrichment manifest contains duplicate video ids.');
  }
  for (const source of VIDEO_SOURCES) {
    const entry = resultsById.get(source.id);
    if (entry === undefined) {
      errors.push(`Video enrichment is missing ${source.id}.`);
      continue;
    }
    if (entry.status === 'extracted') {
      if (typeof entry.output !== 'string' || typeof entry.output_sha256 !== 'string') {
        errors.push(`${source.id}: extracted video result has no verifiable output.`);
        continue;
      }
      await auditGeneratedFile({
        errors,
        expectedHash: entry.output_sha256,
        file: path.join(directory, entry.output),
        label: `enriched/videos/${entry.output}`,
        requiredText: entry.method === 'keyframe-ocr' ? '## 关键帧 OCR 文字' : '## 字幕 / 转写文本',
      });
    } else if (entry.status === 'covered_by_text') {
      await auditVideoTextCoverage(productDir, source, entry, errors);
      notices.push(
        `${source.id}: video itself is untranscribed; ${String(entry.knowledge_coverage)} knowledge coverage is verified by surrounding text`,
      );
      if (requireAllMedia) {
        errors.push(
          `${source.id}: video extraction is required by MEDIA_REQUIRE_ALL but remains unavailable (${String(entry.extraction_error ?? 'no details')})`,
        );
      }
    } else {
      const message = `${source.id}: video knowledge is ${String(entry.status)} (${String(entry.error ?? 'no details')})`;
      if (requireAllMedia) errors.push(message);
      else warnings.push(message);
    }
  }
  const extracted = manifest.videos.filter((entry) => entry.status === 'extracted').length;
  const coveredByText = manifest.videos.filter(
    (entry) => entry.status === 'covered_by_text',
  ).length;
  return {
    coveredByText,
    extracted,
    knowledgeCovered: extracted + coveredByText,
    total: manifest.videos.length,
  };
}

async function auditVideoTextCoverage(productDir, source, entry, errors) {
  const expected = source.textCoverage;
  if (expected === undefined) {
    errors.push(`${source.id}: covered_by_text has no configured text coverage sources.`);
    return;
  }
  if (
    entry.extraction_status !== 'unavailable' ||
    typeof entry.extraction_error !== 'string' ||
    entry.knowledge_coverage !== expected.level ||
    entry.coverage_note !== expected.rationale ||
    !Array.isArray(entry.context_sources)
  ) {
    errors.push(`${source.id}: covered_by_text metadata is incomplete or inconsistent.`);
    return;
  }

  const actualByFile = new Map(entry.context_sources.map((context) => [context?.file, context]));
  if (actualByFile.size !== entry.context_sources.length) {
    errors.push(`${source.id}: text coverage contains duplicate context files.`);
  }
  if (
    actualByFile.size !== expected.sources.length ||
    expected.sources.some((context) => !actualByFile.has(context.file))
  ) {
    errors.push(`${source.id}: text coverage sources do not match the configured evidence set.`);
  }

  for (const context of expected.sources) {
    const actual = actualByFile.get(context.file);
    if (typeof actual?.sha256 !== 'string') {
      errors.push(`${source.id}: ${context.file} has no context SHA256.`);
      continue;
    }
    try {
      const content = await readFile(path.join(productDir, context.file), 'utf8');
      const hash = createHash('sha256').update(content).digest('hex');
      if (hash !== actual.sha256) {
        errors.push(`${source.id}: ${context.file} text coverage is stale.`);
      }
      const missingMarker = context.requiredMarkers.find((marker) => !content.includes(marker));
      if (missingMarker !== undefined) {
        errors.push(
          `${source.id}: ${context.file} is missing coverage marker ${JSON.stringify(missingMarker)}.`,
        );
      }
    } catch (error) {
      errors.push(
        `${source.id}: missing text coverage source ${context.file} (${errorMessage(error)}).`,
      );
    }
  }
}

async function auditGeneratedFile({
  errors,
  expectedBytes,
  expectedHash,
  file,
  label,
  requiredText,
}) {
  try {
    const content = await readFile(file);
    if (createHash('sha256').update(content).digest('hex') !== expectedHash) {
      errors.push(`${label}: SHA256 does not match its manifest.`);
    }
    if (expectedBytes !== undefined && content.byteLength !== expectedBytes) {
      errors.push(`${label}: byte count does not match its manifest.`);
    }
    if (!content.toString('utf8').includes(requiredText)) {
      errors.push(`${label}: expected provenance/content marker is missing.`);
    }
  } catch (error) {
    errors.push(`Missing generated file ${label} (${errorMessage(error)}).`);
  }
}

async function readRequiredJson(file, label, errors) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    errors.push(`Missing or invalid ${label} (${errorMessage(error)}).`);
    return undefined;
  }
}

async function auditReviewedFallbacks(productDir, errors) {
  const fallback = path.join(productDir, 'enriched', 'reviewed', 'avg-price-line-en.md');
  try {
    const content = await readFile(fallback, 'utf8');
    if (!content.includes('official Chinese documentation') || !content.includes('average cost')) {
      errors.push('Reviewed Avg. Price Line fallback is missing provenance or product behavior.');
    }
  } catch (error) {
    errors.push(`Missing reviewed Avg. Price Line fallback (${errorMessage(error)}).`);
  }
}

async function readJsonLines(file) {
  return (await readFile(file, 'utf8'))
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function stripFrontmatter(content) {
  if (!content.startsWith('---')) {
    return content;
  }
  const match = /\r?\n---\r?\n/u.exec(content.slice(3));
  return match === null ? content : content.slice(3 + match.index + match[0].length);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isDirectRun() {
  const invoked = process.argv[1];
  return invoked !== undefined && path.resolve(invoked) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  try {
    const report = await auditXxyyDocs();
    process.stdout.write(
      `Documentation audit: ${report.pageCount} site pages; ${report.counts.content} content, ${report.counts.empty} empty, ${report.counts.not_found} not found.\n`,
    );
    process.stdout.write(
      `Image OCR: ${report.imageOcr.extracted}/${report.imageOcr.total} extracted. Video knowledge: ${report.videos.knowledgeCovered}/${report.videos.total} covered (${report.videos.extracted} extracted, ${report.videos.coveredByText} covered by text).\n`,
    );
    for (const notice of report.notices) {
      process.stdout.write(`Notice: ${notice}\n`);
    }
    for (const warning of report.warnings) {
      process.stdout.write(`Warning: ${warning}\n`);
    }
    if (report.errors.length > 0) {
      for (const error of report.errors) {
        process.stderr.write(`Error: ${error}\n`);
      }
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
