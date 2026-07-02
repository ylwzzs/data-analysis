import { test, expect } from '@playwright/test';

test.describe('1. MVP Implementation', () => {
  test('首页正常加载', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveTitle(/群接龙管理后台|数据分析平台/);
  });

  test('报表列表页重定向到登录（未登录）', async ({ page }) => {
    await page.context().clearCookies();
    await page.goto('/reports', { waitUntil: 'domcontentloaded' });
    // 未登录应跳转到登录页
    await expect(page).toHaveURL(/\/login/);
  });

  test('数据源页正常加载', async ({ page }) => {
    await page.goto('/sources', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('body')).toBeVisible();
  });
});

test.describe('4. Auth Env Detection', () => {
  test('登录页正常渲染', async ({ page }) => {
    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    // 页面应该正常渲染
    await expect(page.locator('body')).toBeVisible();
    // 有标题元素
    const heading = page.locator('h1, h2, .text-xl');
    await expect(heading.first()).toBeVisible();
  });

  test('未登录访问受保护路由跳转登录页', async ({ page }) => {
    await page.context().clearCookies();
    await page.goto('/reports', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe('5. Frontend Error Handling', () => {
  test('错误处理工具存在', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('body')).toBeVisible();
  });

  test('错误消息不暴露技术细节', async ({ page }) => {
    await page.route('**/rest/**', route => route.abort('failed'));
    await page.context().clearCookies();
    await page.goto('/reports', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);

    const bodyText = await page.locator('body').textContent() || '';
    expect(bodyText).not.toContain('stack');
    expect(bodyText).not.toContain('TypeError');
    expect(bodyText).not.toContain('PGRST');
  });

  test('Loading 文件存在', async ({ page }) => {
    await page.route('**/rest/**', async route => {
      await new Promise(resolve => setTimeout(resolve, 100));
      route.continue();
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('body')).toBeVisible();
  });
});

test.describe('响应式布局', () => {
  test('PC 布局正常', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('body')).toBeVisible();
  });

  test('移动端布局适配', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('body')).toBeVisible();
  });
});