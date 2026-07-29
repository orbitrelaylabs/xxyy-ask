import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createBlockscoutTraceClient } from './blockscout-trace-client.js';
import { EvmExecutionDataAdapterConfigurationError } from './errors.js';

const HASH = `0x${'ab'.repeat(32)}`;
const TRACE = {
  calls: [],
  from: '0x1111111111111111111111111111111111111111',
  gasUsed: '0x5208',
  input: '0x',
  output: '0x',
  to: '0x2222222222222222222222222222222222222222',
  type: 'CALL',
  value: '0x0',
};

describe('Blockscout trace client', () => {
  it('loads the bounded transaction root from the configured v2 raw-trace endpoint', async () => {
    const payload = JSON.stringify(TRACE);
    let requestedUrl = '';
    let requestedInit: RequestInit | undefined;
    const client = createBlockscoutTraceClient({
      fetchImpl: (request, init) => {
        requestedUrl = request instanceof Request ? request.url : request.toString();
        requestedInit = init;
        return Promise.resolve(
          new Response(payload, {
            headers: { 'content-type': 'application/json' },
            status: 200,
          }),
        );
      },
      source: {
        endpoint: 'https://explorer.example/base/',
        id: 'blockscout_public',
        kind: 'blockscout_v2',
      },
    });

    await expect(client.requestTrace(HASH)).resolves.toEqual({
      attempts: 1,
      ok: true,
      payloadHash: `sha256:${createHash('sha256').update(payload).digest('hex')}`,
      result: TRACE,
    });
    expect(requestedUrl).toBe(
      `https://explorer.example/base/api/v2/transactions/${HASH}/raw-trace`,
    );
    expect(requestedInit).toMatchObject({
      headers: { accept: 'application/json' },
      method: 'GET',
      redirect: 'error',
    });
    expect(requestedInit?.body).toBeUndefined();
  });

  it('returns stable failures for missing, malformed, and oversized responses', async () => {
    const missing = createBlockscoutTraceClient({
      fetchImpl: () => Promise.resolve(new Response('{}', { status: 404 })),
      source: {
        endpoint: 'https://explorer.example',
        id: 'missing',
        kind: 'blockscout_v2',
      },
    });
    await expect(missing.requestTrace(HASH)).resolves.toMatchObject({
      code: 'trace_not_found',
      httpStatus: 404,
      ok: false,
      retryable: false,
    });

    const malformed = createBlockscoutTraceClient({
      fetchImpl: () => Promise.resolve(new Response('not-json', { status: 200 })),
      source: {
        endpoint: 'https://explorer.example',
        id: 'malformed',
        kind: 'blockscout_v2',
      },
    });
    await expect(malformed.requestTrace(HASH)).resolves.toMatchObject({
      code: 'invalid_json',
      ok: false,
      retryable: false,
    });

    const oversized = createBlockscoutTraceClient({
      fetchImpl: () =>
        Promise.resolve(
          new Response(JSON.stringify(TRACE), {
            headers: { 'content-length': '1000' },
            status: 200,
          }),
        ),
      maxResponseBytes: 100,
      source: {
        endpoint: 'https://explorer.example',
        id: 'oversized',
        kind: 'blockscout_v2',
      },
    });
    await expect(oversized.requestTrace(HASH)).resolves.toMatchObject({
      code: 'response_too_large',
      ok: false,
      retryable: false,
    });
  });

  it('rejects credentials, query strings, and non-TLS remote endpoints at startup', () => {
    for (const endpoint of [
      'https://user:secret@explorer.example',
      'https://explorer.example?token=secret',
      'http://explorer.example',
    ]) {
      expect(() =>
        createBlockscoutTraceClient({
          source: {
            endpoint,
            id: 'invalid',
            kind: 'blockscout_v2',
          },
        }),
      ).toThrow(EvmExecutionDataAdapterConfigurationError);
    }
  });
});
