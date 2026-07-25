import { describe, expect, it } from 'vitest';

import { createSolanaDataAdapter } from './solana-data-adapter.js';

const SIGNATURE =
  '5h6xBEauJ3PK6SWCZ1q9mVqQPfV9VhJ1wN3EZ7hJQf8sJLBX5Un19XTrRruDq4WZx9ZMkF7Xr1ezKj9eVJb2xYwA';
const ACCOUNT = '47eFuHR9ste9kopiJ9eRxcwahmE62JovbKe5r7AjANut';
const RECIPIENT = '9vLSZ1gujMzisVrK5r3ZBXLVJMrF3fp6BtAUDyD94nW2';
const PROGRAM = '11111111111111111111111111111111';
const MINT = '5kR7n7QJv85NrwwXdYWZ52qkRcyvXqKWDPNooYcfDV6e';

describe('createSolanaDataAdapter', () => {
  it('loads and normalizes a confirmed transaction', async () => {
    const adapter = createSolanaDataAdapter({
      config: {
        network: 'solana:mainnet',
        providers: [{ endpoint: 'https://solana.example/rpc', id: 'primary' }],
      },
      fetchImpl: () => Promise.resolve(jsonResponse(transactionPayload())),
      now: () => new Date('2026-07-25T00:00:00.000Z'),
    });

    await expect(
      adapter.loadTransaction({
        network: 'solana:mainnet',
        transactionId: SIGNATURE,
      }),
    ).resolves.toMatchObject({
      snapshot: {
        executionStatus: 'success',
        feeLamports: '5000',
        nativeBalanceChanges: [
          { account: ACCOUNT, deltaLamports: '-6000' },
          { account: RECIPIENT, deltaLamports: '1000' },
        ],
        slot: '423118809',
        sources: [{ id: 'primary', provenanceUrl: 'https://solana.example' }],
        transactionId: SIGNATURE,
      },
      status: 'success',
    });
  });

  it('returns insufficient data when the transaction is absent', async () => {
    const adapter = createSolanaDataAdapter({
      config: {
        network: 'solana:mainnet',
        providers: [{ endpoint: 'https://solana.example/rpc', id: 'primary' }],
      },
      fetchImpl: () => Promise.resolve(jsonResponse({ id: 1, jsonrpc: '2.0', result: null })),
    });

    await expect(
      adapter.loadTransaction({
        network: 'solana:mainnet',
        transactionId: SIGNATURE,
      }),
    ).resolves.toMatchObject({
      diagnostics: [{ code: 'transaction_not_found', providerId: 'primary' }],
      status: 'insufficient_data',
    });
  });

  it('marks conflicting provider observations partial', async () => {
    const adapter = createSolanaDataAdapter({
      config: {
        network: 'solana:mainnet',
        providers: [
          { endpoint: 'https://one.example/rpc', id: 'primary' },
          { endpoint: 'https://two.example/rpc', id: 'secondary' },
        ],
      },
      fetchImpl: (url) => {
        const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
        return Promise.resolve(
          jsonResponse(transactionPayload(href.includes('two.example') ? 5001 : 5000)),
        );
      },
    });

    const result = await adapter.loadTransaction({
      network: 'solana:mainnet',
      transactionId: SIGNATURE,
    });
    expect(result.status).toBe('partial');
    expect(result.diagnostics.filter((item) => item.code === 'provider_conflict')).toHaveLength(2);
  });

  it('rejects insecure remote endpoints at construction', () => {
    expect(() =>
      createSolanaDataAdapter({
        config: {
          network: 'solana:mainnet',
          providers: [{ endpoint: 'http://solana.example/rpc', id: 'primary' }],
        },
      }),
    ).toThrow('not allowed');
  });
});

function transactionPayload(fee = 5000) {
  return {
    id: 1,
    jsonrpc: '2.0',
    result: {
      blockTime: 1_763_751_416,
      meta: {
        computeUnitsConsumed: 21_889,
        err: null,
        fee,
        logMessages: ['Program log: test'],
        postBalances: [994_000, 1_001_000, 1],
        postTokenBalances: [
          {
            accountIndex: 1,
            mint: MINT,
            owner: RECIPIENT,
            programId: PROGRAM,
            uiTokenAmount: { amount: '10', decimals: 2 },
          },
        ],
        preBalances: [1_000_000, 1_000_000, 1],
        preTokenBalances: [
          {
            accountIndex: 1,
            mint: MINT,
            owner: RECIPIENT,
            programId: PROGRAM,
            uiTokenAmount: { amount: '0', decimals: 2 },
          },
        ],
      },
      slot: 423_118_809,
      transaction: {
        message: {
          accountKeys: [ACCOUNT, RECIPIENT, PROGRAM],
          instructions: [{ programId: PROGRAM }],
        },
        signatures: [SIGNATURE],
      },
      version: 0,
    },
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
    status: 200,
  });
}
