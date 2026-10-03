/** `1 task` / `2 tasks` — the one count-and-noun spelling every surface shares. */
export const plural = (n: number, word: string): string => `${String(n)} ${word}${n === 1 ? '' : 's'}`;
