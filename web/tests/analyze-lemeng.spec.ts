import { test } from '@playwright/test';

test('分析乐檬cloud token存储位置', async ({ page, context }) => {
  // 访问登录页
  await page.goto('https://account.lemengcloud.com/', { waitUntil: 'domcontentloaded' });

  // 等待页面基本加载
  await page.waitForTimeout(3000);

  // 截图
  await page.screenshot({ path: 'lemeng-login.png', fullPage: true });

  // 分析页面结构
  const pageInfo = {
    title: await page.title(),
    url: page.url(),
    // 检查是否有可见的登录表单
    hasLoginForm: await page.locator('input[type="password"]').count() > 0,
    // 检查localStorage中的token
    localStorage: await page.evaluate(() => {
      const items: Record<string, string> = {};
      // 显示所有键名（不只是 token 相关）
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key) {
          const value = localStorage.getItem(key);
          // 显示所有键，值截断到前 100 字符
          items[key] = value ? value.substring(0, 100) + '...' : 'null';
        }
      }
      return items;
    }),
    // 检查sessionStorage
    sessionStorage: await page.evaluate(() => {
      const items: Record<string, string> = {};
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        if (key) {
          const value = sessionStorage.getItem(key);
          items[key] = value ? value.substring(0, 100) + '...' : 'null';
        }
      }
      return items;
    }),
    // 检查cookie（通过JS可访问的）
    cookies: await context.cookies(),
  };

  console.log('\n=== 页面信息 ===');
  console.log('标题:', pageInfo.title);
  console.log('URL:', pageInfo.url);
  console.log('有登录表单:', pageInfo.hasLoginForm);

  console.log('\n=== localStorage (token相关) ===');
  console.log(JSON.stringify(pageInfo.localStorage, null, 2));

  console.log('\n=== sessionStorage (token相关) ===');
  console.log(JSON.stringify(pageInfo.sessionStorage, null, 2));

  console.log('\n=== Cookies ===');
  pageInfo.cookies.forEach(c => {
    console.log(`${c.name}: ${c.value.substring(0, 30)}... (domain: ${c.domain})`);
  });

  // 监听网络请求，看是否有API调用携带token
  console.log('\n=== 监听API请求（10秒）===');
  const apiRequests: string[] = [];

  page.on('request', request => {
    const url = request.url();
    const headers = request.headers();
    if (url.includes('api') || headers['authorization'] || headers['token']) {
      apiRequests.push(`URL: ${url}\nAuth: ${headers['authorization'] || 'N/A'}\nToken: ${headers['token'] || 'N/A'}`);
    }
  });

  // 等待10秒观察网络请求
  await page.waitForTimeout(10000);

  if (apiRequests.length > 0) {
    console.log('发现API请求:');
    apiRequests.forEach(r => console.log(r + '\n'));
  } else {
    console.log('未发现携带token的API请求');
  }
});
