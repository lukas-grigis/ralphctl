export const backoff = (attempt, { baseMs = 100 } = {}) => baseMs * 2 ** attempt;
