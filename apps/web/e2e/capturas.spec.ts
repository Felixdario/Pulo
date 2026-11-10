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

test.describe('390 px, claro: landing com erro', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    colorScheme: 'light',
    reducedMotion: 'reduce',
  });

  test('landing sem rede', async ({ page, context }) => {
    await page.goto('/');
    await page.getByLabel('Link para encurtar').fill('https://sualoja.com.br/black-friday');
    await context.setOffline(true);
    await page.getByRole('button', { name: 'Encurtar' }).click();
    await expect(page.locator('.tira-erro')).toContainText('Sem conexão');
    await context.setOffline(false);
    await page.locator('.tira-erro').scrollIntoViewIfNeeded();
    await capturar(page, 'landing-erro', '390', 'claro');
  });
});

/**
 * Página do link com 5 M de cliques (fase 8). Precisa de um web apontado para a API rodando contra
 * `encurtador_bench` (`corepack pnpm seed:big --hot=5000000`), passado em `CAPTURA_5M_URL`, e entra
 * como `bench@encurta.dev` / `bench1234` (o dono do link mais quente; ver packages/bench).
 */
test.describe('1440 px, claro: link com 5 M de cliques', () => {
  test.use({
    viewport: { width: 1440, height: 900 },
    colorScheme: 'light',
    reducedMotion: 'reduce',
  });
  const base = process.env.CAPTURA_5M_URL;

  test('link-5m', async ({ page }) => {
    test.skip(!base, 'defina CAPTURA_5M_URL (web contra a API do encurtador_bench)');
    await page.goto(`${base}/entrar`);
    await page.getByLabel('E-mail').fill('bench@encurta.dev');
    await page.getByLabel('Senha').fill('bench1234');
    await page.getByRole('button', { name: 'Entrar', exact: true }).click();
    await expect(page).toHaveURL(/\/app/);
    await page.goto(`${base}/app?sort=clicks&order=desc`);
    await page.locator('tbody .linha-curto').first().click();
    await page.goto(`${page.url().split('?')[0]}?period=12m`);
    await expect(page.locator('.dim').first()).toBeVisible();
    await expect(page.locator('.mapa-pais').first()).toBeAttached();
    await expect(page.locator('.numeros .numero')).toHaveText(/\d\.\d{3}\.\d{3}/);
    // O painel do pior caso (só em dev) fica fora da captura.
    await page.locator('[data-dev-pior-caso]').evaluateAll((els) => els.forEach((e) => e.remove()));
    await capturar(page, 'link-5m', '1440', 'claro');
  });
});
