import { uuidv7Id } from '@src/domain/value/uuid7.ts';

declare const __projectId: unique symbol;
export type ProjectId = string & { readonly [__projectId]: 'ProjectId' };

export const ProjectId = uuidv7Id<ProjectId>('project');
