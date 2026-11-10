import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { entrarNoDemo } from './apoio';

/**
 * Capturas do README (fase 9): landing, lista, página do link e chaves, em 1440 e 390 px, claro e
 * escuro. Só roda com CAPTURAS=1: `CAPTURAS=1 corepack pnpm test:e2e capturas`.
 */
const pasta = fileURLToPath(new URL('../../../docs/screenshots/', import.meta.url));
mkdirSync(pasta, { recursive: true });

const LARGURAS = [
  { nome: '1440', viewport: { width: 1440, height: 900 } },
  { nome: '390', viewport: { width: 390, height: 844 } },
] as const;

async function capturar(page: Page, tela: string, largura: string, tema: string) {
  // Sem cursor piscando nem animação no meio do quadro.
  await page.addStyleTag({ content: '*{caret-color:transparent!important}' });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${pasta}${tela}-${largura}-${tema}.png` });
}

for (const tema of ['claro', 'escuro'] as const) {
  for (const l of LARGURAS) {
    test.describe(`${l.nome} px, ${tema}`, () => {
      test.use({
        viewport: l.viewport,
        colorScheme: tema === 'claro' ? 'light' : 'dark',
        reducedMotion: 'reduce',
      });

      test('telas', async ({ page }) => {
        await page.goto('/');
        await page.getByLabel('Link para encurtar').fill('https://sualoja.com.br/black-friday');
        await page.getByRole('button', { name: 'Encurtar' }).click();
        await expect(page.locator('.tira-resultado')).toBeVisible();
        await page.locator('body').click({ position: { x: 5, y: 300 } });
        await capturar(page, 'landing', l.nome, tema);

        await entrarNoDemo(page);
        await expect(page.locator('tbody .linha').first()).toBeVisible();
        await capturar(page, 'dashboard', l.nome, tema);

        await page.goto('/app?q=demo-promo');
        await page.locator('tbody .linha-curto').filter({ hasText: 'demo-promo' }).first().click();
        await expect(page.locator('.dim').first()).toBeVisible();
        await expect(page.locator('.mapa-pais').first()).toBeAttached();
        await capturar(page, 'link', l.nome, tema);

        await page.goto('/app/keys');
        await expect(page.locator('tbody tr').first()).toBeVisible();
        await capturar(page, 'chaves', l.nome, tema);
      });
    });
  }
}
