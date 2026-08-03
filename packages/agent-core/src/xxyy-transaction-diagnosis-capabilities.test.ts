import { describe, expect, it, vi } from 'vitest';

import { createXxyyOnchainSupportMcpClientStub } from '@xxyy/xxyy-onchain-support-mcp';

import { CapabilityPolicyDeniedError } from './capability-registry.js';
import {
  XXYY_DIAGNOSIS_SKILL_CAPABILITY_ID,
  createXxyyTransactionDiagnosisCapabilityRegistry,
} from './xxyy-transaction-diagnosis-capabilities.js';

describe('XXYY transaction diagnosis capabilities', () => {
  it('grants only the fixed public caller', async () => {
    const diagnose = vi.fn();
    const registry = createXxyyTransactionDiagnosisCapabilityRegistry({
      caller: { channel: 'web', principal: 'anonymous' },
      mcpClient: createXxyyOnchainSupportMcpClientStub(diagnose),
    });

    await expect(
      registry.invoke(
        XXYY_DIAGNOSIS_SKILL_CAPABILITY_ID,
        { checks: ['pool'], network: 'solana:mainnet', reference: '4'.repeat(88) },
        { channel: 'telegram', principal: 'service' },
      ),
    ).rejects.toBeInstanceOf(CapabilityPolicyDeniedError);
    expect(diagnose).not.toHaveBeenCalled();
  });
});
