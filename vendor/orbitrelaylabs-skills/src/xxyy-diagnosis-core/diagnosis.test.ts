import { describe, expect, it } from 'vitest';

import { assessXxyyPoolSelection, assessXxyySandwichPattern } from './index.js';

describe('XXYY transaction diagnosis core', () => {
  it('separates canonical-pool mismatch from relative small-pool evidence', () => {
    expect(
      assessXxyyPoolSelection({
        actualPoolAddress: 'small-pool',
        candidatePools: [
          {
            baseToken: 'token',
            chain: 'solana:mainnet',
            liquidityUsd: '100000.50',
            pairAddress: 'canonical-pool',
            quoteToken: 'sol',
          },
          {
            baseToken: 'token',
            chain: 'solana:mainnet',
            liquidityUsd: '250',
            pairAddress: 'small-pool',
            quoteToken: 'sol',
          },
        ],
        canonicalPoolAddress: 'canonical-pool',
        policy: {
          maxSmallPoolLiquidityUsd: '1000',
          maxSmallPoolRelativeLiquidityPpm: 50_000,
          version: '1.0.0',
        },
      }),
    ).toMatchObject({
      canonicalMatch: 'does_not_match',
      liquidityClass: 'small',
      relativeLiquidityPpm: 2_499,
    });
  });

  it('confirms only a complete ordered same-pool actor loop with positive loss and profit', () => {
    expect(
      assessXxyySandwichPattern({
        calculation: {
          actorAssetLoopVerified: true,
          attackerProfitRaw: '10',
          victimLossRaw: '20',
        },
        coverage: {
          actorAssetDeltas: 'complete',
          neighborhood: 'complete',
          poolState: 'complete',
          sourceConflicts: 0,
        },
        observations: [
          observation('front', 10, 'attacker', 'buy'),
          observation('target', 11, 'trader', 'buy'),
          observation('back', 12, 'attacker', 'sell'),
        ],
        targetTransactionId: 'target',
      }),
    ).toMatchObject({
      backTransactionId: 'back',
      candidateActor: 'attacker',
      frontTransactionId: 'front',
      verdict: 'confirmed',
    });
  });

  it('marks same-slot bracketing as likely without loss and profit evidence', () => {
    expect(
      assessXxyySandwichPattern({
        coverage: {
          actorAssetDeltas: 'missing',
          neighborhood: 'partial',
          poolState: 'missing',
          sourceConflicts: 0,
        },
        observations: [
          observation('front', 10, 'attacker', 'buy'),
          observation('target', 11, 'trader', 'buy'),
          observation('back', 12, 'attacker', 'sell'),
        ],
        targetTransactionId: 'target',
      }),
    ).toMatchObject({
      reasonCodes: ['candidate_pattern_complete', 'loss_or_profit_missing'],
      verdict: 'likely',
    });
  });

  it('returns unlikely for a complete neighborhood that structurally contradicts a sandwich', () => {
    expect(
      assessXxyySandwichPattern({
        coverage: {
          actorAssetDeltas: 'missing',
          neighborhood: 'complete',
          poolState: 'missing',
          sourceConflicts: 0,
        },
        observations: [
          { ...observation('front', 10, 'first-actor', 'buy'), slot: '41' },
          observation('target', 11, 'trader', 'buy'),
          { ...observation('back', 12, 'second-actor', 'buy'), slot: '43' },
        ],
        targetTransactionId: 'target',
      }),
    ).toMatchObject({
      reasonCodes: ['same_block_or_slot_missing', 'actor_mismatch', 'direction_mismatch'],
      verdict: 'unlikely',
    });
  });

  it('fails closed on source conflict', () => {
    expect(
      assessXxyySandwichPattern({
        coverage: {
          actorAssetDeltas: 'complete',
          neighborhood: 'complete',
          poolState: 'complete',
          sourceConflicts: 1,
        },
        observations: [observation('target', 11, 'trader', 'buy')],
        targetTransactionId: 'target',
      }),
    ).toMatchObject({ reasonCodes: ['source_conflict'], verdict: 'insufficient_data' });
  });
});

function observation(
  transactionId: string,
  transactionIndex: number,
  actor: string,
  side: 'buy' | 'sell',
) {
  return {
    actor,
    poolAddress: 'pool',
    side,
    slot: '42',
    transactionId,
    transactionIndex,
  };
}
