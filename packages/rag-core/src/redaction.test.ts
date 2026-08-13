import { describe, expect, it } from 'vitest';

import { redactSensitiveConversationHistoryText } from './redaction.js';

describe('redactSensitiveConversationHistoryText', () => {
  const transactionId = `0x${'8'.repeat(64)}`;

  it('preserves explicitly labeled public transaction references', () => {
    expect(
      redactSensitiveConversationHistoryText(`检查 BSC 交易 ${transactionId} 是否被夹`),
    ).toContain(transactionId);
    expect(
      redactSensitiveConversationHistoryText(`https://bscscan.com/tx/${transactionId}`),
    ).toContain(transactionId);
  });

  it('continues to redact credentials and unrelated EVM addresses', () => {
    const privateKey = `0x${'a'.repeat(64)}`;
    const address = `0x${'b'.repeat(40)}`;
    const result = redactSensitiveConversationHistoryText(
      `交易私钥：${privateKey}\n池地址：${address}`,
    );

    expect(result).toMatch(/\[(?:sensitive_credential|transaction_hash)\]/u);
    expect(result).toContain('[evm_address]');
    expect(result).not.toContain(privateKey);
    expect(result).not.toContain(address);
  });
});
