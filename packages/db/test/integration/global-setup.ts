import type { TestProject } from 'vitest/node';
import { ensureTestDatabase, holdTestSuiteLock } from '../../src/testing';

declare module 'vitest' {
  export interface ProvidedContext {
    testDatabaseUrl: string;
  }
}

/** Cria `encurtador_test` se não existir e aplica as migrações. Não toca no banco de dev. */
export default async function setup(project: TestProject) {
  // Uma suíte de integração por vez no servidor inteiro (ver holdTestSuiteLock).
  const release = await holdTestSuiteLock();
  project.provide('testDatabaseUrl', await ensureTestDatabase());
  return release;
}
