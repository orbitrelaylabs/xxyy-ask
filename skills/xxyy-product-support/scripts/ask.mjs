#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import path from 'node:path';

export async function runProductSupportSkill(options = {}) {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const parsed = parseArguments(argv);
  const baseUrl = normalizeBaseUrl(
    parsed.baseUrl ?? env.XXYY_SUPPORT_API_BASE_URL ?? 'http://127.0.0.1:3000',
  );
  const apiKey = env.XXYY_SUPPORT_API_KEY?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    throw new TypeError('XXYY_SUPPORT_API_KEY is required.');
  }
  const response = await fetchImpl(`${baseUrl}/api/v1/chat`, {
    body: JSON.stringify({ channel: 'web', message: parsed.question }),
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    method: 'POST',
  });
  const payload = await response.json().catch(() => undefined);
  if (!response.ok || payload === undefined) {
    throw new Error(`XXYY support API failed with HTTP ${response.status}.`);
  }
  return payload;
}

export async function main(options = {}) {
  const argv = options.argv ?? process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  try {
    const output = await runProductSupportSkill({ ...options, argv });
    process.stdout.write(
      `${JSON.stringify(output, null, argv.includes('--pretty') ? 2 : undefined)}\n`,
    );
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        error: {
          code: 'product_support_failed',
          message: error instanceof Error ? error.message : 'XXYY product support failed.',
        },
        status: 'error',
      })}\n`,
    );
    process.exitCode = 1;
  }
}

function parseArguments(argv) {
  const values = new Map();
  const allowed = new Set(['--base-url', '--question']);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--pretty') continue;
    if (!allowed.has(argument)) throw new TypeError(`Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new TypeError(`${argument} requires a value.`);
    }
    values.set(argument, value);
    index += 1;
  }
  const question = values.get('--question')?.trim();
  if (question === undefined || question.length === 0) {
    throw new TypeError('--question is required.');
  }
  return { baseUrl: values.get('--base-url'), question };
}

function normalizeBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('XXYY support API base URL must use HTTP or HTTPS.');
  }
  return url.href.replace(/\/$/u, '');
}

function usage() {
  return [
    'Usage: ask.mjs --question <question> [options]',
    '',
    'Options:',
    '  --base-url <url>   XXYY Agent API base URL (default: http://127.0.0.1:3000)',
    '  --pretty           Pretty-print the JSON response',
    '',
    'Environment:',
    '  XXYY_SUPPORT_API_KEY       Required read-only Agent API key',
    '  XXYY_SUPPORT_API_BASE_URL  Optional default API base URL',
  ].join('\n');
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main();
}
