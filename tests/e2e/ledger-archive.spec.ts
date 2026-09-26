import { expect, test, type Page } from '@playwright/test';
import { LEDGER_STORAGE_KEY } from '../../src/lib/ledgerStorage';

/**
 * 旧浏览器存档的容量轨迹端到端验收。
 *
 * 预置三种轨迹自相矛盾的异常存档（同 id 批次、超额批次、余量与累计矛盾的记录）
 * 与一份类型合法、轨迹一致的旧版无修订号存档，逐项核对：
 * 加载提示、批次选择、历史余量、状态、提交结果、修订号与原始存储。
 * 异常存档不得作为可写台账，也不得被普通操作覆盖；
 * 合法旧档正常恢复，登记后刷新还原同一台账。
 */

const CORRUPTED_BANNER =
  '本地台账无法读取或已损坏，为避免覆盖可追溯数据，当前不会写入任何登记；请刷新页面核对存储内容。';

/** 在页面脚本运行前播种存档；键已存在时不覆盖（刷新后保留演进后的台账）。 */
async function seedArchive(page: Page, payload: string): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      if (window.localStorage.getItem(key) === null) {
        window.localStorage.setItem(key, value);
      }
    },
    [LEDGER_STORAGE_KEY, payload] as const,
  );
}

/** 读取 localStorage 中的原始台账 JSON（未经解析，用于逐字节核对）。 */
async function readRawArchive(page: Page): Promise<string | null> {
  return page.evaluate((key) => window.localStorage.getItem(key), LEDGER_STORAGE_KEY);
}

async function gotoLedger(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('nav-ledger').click();
}

const ANOMALOUS_ARCHIVES: Array<{ title: string; payload: string }> = [
  {
    title: '两个同 id、不同额定容量的批次',
    payload: JSON.stringify({
      batches: [
        { id: 'dup-batch', name: '显影液（甲）', capacity: 10, createdAt: '2026-09-01T08:00:00.000Z' },
        { id: 'dup-batch', name: '显影液（乙）', capacity: 20, createdAt: '2026-09-01T08:05:00.000Z' },
      ],
      records: [
        {
          id: 'r1',
          batchId: 'dup-batch',
          films: 4,
          note: '归属不明',
          remainingAfter: 6,
          createdAt: '2026-09-02T09:00:00.000Z',
        },
      ],
      revision: 2,
    }),
  },
  {
    title: '累计用量超过额定容量的批次',
    payload: JSON.stringify({
      batches: [{ id: 'b1', name: '超用批次', capacity: 5, createdAt: '2026-09-01T08:00:00.000Z' }],
      records: [
        { id: 'r1', batchId: 'b1', films: 4, note: '', remainingAfter: 1, createdAt: '2026-09-02T09:00:00.000Z' },
        { id: 'r2', batchId: 'b1', films: 3, note: '', remainingAfter: 0, createdAt: '2026-09-03T09:00:00.000Z' },
      ],
    }),
  },
  {
    title: '记录的登记后剩余量与累计用量不符',
    payload: JSON.stringify({
      batches: [{ id: 'b1', name: '矛盾批次', capacity: 10, createdAt: '2026-09-01T08:00:00.000Z' }],
      records: [
        { id: 'r1', batchId: 'b1', films: 3, note: '', remainingAfter: 7, createdAt: '2026-09-02T09:00:00.000Z' },
        { id: 'r2', batchId: 'b1', films: 2, note: '', remainingAfter: 4, createdAt: '2026-09-03T09:00:00.000Z' },
      ],
      revision: 1,
    }),
  },
];

for (const { title, payload } of ANOMALOUS_ARCHIVES) {
  test(`异常存档不作为可写台账、不被普通操作覆盖：${title}`, async ({ page }) => {
    await seedArchive(page, payload);
    await gotoLedger(page);

    // 加载提示：就地说明存档不可信；不列出任何批次卡，也没有登记入口
    await expect(page.getByTestId('ledger-error')).toHaveText(CORRUPTED_BANNER);
    await expect(page.getByTestId('batch-item')).toHaveCount(0);
    await expect(page.getByTestId('batch-empty')).toBeVisible();
    await expect(page.getByTestId('usage-panel')).toHaveCount(0);

    // 提交结果：尝试创建批次被整体拒绝，不产生任何批次，提示保持
    await page.getByTestId('batch-name-input').fill('交接班新批次');
    await page.getByTestId('batch-capacity-input').fill('8');
    await page.getByTestId('create-batch-button').click();
    await expect(page.getByTestId('batch-item')).toHaveCount(0);
    await expect(page.getByTestId('ledger-error')).toHaveText(CORRUPTED_BANNER);

    // 配液页的「存入容量台账」同样被拒绝：就地提示、不切换页面
    await page.getByTestId('nav-mix').click();
    await expect(page.getByTestId('store-to-ledger')).toBeVisible();
    await page.getByTestId('store-name-input').fill('配液建档批次');
    await page.getByTestId('store-capacity-input').fill('8');
    await page.getByTestId('store-to-ledger-button').click();
    await expect(page.getByTestId('store-ledger-error')).toBeVisible();
    await expect(page.getByTestId('result-card')).toBeVisible();

    // 修订号与原始存储：存档原文一个字节都没变
    expect(await readRawArchive(page)).toBe(payload);

    // 刷新后：仍是同一损坏提示，异常存档保留待人工核对
    await page.reload();
    await page.getByTestId('nav-ledger').click();
    await expect(page.getByTestId('ledger-error')).toHaveText(CORRUPTED_BANNER);
    await expect(page.getByTestId('batch-item')).toHaveCount(0);
    expect(await readRawArchive(page)).toBe(payload);
  });
}

test('合法旧版存档（无修订号）正常恢复，登记后刷新还原同一台账', async ({ page }) => {
  // 类型合法、容量轨迹一致的旧版存档：两批三条记录（显影液恰好耗尽）
  const payload = JSON.stringify({
    batches: [
      { id: 'legacy-dev', name: '旧版显影液', capacity: 10, createdAt: '2026-09-01T08:00:00.000Z' },
      { id: 'legacy-fix', name: '旧版定影液', capacity: 5, createdAt: '2026-09-01T08:05:00.000Z' },
    ],
    records: [
      { id: 'r1', batchId: 'legacy-dev', films: 4, note: '4 卷 135', remainingAfter: 6, createdAt: '2026-09-02T09:00:00.000Z' },
      { id: 'r2', batchId: 'legacy-dev', films: 6, note: '', remainingAfter: 0, createdAt: '2026-09-03T09:00:00.000Z' },
      { id: 'r3', batchId: 'legacy-fix', films: 2, note: '2 卷 120', remainingAfter: 3, createdAt: '2026-09-02T10:00:00.000Z' },
    ],
  });
  await seedArchive(page, payload);
  await gotoLedger(page);

  // 加载提示：合法旧档没有损坏提示
  await expect(page.getByTestId('ledger-error')).toHaveCount(0);

  // 批次选择与状态：两张卡，累计 / 剩余 / 状态由同一容量轨迹推导
  const items = page.getByTestId('batch-item');
  await expect(items).toHaveCount(2);
  await expect(items.nth(0).getByTestId('batch-name')).toHaveText('旧版显影液');
  await expect(items.nth(0).getByTestId('batch-used')).toHaveText('10');
  await expect(items.nth(0).getByTestId('batch-remaining')).toHaveText('0');
  await expect(items.nth(0).getByTestId('batch-status')).toHaveText('已耗尽');
  await expect(items.nth(1).getByTestId('batch-name')).toHaveText('旧版定影液');
  await expect(items.nth(1).getByTestId('batch-used')).toHaveText('2');
  await expect(items.nth(1).getByTestId('batch-remaining')).toHaveText('3');
  await expect(items.nth(1).getByTestId('batch-status')).toHaveText('使用中');

  // 历史余量：显影液两条记录的登记后剩余量与批次汇总一致
  await items.nth(0).click();
  await expect(page.getByTestId('detail-used')).toHaveText('10');
  await expect(page.getByTestId('detail-remaining')).toHaveText('0');
  await expect(page.getByTestId('detail-status')).toHaveText('已耗尽');
  await expect(page.getByTestId('exhausted-note')).toBeVisible();
  await expect(page.getByTestId('usage-item')).toHaveCount(2);
  await expect(page.getByTestId('usage-films').nth(0)).toHaveText('4');
  await expect(page.getByTestId('usage-remaining').nth(0)).toHaveText('6');
  await expect(page.getByTestId('usage-films').nth(1)).toHaveText('6');
  await expect(page.getByTestId('usage-remaining').nth(1)).toHaveText('0');

  // 提交结果：在定影液批次登记 1，成功落账
  await items.nth(1).click();
  await expect(page.getByTestId('detail-remaining')).toHaveText('3');
  await page.getByTestId('films-input').fill('1');
  await page.getByTestId('note-input').fill('交接班登记');
  await page.getByTestId('record-usage-button').click();
  await expect(page.getByTestId('detail-remaining')).toHaveText('2');
  await expect(page.getByTestId('usage-item')).toHaveCount(2);
  await expect(page.getByTestId('usage-remaining').nth(0)).toHaveText('3');
  await expect(page.getByTestId('usage-remaining').nth(1)).toHaveText('2');

  // 修订号与原始存储：旧档升级为 revision 1，旧记录原样保留在前
  const raw = JSON.parse((await readRawArchive(page))!) as {
    revision: number;
    records: Array<{ films: number; remainingAfter: number; note: string }>;
  };
  expect(raw.revision).toBe(1);
  expect(raw.records.map((record) => record.films)).toEqual([4, 6, 2, 1]);
  expect(raw.records.map((record) => record.remainingAfter)).toEqual([6, 0, 3, 2]);
  expect(raw.records[3].note).toBe('交接班登记');

  // 刷新：还原同一台账——批次状态、历史记录与余量逐项一致
  await page.reload();
  await page.getByTestId('nav-ledger').click();
  await expect(page.getByTestId('ledger-error')).toHaveCount(0);
  const restored = page.getByTestId('batch-item');
  await expect(restored).toHaveCount(2);
  await expect(restored.nth(0).getByTestId('batch-status')).toHaveText('已耗尽');
  await expect(restored.nth(1).getByTestId('batch-used')).toHaveText('3');
  await expect(restored.nth(1).getByTestId('batch-remaining')).toHaveText('2');
  await restored.nth(1).click();
  await expect(page.getByTestId('usage-item')).toHaveCount(2);
  await expect(page.getByTestId('usage-films').nth(0)).toHaveText('2');
  await expect(page.getByTestId('usage-films').nth(1)).toHaveText('1');
  await expect(page.getByTestId('usage-note').nth(1)).toContainText('交接班登记');
  await expect(page.getByTestId('usage-remaining').nth(0)).toHaveText('3');
  await expect(page.getByTestId('usage-remaining').nth(1)).toHaveText('2');
});
