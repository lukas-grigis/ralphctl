import { formatBytes } from './format-bytes.mjs';

export const sizeLine = (name, bytes) => `${name}: ${formatBytes(bytes)}`;
