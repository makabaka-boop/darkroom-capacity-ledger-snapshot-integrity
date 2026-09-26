import { expect, test, type Page } from '@playwright/test';
import { LEDGER_STORAGE_KEY } from '../../src/lib/ledgerStorage';

/**
 * 旧浏览器存档的容量轨迹完整性验收。
 *
 * 预置三份异常存档与一份合法旧档，逐项核对：
 * 加载提示、批次选择、历史余量、状态、提交结果、修订号与原始存储。
 * - 异常存档（同 id 不同容量的两个批次 / 累计用量超额定容量 /
 *   登记后剩余量与累计用量不符）不得作为可写台账加载，
 *   就地提示损坏，且任何普通操作都不得覆盖原始存储；
 * - 类型合法、容量轨迹一致的旧版无修订号存档正常恢复，
 *   登记后刷新得到相同记录。
 */

const CORRUPT_BANNER = '本地台账无法读取或已损坏';

/** 异常存档一：两个同 id、不同额定容量的批次，同一组记录归属无法确认。 */
const DUPLICATE_ID_ARCHIVE = JSON.stringify({
  batches: [
    { id: 'dup-batch', name: 'D-76 显影液（卡 A）', capacity: 10, createdAt: '2026-09-01T08:00:00.000Z' },
    { id: 'dup-batch', name: 'D-76 显影液（卡 B）', capacity: 20, createdAt: '2026-09-01T08:05:00.000Z' },
  ],
  records: [
    {
      id: 'dup-r1',
      batchId: 'dup-batch',
      films: 4,
      note: '归属不明',
      remainingAfter: 6,
      createdAt: '2026-09-01T09:00:00.000Z',
    },
  ],
  revision: 3,
});

/** 异常存档二：记录用量总和 8 + 6 = 14，超过额定容量 10（余量已为负）。 */
const OVER_USED_ARCHIVE = JSON.stringify({
  batches: [{ id: 'over-batch', name: '定影液', capacity: 10, createdAt: '2026-09-01T08:00:00.000Z' }],
  records: [
    {
      id: 'over-r1',
      batchId: 'over-batch',
      films: 8,
      note: '',
      remainingAfter: 2,
      createdAt: '2026-09-01T09:00:00.000Z',
    },
    {
      id: 'over-r2',
      batchId: 'over-batch',
      films: 6,
      note: '超用',
      remainingAfter: 0,
      createdAt: '2026-09-01T10:00:00.000Z',
    },
  ],
});

/** 异常存档三：第二条记录的登记后剩余量 5 与累计用量（4 + 3 → 应剩 3）不符。 */
const DRIFTED_REMAINING_ARCHIVE = JSON.stringify({
  batches: [{ id: 'drift-batch', name: '停显液', capacity: 10, createdAt: '2026-09-01T08:00:00.000Z' }],
  records: [
    {
      id: 'drift-r1',
      batchId: 'drift-batch',
      films: 4,
      note: '',
      remainingAfter: 6,
      createdAt: '2026-09-01T09:00:00.000Z',
    },
    {
      id: 'drift-r2',
      batchId: 'drift-batch',
      films: 3,
      note: '余量对不上',
      remainingAfter: 5,
      createdAt: '2026-09-01T10:00:00.000Z',
    },
  ],
});

/** 合法旧档：无 revision、容量轨迹一致，一个带快照的已耗尽批次 + 一个使用中批次。 */
const LEGACY_VALID_ARCHIVE = JSON.stringify({
  batches: [
    {
      id: 'legacy-dev',
      name: '旧版显影液',
      capacity: 10,
      createdAt: '2026-09-01T08:00:00.000Z',
      mixSource: { n: 4, total: 1000, capacity: 250, tanks: 1, concentrate: 200, water: 800 },
    },
    { id: 'legacy-fix', name: '旧版定影液', capacity: 5, createdAt: '2026-09-01T08:00:00.000Z' },
  ],
  records: [
    {
      id: 'legacy-r1',
      batchId: 'legacy-dev',
      films: 10,
      note: '旧版已耗尽',
      remainingAfter: 0,
      createdAt: '2026-09-01T09:00:00.000Z',
    },
    {
      id: 'legacy-r2',
      batchId: 'legacy-fix',
      films: 2,
      note: '2 卷 120',
      remainingAfter: 3,
      createdAt: '2026-09-01T09:30:00.000Z',
    },
  ],
});

/** 导航前播种存档；只在键不存在时写入，避免刷新后覆盖已演进的台账。 */
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

async function gotoLedger(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('nav-ledger').click();
}

/** 读取 localStorage 中的原始台账字符串（未经解析，逐字节核对用）。 */
async function readRawArchive(page: Page): Promise<string | null> {
  return page.evaluate((key) => window.localStorage.getItem(key), LEDGER_STORAGE_KEY);
}

/** 异常存档的共性核对：不加载、不可写、不覆盖。 */
async function expectArchiveRejected(page: Page, payload: string): Promise<void> {
  await gotoLedger(page);

  // 加载提示：就地说明存档损坏，且不会写入任何登记
  await expect(page.getByTestId('ledger-error')).toContainText(CORRUPT_BANNER);

  // 批次选择：异常存档不作为台账加载——没有批次卡、没有明细面板
  await expect(page.getByTestId('batch-item')).toHaveCount(0);
  await expect(page.getByTestId('batch-empty')).toBeVisible();
  await expect(page.getByTestId('usage-panel')).toHaveCount(0);

  // 历史余量与状态：没有任何记录余量或「使用中 / 已耗尽」状态从异常档渲染出来
  await expect(page.getByTestId('batch-status')).toHaveCount(0);
  await expect(page.getByTestId('usage-item')).toHaveCount(0);
  await expect(page.getByTestId('usage-remaining')).toHaveCount(0);

  // 提交结果：尝试新建批次（普通操作）被拒绝，异常档不作为可写台账
  await page.getByTestId('batch-name-input').fill('交接班新批次');
  await page.getByTestId('batch-capacity-input').fill('5');
  await page.getByTestId('create-batch-button').click();
  await expect(page.getByTestId('ledger-error')).toContainText(CORRUPT_BANNER);
  await expect(page.getByTestId('batch-item')).toHaveCount(0);
  await expect(page.getByTestId('batch-empty')).toBeVisible();

  // 原始存储：一个字节都没变（修订号、批次、记录全部原样保留）
  expect(await readRawArchive(page)).toBe(payload);

  // 刷新后：仍是同一拒绝姿态，原文仍在
  await page.reload();
  await page.getByTestId('nav-ledger').click();
  await expect(page.getByTestId('ledger-error')).toContainText(CORRUPT_BANNER);
  await expect(page.getByTestId('batch-item')).toHaveCount(0);
  expect(await readRawArchive(page)).toBe(payload);
}

test('异常存档：同 id 不同容量的两个批次 → 整体不可信，不加载、不可写、不覆盖', async ({
  page,
}) => {
  await seedArchive(page, DUPLICATE_ID_ARCHIVE);
  await expectArchiveRejected(page, DUPLICATE_ID_ARCHIVE);
  // 修订号核对：预置的 revision 3 未被推进
  const raw = JSON.parse((await readRawArchive(page))!) as { revision: number };
  expect(raw.revision).toBe(3);
});

test('异常存档：累计用量超过额定容量 → 不显示负余量 / 假「使用中」，登记入口不可用', async ({
  page,
}) => {
  await seedArchive(page, OVER_USED_ARCHIVE);
  await expectArchiveRejected(page, OVER_USED_ARCHIVE);
  // 预置存档无 revision：拒绝期间没有写出任何修订号
  const raw = JSON.parse((await readRawArchive(page))!) as Record<string, unknown>;
  expect('revision' in raw).toBe(false);
});

test('异常存档：登记后剩余量与累计用量不符 → 历史与汇总矛盾的台账不可信', async ({ page }) => {
  await seedArchive(page, DRIFTED_REMAINING_ARCHIVE);
  await expectArchiveRejected(page, DRIFTED_REMAINING_ARCHIVE);
  const raw = JSON.parse((await readRawArchive(page))!) as Record<string, unknown>;
  expect('revision' in raw).toBe(false);
});

test('合法旧档（无修订号、容量轨迹一致）：正常恢复，登记后刷新得到相同记录', async ({ page }) => {
  await seedArchive(page, LEGACY_VALID_ARCHIVE);
  await gotoLedger(page);

  // 加载提示：合法旧档没有损坏提示
  await expect(page.getByTestId('ledger-error')).toHaveCount(0);

  // 批次选择：两个批次都列出，状态与汇总来自同一份容量轨迹
  const items = page.getByTestId('batch-item');
  await expect(items).toHaveCount(2);
  await expect(items.nth(0).getByTestId('batch-status')).toHaveText('已耗尽');
  await expect(items.nth(0).getByTestId('batch-used')).toHaveText('10');
  await expect(items.nth(0).getByTestId('batch-remaining')).toHaveText('0');
  await expect(items.nth(1).getByTestId('batch-status')).toHaveText('使用中');
  await expect(items.nth(1).getByTestId('batch-used')).toHaveText('2');
  await expect(items.nth(1).getByTestId('batch-remaining')).toHaveText('3');

  // 已耗尽批次：历史余量与汇总一致（0），来源快照摘要照常展示
  await items.nth(0).click();
  await expect(page.getByTestId('detail-status')).toHaveText('已耗尽');
  await expect(page.getByTestId('exhausted-note')).toBeVisible();
  await expect(page.getByTestId('mix-source-summary')).toContainText('稀释式 1+4');
  await expect(page.getByTestId('usage-remaining')).toHaveText('0');

  // 使用中批次：历史余量 3 与批次汇总（额定 5 − 累计 2）一致
  await items.nth(1).click();
  await expect(page.getByTestId('detail-status')).toHaveText('使用中');
  await expect(page.getByTestId('detail-remaining')).toHaveText('3');
  await expect(page.getByTestId('usage-item')).toHaveCount(1);
  await expect(page.getByTestId('usage-note')).toContainText('2 卷 120');
  await expect(page.getByTestId('usage-remaining')).toHaveText('3');

  // 提交结果：本卷登记 1，历史余量延续同一轨迹（3 → 2）
  await page.getByTestId('films-input').fill('1');
  await page.getByTestId('note-input').fill('交接班登记 1 卷 135');
  await page.getByTestId('record-usage-button').click();
  await expect(page.getByTestId('usage-item')).toHaveCount(2);
  await expect(page.getByTestId('detail-remaining')).toHaveText('2');
  await expect(page.getByTestId('usage-remaining').nth(1)).toHaveText('2');

  // 修订号与原始存储：旧档升级为 revision 1，旧批次 / 旧记录 / 快照原样保留
  const raw = JSON.parse((await readRawArchive(page))!) as {
    revision: number;
    batches: Array<{ id: string; mixSource?: unknown }>;
    records: Array<{ batchId: string; films: number; remainingAfter: number }>;
  };
  expect(raw.revision).toBe(1);
  expect(raw.batches.map((batch) => batch.id)).toEqual(['legacy-dev', 'legacy-fix']);
  expect(raw.batches[0].mixSource).toEqual({
    n: 4,
    total: 1000,
    capacity: 250,
    tanks: 1,
    concentrate: 200,
    water: 800,
  });
  expect(raw.records.map((record) => record.films)).toEqual([10, 2, 1]);
  expect(raw.records.map((record) => record.remainingAfter)).toEqual([0, 3, 2]);

  // 刷新：得到相同记录——批次、状态、历史余量逐项一致
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
  await expect(page.getByTestId('usage-note').nth(1)).toContainText('交接班登记 1 卷 135');
  await expect(page.getByTestId('usage-remaining').nth(0)).toHaveText('3');
  await expect(page.getByTestId('usage-remaining').nth(1)).toHaveText('2');
});
