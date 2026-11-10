import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { entrarNoDemo, sufixo } from './apoio';

/** axe com as regras WCAG 2.x A/AA: nenhuma violação, de qualquer impacto (fase 8). */
async function semViolacoes(page: Page, tela: string) {
  const r = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(
    r.violations.map(
      (v) =>
        `${tela}: ${v.id} (${v.impact}) em ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
    ),
  ).toEqual([]);
}

/** O elemento focado e se o foco aparece (anel de contorno ou sombra). */
async function foco(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return { nome: '', visivel: false };
    const s = getComputedStyle(el);
    const label = el.id ? document.querySelector(`label[for="${el.id}"]`)?.textContent : null;
    return {
      nome: (el.getAttribute('aria-label') ?? label ?? el.textContent ?? '').trim(),
      visivel:
        el.matches(':focus-visible') &&
        ((s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2) || s.boxShadow !== 'none'),
    };
  });
}

/** Aperta Tab até o foco chegar no elemento com esse nome (no máximo `max` vezes). */
async function tabAte(page: Page, nome: string | RegExp, max = 40) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const f = await foco(page);
    if (typeof nome === 'string' ? f.nome === nome : nome.test(f.nome)) return f;
  }
  throw new Error(`o Tab não chegou em ${String(nome)}`);
}

for (const tema of ['light', 'dark'] as const) {
  test.describe(`axe, tema ${tema === 'light' ? 'claro' : 'escuro'}`, () => {
    test.use({ colorScheme: tema });

    test('landing (com erro e com a tira do resultado) e login', async ({ page }) => {
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await semViolacoes(page, 'landing');
      await page.getByLabel('Link para encurtar').fill('isso não é link');
      await page.getByRole('button', { name: 'Encurtar' }).click();
      await expect(page.getByRole('alert').first()).toContainText('não parece');
      await semViolacoes(page, 'landing com erro');
      await page.getByLabel('Link para encurtar').fill('example.com/axe');
      await page.getByRole('button', { name: 'Encurtar' }).click();
      await expect(page.locator('.tira-resultado')).toBeVisible();
      await semViolacoes(page, 'landing com resultado');
      await page.goto('/entrar');
      await expect(page.getByRole('heading', { name: 'Entrar' })).toBeVisible();
      await semViolacoes(page, 'login');
    });

    test('lista, página do link (tabela e diálogo) e chaves', async ({ page }) => {
      await entrarNoDemo(page);
      await expect(page.locator('tbody .linha').first()).toBeVisible();
      await semViolacoes(page, 'lista');

      await page.goto('/app?q=demo-promo');
      await page.locator('tbody .linha-curto').filter({ hasText: 'demo-promo' }).first().click();
      await expect(page.locator('.numeros .numero')).not.toHaveText('');
      await expect(page.locator('.mapa-pais').first()).toBeAttached();
      await expect(page.locator('.dim').first()).toBeVisible();
      await semViolacoes(page, 'link');
      await page.getByRole('button', { name: 'Ver tabela' }).click();
      await expect(page.locator('.tabela-serie')).toBeVisible();
      await semViolacoes(page, 'link com a tabela da série');
      await page.getByRole('button', { name: 'Editar regras' }).click();
      await expect(page.getByRole('dialog', { name: 'Editar regras' })).toBeVisible();
      await semViolacoes(page, 'editar regras');
      await page.keyboard.press('Escape');

      await page.getByRole('link', { name: 'Chaves de API' }).click();
      await expect(page.locator('tbody tr').first()).toBeVisible();
      await semViolacoes(page, 'chaves');
    });
  });
}

test.describe('teclado', () => {
  test('criar link só com teclado: ordem lógica, foco visível e resultado', async ({ page }) => {
    await entrarNoDemo(page);
    await page.goto('/app');
    await expect(page.locator('tbody .linha').first()).toBeVisible();

    // O primeiro Tab mostra o "Pular para o conteúdo"; Enter leva ao conteúdo.
    await page.keyboard.press('Tab');
    expect(await foco(page)).toEqual({ nome: 'Pular para o conteúdo', visivel: true });
    await page.keyboard.press('Enter');

    // Depois do salto, a ordem segue o formulário: destino → alias → título → Encurtar.
    expect(await tabAte(page, 'Link para encurtar', 5)).toMatchObject({ visivel: true });
    await page.keyboard.type('example.com/teclado');
    await page.keyboard.press('Tab');
    expect(await foco(page)).toEqual({ nome: 'Alias (opcional)', visivel: true });
    const alias = `tecla-${sufixo()}`;
    await page.keyboard.type(alias);
    await page.keyboard.press('Tab');
    expect(await foco(page)).toEqual({ nome: 'Título (opcional)', visivel: true });
    await page.keyboard.type('Feito no teclado');
    await page.keyboard.press('Tab');
    expect(await foco(page)).toEqual({ nome: 'Encurtar', visivel: true });
    await page.keyboard.press('Enter');

    const criado = page.locator('.criado');
    await expect(criado).toContainText(alias);
    // Do resultado, o Tab chega no "Ver cliques"; Enter abre a página do link.
    expect(await tabAte(page, /^Ver cliques/, 15)).toMatchObject({ visivel: true });
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/app\/links\/\d+/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(alias);
  });

  test('período com setas, tabela e editar regras com Esc e foco de volta', async ({ page }) => {
    await entrarNoDemo(page);
    await page.goto('/app?q=demo-promo');
    await page.locator('tbody .linha-curto').filter({ hasText: 'demo-promo' }).first().click();
    await expect(page.locator('.dim').first()).toBeVisible();

    // Grupo de rádio: um Tab entra no período marcado; as setas trocam e marcam.
    await page.getByRole('button', { name: 'Editar regras' }).focus();
    expect((await tabAte(page, '30 d')).visivel).toBe(true);
    await page.keyboard.press('ArrowRight');
    const noventa = page.getByRole('radio', { name: '90 d' });
    await expect(noventa).toHaveAttribute('aria-checked', 'true');
    await expect(noventa).toBeFocused();
    await expect(page).toHaveURL(/period=90d/);
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByRole('radio', { name: '30 d' })).toBeFocused();

    // "Ver tabela" pelo teclado: a série vira tabela (o mapa tem a lista de países ao lado).
    await tabAte(page, 'Ver tabela');
    await page.keyboard.press('Enter');
    await expect(page.locator('.tabela-serie')).toBeVisible();

    // Diálogo: abre com Enter, o foco entra nele, Esc fecha e o foco volta para o botão.
    const editar = page.getByRole('button', { name: 'Editar regras' });
    await editar.focus();
    await page.keyboard.press('Enter');
    const dialogo = page.getByRole('dialog', { name: 'Editar regras' });
    await expect(dialogo).toBeVisible();
    await expect(dialogo.locator(':focus')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(dialogo).toBeHidden();
    await expect(editar).toBeFocused();
  });

  test('chaves: criar com teclado, e o erro de campo é anunciado', async ({ page }) => {
    await entrarNoDemo(page, '/app/keys');
    await page.getByLabel('Nome').focus();
    await tabAte(page, 'Criar chave', 10);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('alert').first()).toBeVisible();
    await page.getByLabel('Nome').focus();
    await page.keyboard.type(`teclado ${sufixo()}`);
    await page.keyboard.press('Tab');
    expect((await foco(page)).visivel).toBe(true);
    await tabAte(page, 'Criar chave', 10);
    await page.keyboard.press('Enter');
    await expect(page.getByText('Guarde agora: depois ela não aparece mais.')).toBeVisible();
  });
});

test.describe('zoom de 200 % (viewport de 640 px)', () => {
  test.use({ viewport: { width: 640, height: 400 } });

  test('nenhuma tela rola na horizontal', async ({ page }) => {
    const semRolagem = async (tela: string) => {
      const r = await page.evaluate(() => ({
        sw: document.documentElement.scrollWidth,
        cw: document.documentElement.clientWidth,
      }));
      expect(r.sw, tela).toBeLessThanOrEqual(r.cw);
    };
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await semRolagem('landing');
    await entrarNoDemo(page);
    await expect(page.locator('tbody .linha').first()).toBeVisible();
    await semRolagem('lista');
    await page.goto('/app?q=demo-promo');
    await page.locator('tbody .linha-curto').filter({ hasText: 'demo-promo' }).first().click();
    await expect(page.locator('.dim').first()).toBeVisible();
    await semRolagem('link');
    await page.goto('/app/keys');
    await expect(page.locator('tbody tr').first()).toBeVisible();
    await semRolagem('chaves');
  });
});

test.describe('movimento reduzido', () => {
  test.use({ reducedMotion: 'reduce' });

  test('a tira nasce reta e sem animação; o ao vivo tem as regiões de anúncio', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByLabel('Link para encurtar').fill('example.com/sem-movimento');
    await page.getByRole('button', { name: 'Encurtar' }).click();
    const tira = page.locator('.tira-resultado');
    await expect(tira).toBeVisible();
    const estilo = await tira.evaluate((el) => {
      const s = getComputedStyle(el);
      return { animacao: s.animationName, transform: s.transform };
    });
    expect(estilo).toEqual({ animacao: 'none', transform: 'none' });

    await entrarNoDemo(page);
    await page.goto('/app?q=demo-promo');
    await page.locator('tbody .linha-curto').filter({ hasText: 'demo-promo' }).first().click();
    await expect(page.locator('.ao-vivo [aria-live="polite"]')).toHaveCount(1);
    await expect(page.locator('.ao-vivo [role="status"]')).toHaveCount(1);
  });
});

test('Documentação da API: o Swagger UI carrega os assets pelo proxy', async ({ page }) => {
  const falhas: string[] = [];
  page.on('response', (r) => {
    if (r.url().includes('/api/docs') && r.status() >= 400) falhas.push(`${r.status()} ${r.url()}`);
  });
  await page.goto('/');
  await page.getByRole('link', { name: 'Documentação da API' }).click();
  await expect(page.locator('.swagger-ui .info .title')).toBeVisible({ timeout: 15_000 });
  expect(falhas).toEqual([]);
});
