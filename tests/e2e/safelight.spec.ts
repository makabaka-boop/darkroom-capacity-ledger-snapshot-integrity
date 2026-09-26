import { expect, test, type Page } from '@playwright/test';

/**
 * 安全灯测试端到端：从顶部入口进入，走「创建阶梯测试 → 观察评估 →
 * 得出安全上限」，并验证独立 localStorage 键在刷新后还原草稿与结论。
 * 每个用例使用独立浏览器上下文，localStorage 互不影响。
 */

const SAFELIGHT_KEY = 'darkroom.safelight-tests.v1';

async function createTest(
  page: Page,
  name: string,
  start: string,
  step: string,
  strips: string,
) {
  await page.getByTestId('safelight-name-input').fill(name);
  await page.getByTestId('safelight-start-input').fill(start);
  await page.getByTestId('safelight-step-input').fill(step);
  await page.getByTestId('safelight-strips-input').fill(strips);
  await page.getByTestId('create-safelight-button').click();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('nav-safelight').click();
});

test('创建 → 阶梯按曝光顺序列出 → 评估中间条 → 刷新后草稿与结论都还原', async ({ page }) => {
  await expect(page.getByTestId('safelight-empty')).toBeVisible();

  // 创建：起始 10 秒、递增 5 秒、4 条 → 阶梯 10/15/20/25
  await createTest(page, '红色安全灯 1 米 + MGIV', '10', '5', '4');
  await expect(page.getByTestId('safelight-item')).toHaveCount(1);
  await expect(page.getByTestId('safelight-item-name')).toHaveText('红色安全灯 1 米 + MGIV');
  await expect(page.getByTestId('safelight-item-status')).toHaveText('待评估');

  // 创建后按曝光顺序列出各条带时长，并等待观察结果
  await expect(page.getByTestId('safelight-detail')).toBeVisible();
  await expect(page.getByTestId('strip-item')).toHaveCount(4);
  const seconds = await page.getByTestId('strip-seconds').allTextContents();
  expect(seconds).toEqual(['10', '15', '20', '25']);
  await expect(page.getByTestId('safelight-awaiting')).toBeVisible();

  // 缺失观察：直接完成评估 → 就地反馈，不写入结论
  await page.getByTestId('evaluate-button').click();
  await expect(page.getByTestId('error-safelight-observation')).toHaveText(
    '请选择观察结果：首条出现可见灰雾的条带，或「全部未起雾」',
  );
  await expect(page.getByTestId('safelight-item-status')).toHaveText('待评估');
  await expect(page.getByTestId('safelight-conclusion')).toHaveCount(0);

  // 选择首条起雾为条带 3（20 秒）→ 安全上限 = 前一条的 15 秒
  await page.getByTestId('fog-option-3').check();
  await page.getByTestId('evaluate-button').click();
  await expect(page.getByTestId('safelight-conclusion')).toBeVisible();
  await expect(page.getByTestId('conclusion-seconds')).toHaveText('15 秒');
  await expect(page.getByTestId('safelight-item-status')).toHaveText('已完成');
  // 已完成的测试不再显示观察表单
  await expect(page.getByTestId('evaluate-button')).toHaveCount(0);
  await expect(page.getByTestId('safelight-awaiting')).toHaveCount(0);

  // 再建一个草稿（不评估），验证草稿与结论一起持久化
  await createTest(page, '绿色安全灯 2 米', '20', '10', '3');
  await expect(page.getByTestId('safelight-item')).toHaveCount(2);
  await expect(page.getByTestId('safelight-item-status').nth(1)).toHaveText('待评估');

  // 刷新：两个测试都还原；已完成测试结论原样保留，草稿仍在等待观察
  await page.reload();
  await page.getByTestId('nav-safelight').click();
  await expect(page.getByTestId('safelight-item')).toHaveCount(2);
  await expect(page.getByTestId('safelight-item-status').nth(0)).toHaveText('已完成');
  await expect(page.getByTestId('safelight-item-status').nth(1)).toHaveText('待评估');

  await page.getByTestId('safelight-item').nth(0).click();
  await expect(page.getByTestId('conclusion-seconds')).toHaveText('15 秒');
  await expect(page.getByTestId('strip-item')).toHaveCount(4);

  await page.getByTestId('safelight-item').nth(1).click();
  await expect(page.getByTestId('safelight-awaiting')).toBeVisible();
  const restoredSeconds = await page.getByTestId('strip-seconds').allTextContents();
  expect(restoredSeconds).toEqual(['20', '30', '40']);
});

test('未提交的观察草稿不跨测试串用：A 上选择后切到 B 直接提交，视为 B 尚未观察', async ({
  page,
}) => {
  // 创建 A、B 两个待评估测试（阶梯不同，便于确认结论属于哪一份）
  await createTest(page, '测试 A', '10', '5', '4');
  await createTest(page, '测试 B', '20', '10', '3');
  await expect(page.getByTestId('safelight-item')).toHaveCount(2);

  const itemA = page.getByTestId('safelight-item').nth(0);
  const itemB = page.getByTestId('safelight-item').nth(1);

  // 在 A 选择第 2 条起雾但不提交
  await itemA.click();
  await expect(page.getByTestId('safelight-detail').getByRole('heading', { name: '测试 A' })).toBeVisible();
  await page.getByTestId('fog-option-2').check();
  await expect(page.getByTestId('fog-option-2')).toBeChecked();

  // 切换到 B：应视为尚未选择观察（单选项全部未选）
  await itemB.click();
  await expect(page.getByTestId('safelight-detail').getByRole('heading', { name: '测试 B' })).toBeVisible();
  for (const n of [1, 2, 3]) {
    await expect(page.getByTestId(`fog-option-${n}`)).not.toBeChecked();
  }
  await expect(page.getByTestId('fog-option-none')).not.toBeChecked();

  // B 直接完成评估：缺失提示，不沿用 A 的选择，不产生结论，保持待评估
  await page.getByTestId('evaluate-button').click();
  await expect(page.getByTestId('error-safelight-observation')).toHaveText(
    '请选择观察结果：首条出现可见灰雾的条带，或「全部未起雾」',
  );
  await expect(page.getByTestId('safelight-conclusion')).toHaveCount(0);
  await expect(itemB.getByTestId('safelight-item-status')).toHaveText('待评估');

  // 切回 A：A 上未提交的草稿同样已丢弃，直接提交也得到缺失提示
  await itemA.click();
  await expect(page.getByTestId('fog-option-2')).not.toBeChecked();
  await page.getByTestId('evaluate-button').click();
  await expect(page.getByTestId('error-safelight-observation')).toBeVisible();
  await expect(page.getByTestId('safelight-conclusion')).toHaveCount(0);
  await expect(itemA.getByTestId('safelight-item-status')).toHaveText('待评估');

  // 刷新后两条都仍是待评估：没有任何结论被误写入
  await page.reload();
  await page.getByTestId('nav-safelight').click();
  await expect(page.getByTestId('safelight-item-status').nth(0)).toHaveText('待评估');
  await expect(page.getByTestId('safelight-item-status').nth(1)).toHaveText('待评估');
});

test('三种结论边界：首条即起雾显示低于起始值，全部未起雾显示至少达到末条时长', async ({
  page,
}) => {
  // 首条即起雾 → 低于起始值（不足 10 秒）
  await createTest(page, '首条起雾测试', '10', '5', '4');
  await page.getByTestId('fog-option-1').check();
  await page.getByTestId('evaluate-button').click();
  await expect(page.getByTestId('safelight-conclusion')).toContainText('首条即出现灰雾');
  await expect(page.getByTestId('conclusion-seconds')).toContainText('低于起始值（不足 10 秒）');

  // 全部未起雾 → 至少达到末条时长（≥ 25 秒）
  await createTest(page, '全部清晰测试', '10', '5', '4');
  await page.getByTestId('fog-option-none').check();
  await page.getByTestId('evaluate-button').click();
  await expect(page.getByTestId('safelight-conclusion')).toContainText('全部条带均未起雾');
  await expect(page.getByTestId('conclusion-seconds')).toContainText('至少达到末条时长（≥ 25 秒）');

  // 刷新后两个结论都原样还原
  await page.reload();
  await page.getByTestId('nav-safelight').click();
  await page.getByTestId('safelight-item').nth(0).click();
  await expect(page.getByTestId('conclusion-seconds')).toContainText('低于起始值（不足 10 秒）');
  await page.getByTestId('safelight-item').nth(1).click();
  await expect(page.getByTestId('conclusion-seconds')).toContainText('至少达到末条时长（≥ 25 秒）');
});

test('非法输入就地反馈：不创建测试，也不覆盖最近一次有效数据', async ({ page }) => {
  // 先建立一份有效数据
  await createTest(page, '有效测试', '10', '5', '4');
  await expect(page.getByTestId('safelight-item')).toHaveCount(1);

  // 空表单提交：各字段就地说明原因，已有数据不变
  await page.getByTestId('create-safelight-button').click();
  await expect(page.getByTestId('error-safelight-name')).toHaveText('请输入测试名称');
  await expect(page.getByTestId('error-safelight-start')).toHaveText('请输入起始秒数');
  await expect(page.getByTestId('error-safelight-step')).toHaveText('请输入递增秒数');
  await expect(page.getByTestId('error-safelight-strips')).toHaveText('请输入条带数量');
  await expect(page.getByTestId('safelight-item')).toHaveCount(1);

  // 非整数秒数
  await page.getByTestId('safelight-name-input').fill('异常测试');
  await page.getByTestId('safelight-start-input').fill('10.5');
  await page.getByTestId('create-safelight-button').click();
  await expect(page.getByTestId('error-safelight-start')).toHaveText(
    '起始秒数必须为整数，不能含小数或字母',
  );
  await expect(page.getByTestId('safelight-item')).toHaveCount(1);

  // 条带数量越界（少于 2 条）
  await page.getByTestId('safelight-start-input').fill('10');
  await page.getByTestId('safelight-step-input').fill('5');
  await page.getByTestId('safelight-strips-input').fill('1');
  await page.getByTestId('create-safelight-button').click();
  await expect(page.getByTestId('error-safelight-strips')).toHaveText(
    '条带数量须为 2–20 的整数',
  );
  await expect(page.getByTestId('safelight-item')).toHaveCount(1);

  // 末条曝光超出一小时：3500 + 200 = 3700 > 3600
  await page.getByTestId('safelight-start-input').fill('3500');
  await page.getByTestId('safelight-step-input').fill('200');
  await page.getByTestId('safelight-strips-input').fill('2');
  await page.getByTestId('create-safelight-button').click();
  await expect(page.getByTestId('error-safelight-exposure')).toContainText(
    '末条曝光 3700 秒超过一小时上限（3600 秒）',
  );
  await expect(page.getByTestId('safelight-item')).toHaveCount(1);

  // 修正为恰好一小时（3500 + 100 = 3600）：允许创建
  await page.getByTestId('safelight-step-input').fill('100');
  await page.getByTestId('create-safelight-button').click();
  await expect(page.getByTestId('error-safelight-exposure')).toHaveCount(0);
  await expect(page.getByTestId('safelight-item')).toHaveCount(2);

  // 刷新：有效数据原样保留，失败输入没有产生任何测试
  await page.reload();
  await page.getByTestId('nav-safelight').click();
  await expect(page.getByTestId('safelight-item')).toHaveCount(2);
  await expect(page.getByTestId('safelight-item-name').nth(0)).toHaveText('有效测试');
});

test('损坏存储就地反馈且不覆盖原数据，新建测试后恢复可用', async ({ page }) => {
  // 先建立一份有效数据并确认已写入独立存储键
  await createTest(page, '已有测试', '10', '5', '4');
  await expect(page.getByTestId('safelight-item')).toHaveCount(1);
  const validJson = await page.evaluate((key) => localStorage.getItem(key), SAFELIGHT_KEY);
  expect(validJson).toContain('已有测试');

  // 篡改存储为损坏内容后刷新：就地提示损坏，列表回退空白
  await page.evaluate((key) => localStorage.setItem(key, 'corrupted{json'), SAFELIGHT_KEY);
  await page.reload();
  await page.getByTestId('nav-safelight').click();
  await expect(page.getByTestId('safelight-storage-corrupted')).toBeVisible();
  await expect(page.getByTestId('safelight-item')).toHaveCount(0);
  await expect(page.getByTestId('safelight-empty')).toBeVisible();

  // 原数据未被空白状态覆盖（仍是损坏内容，留待人工处理）
  const afterReload = await page.evaluate((key) => localStorage.getItem(key), SAFELIGHT_KEY);
  expect(afterReload).toBe('corrupted{json');

  // 新建测试：提示消失，存储键被新的有效数据替代
  await createTest(page, '重建测试', '15', '5', '3');
  await expect(page.getByTestId('safelight-storage-corrupted')).toHaveCount(0);
  await expect(page.getByTestId('safelight-item')).toHaveCount(1);
  const rebuilt = await page.evaluate((key) => localStorage.getItem(key), SAFELIGHT_KEY);
  expect(rebuilt).toContain('重建测试');

  // 再次刷新：新数据正常还原
  await page.reload();
  await page.getByTestId('nav-safelight').click();
  await expect(page.getByTestId('safelight-item')).toHaveCount(1);
  await expect(page.getByTestId('safelight-item-name')).toHaveText('重建测试');
});

test('存档含重复测试或空时间时按损坏处理：就地提示且不覆盖原数据', async ({ page }) => {
  // 重复 id：两条测试共用 t1，按 id 选中永远只能打开第一条，第二条无法正确打开
  const duplicated = JSON.stringify({
    tests: [
      { id: 't1', name: '甲测试', startSeconds: 10, stepSeconds: 5, stripCount: 4, createdAt: '2026-09-12T08:00:00.000Z' },
      { id: 't1', name: '乙测试', startSeconds: 20, stepSeconds: 10, stripCount: 3, createdAt: '2026-09-12T09:00:00.000Z' },
    ],
  });
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), [SAFELIGHT_KEY, duplicated]);
  await page.reload();
  await page.getByTestId('nav-safelight').click();
  await expect(page.getByTestId('safelight-storage-corrupted')).toBeVisible();
  await expect(page.getByTestId('safelight-item')).toHaveCount(0);
  // 原数据未被空白状态覆盖
  expect(await page.evaluate((key) => localStorage.getItem(key), SAFELIGHT_KEY)).toBe(duplicated);

  // 空创建时间同样视为损坏
  const emptyTime = JSON.stringify({
    tests: [
      { id: 't2', name: '空时间测试', startSeconds: 10, stepSeconds: 5, stripCount: 4, createdAt: '' },
    ],
  });
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), [SAFELIGHT_KEY, emptyTime]);
  await page.reload();
  await page.getByTestId('nav-safelight').click();
  await expect(page.getByTestId('safelight-storage-corrupted')).toBeVisible();
  await expect(page.getByTestId('safelight-item')).toHaveCount(0);
  expect(await page.evaluate((key) => localStorage.getItem(key), SAFELIGHT_KEY)).toBe(emptyTime);

  // 空评估时间（已完成结论里的 evaluatedAt 为空）也视为损坏
  const emptyEvalTime = JSON.stringify({
    tests: [
      {
        id: 't3',
        name: '空评估时间测试',
        startSeconds: 10,
        stepSeconds: 5,
        stripCount: 4,
        createdAt: '2026-09-12T08:00:00.000Z',
        evaluation: { firstFogStrip: 2, evaluatedAt: '' },
      },
    ],
  });
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), [SAFELIGHT_KEY, emptyEvalTime]);
  await page.reload();
  await page.getByTestId('nav-safelight').click();
  await expect(page.getByTestId('safelight-storage-corrupted')).toBeVisible();
  await expect(page.getByTestId('safelight-item')).toHaveCount(0);
});

test('安全灯测试与配液计算、容量台账切换互不干扰', async ({ page }) => {
  // 在安全灯测试里建一个草稿
  await createTest(page, '切换测试', '10', '5', '4');
  await expect(page.getByTestId('safelight-item')).toHaveCount(1);

  // 切到配液计算：结果区照常工作
  await page.getByTestId('nav-mix').click();
  await expect(page.getByTestId('result-card')).toBeVisible();
  await expect(page.getByTestId('result-concentrate')).toHaveText('200 mL');

  // 切到容量台账：不受安全灯数据影响，仍为空台账
  await page.getByTestId('nav-ledger').click();
  await expect(page.getByTestId('batch-empty')).toBeVisible();

  // 切回安全灯测试：草稿仍在
  await page.getByTestId('nav-safelight').click();
  await expect(page.getByTestId('safelight-item')).toHaveCount(1);
  await expect(page.getByTestId('safelight-item-name')).toHaveText('切换测试');
});
