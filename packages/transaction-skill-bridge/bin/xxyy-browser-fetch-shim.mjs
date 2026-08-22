import { createXxyyBrowserFetch } from '../src/xxyy-browser-fetch-runtime.mjs';

const referenceIndex = process.argv.indexOf('--reference');
const targetTransactionId =
  referenceIndex < 0 ? undefined : process.argv[referenceIndex + 1]?.trim();

globalThis.fetch = createXxyyBrowserFetch({
  originalFetch: globalThis.fetch,
  ...(targetTransactionId ? { targetTransactionId } : {}),
});
