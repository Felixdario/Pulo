import { ensureTestDatabase, holdTestSuiteLock } from '@encurtador/db/testing';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    testDatabaseUrl: string;
  }
}

export default async function setup(project: TestProject) {
  // Uma suíte de integração por vez no servidor inteiro (ver holdTestSuiteLock).
  const release = await holdTestSuiteLock();
  project.provide('testDatabaseUrl', await ensureTestDatabase());
  return release;
}
