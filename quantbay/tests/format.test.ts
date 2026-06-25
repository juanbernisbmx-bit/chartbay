import { describe, it, expect } from 'vitest';
import {
  escapeHtml,
  significanceBadge,
  significanceLabel,
  correlationClass,
} from '../src/utils/format';

describe('escapeHtml', () => {
  it('escapes &', () => expect(escapeHtml('a & b')).toBe('a &amp; b'));
  it('escapes <', () => expect(escapeHtml('<script>')).toBe('&lt;script&gt;'));
  it('escapes >', () => expect(escapeHtml('a > b')).toBe('a &gt; b'));
  it('escapes "', () => expect(escapeHtml('"quoted"')).toBe('&quot;quoted&quot;'));
  it("escapes '", () => expect(escapeHtml("it's")).toBe('it&#39;s'));
  it('treats null as empty string', () => expect(escapeHtml(null)).toBe(''));
  it('treats undefined as empty string', () => expect(escapeHtml(undefined)).toBe(''));
  it('handles numbers', () => expect(escapeHtml(42)).toBe('42'));
  it('leaves safe strings unchanged', () => expect(escapeHtml('hello 123')).toBe('hello 123'));
  it('escapes all five chars in a single string', () => {
    expect(escapeHtml('<a href="x&y">it\'s</a>')).toBe(
      '&lt;a href=&quot;x&amp;y&quot;&gt;it&#39;s&lt;/a&gt;'
    );
  });
});

describe('significanceBadge', () => {
  it('p < 0.01 → *** badge', () => expect(significanceBadge(0.005)).toContain('***'));
  it('p = 0.01 → ** badge (boundary)', () => expect(significanceBadge(0.01)).toContain('**'));
  it('p < 0.05 → ** badge', () => expect(significanceBadge(0.03)).toContain('**'));
  it('p = 0.05 → * badge (boundary)', () => expect(significanceBadge(0.05)).toContain('*'));
  it('p < 0.10 → * badge', () => expect(significanceBadge(0.08)).toContain('*'));
  it('p = 0.10 → n.s. (boundary)', () => expect(significanceBadge(0.10)).toContain('n.s.'));
  it('p > 0.10 → n.s.', () => expect(significanceBadge(0.5)).toContain('n.s.'));
  it('returns an HTML string with a span', () => expect(significanceBadge(0.01)).toContain('<span'));
});

describe('significanceLabel', () => {
  it('p < 0.01 → ***', () => expect(significanceLabel(0.001)).toBe('***'));
  it('p < 0.05 → **', () => expect(significanceLabel(0.03)).toBe('**'));
  it('p < 0.10 → *', () => expect(significanceLabel(0.07)).toBe('*'));
  it('p >= 0.10 → n.s.', () => expect(significanceLabel(0.5)).toBe('n.s.'));
  it('p = 0 → ***', () => expect(significanceLabel(0)).toBe('***'));
});

describe('correlationClass', () => {
  it('diagonal element → corr-diag', () => expect(correlationClass(1, true)).toBe('corr-diag'));
  it('r >= 0.7 → corr-sp', () => expect(correlationClass(0.8, false)).toBe('corr-sp'));
  it('r = 0.7 boundary → corr-sp', () => expect(correlationClass(0.7, false)).toBe('corr-sp'));
  it('r <= -0.7 → corr-sn', () => expect(correlationClass(-0.75, false)).toBe('corr-sn'));
  it('r = -0.7 boundary → corr-sn', () => expect(correlationClass(-0.7, false)).toBe('corr-sn'));
  it('0.3 <= r < 0.7 → corr-mp', () => expect(correlationClass(0.5, false)).toBe('corr-mp'));
  it('-0.7 < r <= -0.3 → corr-mn', () => expect(correlationClass(-0.4, false)).toBe('corr-mn'));
  it('|r| < 0.3 → corr-w', () => expect(correlationClass(0.1, false)).toBe('corr-w'));
  it('r = 0 → corr-w', () => expect(correlationClass(0, false)).toBe('corr-w'));
});
