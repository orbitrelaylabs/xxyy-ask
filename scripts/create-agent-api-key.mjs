import { createHash, randomBytes } from 'node:crypto';

const rawArguments = process.argv.slice(2);
const argumentsWithoutSeparator = rawArguments[0] === '--' ? rawArguments.slice(1) : rawArguments;
const id = (argumentsWithoutSeparator[0] ?? 'integration').trim();

if (!/^[A-Za-z0-9_.:@-]{1,160}$/u.test(id)) {
  process.stderr.write('Usage: pnpm agent:api-key:create -- [integration-id]\n');
  process.exitCode = 1;
} else {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  process.stdout.write(
    [
      'Store this plaintext API key in the integration secret manager; it will not be shown again:',
      token,
      '',
      'Add this record to XXYY_AGENT_API_KEYS_JSON:',
      JSON.stringify({ id, tokenHash }),
      '',
    ].join('\n'),
  );
}
