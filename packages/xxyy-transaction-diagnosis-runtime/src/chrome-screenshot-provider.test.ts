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
    expect(expression).toContain('inset 0 0 0 4px #ff3b30');
    expect(expression).not.toContain('row.scrollIntoView');
    expect(expression).not.toContain('createElement');
  });

  it('requires stable OHLC data and painted K-line pixels before capture', () => {
    const expression = buildKlineReadinessExpression();

    expect(expression).toContain("document.querySelector('.main-content .chart iframe')");
    expect(expression).toContain("text.includes('∅')");
    expect(expression).toContain("frameDocument.querySelectorAll('.pane canvas')");
    expect(expression).toContain("canvas.getContext('2d', {willReadFrequently:true})");
    expect(expression).toContain('colorfulPixels >= 3');
    expect(expression).not.toContain('createElement');
  });

  it('drives the native historical-time filter without synthesizing evidence rows', () => {
    const expression = buildNativeHistoricalFilterExpression(1_785_576_519_057);

    expect(expression).toContain("name === 'tradeTable'");
    expect(expression).toContain('tradeTable.updateFilters');
    expect(expression).toContain('timeStart:1785576517057');
    expect(expression).toContain('timeEnd:1785576521057');
    expect(expression).toContain('document.hidden');
    expect(expression).not.toContain('createElement');
    expect(expression).not.toContain('/api/data/trades/search');
    expect(expression).not.toContain('xxyy-verified-evidence-panel');
  });
});
