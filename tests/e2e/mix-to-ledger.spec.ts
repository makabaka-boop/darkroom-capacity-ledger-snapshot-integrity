import { expect, test } from '@playwright/test';

/**
 * 「存入容量台账」端到端：配液结果区一键建档，
 * 自动切换到台账并选中该批次展示来源摘要；刷新后摘要仍在。
 * 每个用例使用独立浏览器上下文，localStorage 互不影响。
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('计算 → 存入台账 → 跳转选中 → 刷新后来源摘要仍在，且可继续登记用量', async ({ page }) => {
  // 完成一次分罐配液计算：1+4、1000 mL、250 mL 量筒、3 罐
  await page.getByTestId('input-n').fill('4');
  await page.getByTestId('input-total').fill('1000');
  await page.getByTestId('input-capacity').fill('250');
  await page.getByTestId('input-tanks').fill('3');
  await expect(page.getByTestId('result-card')).toBeVisible();
  await expect(page.getByTestId('result-concentrate')).toHaveText('200 mL');
  await expect(page.getByTestId('result-water')).toHaveText('800 mL');
  await expect(page.getByTestId('store-to-ledger')).toBeVisible();

  // 失败提交一：名称与容量留空 → 当前操作区就地说明原因，不切换页面
  await page.getByTestId('store-to-ledger-button').click();
  await expect(page.getByTestId('error-store-name')).toHaveText('请输入药液名称');
  await expect(page.getByTestId('error-store-capacity')).toHaveText('请输入额定容量');
  await expect(page.getByTestId('result-card')).toBeVisible();

  // 失败提交二：容量非整数 → 就地说明原因，仍停留在配液页
  await page.getByTestId('store-name-input').fill('D-76 显影液（2026-09 配制）');
  await page.getByTestId('store-capacity-input').fill('10.5');
  await page.getByTestId('store-to-ledger-button').click();
  await expect(page.getByTestId('error-store-capacity')).toHaveText(
    '额定容量必须为整数，不能含小数或字母',
  );
  await expect(page.getByTestId('result-card')).toBeVisible();

  // 失败提交不产生任何批次：台账仍为空
  await page.getByTestId('nav-ledger').click();
  await expect(page.getByTestId('batch-empty')).toBeVisible();
  await expect(page.getByTestId('batch-item')).toHaveCount(0);
  await page.getByTestId('nav-mix').click();
  await expect(page.getByTestId('store-to-ledger')).toBeVisible();

  // 合法提交：名称沿用（未清空），容量改为 12
  await page.getByTestId('store-capacity-input').fill('12');
  await page.getByTestId('store-to-ledger-button').click();

  // 自动切换到台账并选中该批次，展示来源摘要
  await expect(page.getByTestId('batch-item')).toHaveCount(1);
  await expect(page.getByTestId('batch-name')).toHaveText('D-76 显影液（2026-09 配制）');
  await expect(page.getByTestId('batch-item')).toHaveClass(/batch-item--selected/);
  await expect(page.getByTestId('usage-panel')).toBeVisible();
  const summary = page.getByTestId('mix-source-summary');
  await expect(summary).toContainText('稀释式 1+4');
  await expect(summary).toContainText('目标总量 1000 mL');
  await expect(summary).toContainText('量筒容量 250 mL');
  await expect(summary).toContainText('显影罐 3 只');
  await expect(summary).toContainText('浓缩液 200 mL');
  await expect(summary).toContainText('清水 800 mL');

  // 刷新：还原台账，重新选中批次后来源摘要原样保留
  await page.reload();
  await page.getByTestId('nav-ledger').click();
  await expect(page.getByTestId('batch-item')).toHaveCount(1);
  await page.getByTestId('batch-item').click();
  const restoredSummary = page.getByTestId('mix-source-summary');
  await expect(restoredSummary).toContainText('稀释式 1+4');
  await expect(restoredSummary).toContainText('目标总量 1000 mL');
  await expect(restoredSummary).toContainText('量筒容量 250 mL');
  await expect(restoredSummary).toContainText('显影罐 3 只');
  await expect(restoredSummary).toContainText('浓缩液 200 mL');
  await expect(restoredSummary).toContainText('清水 800 mL');

  // 带快照的批次仍可正常登记用量
  await page.getByTestId('films-input').fill('5');
  await page.getByTestId('record-usage-button').click();
  await expect(page.getByTestId('detail-used')).toHaveText('5');
  await expect(page.getByTestId('detail-remaining')).toHaveText('7');
  await expect(page.getByTestId('mix-source-summary')).toBeVisible();
});

test('任一配液参数变为非法时，存入入口随结果一同消失', async ({ page }) => {
  // 默认参数合法：入口可见
  await expect(page.getByTestId('result-card')).toBeVisible();
  await expect(page.getByTestId('store-to-ledger')).toBeVisible();

  await page.getByTestId('input-n').fill('0');
  await expect(page.getByTestId('error-n')).toBeVisible();
  await expect(page.getByTestId('result-card')).toHaveCount(0);
  await expect(page.getByTestId('store-to-ledger')).toHaveCount(0);

  await page.getByTestId('input-n').fill('4');
  await expect(page.getByTestId('store-to-ledger')).toBeVisible();

  await page.getByTestId('input-tanks').fill('21');
  await expect(page.getByTestId('error-tanks')).toBeVisible();
  await expect(page.getByTestId('store-to-ledger')).toHaveCount(0);

  // 恢复合法后入口随结果一同回来
  await page.getByTestId('input-tanks').fill('1');
  await expect(page.getByTestId('result-card')).toBeVisible();
  await expect(page.getByTestId('store-to-ledger')).toBeVisible();
});

test('改变配液参数后，待建档的名称与额定容量随旧结果一起重置', async ({ page }) => {
  // 默认 1+4 / 1000 mL，结果合法，入口可见
  await expect(page.getByTestId('store-to-ledger')).toBeVisible();

  // 为当前结果填写建档信息（不提交）
  await page.getByTestId('store-name-input').fill('旧批次名称');
  await page.getByTestId('store-capacity-input').fill('99');
  await expect(page.getByTestId('store-name-input')).toHaveValue('旧批次名称');
  await expect(page.getByTestId('store-capacity-input')).toHaveValue('99');

  // 改变配液参数：得到新的计算结果，旧建档草稿必须重置
  await page.getByTestId('input-n').fill('9');
  await expect(page.getByTestId('result-concentrate')).toHaveText('100 mL');
  await expect(page.getByTestId('store-name-input')).toHaveValue('');
  await expect(page.getByTestId('store-capacity-input')).toHaveValue('');
  await expect(page.getByTestId('error-store-name')).toHaveCount(0);
  await expect(page.getByTestId('error-store-capacity')).toHaveCount(0);

  // 参数变为非法（结果消失）时草稿同样被清空；恢复后入口可用且表单为空
  await page.getByTestId('store-name-input').fill('不应残留');
  await page.getByTestId('input-total').fill('99');
  await expect(page.getByTestId('result-card')).toHaveCount(0);
  await page.getByTestId('input-total').fill('1000');
  await expect(page.getByTestId('store-to-ledger')).toBeVisible();
  await expect(page.getByTestId('store-name-input')).toHaveValue('');
  await expect(page.getByTestId('store-capacity-input')).toHaveValue('');

  // 用新参数建档：快照取自新结果（1+9 → 浓缩液 100 mL），不带旧名称 / 旧容量
  await page.getByTestId('store-name-input').fill('新批次名称');
  await page.getByTestId('store-capacity-input').fill('12');
  await page.getByTestId('store-to-ledger-button').click();
  await expect(page.getByTestId('batch-name')).toHaveText('新批次名称');
  await expect(page.getByTestId('batch-capacity')).toHaveText('12');
  await expect(page.getByTestId('mix-source-summary')).toContainText('稀释式 1+9');
  await expect(page.getByTestId('mix-source-summary')).toContainText('浓缩液 100 mL');
});

test('手工创建的批次没有来源摘要，原有创建与登记流程不受影响', async ({ page }) => {
  await page.getByTestId('nav-ledger').click();
  await page.getByTestId('batch-name-input').fill('定影液');
  await page.getByTestId('batch-capacity-input').fill('5');
  await page.getByTestId('create-batch-button').click();

  await expect(page.getByTestId('usage-panel')).toBeVisible();
  await expect(page.getByTestId('mix-source-summary')).toHaveCount(0);

  await page.getByTestId('films-input').fill('2');
  await page.getByTestId('record-usage-button').click();
  await expect(page.getByTestId('detail-remaining')).toHaveText('3');
  await expect(page.getByTestId('mix-source-summary')).toHaveCount(0);
});
