import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { auditXxyyDocs } from './audit-xxyy-docs.mjs';
import { VIDEO_SOURCES } from './xxyy-video-sources.mjs';

describe('auditXxyyDocs', () => {
  it('accepts known non-content pages only when they are excluded from ingestion', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'xxyy-docs-audit-'));
    const productDir = path.join(cwd, 'docs', 'product-features');
    await mkdir(path.join(productDir, 'pages'), { recursive: true });
    await mkdir(path.join(productDir, 'assets'), { recursive: true });
    await mkdir(path.join(productDir, 'enriched', 'reviewed'), { recursive: true });
    const page = [
      '---',
      'title: "Page Not Found"',
      '---',
      '# Page Not Found',
      '',
      'The URL `en` does not exist. This page may have been moved, renamed, or deleted.',
      '',
    ].join('\n');
    await writeFile(path.join(productDir, 'pages', '01-en.md'), page);
    await writeFile(
      path.join(productDir, 'manifest.jsonl'),
      `${[
        {
          file: '00-overview.md',
          source_url: 'https://docs.xxyy.io/en',
          title: 'Local overview',
        },
        {
          content_state: 'not_found',
          file: '01-en.md',
          ingest: false,
          pathname: '/en',
          site_page: true,
          source_url: 'https://docs.xxyy.io/en',
          title: 'Page Not Found',
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n')}\n`,
    );
    await writeFile(path.join(productDir, 'pages', '00-overview.md'), '# Local overview\n');
    await writeFile(
      path.join(productDir, 'assets', 'xxyy-docs-assets.json'),
      `${JSON.stringify({ assets: [] })}\n`,
    );
    await writeFile(
      path.join(productDir, 'enriched', 'reviewed', 'avg-price-line-en.md'),
      'Derived from official Chinese documentation. The average cost line shows average cost.\n',
    );
    await writeExtendedSourceFixtures(productDir);

    const report = await auditXxyyDocs({ cwd });

    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('upstream page is not_found')]),
    );
    expect(report.warnings).not.toEqual(
      expect.arrayContaining([expect.stringContaining('video knowledge is unavailable')]),
    );
    expect(report.notices).toEqual(
      expect.arrayContaining([
        expect.stringContaining('mzTSPHqP8UA: video itself is untranscribed'),
        expect.stringContaining('ssww8GJnedE: video itself is untranscribed'),
      ]),
    );
    expect(report.videos).toMatchObject({
      coveredByText: 2,
      extracted: 1,
      knowledgeCovered: 3,
      total: 3,
    });
    expect(report.counts.not_found).toBe(1);
    expect(await readFile(path.join(productDir, 'pages', '01-en.md'), 'utf8')).toBe(page);

    const strictReport = await auditXxyyDocs({ cwd, requireAllMedia: true });
    expect(strictReport.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('mzTSPHqP8UA: video extraction is required by MEDIA_REQUIRE_ALL'),
        expect.stringContaining('ssww8GJnedE: video extraction is required by MEDIA_REQUIRE_ALL'),
      ]),
    );

    const telegramSource = VIDEO_SOURCES.find((source) => source.id === 'mzTSPHqP8UA');
    const telegramContext = telegramSource?.textCoverage?.sources[0];
    if (telegramContext === undefined) {
      throw new Error('Expected Telegram video text coverage fixture');
    }
    await writeFile(
      path.join(productDir, telegramContext.file),
      `${telegramContext.requiredMarkers.join('\n')}\nupdated\n`,
    );
    const staleReport = await auditXxyyDocs({ cwd });
    expect(
      staleReport.errors.some(
        (error) => error.includes('mzTSPHqP8UA') && error.includes('text coverage is stale'),
      ),
    ).toBe(true);
  });
});

async function writeExtendedSourceFixtures(productDir) {
  const mediaDir = path.join(productDir, 'enriched', 'media');
  const videoDir = path.join(productDir, 'enriched', 'videos');
  await Promise.all([mkdir(mediaDir, { recursive: true }), mkdir(videoDir, { recursive: true })]);
  await writeFile(path.join(mediaDir, 'manifest.json'), `${JSON.stringify({ assets: [] })}\n`);

  const localVideo = '# Local video\n\n## 关键帧 OCR 文字\n\nAdd to Home Screen\n';
  await writeFile(path.join(videoDir, 'xxyy-add-to-home.md'), localVideo);
  const coveredVideos = [];
  for (const source of VIDEO_SOURCES.filter((candidate) => candidate.textCoverage !== undefined)) {
    const contextSources = [];
    for (const context of source.textCoverage.sources) {
      const content = `${context.requiredMarkers.join('\n')}\n`;
      const file = path.join(productDir, context.file);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
      contextSources.push({ file: context.file, sha256: sha256(content) });
    }
    coveredVideos.push({
      id: source.id,
      status: 'covered_by_text',
      extraction_status: 'unavailable',
      extraction_error: 'captions unavailable',
      knowledge_coverage: source.textCoverage.level,
      coverage_note: source.textCoverage.rationale,
      context_sources: contextSources,
    });
  }
  await writeFile(
    path.join(videoDir, 'manifest.json'),
    `${JSON.stringify({
      videos: [
        {
          id: 'xxyy-add-to-home',
          method: 'keyframe-ocr',
          output: 'xxyy-add-to-home.md',
          output_sha256: sha256(localVideo),
          status: 'extracted',
        },
        ...coveredVideos,
      ],
    })}\n`,
  );
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}
