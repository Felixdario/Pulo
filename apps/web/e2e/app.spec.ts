import { expect, test } from '@playwright/test';
import { SHORT_BASE_URL } from './ambiente';
import { clicar, entrarNoDemo, sufixo } from './apoio';

test('demo: cria link com alias, edita regra, vê o contador ao vivo subir com 3 cliques', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Ou entre no demo' }).first().click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole('heading', { name: /^Links/ })).toBeVisible();
  await expect(page.locator('tbody .linha').first()).toBeVisible();

  // Criar link: alias validado ao vivo.
  const alias = `e2e-${sufixo()}`;
  await page.getByLabel('Link para encurtar').fill('https://example.com/e2e');
  await page.getByLabel('Alias (opcional)').fill('admin');
  await expect(
    page.getByText('"admin" é um nome reservado pelo sistema. Escolha outro.'),
  ).toBeVisible();
  await page.getByLabel('Alias (opcional)').fill(alias);
  await expect(page.getByText('Formato válido.')).toBeVisible();
  await page.getByRole('button', { name: 'Encurtar' }).click();

  const criado = page.locator('.criado');
  await expect(criado).toContainText(alias);
  await expect(criado.getByRole('img', { name: /QR code/ })).toBeVisible();
  await expect(criado.getByRole('button', { name: 'PNG' })).toBeVisible();
  await criado.getByRole('link', { name: /Ver cliques/ }).click();

  await expect(page).toHaveURL(/\/app\/links\/\d+/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(alias);

  // Editar regra: limite de cliques e repasse da query.
  await page.getByRole('button', { name: 'Editar regras' }).click();
  const dialogo = page.getByRole('dialog', { name: 'Editar regras' });
  await dialogo.getByLabel('Limite de cliques humanos (opcional)').fill('500');
  await dialogo.getByLabel(/^308/).check();
  await expect(dialogo.getByText(/o navegador guarda o destino/)).toBeVisible();
  await dialogo.getByLabel(/^302/).check();
  await expect(dialogo.getByText('Para depois de 500 cliques humanos.')).toBeVisible();
  await dialogo.getByRole('button', { name: 'Salvar' }).click();
  await expect(dialogo).toBeHidden();
  await expect(page.getByLabel('Regras').getByText('Para em 500')).toBeVisible();

  // Ao vivo: 3 cliques reais no redirect → o contador sobe 3.
  const numero = page.getByTestId('ao-vivo-numero');
  await expect(page.locator('.ao-vivo')).toContainText('Ao vivo');
  await expect(numero).toHaveText('0');
  await expect(page.locator('.ponto-vivo:not(.ponto-vivo-vazado)')).toBeVisible();
  for (let i = 0; i < 3; i++) await clicar(request, `${SHORT_BASE_URL}/${alias}`);
  await expect(numero).toHaveText('3', { timeout: 15_000 });
  await expect(page.locator('.ao-vivo-delta')).toHaveText('+3 no último minuto');
});

test('412: a edição de outra aba não é sobrescrita', async ({ page, context }) => {
  await entrarNoDemo(page);
  const alias = `e2e-${sufixo()}`;
  await page.getByLabel('Link para encurtar').fill('https://example.com/conflito');
  await page.getByLabel('Alias (opcional)').fill(alias);
  await page.getByRole('button', { name: 'Encurtar' }).click();
  await page
    .locator('.criado')
    .getByRole('link', { name: /Ver cliques/ })
    .click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(alias);
  const url = page.url();

  await page.getByRole('button', { name: 'Editar regras' }).click();
  const dialogo = page.getByRole('dialog', { name: 'Editar regras' });
  await dialogo.getByLabel('Título').fill('Edição da aba 1');

  // Segunda aba (mesmo cookie): renova a sessão sem derrubar a primeira e salva antes.
  const outra = await context.newPage();
  await outra.goto(url);
  await outra.getByRole('button', { name: 'Editar regras' }).click();
  const d2 = outra.getByRole('dialog', { name: 'Editar regras' });
  await d2.getByLabel('Título').fill('Edição da aba 2');
  await d2.getByRole('button', { name: 'Salvar' }).click();
  await expect(d2).toBeHidden();
  await outra.close();

  await dialogo.getByRole('button', { name: 'Salvar' }).click();
  await expect(dialogo.getByText('Alguém editou este link em outra aba.')).toBeVisible();
  await dialogo.getByRole('button', { name: 'Recarregar' }).click();
  await expect(dialogo.getByLabel('Título')).toHaveValue('Edição da aba 2');
});

test('logout e sessão expirada', async ({ page, context }) => {
  await entrarNoDemo(page);
  const outra = await context.newPage();
  await outra.goto('/app/keys');
  await expect(outra.getByRole('heading', { name: 'Chaves de API' })).toBeVisible();
  // Sair numa aba avisa a outra.
  await outra.getByRole('button', { name: 'Sair' }).first().click();
  await expect(outra).toHaveURL(/\/$/);
  await expect(page.getByRole('alertdialog')).toContainText('Você saiu em outra aba');
  await page.getByRole('button', { name: 'Entrar de novo' }).click();
  await expect(page).toHaveURL(/\/entrar/);
});
