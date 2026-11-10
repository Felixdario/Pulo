import { ensureTestDatabase } from '@encurtador/db/testing';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    testDatabaseUrl: string;
  }
}

export default async function setup(project: TestProject) {
  project.provide('testDatabaseUrl', await ensureTestDatabase());
}
