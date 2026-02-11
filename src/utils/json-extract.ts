/**
 * Extract a complete JSON array from text that may contain surrounding content.
 * Uses bracket-depth tracking to handle nested arrays and strings containing brackets.
 *
 * @param output - The text containing a JSON array
 * @returns The extracted JSON array string
 * @throws Error if no complete JSON array is found
 */
export function extractJsonArray(output: string): string {
  const start = output.indexOf('[');
  if (start === -1) {
    throw new Error('No JSON array found in output');
  }

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < output.length; i++) {
    const ch = output[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '[') depth++;
    if (ch === ']') {
      depth--;
      if (depth === 0) {
        return output.slice(start, i + 1);
      }
    }
  }
  throw new Error('No complete JSON array found in output');
}
