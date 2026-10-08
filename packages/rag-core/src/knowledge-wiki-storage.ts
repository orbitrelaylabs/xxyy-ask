import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  publishedWikiSchema,
  renderWikiPage,
  validateWikiBundle,
  wikiBundleHash,
  WIKI_MAX_BYTES,
  type WikiBundle,
  type PublishedWiki,
} from './knowledge-wiki.js';

export async function readWikiJson(file: string): Promise<unknown> {
  const handle = await open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > WIKI_MAX_BYTES) throw new Error('wiki_artifact_size_limit');
    // Bound allocation and detect an in-place writer. Atomic publication keeps
    // each already-open file stable even while the published pathname changes.
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) throw new Error('wiki_artifact_changed_during_read');
    return JSON.parse(buffer.subarray(0, offset).toString('utf8')) as unknown;
  } finally {
    await handle.close();
  }
}

export async function readPublishedWiki(file: string): Promise<PublishedWiki> {
  const published = publishedWikiSchema.parse(await readWikiJson(file));
  validateWikiBundle(published.bundle);
  if (wikiBundleHash(published.bundle) !== published.bundleHash)
    throw new Error('wiki_artifact_hash_mismatch');
  return published;
}

export function wikiBuildDirectory(cwd: string, id: string): string {
  if (!/^[a-f0-9-]{36}$/u.test(id)) throw new Error('wiki_invalid_build_id');
  return path.join(cwd, '.rag', 'wiki', 'builds', id);
}

export async function saveWikiBuild(
  cwd: string,
  input: WikiBundle,
): Promise<{ id: string; directory: string }> {
  const bundle = validateWikiBundle(input);
  const serialized = `${JSON.stringify(bundle, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > WIKI_MAX_BYTES) throw new Error('wiki_artifact_size_limit');
  const id = randomUUID();
  const directory = wikiBuildDirectory(cwd, id);
  await mkdir(directory, { recursive: true });
  // A build is immutable. The final bundle is the completion marker.
  for (const page of bundle.pages)
    await writeFile(path.join(directory, `${page.id}.md`), renderWikiPage(page, bundle), {
      flag: 'wx',
    });
  await writeFile(
    path.join(directory, 'index.md'),
    [
      '# XXYY 产品 Wiki（待发布）',
      '',
      ...bundle.pages.map((page) => `- [${page.title}](${page.id}.md)`),
      '',
    ].join('\n'),
    { flag: 'wx' },
  );
  await writeFile(path.join(directory, 'bundle.json'), serialized, { flag: 'wx' });
  return { id, directory };
}

export async function loadWikiBuild(cwd: string, id: string): Promise<WikiBundle> {
  return validateWikiBundle(
    await readWikiJson(path.join(wikiBuildDirectory(cwd, id), 'bundle.json')),
  );
}

export async function publishWikiBuild(options: {
  cwd: string;
  bundle: WikiBundle;
  goldenCaseCount: number;
  verify: () => Promise<void>;
}): Promise<string> {
  const root = path.join(options.cwd, '.rag', 'wiki');
  await mkdir(root, { recursive: true });
  const lock = path.join(root, 'publication.lock');
  await mkdir(lock); // Fail closed on concurrent publication; never steal an old lock.
  const temporary = path.join(root, `.published-${randomUUID()}.json`);
  try {
    await options.verify();
    const published: PublishedWiki = publishedWikiSchema.parse({
      version: 1,
      publishedAt: new Date().toISOString(),
      bundle: options.bundle,
      bundleHash: wikiBundleHash(options.bundle),
      gate: {
        version: 'wiki-publication-v1',
        goldenCaseCount: options.goldenCaseCount,
        passed: true,
      },
    });
    const serialized = `${JSON.stringify(published, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > WIKI_MAX_BYTES) throw new Error('wiki_artifact_size_limit');
    await writeFile(temporary, serialized, { flag: 'wx' });
    const destination = path.join(root, 'published.json');
    await rename(temporary, destination);
    return destination;
  } finally {
    await rm(temporary, { force: true });
    await rm(lock, { recursive: true, force: true });
  }
}

export async function writeWikiReport(cwd: string, id: string, report: unknown): Promise<void> {
  // Evaluation reports are separate from the immutable model output.
  const directory = path.join(cwd, '.rag', 'wiki', 'evaluations');
  wikiBuildDirectory(cwd, id);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, `${id}-${randomUUID()}.json`),
    `${JSON.stringify(report, null, 2)}\n`,
    { flag: 'wx' },
  );
}
