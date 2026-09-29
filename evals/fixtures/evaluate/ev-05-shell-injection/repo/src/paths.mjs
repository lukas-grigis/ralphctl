import { join } from 'node:path';

export const inHome = (name) => join(process.env.HOME ?? '.', name);
