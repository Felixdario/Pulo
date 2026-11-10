import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { entrarNoDemo } from './apoio';

/** axe com as regras WCAG 2.x A/AA; falha em violação séria ou crítica. */
async function semViolacoesSerias(page: Page, tela: string) {
  const r = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const serias = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    serias.map(
      (v) =>
        `${tela}: ${v.id} (${v.impact}) em ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
    ),
  ).toEqual([]);
}

for (const tema of ['light', 'dark'] as const) {
  test.describe(`axe, tema ${tema === 'light' ? 'claro' : 'escuro'}`, () => {
    test.use({ colorScheme: tema });

    test('landing e login', async ({ page }) => {
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await semViolacoesSerias(page, 'landing');
      await page.goto('/entrar');
      await expect(page.getByRole('heading', { name: 'Entrar' })).toBeVisible();
      await semViolacoesSerias(page, 'login');
    });

    test('lista, página do link e chaves', async ({ page }) => {
      await entrarNoDemo(page);
      await expect(page.locator('tbody .linha').first()).toBeVisible();
      await semViolacoesSerias(page, 'lista');

      await page.goto('/app?q=demo-promo');
      await page.locator('tbody .linha-curto').filter({ hasText: 'demo-promo' }).first().click();
      await expect(page.locator('.numeros .numero')).not.toHaveText('');
      await expect(page.locator('.mapa-pais').first()).toBeAttached();
      await expect(page.locator('.dim').first()).toBeVisible();
      await semViolacoesSerias(page, 'link');

      await page.getByRole('link', { name: 'Chaves de API' }).click();
      await expect(page.locator('tbody tr').first()).toBeVisible();
      await semViolacoesSerias(page, 'chaves');
    });
  });
}
