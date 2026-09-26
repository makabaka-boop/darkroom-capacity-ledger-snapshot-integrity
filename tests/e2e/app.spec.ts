import { expect, test, type Page } from '@playwright/test';

async function fillForm(page: Page, n: string, total: string, capacity: string) {
  await page.getByTestId('input-n').fill(n);
  await page.getByTestId('input-total').fill(total);
  await page.getByTestId('input-capacity').fill(capacity);
}

async function stepAmounts(page: Page): Promise<number[]> {
  const texts = await page.getByTestId('step-amount').allTextContents();
  return texts.map((t) => Number.parseInt(t, 10));
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('合法输入：显示浓缩液、清水与分次量取步骤，合计严格等于目标总量', async ({ page }) => {
  await fillForm(page, '4', '1000', '300');

  await expect(page.getByTestId('result-concentrate')).toHaveText('200 mL');
  await expect(page.getByTestId('result-water')).toHaveText('800 mL');
  await expect(page.getByTestId('result-total')).toHaveText('1000 mL');

  // 浓缩液 200 → 1 步；清水 800 → 300 + 300 + 200，共 4 步
  await expect(page.getByTestId('measure-step')).toHaveCount(4);
  const amounts = await stepAmounts(page);
  expect(amounts).toEqual([200, 300, 300, 200]);

  // 每一步不超容量，合计严格等于目标总量
  for (const amount of amounts) {
    expect(amount).toBeLessThanOrEqual(300);
  }
  expect(amounts.reduce((a, b) => a + b, 0)).toBe(1000);
  await expect(page.getByTestId('steps-sum')).toContainText('✓');
});

test('0.5 mL 边界取整：102 mL 的 1+3 → 浓缩液 26 mL、清水 76 mL', async ({ page }) => {
  await fillForm(page, '3', '102', '5000');
  await expect(page.getByTestId('result-concentrate')).toHaveText('26 mL');
  await expect(page.getByTestId('result-water')).toHaveText('76 mL');
  await expect(page.getByTestId('result-exact')).toContainText('25.50');
});

test('非法字段就地反馈，且不保留旧配液卡', async ({ page }) => {
  await fillForm(page, '4', '1000', '300');
  await expect(page.getByTestId('result-card')).toBeVisible();

  await page.getByTestId('input-n').fill('0');
  await expect(page.getByTestId('error-n')).toBeVisible();
  await expect(page.getByTestId('result-card')).toHaveCount(0);
  await expect(page.getByTestId('print-card')).toHaveCount(0);

  await page.getByTestId('input-n').fill('4');
  await expect(page.getByTestId('result-card')).toBeVisible();

  await page.getByTestId('input-total').fill('5001');
  await expect(page.getByTestId('error-total')).toBeVisible();
  await expect(page.getByTestId('result-card')).toHaveCount(0);

  await page.getByTestId('input-total').fill('1000');
  await page.getByTestId('input-capacity').fill('10.5');
  await expect(page.getByTestId('error-capacity')).toBeVisible();
  await expect(page.getByTestId('result-card')).toHaveCount(0);
});

test('液体恰好等于量筒容量整数倍时，不出现零余量步骤', async ({ page }) => {
  // 浓缩液 200、清水 800，容量 200 → 1 + 4 步，全部满量筒
  await fillForm(page, '4', '1000', '200');
  const amounts = await stepAmounts(page);
  expect(amounts).toEqual([200, 200, 200, 200, 200]);
  await expect(page.getByTestId('measure-step')).toHaveCount(5);
  await expect(page.locator('text=/量取 0 mL/')).toHaveCount(0);
});

test('量取步骤可逐项勾选并更新进度', async ({ page }) => {
  await fillForm(page, '4', '1000', '300');
  const boxes = page.getByTestId('step-checkbox');
  await expect(boxes).toHaveCount(4);
  await expect(page.getByTestId('steps-progress')).toContainText('0/4');

  await boxes.nth(0).check();
  await boxes.nth(2).check();
  await expect(page.getByTestId('steps-progress')).toContainText('2/4');

  await boxes.nth(0).uncheck();
  await expect(page.getByTestId('steps-progress')).toContainText('1/4');
});

test('配液卡包含全部步骤且合计等于目标总量', async ({ page }) => {
  await fillForm(page, '9', '2500', '400');
  const card = page.getByTestId('print-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('1+9');
  await expect(card).toContainText('250 mL'); // 浓缩液 2500/10
  await expect(card).toContainText('2250 mL'); // 清水
  await expect(card).toContainText('2500 mL'); // 合计行
});

test('罐数为 1（默认）时不出现分罐区块，打印卡保持单批格式', async ({ page }) => {
  await fillForm(page, '4', '1000', '300');
  await expect(page.getByTestId('tank-plan')).toHaveCount(0);
  await expect(page.getByTestId('print-tank')).toHaveCount(0);
  await expect(page.getByTestId('print-card')).not.toContainText('显影罐数量');
  // 步骤顺序与数值保持既有行为
  const amounts = await stepAmounts(page);
  expect(amounts).toEqual([200, 300, 300, 200]);
});

test('罐数留空、含小数或越界：就地说明原因并立即隐藏旧结果', async ({ page }) => {
  await fillForm(page, '4', '1000', '250');
  await expect(page.getByTestId('result-card')).toBeVisible();

  await page.getByTestId('input-tanks').fill('');
  await expect(page.getByTestId('error-tanks')).toHaveText('请输入数值');
  await expect(page.getByTestId('result-card')).toHaveCount(0);
  await expect(page.getByTestId('print-card')).toHaveCount(0);

  await page.getByTestId('input-tanks').fill('2.5');
  await expect(page.getByTestId('error-tanks')).toHaveText('必须为整数，不能含小数或字母');
  await expect(page.getByTestId('result-card')).toHaveCount(0);

  await page.getByTestId('input-tanks').fill('21');
  await expect(page.getByTestId('error-tanks')).toHaveText('罐数须为 1–20 的整数');
  await expect(page.getByTestId('result-card')).toHaveCount(0);

  await page.getByTestId('input-tanks').fill('0');
  await expect(page.getByTestId('error-tanks')).toHaveText('罐数须为 1–20 的整数');
  await expect(page.getByTestId('result-card')).toHaveCount(0);

  // 恢复合法后按罐重新出结果
  await page.getByTestId('input-tanks').fill('2');
  await expect(page.getByTestId('error-tanks')).toHaveCount(0);
  await expect(page.getByTestId('result-card')).toBeVisible();
  await expect(page.getByTestId('tank-plan')).toHaveCount(2);
});

test('分罐流程：输入罐数 → 按罐勾选全部步骤 → 核对打印卡每罐明细', async ({ page }) => {
  await fillForm(page, '4', '1000', '250');
  await page.getByTestId('input-tanks').fill('3');

  // 整批工作液只算一次：汇总保持 200 / 800 / 1000
  await expect(page.getByTestId('result-concentrate')).toHaveText('200 mL');
  await expect(page.getByTestId('result-water')).toHaveText('800 mL');
  await expect(page.getByTestId('result-total')).toHaveText('1000 mL');

  // 分罐：总量 [334,333,333]，浓缩液 [67,67,66]，清水 = 罐目标量 − 罐浓缩液
  const plans = page.getByTestId('tank-plan');
  await expect(plans).toHaveCount(3);
  await expect(plans.nth(0)).toContainText('罐 1');
  await expect(plans.nth(0)).toContainText('目标 334 mL');
  await expect(plans.nth(0)).toContainText('浓缩液 67 mL');
  await expect(plans.nth(0)).toContainText('清水 267 mL');
  await expect(plans.nth(1)).toContainText('目标 333 mL');
  await expect(plans.nth(1)).toContainText('清水 266 mL');
  await expect(plans.nth(2)).toContainText('浓缩液 66 mL');
  await expect(plans.nth(2)).toContainText('清水 267 mL');

  // 全部步骤受量筒容量约束，合计严格还原目标总量
  const amounts = await stepAmounts(page);
  expect(amounts).toEqual([67, 250, 17, 67, 250, 16, 66, 250, 17]);
  expect(amounts.reduce((a, b) => a + b, 0)).toBe(1000);
  for (const amount of amounts) {
    expect(amount).toBeLessThanOrEqual(250);
  }
  await expect(page.getByTestId('steps-sum')).toContainText('✓');

  // 勾选进度覆盖全部分罐步骤
  const boxes = page.getByTestId('step-checkbox');
  await expect(boxes).toHaveCount(9);
  await expect(page.getByTestId('steps-progress')).toContainText('0/9');
  await boxes.nth(0).check();
  await boxes.nth(5).check();
  await expect(page.getByTestId('steps-progress')).toContainText('2/9');

  // 任一参数变化都清空勾选
  await page.getByTestId('input-tanks').fill('4');
  await expect(page.getByTestId('steps-progress')).toContainText('0/');
  await page.getByTestId('input-tanks').fill('3');
  await expect(page.getByTestId('steps-progress')).toContainText('0/9');

  // 勾完全部步骤
  for (let i = 0; i < 9; i += 1) {
    await boxes.nth(i).check();
  }
  await expect(page.getByTestId('steps-progress')).toContainText('9/9');

  // 打印卡使用同一分配结果列出每罐明细
  const card = page.getByTestId('print-card');
  await expect(card).toContainText('显影罐数量');
  await expect(card).toContainText('3 只');
  const printTanks = page.getByTestId('print-tank');
  await expect(printTanks).toHaveCount(3);
  await expect(printTanks.nth(0)).toContainText('罐 1');
  await expect(printTanks.nth(0)).toContainText('目标 334 mL');
  await expect(printTanks.nth(0)).toContainText('浓缩液 67 mL');
  await expect(printTanks.nth(0)).toContainText('清水 267 mL');
  await expect(printTanks.nth(0)).toContainText('罐 1 合计');
  await expect(printTanks.nth(1)).toContainText('罐 2');
  await expect(printTanks.nth(1)).toContainText('清水 266 mL');
  await expect(printTanks.nth(2)).toContainText('罐 3');
  await expect(printTanks.nth(2)).toContainText('浓缩液 66 mL');
  await expect(page.getByTestId('print-batch-total')).toContainText('整批合计 1000 mL');
});

test('无障碍回归：三罐时每个量取复选框的可访问名称明确包含所属罐号', async ({ page }) => {
  await fillForm(page, '4', '1000', '250');
  await page.getByTestId('input-tanks').fill('3');

  // 三罐各 3 步，读屏逐项浏览时不能只听到重复的液体/次数，必须能辨别罐号
  const checkboxes = page.getByRole('checkbox', { name: /罐 \d+：/ });
  await expect(checkboxes).toHaveCount(9);
  for (const tank of [1, 2, 3]) {
    await expect(
      page.getByRole('checkbox', { name: new RegExp(`罐 ${tank}：`) }),
    ).toHaveCount(3);
  }
  // 罐 1 首步的完整名称包含罐号、液体与体积信息
  await expect(
    page.getByRole('checkbox', { name: '罐 1：浓缩液 第 1/1 次：量取 67 mL（余量）' }),
  ).toHaveCount(1);

  // 兼容：单罐步骤名称保持原样，不额外引入罐号
  await page.getByTestId('input-tanks').fill('1');
  await expect(page.getByRole('checkbox', { name: /罐 \d+：/ })).toHaveCount(0);
  await expect(
    page.getByRole('checkbox', { name: '浓缩液 第 1/1 次：量取 200 mL（余量）' }),
  ).toHaveCount(1);
});

test('无障碍回归：进度区为 polite live region，连续勾选后最新进度可被读屏播报', async ({ page }) => {
  await fillForm(page, '4', '1000', '250');
  await page.getByTestId('input-tanks').fill('3');

  const progress = page.getByTestId('steps-progress');
  await expect(progress).toHaveAttribute('role', 'status');
  await expect(progress).toHaveAttribute('aria-live', 'polite');
  await expect(progress).toHaveAttribute('aria-atomic', 'true');

  const boxes = page.getByTestId('step-checkbox');
  await expect(progress).toContainText('0/9');
  await boxes.nth(0).check();
  // 每次勾选后 live region 内的文本即最新进度（aria-atomic 整体播报）
  await expect(progress).toHaveText(/已勾选 1\/9/);
  await boxes.nth(1).check();
  await expect(progress).toHaveText(/已勾选 2\/9/);
});

test('打印回归：三罐步骤全部勾选后，打印卡保留已勾选完成状态', async ({ page }) => {
  await fillForm(page, '4', '1000', '250');
  await page.getByTestId('input-tanks').fill('3');

  const card = page.getByTestId('print-card');
  // 初始：打印卡 9 个完成标记全部为空框
  await expect(card.getByTestId('print-step-box')).toHaveCount(9);
  await expect(card.getByTestId('print-step-box')).toHaveText(Array(9).fill('☐'));

  // 三罐步骤全部勾选完成
  const boxes = page.getByTestId('step-checkbox');
  for (let i = 0; i < 9; i += 1) {
    await boxes.nth(i).check();
  }
  await expect(page.getByTestId('steps-progress')).toContainText('9/9');

  // 打印预览（打印卡始终渲染在页面上）中的完成标记全部为已勾选
  const printBoxes = card.getByTestId('print-step-box');
  await expect(printBoxes).toHaveCount(9);
  await expect(printBoxes).toHaveText(Array(9).fill('☑'));

  // 兼容：取消勾选后对应标记恢复为空框；参数变化清空勾选后全部回到空框
  await boxes.nth(0).uncheck();
  const printTexts = await printBoxes.allTextContents();
  expect(printTexts[0]).toBe('☐');
  expect(printTexts.filter((t) => t === '☑')).toHaveLength(8);

  await page.getByTestId('input-total').fill('999');
  await page.getByTestId('input-total').fill('1000');
  await expect(card.getByTestId('print-step-box')).toHaveText(Array(9).fill('☐'));
});
