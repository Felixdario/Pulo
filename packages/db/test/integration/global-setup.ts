import type { TestProject } from 'vitest/node';
import { ensureTestDatabase } from '../../src/testing';

declare module 'vitest' {
  export interface ProvidedContext {
    testDatabaseUrl: string;
  }
}

/** Cria `encurtador_test` se não existir e aplica as migrações. Não toca no banco de dev. */
export default async function setup(project: TestProject) {
  project.provide('testDatabaseUrl', await ensureTestDatabase());
}
