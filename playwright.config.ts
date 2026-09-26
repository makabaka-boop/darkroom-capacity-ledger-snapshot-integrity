import { defineConfig } from '@playwright/test';

/**
 * 默认在本机起 `vite preview` 作为被测服务器；
 * 设置 E2E_BASE_URL（如 Docker Compose 验收链路的 http://web）时，
 * 改为直接访问该地址，不再自起服务器。
 */
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:4173';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  retries: 0,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL,
    // 受限容器（无 root / 无用户命名空间）下通过 PW_DISABLE_SANDBOX=1 运行
    launchOptions: process.env.PW_DISABLE_SANDBOX
      ? { args: ['--no-sandbox', '--disable-setuid-sandbox'] }
      : undefined,
  },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'npm run build && npm run preview -- --strictPort',
        url: 'http://localhost:4173',
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
