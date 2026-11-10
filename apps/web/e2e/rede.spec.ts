import { expect, test } from '@playwright/test';
import { entrarNoDemo } from './apoio';

/** break-ui (fase 8): sem rede, cada bloco diz o que falhou e oferece tentar de novo. */
test('sem rede: landing, busca da lista, página seguinte e ao vivo', async ({ page, context }) => {
  // Landing: o encurtar falha com a frase de conexão, não com um erro genérico.
  await page.goto('/');
  await page.getByLabel('Link para encurtar').fill('example.com/sem-rede');
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Encurtar' }).click();
  await expect(page.locator('.tira-erro')).toContainText('Sem conexão com o servidor');
  await context.setOffline(false);

  // Lista: uma busca nova sem rede mostra o erro, não a lista da busca anterior.
  await entrarNoDemo(page);
  await expect(page.locator('tbody .linha').first()).toBeVisible();
  await context.setOffline(true);
  await page.getByPlaceholder('Buscar por título, slug ou destino').fill('demo-promo');
  const erro = page.locator('.lista .bloco-erro');
  await expect(erro).toContainText('Não deu para carregar os links. Sem conexão');
  await expect(page.locator('tbody .linha')).toHaveCount(0);
  await context.setOffline(false);
  await erro.getByRole('button', { name: 'Tentar de novo' }).click();
  await expect(page.locator('tbody .linha').first()).toContainText('demo-promo');

  // Ao vivo: offline pausa e diz a hora; Retomar reconecta.
  await page.locator('tbody .linha-curto').filter({ hasText: 'demo-promo' }).first().click();
  const aoVivo = page.locator('.ao-vivo');
  await expect(page.locator('.ponto-vivo:not(.ponto-vivo-vazado)')).toBeVisible();
  await context.setOffline(true);
  await expect(aoVivo).toContainText('Ao vivo pausado');
  await expect(aoVivo).toContainText(/Atualizado às \d{2}:\d{2}/);
  await expect(aoVivo.locator('[role="status"]')).toHaveText('Ao vivo pausado.');
  await context.setOffline(false);
  await aoVivo.getByRole('button', { name: 'Retomar' }).click();
  await expect(page.locator('.ponto-vivo:not(.ponto-vivo-vazado)')).toBeVisible();
  await expect(aoVivo).not.toContainText('pausado');
});

test('a página seguinte da lista falha sem apagar a que já carregou', async ({ page }) => {
  await entrarNoDemo(page);
  // Página de 5 itens (a API aceita `limit`): o demo tem bem mais que isso.
  await page.route('**/api/v1/links?**', (r) => {
    const u = new URL(r.request().url());
    if (u.searchParams.has('cursor')) return r.abort('internetdisconnected');
    u.searchParams.set('limit', '5');
    return r.continue({ url: u.href });
  });
  await page.goto('/app');
  const linhas = page.locator('tbody .linha');
  await expect(linhas).toHaveCount(5);
  await page.mouse.wheel(0, 50_000);
  const erro = page.locator('.lista-pe .bloco-erro, .bloco-erro', {
    hasText: 'Não deu para carregar mais links.',
  });
  await expect(erro).toContainText('Sem conexão');
  await expect(linhas).toHaveCount(5);
  await expect(erro.getByRole('button', { name: 'Tentar de novo' })).toBeVisible();
});
