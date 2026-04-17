import { describe, expect, it } from 'vitest';
import {
  banner,
  colors,
  getQuoteForContext,
  getRandomQuote,
  getStatusEmoji,
  gradients,
  type QuoteCategory,
  QUOTES_BY_CATEGORY,
  RALPH_QUOTES,
  statusEmoji,
} from './theme.ts';
import { boxChars, type BoxStyle, horizontalLine, isTTY, renderBox, renderCard, verticalLine } from './ui.ts';

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

  // ========================================================================
  // New tests for expanded theme system
  // ========================================================================

  describe('gradients', () => {
    it('has donut, success, and warning presets', () => {
      expect(gradients.donut).toBeDefined();
      expect(gradients.success).toBeDefined();
      expect(gradients.warning).toBeDefined();
    });

    it('each preset is a callable function', () => {
      expect(typeof gradients.donut).toBe('function');
      expect(typeof gradients.success).toBe('function');
      expect(typeof gradients.warning).toBe('function');
    });

    it('each preset has a multiline method', () => {
      expect(typeof gradients.donut.multiline).toBe('function');
      expect(typeof gradients.success.multiline).toBe('function');
      expect(typeof gradients.warning.multiline).toBe('function');
    });

    it('donut gradient returns string containing original characters', () => {
      const result = gradients.donut('abcdef');
      expect(typeof result).toBe('string');
      for (const char of 'abcdef') {
        expect(result).toContain(char);
      }
    });

    it('multiline applies gradient per line', () => {
      const result = gradients.donut.multiline('abc\ndef');
      expect(result).toContain('\n');
      const lines = result.split('\n');
      expect(lines).toHaveLength(2);
    });

    it('success gradient returns a string', () => {
      const result = gradients.success('hello');
      expect(typeof result).toBe('string');
      expect(result).toContain('h');
    });

    it('warning gradient returns a string', () => {
      const result = gradients.warning('warning!');
      expect(typeof result).toBe('string');
      expect(result).toContain('w');
    });
  });

  describe('context-sensitive quotes', () => {
    it('has all four categories', () => {
      const categories: QuoteCategory[] = ['error', 'success', 'farewell', 'idle'];
      for (const cat of categories) {
        expect(QUOTES_BY_CATEGORY[cat].length).toBeGreaterThan(0);
      }
    });

    it('getQuoteForContext returns a string from the correct category', () => {
      const categories: QuoteCategory[] = ['error', 'success', 'farewell', 'idle'];
      for (const cat of categories) {
        const quote = getQuoteForContext(cat);
        expect(typeof quote).toBe('string');
        expect(quote.length).toBeGreaterThan(0);
      }
    });

    it('error quotes contain error-themed messages', () => {
      expect(QUOTES_BY_CATEGORY.error).toContain('Tastes like burning!');
    });

    it('success quotes contain positive messages', () => {
      expect(QUOTES_BY_CATEGORY.success).toContain("I'm helping!");
    });

    it('farewell quotes contain goodbye messages', () => {
      expect(QUOTES_BY_CATEGORY.farewell).toContain('I sleep in a drawer!');
    });

    it('idle quotes contain general Ralph sayings', () => {
      expect(QUOTES_BY_CATEGORY.idle).toContain('Hi, Super Nintendo Chalmers!');
    });
  });
});

// ============================================================================
// UI Component Tests
// ============================================================================

describe('UI Components', () => {
  describe('boxChars', () => {
    it('has light, rounded, and heavy styles', () => {
      const styles: BoxStyle[] = ['light', 'rounded', 'heavy'];
      for (const style of styles) {
        expect(boxChars[style]).toBeDefined();
        expect(boxChars[style].topLeft).toBeDefined();
        expect(boxChars[style].horizontal).toBeDefined();
        expect(boxChars[style].vertical).toBeDefined();
      }
    });

    it('rounded style uses curved corners', () => {
      expect(boxChars.rounded.topLeft).toBe('╭');
      expect(boxChars.rounded.bottomRight).toBe('╯');
    });

    it('heavy style uses thick lines', () => {
      expect(boxChars.heavy.horizontal).toBe('━');
      expect(boxChars.heavy.vertical).toBe('┃');
    });
  });

  describe('horizontalLine', () => {
    it('creates a line of specified width', () => {
      const line = horizontalLine(5);
      expect(line).toBe('─────');
    });

    it('uses heavy style when specified', () => {
      const line = horizontalLine(3, 'heavy');
      expect(line).toBe('━━━');
    });
  });

  describe('verticalLine', () => {
    it('returns vertical character for default style', () => {
      expect(verticalLine()).toBe('│');
    });

    it('returns heavy vertical character', () => {
      expect(verticalLine('heavy')).toBe('┃');
    });
  });

  describe('renderBox', () => {
    it('renders a box with borders around content', () => {
      const result = renderBox(['hello', 'world']);
      expect(result).toContain('hello');
      expect(result).toContain('world');
      // Should have multiple lines (top border + content + bottom border)
      const lines = result.split('\n');
      expect(lines.length).toBeGreaterThanOrEqual(4);
    });

    it('uses rounded style by default', () => {
      const result = renderBox(['test']);
      expect(result).toContain('╭');
      expect(result).toContain('╯');
    });

    it('respects style option', () => {
      const result = renderBox(['test'], { style: 'heavy' });
      expect(result).toContain('┏');
      expect(result).toContain('┛');
    });
  });

  describe('renderCard', () => {
    it('renders a card with title and content', () => {
      const result = renderCard('My Title', ['line 1', 'line 2']);
      expect(result).toContain('My Title');
      expect(result).toContain('line 1');
      expect(result).toContain('line 2');
    });

    it('includes a separator between title and content', () => {
      const result = renderCard('Title', ['body']);
      // Should contain tee characters from separator
      expect(result).toContain('├');
      expect(result).toContain('┤');
    });

    it('has more lines than renderBox due to title + separator', () => {
      const card = renderCard('Title', ['line']);
      const box = renderBox(['line']);
      expect(card.split('\n').length).toBeGreaterThan(box.split('\n').length);
    });
  });

  describe('isTTY', () => {
    it('returns a boolean', () => {
      expect(typeof isTTY()).toBe('boolean');
    });
  });

  describe('terminalBell', () => {
    it('is exported and callable', async () => {
      const { terminalBell } = await import('./ui.ts');
      expect(typeof terminalBell).toBe('function');
      // Should not throw
      terminalBell();
    });
  });
});
