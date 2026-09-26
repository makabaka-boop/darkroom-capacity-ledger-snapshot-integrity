import { expect, test, type Page } from '@playwright/test';
import { LEDGER_STORAGE_KEY } from '../../src/lib/ledgerStorage';

/**
 * 跨标签并发登记的端到端验收。
 *
 * 两个浏览器标签页（同一 context，localStorage 共享）读取同一份旧状态后交错提交，
 * 覆盖：同批次并发、不同批次互不回滚、外部新建批次、写入失败、外部写入自动同步、
 * 旧版台账兼容。每个用例逐次刷新并核对：记录集合、累计量、状态、错误提示与原始存储内容。
 */

const BATCH_A_ID = 'seed-batch-a';
const BATCH_B_ID = 'seed-batch-b';

interface SeedBatch {
  id: string;
  name: string;
  capacity: number;
  records?: Array<{ films: number; note?: string; remainingAfter: number }>;
  mixSource?: Record<string, number>;
}

/** 直接在 localStorage 写入一份带修订号的台账（两页打开前完成，模拟共同旧状态）。 */
async function seedLedger(page: Page, batches: SeedBatch[], revision = 1): Promise<void> {
  const records = batches.flatMap((batch, batchIndex) =>
    (batch.records ?? []).map((record, recordIndex) => ({
      id: `seed-record-${batchIndex}-${recordIndex}`,
      batchId: batch.id,
      films: record.films,
      note: record.note ?? '',
      remainingAfter: record.remainingAfter,
      createdAt: new Date(Date.UTC(2026, 9, 1, 9, recordIndex)).toISOString(),
    })),
  );
  const payload = {
    batches: batches.map((batch) => ({
      id: batch.id,
      name: batch.name,
      capacity: batch.capacity,
      createdAt: new Date(Date.UTC(2026, 9, 1, 8)).toISOString(),
      ...(batch.mixSource ? { mixSource: batch.mixSource } : {}),
    })),
    records,
    revision,
  };
  await page.addInitScript(
    ([key, value]) => {
      // 只在键不存在时播种：addInitScript 会在每次导航（含 reload）重放，
      // 无条件写入会用旧种子覆盖刷新前已经演进的台账。
      if (window.localStorage.getItem(key) === null) {
        window.localStorage.setItem(key, value);
      }
    },
    [LEDGER_STORAGE_KEY, JSON.stringify(payload)] as const,
  );
}

async function gotoLedger(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('nav-ledger').click();
}

/** 读取 localStorage 中的原始台账 JSON。 */
async function readRawLedger(page: Page) {
  return page.evaluate((key) => {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as { revision: number; records: unknown[]; batches: unknown[] }) : null;
  }, LEDGER_STORAGE_KEY);
}

/** 让目标页面随后所有台账写入都抛错（模拟配额 / 安全策略拒绝），可恢复。 */
async function makeLedgerWritesFail(page: Page): Promise<void> {
  await page.evaluate((key) => {
    const proto = Object.getPrototypeOf(window.localStorage);
    if (!(proto as { __failLedger?: boolean }).__failLedger) {
      const original = proto.setItem;
      proto.setItem = function patchedSetItem(this: Storage, k: string, value: string) {
        if (k === key) throw new Error('QuotaExceededError: simulated quota');
        return original.call(this, k, value);
      };
      (proto as { __failLedger?: boolean }).__failLedger = true;
    }
  }, LEDGER_STORAGE_KEY);
}

/**
 * 暂时屏蔽目标页面收到的台账 storage 事件通知。
 *
 * 跨标签验收需要确定性复现「两个页面读取同一旧状态后交错提交」：
 * 现实中两页几乎同时点提交时，落后页面可能在收到 storage 事件之前就已完成提交，
 * 此时必须由修订号比较兜底拒绝。屏蔽期间该页保持旧视图，
 * 调用方在交错提交结束后用 unblockStorageSync 恢复实时同步。
 * （该监听器在页面脚本之前于捕获阶段注册，stopImmediatePropagation 可阻止应用收到事件。）
 */
async function blockStorageSync(page: Page): Promise<void> {
  await page.addInitScript((key) => {
    const w = window as Window & { __blockLedgerEvents?: boolean };
    w.__blockLedgerEvents = true;
    window.addEventListener(
      'storage',
      (event) => {
        if (w.__blockLedgerEvents && event.key === key) {
          event.stopImmediatePropagation();
        }
      },
      true,
    );
  }, LEDGER_STORAGE_KEY);
}

async function unblockStorageSync(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as Window & { __blockLedgerEvents?: boolean }).__blockLedgerEvents = false;
  });
}

test.describe('两个标签页交错提交同一台账', () => {
  test('同批次：两页从同一剩余量出发，只有先提交者成功；后者冲突提示且不丢记录，刷新后按新余量登记', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const pageA = await context.newPage();
    await seedLedger(pageA, [{ id: BATCH_A_ID, name: '同批显影液', capacity: 10 }]);

    // B 页在读取旧状态期间屏蔽外部通知，确定性复现「同一旧状态交错提交」
    const pageB = await context.newPage();
    await blockStorageSync(pageB);

    // 两个页面读取同一旧状态
    await gotoLedger(pageA);
    await gotoLedger(pageB);

    await expect(pageA.getByTestId('batch-remaining')).toHaveText('10');
    await expect(pageB.getByTestId('batch-remaining')).toHaveText('10');

    // 两页都选中该批次
    await pageA.getByTestId('batch-item').click();
    await pageB.getByTestId('batch-item').click();

    // A 先登记 6 → 成功，剩余 4
    await pageA.getByTestId('films-input').fill('6');
    await pageA.getByTestId('note-input').fill('A 页登记');
    await pageA.getByTestId('record-usage-button').click();
    await expect(pageA.getByTestId('usage-item')).toHaveCount(1);
    await expect(pageA.getByTestId('detail-remaining')).toHaveText('4');

    // B 仍按过期余量 10 提交 6 → 冲突被拒：顶部错误提示，B 页立即对齐最新台账
    await pageB.getByTestId('films-input').fill('6');
    await pageB.getByTestId('note-input').fill('B 页登记');
    await pageB.getByTestId('record-usage-button').click();
    await expect(pageB.getByTestId('ledger-error')).toContainText(/其他页面|未写入/);
    // B 没有产生幽灵记录：输入值保留便于核对，台账显示 A 的记录与新余量
    await expect(pageB.getByTestId('usage-item')).toHaveCount(1);
    await expect(pageB.getByTestId('usage-note')).toContainText('A 页登记');
    await expect(pageB.getByTestId('detail-remaining')).toHaveText('4');
    await expect(pageB.getByTestId('films-input')).toHaveValue('6');

    // 原始存储核对：只有 A 一条成功记录，修订号仅 +1，容量不为负
    const rawAfterConflict = await readRawLedger(pageA);
    expect(rawAfterConflict?.revision).toBe(2);
    expect(rawAfterConflict?.records).toHaveLength(1);

    // B 按新余量改填 4 → 成功，两条记录都可追溯，恰好耗尽
    await pageB.getByTestId('films-input').fill('4');
    await pageB.getByTestId('record-usage-button').click();
    await expect(pageB.getByTestId('ledger-error')).toHaveCount(0);
    await expect(pageB.getByTestId('usage-item')).toHaveCount(2);
    await expect(pageB.getByTestId('detail-status')).toHaveText('已耗尽');
    await expect(pageB.getByTestId('detail-remaining')).toHaveText('0');
    // 交错窗口结束：恢复 B 的实时同步
    await unblockStorageSync(pageB);

    // A 页通过 storage 事件自动同步：无需刷新即看到 B 的记录与耗尽状态
    await expect(pageA.getByTestId('usage-item')).toHaveCount(2);
    await expect(pageA.getByTestId('detail-status')).toHaveText('已耗尽');
    await expect(pageA.getByTestId('films-input')).toHaveValue('');

    // 逐次刷新两页：记录集合、顺序、累计、状态完全一致
    for (const page of [pageA, pageB]) {
      await page.reload();
      await page.getByTestId('nav-ledger').click();
      await expect(page.getByTestId('batch-status')).toHaveText('已耗尽');
      await expect(page.getByTestId('batch-used')).toHaveText('10');
      await expect(page.getByTestId('batch-remaining')).toHaveText('0');
      await page.getByTestId('batch-item').click();
      await expect(page.getByTestId('usage-films').first()).toHaveText('6');
      await expect(page.getByTestId('usage-films').nth(1)).toHaveText('4');
      await expect(page.getByTestId('usage-remaining').nth(1)).toHaveText('0');
    }
    const finalRaw = await readRawLedger(pageA);
    expect(finalRaw?.records).toHaveLength(2);
    expect(finalRaw?.revision).toBe(3);
    await context.close();
  });

  test('同批次：冲突后若坚持按旧余量超量提交，按最新台账拒绝且不落账，容量永不为负', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const pageA = await context.newPage();
    await seedLedger(pageA, [{ id: BATCH_A_ID, name: '超量批次', capacity: 10 }]);
    const pageB = await context.newPage();
    await blockStorageSync(pageB);
    await gotoLedger(pageA);
    await gotoLedger(pageB);
    await pageA.getByTestId('batch-item').click();
    await pageB.getByTestId('batch-item').click();

    await pageA.getByTestId('films-input').fill('8');
    await pageA.getByTestId('record-usage-button').click();
    await expect(pageA.getByTestId('detail-remaining')).toHaveText('2');

    // B 冲突后刷新页面，再试图登记 8（超过新余量 2）→ 领域拒绝
    await pageB.getByTestId('films-input').fill('8');
    await pageB.getByTestId('record-usage-button').click();
    await expect(pageB.getByTestId('ledger-error')).toBeVisible();
    await pageB.reload();
    await gotoLedger(pageB);
    await pageB.getByTestId('batch-item').click();
    await expect(pageB.getByTestId('detail-remaining')).toHaveText('2');
    await pageB.getByTestId('films-input').fill('8');
    await pageB.getByTestId('record-usage-button').click();
    await expect(pageB.getByTestId('error-films')).toContainText('超过剩余容量：本批仅剩 2，无法登记 8');
    await expect(pageB.getByTestId('usage-item')).toHaveCount(1);

    const raw = await readRawLedger(pageB);
    expect(raw?.records).toHaveLength(1);
    await context.close();
  });

  test('不同批次：旧页面登记其他批次时不会回滚另一页刚创建的批次和新增记录', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const pageA = await context.newPage();
    await seedLedger(pageA, [{ id: BATCH_A_ID, name: '已有批次 A', capacity: 10 }]);
    await blockStorageSync(pageA);

    // 两页都读到只有批次 A
    await gotoLedger(pageA);
    const pageB = await context.newPage();
    await gotoLedger(pageB);
    await pageA.getByTestId('batch-item').click();

    // B 页新建批次 B 并登记 3
    await pageB.getByTestId('batch-name-input').fill('新批次 B');
    await pageB.getByTestId('batch-capacity-input').fill('5');
    await pageB.getByTestId('create-batch-button').click();
    await expect(pageB.getByTestId('batch-item')).toHaveCount(2);
    await pageB.getByTestId('films-input').fill('3');
    await pageB.getByTestId('record-usage-button').click();
    await expect(pageB.getByTestId('detail-remaining')).toHaveText('2');

    // A 页用旧状态向 A 登记 4 → 冲突被拒，顶部提示；屏蔽期间 A 的列表保持旧视图（仅批次 A）
    await pageA.getByTestId('films-input').fill('4');
    await pageA.getByTestId('record-usage-button').click();
    await expect(pageA.getByTestId('ledger-error')).toContainText('其他页面');

    // 原始存储：两个批次、仅 B 的一条记录
    const raw = await readRawLedger(pageA);
    expect(raw?.batches).toHaveLength(2);
    expect(raw?.records).toHaveLength(1);

    // A 刷新后看到完整台账：批次 B 存在，A 未被登记
    await pageA.reload();
    await gotoLedger(pageA);
    await expect(pageA.getByTestId('batch-item')).toHaveCount(2);
    await pageA.getByTestId('batch-item').first().click();
    await expect(pageA.getByTestId('detail-used')).toHaveText('0');
    await expect(pageA.getByTestId('usage-empty')).toBeVisible();

    // A 刷新后重试登记 4 → 成功；两页刷新后记录集合一致、各自容量非负
    await pageA.reload();
    await gotoLedger(pageA);
    await pageA.getByTestId('batch-item').first().click();
    await pageA.getByTestId('films-input').fill('4');
    await pageA.getByTestId('record-usage-button').click();
    await expect(pageA.getByTestId('detail-remaining')).toHaveText('6');

    for (const page of [pageA, pageB]) {
      await page.reload();
      await gotoLedger(page);
      await expect(page.getByTestId('batch-item')).toHaveCount(2);
      const items = page.getByTestId('batch-item');
      await expect(items.nth(0).getByTestId('batch-used')).toHaveText('4');
      await expect(items.nth(0).getByTestId('batch-remaining')).toHaveText('6');
      await expect(items.nth(1).getByTestId('batch-used')).toHaveText('3');
      await expect(items.nth(1).getByTestId('batch-remaining')).toHaveText('2');
    }
    await context.close();
  });

  test('外部新建批次：旧页面稍后建档被拒，刷新后可见外来批次且记录不丢', async ({ browser }) => {
    const context = await browser.newContext();
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    await blockStorageSync(pageB);
    // 两页打开时为空台账（revision 0）
    await gotoLedger(pageA);
    await gotoLedger(pageB);
    await expect(pageA.getByTestId('batch-empty')).toBeVisible();
    await expect(pageB.getByTestId('batch-empty')).toBeVisible();

    // A 页创建外来批次
    await pageA.getByTestId('batch-name-input').fill('外来批次 X');
    await pageA.getByTestId('batch-capacity-input').fill('8');
    await pageA.getByTestId('create-batch-button').click();
    await expect(pageA.getByTestId('batch-item')).toHaveCount(1);

    // B 页稍后也建档（不知道 X）→ 冲突被拒，不产生重复 / 孤儿批次
    await pageB.getByTestId('batch-name-input').fill('旧页面批次 Y');
    await pageB.getByTestId('batch-capacity-input').fill('3');
    await pageB.getByTestId('create-batch-button').click();
    await expect(pageB.getByTestId('ledger-error')).toContainText('其他页面');
    await expect(pageB.getByTestId('batch-item')).toHaveCount(1);
    await expect(pageB.getByTestId('batch-name')).toHaveText('外来批次 X');
    // 建档失败后表单草稿保留，操作员可放弃或改名重试
    await expect(pageB.getByTestId('batch-name-input')).toHaveValue('旧页面批次 Y');

    // B 刷新后向外来批次登记 8 → 恰好耗尽
    await pageB.reload();
    await gotoLedger(pageB);
    await unblockStorageSync(pageB);
    await expect(pageB.getByTestId('batch-item')).toHaveCount(1);
    await pageB.getByTestId('batch-item').click();
    await pageB.getByTestId('films-input').fill('8');
    await pageB.getByTestId('record-usage-button').click();
    await expect(pageB.getByTestId('detail-status')).toHaveText('已耗尽');

    // A 自动同步到耗尽；两页刷新后一致
    await expect(pageA.getByTestId('batch-status')).toHaveText('已耗尽');
    for (const page of [pageA, pageB]) {
      await page.reload();
      await gotoLedger(page);
      await expect(page.getByTestId('batch-name')).toHaveText('外来批次 X');
      await expect(page.getByTestId('batch-used')).toHaveText('8');
      await expect(page.getByTestId('batch-remaining')).toHaveText('0');
    }
    const raw = await readRawLedger(pageA);
    expect(raw?.batches).toHaveLength(1);
    expect(raw?.records).toHaveLength(1);
    await context.close();
  });

  test('写入失败：setItem 抛错时显示保存失败、不扣减余量、不伪装成功；刷新恢复旧台账后可重试', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await seedLedger(page, [{ id: BATCH_A_ID, name: '配额批次', capacity: 10 }]);
    await gotoLedger(page);
    await page.getByTestId('batch-item').click();
    await expect(page.getByTestId('detail-remaining')).toHaveText('10');

    // 让台账写入开始失败
    await makeLedgerWritesFail(page);
    await page.getByTestId('films-input').fill('4');
    await page.getByTestId('record-usage-button').click();

    // 明确的保存失败提示（不是登记成功），余量不扣减、记录不出现
    await expect(page.getByTestId('ledger-error')).toContainText(/保存失败|存储/);
    await expect(page.getByTestId('detail-remaining')).toHaveText('10');
    await expect(page.getByTestId('detail-used')).toHaveText('0');
    await expect(page.getByTestId('usage-item')).toHaveCount(0);
    // 输入保留以便重试
    await expect(page.getByTestId('films-input')).toHaveValue('4');

    // 原始存储仍是旧台账（修订号未变）
    const rawBefore = await readRawLedger(page);
    expect(rawBefore?.records).toHaveLength(0);
    expect(rawBefore?.revision).toBe(1);

    // 刷新：恢复旧台账，没有幽灵记录
    await page.reload();
    await gotoLedger(page);
    await expect(page.getByTestId('batch-used')).toHaveText('0');
    await expect(page.getByTestId('batch-remaining')).toHaveText('10');
    await page.getByTestId('batch-item').click();
    await expect(page.getByTestId('usage-empty')).toBeVisible();

    // 恢复写入能力（新页面不带补丁）后重试同一用量 → 成功
    const page2 = await context.newPage();
    await gotoLedger(page2);
    await page2.getByTestId('batch-item').click();
    await page2.getByTestId('films-input').fill('4');
    await page2.getByTestId('record-usage-button').click();
    await expect(page2.getByTestId('detail-remaining')).toHaveText('6');
    await expect(page2.getByTestId('usage-item')).toHaveCount(1);
    await context.close();
  });

  test('外部写入后当前页自动刷新批次状态与剩余量，无需手动重载', async ({ browser }) => {
    const context = await browser.newContext();
    const pageA = await context.newPage();
    await seedLedger(pageA, [{ id: BATCH_A_ID, name: '同步批次', capacity: 10 }]);
    await gotoLedger(pageA);
    const pageB = await context.newPage();
    await gotoLedger(pageB);

    await pageA.getByTestId('batch-item').click();
    // A 停留在台账页，B 在外部连续登记
    await pageB.getByTestId('batch-item').click();
    for (const films of ['3', '3']) {
      await pageB.getByTestId('films-input').fill(films);
      await pageB.getByTestId('record-usage-button').click();
    }
    // A 自动同步：列表与详情都反映累计 6、剩余 4、两条记录
    await expect(pageA.getByTestId('batch-used')).toHaveText('6');
    await expect(pageA.getByTestId('batch-remaining')).toHaveText('4');
    await expect(pageA.getByTestId('detail-used')).toHaveText('6');
    await expect(pageA.getByTestId('detail-remaining')).toHaveText('4');
    await expect(pageA.getByTestId('usage-item')).toHaveCount(2);

    // B 再登记 4 恰好耗尽，A 自动转为已耗尽
    await pageB.getByTestId('films-input').fill('4');
    await pageB.getByTestId('record-usage-button').click();
    await expect(pageA.getByTestId('batch-status')).toHaveText('已耗尽');
    await expect(pageA.getByTestId('detail-status')).toHaveText('已耗尽');
    await expect(pageA.getByTestId('exhausted-note')).toBeVisible();

    // A 在耗尽后尝试登记 1：领域拒绝
    await pageA.getByTestId('films-input').fill('1');
    await pageA.getByTestId('record-usage-button').click();
    await expect(pageA.getByTestId('error-films')).toContainText('本批仅剩 0');
    await context.close();
  });

  test('旧版台账（无 revision）照常读取，首次提交升级且既有批次/记录/快照/耗尽状态保持', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const pageA = await context.newPage();
    // 写入不带 revision 的旧格式：一个带快照、已耗尽的批次
    await pageA.addInitScript(
      ([key, value]) => {
        if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, value);
      },
      [
        LEDGER_STORAGE_KEY,
        JSON.stringify({
          batches: [
            {
              id: BATCH_A_ID,
              name: '旧版带快照批次',
              capacity: 10,
              createdAt: '2026-09-01T08:00:00.000Z',
              mixSource: { n: 4, total: 1000, capacity: 250, tanks: 3, concentrate: 200, water: 800 },
            },
            { id: BATCH_B_ID, name: '旧版使用中批次', capacity: 5, createdAt: '2026-09-01T08:00:00.000Z' },
          ],
          records: [
            {
              id: 'old-record-1',
              batchId: BATCH_A_ID,
              films: 10,
              note: '旧版已耗尽',
              remainingAfter: 0,
              createdAt: '2026-09-01T09:00:00.000Z',
            },
          ],
        }),
      ] as const,
    );
    await gotoLedger(pageA);

    // 旧数据完整读入：耗尽状态、来源摘要、记录都在
    const items = pageA.getByTestId('batch-item');
    await expect(items).toHaveCount(2);
    await expect(items.first().getByTestId('batch-status')).toHaveText('已耗尽');
    await expect(items.first().getByTestId('batch-used')).toHaveText('10');
    await pageA.getByTestId('batch-item').first().click();
    await expect(pageA.getByTestId('mix-source-summary')).toContainText('稀释式 1+4');
    await expect(pageA.getByTestId('mix-source-summary')).toContainText('浓缩液 200 mL');
    await expect(pageA.getByTestId('usage-films')).toHaveText('10');
    await expect(pageA.getByTestId('usage-remaining')).toHaveText('0');

    // 另一个标签页也读到同一份旧状态（屏蔽通知以确定性复现交错提交）
    const pageB = await context.newPage();
    await blockStorageSync(pageB);
    await gotoLedger(pageB);
    await expect(pageB.getByTestId('batch-item')).toHaveCount(2);

    // A 在使用中批次首次提交 → 旧格式升级（revision 1）
    await pageA.getByTestId('batch-item').nth(1).click();
    await pageA.getByTestId('films-input').fill('2');
    await pageA.getByTestId('record-usage-button').click();
    await expect(pageA.getByTestId('detail-remaining')).toHaveText('3');

    // B 用旧基准提交被冲突拒绝（升级同样受并发保护），刷新后重试成功
    await pageB.getByTestId('batch-item').nth(1).click();
    await pageB.getByTestId('films-input').fill('2');
    await pageB.getByTestId('record-usage-button').click();
    await expect(pageB.getByTestId('ledger-error')).toBeVisible();
    await pageB.reload();
    await gotoLedger(pageB);
    await pageB.getByTestId('batch-item').nth(1).click();
    await pageB.getByTestId('films-input').fill('2');
    await pageB.getByTestId('record-usage-button').click();
    await expect(pageB.getByTestId('detail-remaining')).toHaveText('1');

    // 最终存储核对：两个旧批次 + 旧记录保留，新格式带 revision=2
    await pageA.waitForTimeout(100);
    const raw = await readRawLedger(pageA);
    expect(raw?.batches).toHaveLength(2);
    expect(raw?.records.map((r) => (r as { films: number }).films)).toEqual([10, 2, 2]);
    expect(raw?.revision).toBe(2);
    await context.close();
  });
});
