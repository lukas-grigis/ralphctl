import { describe, expect, it } from 'vitest';
import {
  banner,
  colors,
  getMessage,
  getRandomQuote,
  getStatusEmoji,
  messages,
  RALPH_QUOTES,
  statusEmoji,
} from './index.ts';

describe('Theme System', () => {
  describe('colors', () => {
    it('has semantic color functions', () => {
      expect(typeof colors.success).toBe('function');
      expect(typeof colors.error).toBe('function');
      expect(typeof colors.info).toBe('function');
    });
  });

  describe('getRandomQuote', () => {
    it('returns a string from theme quotes', () => {
      const quote = getRandomQuote();
      expect(typeof quote).toBe('string');
      expect(quote.length).toBeGreaterThan(0);
    });
  });

  describe('getStatusEmoji', () => {
    it('returns emoji for known status', () => {
      const emoji = getStatusEmoji('done');
      expect(emoji).toBe(statusEmoji.done);
    });

    it('returns status string for unknown status', () => {
      const emoji = getStatusEmoji('unknown');
      expect(emoji).toBe('unknown');
    });
  });

  describe('getMessage', () => {
    it('returns themed message', () => {
      const msg = getMessage('welcome');
      expect(msg).toBe(messages.welcome);
    });
  });

  describe('banner', () => {
    it('has donuts in banner', () => {
      expect(banner.art).toContain('🍩');
    });
  });

  describe('quotes', () => {
    it('has Ralph quotes', () => {
      expect(RALPH_QUOTES).toContain("I'm helping!");
      expect(RALPH_QUOTES).toContain('Go banana!');
    });
  });

  describe('statusEmoji', () => {
    it('has emoji status indicators', () => {
      expect(statusEmoji.done).toBe('✅');
      expect(statusEmoji.todo).toBe('📝');
    });
  });
});
