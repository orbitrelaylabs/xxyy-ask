import { readFile, writeFile } from 'node:fs/promises';

const bundles = [
  'skills/onchain-transaction-inspector/scripts/inspect.mjs',
  'skills/xxyy-transaction-diagnosis/scripts/diagnose.mjs',
];

for (const bundle of bundles) {
  const source = await readFile(bundle, 'utf8');
  await writeFile(bundle, source.replace(/[\t ]+$/gmu, ''));
}
