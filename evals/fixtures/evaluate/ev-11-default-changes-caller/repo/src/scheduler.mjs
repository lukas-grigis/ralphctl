import { backoff } from './backoff.mjs';

export const nextDelay = (attempt) => backoff(attempt);
