/**
 * Extract a complete JSON structure (array or object) from text that may contain surrounding content.
 * Uses depth tracking to handle nested structures and strings containing brackets/braces.
 */
function extractJsonStructure(output: string, open: string, close: string, typeName: string): string {
  const start = output.indexOf(open);
  if (start === -1) {
    throw new Error(`No JSON ${typeName} found in output`);
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
    if (ch === open) depth++;
    if (ch === close) {
      depth--;
      if (depth === 0) {
        return output.slice(start, i + 1);
      }
    }
  }
  throw new Error(`No complete JSON ${typeName} found in output`);
}

/**
 * Extract a complete JSON array from text that may contain surrounding content.
 * Uses bracket-depth tracking to handle nested arrays and strings containing brackets.
 *
 * @param output - The text containing a JSON array
 * @returns The extracted JSON array string
 * @throws Error if no complete JSON array is found
 */
export function extractJsonArray(output: string): string {
  return extractJsonStructure(output, '[', ']', 'array');
}

/**
 * Extract a complete JSON object from text that may contain surrounding content.
 * Uses brace-depth tracking to handle nested objects and strings containing braces.
 *
 * @param output - The text containing a JSON object
 * @returns The extracted JSON object string
 * @throws Error if no complete JSON object is found
 */
export function extractJsonObject(output: string): string {
  return extractJsonStructure(output, '{', '}', 'object');
}
