import { describe, expect, it } from 'vitest';

import {
  buildKlineReadinessExpression,
  buildNativeHistoricalFilterExpression,
  buildVerifiedRowHighlightExpression,
  xxyyPairUrl,
} from './chrome-screenshot-provider.js';

describe('xxyyPairUrl', () => {
  it('maps only fixed XXYY chain routes', () => {
    expect(xxyyPairUrl('solana:mainnet', '4EBLSHwS9fCmvEva1ZXFoczrkNUtcXiz3RQtCizPP1mP')).toBe(
      'https://www.xxyy.io/sol/4EBLSHwS9fCmvEva1ZXFoczrkNUtcXiz3RQtCizPP1mP',
    );
    expect(xxyyPairUrl('eip155:1', '0xabc')).toBe('https://www.xxyy.io/eth/0xabc');
    expect(xxyyPairUrl('eip155:56', '0xabc')).toBe('https://www.xxyy.io/bsc/0xabc');
    expect(xxyyPairUrl('eip155:8453', '0xabc')).toBe('https://www.xxyy.io/base/0xabc');
    expect(xxyyPairUrl('eip155:4663', '0xabc')).toBe('https://www.xxyy.io/robin/0xabc');
    expect(xxyyPairUrl('eip155:988', '0xabc')).toBe('https://www.xxyy.io/stable/0xabc');
    expect(() => xxyyPairUrl('unknown', 'abc')).toThrow(TypeError);
    expect(() => xxyyPairUrl('solana:mainnet', '../admin')).toThrow(TypeError);
  });

  it('centers and outlines only the native target row with surrounding rows visible', () => {
    const expression = buildVerifiedRowHighlightExpression({
      amountFragments: ['289.26', '182.27K'],
      makerSuffix: 'dae378',
      side: 'buy',
      timeFragments: ['17:28:39'],
    });

    expect(expression).toContain("leaf.closest('.row')");
    expect(expression).toContain("document.querySelector('.main-content .dashboard')");
    expect(expression).toContain('rowBox.top + rowBox.height / 2');
    expect(expression).toContain('targetIndex < 2');
    expect(expression).toContain('rendered.splice(0, rendered.length, ...source)');
    expect(expression).toContain('(nativeTargetIndex - 2) * rowHeight');
    expect(expression).toContain('inset 0 0 0 4px #ff3b30');
    expect(expression).not.toContain('row.scrollIntoView');
    expect(expression).not.toContain('createElement');
  });

  it('requires stable OHLC data and a rendered K-line canvas before capture', () => {
    const expression = buildKlineReadinessExpression();

    expect(expression).toContain("document.querySelectorAll('.main-content iframe')");
    expect(expression).toContain("candidate.src.startsWith('blob:https://www.xxyy.io/')");
    expect(expression).toContain("text.includes('∅')");
    expect(expression).toContain("frameDocument.querySelectorAll('.pane canvas')");
    expect(expression).toContain('canvas.width >= 100 && canvas.height >= 100');
    expect(expression).toContain('open|\\bO');
    expect(expression).toContain('close|\\bC');
    expect(expression).not.toContain('createElement');
  });

  it('drives the native historical-time filter without synthesizing evidence rows', () => {
    const expression = buildNativeHistoricalFilterExpression(1_785_576_519_057);

    expect(expression).toContain("name === 'tradeTable'");
    expect(expression).toContain('tradeTable.updateFilters');
    expect(expression).toContain('{...current, timeStart:1785576399057');
    expect(expression).toContain('timeStart:1785576399057');
    expect(expression).toContain('timeEnd:1785576639057');
    expect(expression).toContain('document.hidden');
    expect(expression).not.toContain('createElement');
    expect(expression).not.toContain('JSON.stringify(current)');
    expect(expression).not.toContain('/api/data/trades/search');
    expect(expression).not.toContain('xxyy-verified-evidence-panel');
  });

  it('supports a narrow historical window for high-volume trade lists', () => {
    const expression = buildNativeHistoricalFilterExpression(1_785_576_519_057, 5_000);

    expect(expression).toContain('timeStart:1785576514057');
    expect(expression).toContain('timeEnd:1785576524057');
  });
});
