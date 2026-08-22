#!/usr/bin/env node

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

if (value('--reference') === 'fail') {
  process.stdout.write(
    `${JSON.stringify({ error: { message: 'xxyy-chrome-driver is unavailable' }, status: 'error' })}\n`,
  );
  process.exitCode = 1;
} else {
  const transaction = {
    analysis: {
      evidence: [],
      tokenTransfers: [],
      transaction: {
        chainId: '56',
        executionStatus: 'success',
        hash: value('--reference'),
      },
    },
    chainId: '56',
    diagnostics: [],
    family: 'evm',
    network: 'eip155:56',
    status: 'success',
    summary: 'fixture transaction',
    transactionId: value('--reference'),
  };
  const output = args.includes('--checks')
    ? {
        checks: value('--checks').split(','),
        screenshotEvidence: { reason: 'not_configured', status: 'unavailable' },
        status: 'success',
        summary: args.join(' '),
        transaction,
        warnings: process.env.OPENAI_API_KEY === undefined ? [] : ['secret-leaked'],
      }
    : transaction;
  process.stdout.write(`${JSON.stringify(output)}\n`);
}
