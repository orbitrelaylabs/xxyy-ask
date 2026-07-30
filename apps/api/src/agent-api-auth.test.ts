import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createAgentApiAuthenticator } from './agent-api-auth.js';

describe('createAgentApiAuthenticator', () => {
  it('fails closed when API keys are not configured', () => {
    const authenticator = createAgentApiAuthenticator(undefined);
    expect(authenticator.configured).toBe(false);
    expect(authenticator.authenticate('Bearer any-token-that-is-long-enough')).toBeUndefined();
  });

  it('authenticates a hashed bearer token without storing the plaintext secret', () => {
    const token = 'agent-api-token-with-at-least-24-chars';
    const authenticator = createAgentApiAuthenticator(
      JSON.stringify([
        {
          id: 'integration:test',
          tokenHash: createHash('sha256').update(token).digest('hex'),
        },
      ]),
    );
    expect(authenticator.authenticate(`Bearer ${token}`)).toEqual({ id: 'integration:test' });
    expect(authenticator.authenticate('Bearer wrong-token-that-is-long-enough')).toBeUndefined();
  });
});
