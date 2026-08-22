import {
  xxyySandwichAssessmentInputSchema,
  xxyySandwichAssessmentSchema,
  type XxyySandwichAssessment,
  type XxyySandwichAssessmentInput,
  type XxyyTradeObservation,
} from './contracts.js';

export function assessXxyySandwichPattern(input: unknown): XxyySandwichAssessment {
  const parsed = xxyySandwichAssessmentInputSchema.parse(input) as XxyySandwichAssessmentInput;
  const target = parsed.observations.find(
    (observation) => observation.transactionId === parsed.targetTransactionId,
  );
  if (target === undefined) {
    throw new RangeError('Target transaction is missing from the Sandwich neighborhood.');
  }
  if (parsed.coverage.sourceConflicts > 0) {
    return result('insufficient_data', ['source_conflict']);
  }

  const ordered = [...parsed.observations].sort(compareObservationOrder);
  const targetIndex = ordered.findIndex(
    (observation) => observation.transactionId === parsed.targetTransactionId,
  );
  const front = ordered[targetIndex - 1];
  const back = ordered[targetIndex + 1];
  if (front === undefined || back === undefined) {
    return parsed.coverage.neighborhood === 'complete'
      ? result('unlikely', ['no_bracketing_transactions'])
      : result('insufficient_data', ['no_bracketing_transactions', 'neighborhood_incomplete']);
  }

  const sameBlockOrSlot = shareBlockOrSlot(front, target, back);
  const samePool =
    front.poolAddress === target.poolAddress && back.poolAddress === target.poolAddress;
  const transactionOrder =
    front.transactionIndex !== undefined &&
    target.transactionIndex !== undefined &&
    back.transactionIndex !== undefined &&
    front.transactionIndex < target.transactionIndex &&
    target.transactionIndex < back.transactionIndex;
  const actorMatches =
    front.actor !== undefined && front.actor === back.actor && front.actor !== target.actor;
  const directionMatches = front.side === target.side && isOppositeSide(target.side, back.side);

  const structuralReasons: XxyySandwichAssessment['reasonCodes'] = [
    ...(!sameBlockOrSlot ? (['same_block_or_slot_missing'] as const) : []),
    ...(!samePool ? (['pool_mismatch'] as const) : []),
    ...(!transactionOrder ? (['ordering_missing'] as const) : []),
    ...(front.actor === target.actor ? (['actor_same_as_target'] as const) : []),
    ...(!actorMatches && front.actor !== target.actor ? (['actor_mismatch'] as const) : []),
    ...(!directionMatches ? (['direction_mismatch'] as const) : []),
  ];
  const criteria = {
    actorLoop: criterion(parsed.calculation?.actorAssetLoopVerified),
    adverseVictimImpact: positiveCriterion(parsed.calculation?.victimLossRaw),
    profitableActor: positiveCriterion(parsed.calculation?.attackerProfitRaw),
    sameBlockOrSlot: booleanCriterion(sameBlockOrSlot),
    samePool: booleanCriterion(samePool),
    transactionOrder: booleanCriterion(transactionOrder),
    twoSidedDirection: booleanCriterion(directionMatches && actorMatches),
  } as const;

  if (structuralReasons.length > 0) {
    return result(
      parsed.coverage.neighborhood === 'complete' ? 'unlikely' : 'insufficient_data',
      structuralReasons,
      {
        back,
        criteria,
        front,
      },
    );
  }

  const victimLoss = parsed.calculation?.victimLossRaw;
  const attackerProfit = parsed.calculation?.attackerProfitRaw;
  if (victimLoss === undefined || attackerProfit === undefined) {
    return result('likely', ['candidate_pattern_complete', 'loss_or_profit_missing'], {
      back,
      criteria,
      front,
    });
  }
  if (victimLoss === '0') {
    return result('unlikely', ['target_not_adversely_affected'], { back, criteria, front });
  }
  if (attackerProfit === '0') {
    return result('unlikely', ['not_profitable'], { back, criteria, front });
  }

  const completeCoverage =
    parsed.coverage.neighborhood === 'complete' &&
    parsed.coverage.poolState === 'complete' &&
    parsed.coverage.actorAssetDeltas === 'complete';
  const actorLoopVerified = parsed.calculation?.actorAssetLoopVerified === true;
  return result(
    completeCoverage && actorLoopVerified ? 'confirmed' : 'likely',
    ['candidate_pattern_complete'],
    {
      back,
      criteria,
      front,
    },
  );
}

function result(
  verdict: XxyySandwichAssessment['verdict'],
  reasonCodes: XxyySandwichAssessment['reasonCodes'],
  candidate: {
    back?: XxyyTradeObservation;
    criteria?: XxyySandwichAssessment['criteria'];
    front?: XxyyTradeObservation;
  } = {},
): XxyySandwichAssessment {
  return xxyySandwichAssessmentSchema.parse({
    ...(candidate.back === undefined ? {} : { backTransactionId: candidate.back.transactionId }),
    ...(candidate.front?.actor === undefined ? {} : { candidateActor: candidate.front.actor }),
    criteria:
      candidate.criteria ??
      ({
        actorLoop: 'unknown',
        adverseVictimImpact: 'unknown',
        profitableActor: 'unknown',
        sameBlockOrSlot: 'unknown',
        samePool: 'unknown',
        transactionOrder: 'unknown',
        twoSidedDirection: 'unknown',
      } as const),
    ...(candidate.front === undefined ? {} : { frontTransactionId: candidate.front.transactionId }),
    reasonCodes,
    verdict,
  });
}

function compareObservationOrder(left: XxyyTradeObservation, right: XxyyTradeObservation): number {
  if (left.transactionIndex === undefined || right.transactionIndex === undefined) {
    return left.transactionId.localeCompare(right.transactionId);
  }
  return left.transactionIndex - right.transactionIndex;
}

function shareBlockOrSlot(
  front: XxyyTradeObservation,
  target: XxyyTradeObservation,
  back: XxyyTradeObservation,
): boolean {
  if (target.blockNumber !== undefined) {
    return front.blockNumber === target.blockNumber && back.blockNumber === target.blockNumber;
  }
  if (target.slot !== undefined) {
    return front.slot === target.slot && back.slot === target.slot;
  }
  return false;
}

function isOppositeSide(target: XxyyTradeObservation['side'], back: XxyyTradeObservation['side']) {
  return (target === 'buy' && back === 'sell') || (target === 'sell' && back === 'buy');
}

function booleanCriterion(value: boolean): 'yes' | 'no' {
  return value ? 'yes' : 'no';
}

function criterion(value: boolean | undefined): 'yes' | 'no' | 'unknown' {
  return value === undefined ? 'unknown' : booleanCriterion(value);
}

function positiveCriterion(value: string | undefined): 'yes' | 'no' | 'unknown' {
  return value === undefined ? 'unknown' : value === '0' ? 'no' : 'yes';
}
