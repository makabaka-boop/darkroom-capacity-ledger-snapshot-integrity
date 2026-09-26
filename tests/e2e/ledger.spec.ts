import { expect, test } from '@playwright/test';

/**
 * 容量台账端到端：从顶部入口进入，走「新建批次 → 分次登记 → 恰好用完」，
 * 并验证 localStorage 持久化在刷新后还原同一台账。
 * 每个用例使用独立浏览器上下文，localStorage 互不影响。
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('新建批次 → 分次登记 → 恰好耗尽 → 刷新后还原同一台账', async ({ page }) => {
  // 默认落在配液计算，从顶部「容量台账」入口进入
  await expect(page.getByTestId('input-n')).toBeVisible();
  await page.getByTestId('nav-ledger').click();
  await expect(page.getByTestId('batch-empty')).toBeVisible();

  // 空名称 + 空容量：就地说明原因，不创建任何批次
  await page.getByTestId('create-batch-button').click();
  await expect(page.getByTestId('error-batch-name')).toHaveText('请输入药液名称');
  await expect(page.getByTestId('error-batch-capacity')).toHaveText('请输入额定容量');
  await expect(page.getByTestId('batch-item')).toHaveCount(0);

  // 非整数容量
  await page.getByTestId('batch-name-input').fill('D-76 显影液');
  await page.getByTestId('batch-capacity-input').fill('10.5');
  await page.getByTestId('create-batch-button').click();
  await expect(page.getByTestId('error-batch-capacity')).toHaveText(
    '额定容量必须为整数，不能含小数或字母',
  );
  await expect(page.getByTestId('batch-item')).toHaveCount(0);

  // 非正整数容量
  await page.getByTestId('batch-capacity-input').fill('0');
  await page.getByTestId('create-batch-button').click();
  await expect(page.getByTestId('error-batch-capacity')).toHaveText('额定容量须为大于 0 的整数');
  await expect(page.getByTestId('batch-item')).toHaveCount(0);

  // 合法创建：批次出现并自动选中，状态使用中
  await page.getByTestId('batch-capacity-input').fill('10');
  await page.getByTestId('create-batch-button').click();
  await expect(page.getByTestId('error-batch-capacity')).toHaveCount(0);
  await expect(page.getByTestId('batch-item')).toHaveCount(1);
  await expect(page.getByTestId('batch-name')).toHaveText('D-76 显影液');
  await expect(page.getByTestId('batch-status')).toHaveText('使用中');
  await expect(page.getByTestId('batch-capacity')).toHaveText('10');
  await expect(page.getByTestId('usage-panel')).toBeVisible();
  await expect(page.getByTestId('usage-empty')).toBeVisible();

  // 第一次登记 4：累计 4、剩余 6，记录按时间列出
  await page.getByTestId('films-input').fill('4');
  await page.getByTestId('note-input').fill('4 卷 135，正常冲洗');
  await page.getByTestId('record-usage-button').click();
  await expect(page.getByTestId('usage-item')).toHaveCount(1);
  await expect(page.getByTestId('detail-used')).toHaveText('4');
  await expect(page.getByTestId('detail-remaining')).toHaveText('6');
  await expect(page.getByTestId('detail-status')).toHaveText('使用中');
  await expect(page.getByTestId('usage-films').first()).toHaveText('4');
  await expect(page.getByTestId('usage-note').first()).toContainText('4 卷 135，正常冲洗');
  await expect(page.getByTestId('usage-remaining').first()).toHaveText('6');
  await expect(page.getByTestId('usage-time').first()).not.toBeEmpty();

  // 超过剩余容量：就地说明原因，不写入记录
  await page.getByTestId('films-input').fill('7');
  await page.getByTestId('record-usage-button').click();
  await expect(page.getByTestId('error-films')).toHaveText('超过剩余容量：本批仅剩 6，无法登记 7');
  await expect(page.getByTestId('usage-item')).toHaveCount(1);
  await expect(page.getByTestId('detail-remaining')).toHaveText('6');

  // 非正整数：就地说明原因，不写入记录
  await page.getByTestId('films-input').fill('0');
  await page.getByTestId('record-usage-button').click();
  await expect(page.getByTestId('error-films')).toHaveText('数量须为大于 0 的整数');
  await expect(page.getByTestId('usage-item')).toHaveCount(1);

  // 恰好登记完剩余 6：状态确定转为已耗尽
  await page.getByTestId('films-input').fill('6');
  await page.getByTestId('record-usage-button').click();
  await expect(page.getByTestId('error-films')).toHaveCount(0);
  await expect(page.getByTestId('usage-item')).toHaveCount(2);
  await expect(page.getByTestId('detail-used')).toHaveText('10');
  await expect(page.getByTestId('detail-remaining')).toHaveText('0');
  await expect(page.getByTestId('detail-status')).toHaveText('已耗尽');
  await expect(page.getByTestId('batch-status')).toHaveText('已耗尽');
  await expect(page.getByTestId('exhausted-note')).toBeVisible();
  await expect(page.getByTestId('usage-remaining').nth(1)).toHaveText('0');

  // 已耗尽后继续登记仍被拒绝，且不写入
  await page.getByTestId('films-input').fill('1');
  await page.getByTestId('record-usage-button').click();
  await expect(page.getByTestId('error-films')).toHaveText('超过剩余容量：本批仅剩 0，无法登记 1');
  await expect(page.getByTestId('usage-item')).toHaveCount(2);

  // 刷新：还原同一台账（批次、状态、累计/剩余、使用记录）
  await page.reload();
  await page.getByTestId('nav-ledger').click();
  await expect(page.getByTestId('batch-item')).toHaveCount(1);
  await expect(page.getByTestId('batch-name')).toHaveText('D-76 显影液');
  await expect(page.getByTestId('batch-status')).toHaveText('已耗尽');
  await expect(page.getByTestId('batch-used')).toHaveText('10');
  await expect(page.getByTestId('batch-remaining')).toHaveText('0');

  // 重新选中批次：两条使用记录与备注原样还原
  await page.getByTestId('batch-item').click();
  await expect(page.getByTestId('usage-item')).toHaveCount(2);
  await expect(page.getByTestId('detail-status')).toHaveText('已耗尽');
  await expect(page.getByTestId('usage-films').first()).toHaveText('4');
  await expect(page.getByTestId('usage-films').nth(1)).toHaveText('6');
  await expect(page.getByTestId('usage-note').first()).toContainText('4 卷 135，正常冲洗');
  await expect(page.getByTestId('usage-remaining').first()).toHaveText('6');
  await expect(page.getByTestId('usage-remaining').nth(1)).toHaveText('0');
});

test('多批次各自独立累计，选中批次才登记到对应台账', async ({ page }) => {
  await page.getByTestId('nav-ledger').click();

  await page.getByTestId('batch-name-input').fill('显影液 A');
  await page.getByTestId('batch-capacity-input').fill('8');
  await page.getByTestId('create-batch-button').click();
  await page.getByTestId('batch-name-input').fill('定影液 B');
  await page.getByTestId('batch-capacity-input').fill('5');
  await page.getByTestId('create-batch-button').click();
  await expect(page.getByTestId('batch-item')).toHaveCount(2);

  // 新创建的 B 自动选中：登记 2
  await page.getByTestId('films-input').fill('2');
  await page.getByTestId('record-usage-button').click();
  await expect(page.getByTestId('detail-used')).toHaveText('2');

  // 切到 A：记录独立，从 0 开始；一次登记 8 恰好耗尽
  await page.getByTestId('batch-item').first().click();
  await expect(page.getByTestId('detail-used')).toHaveText('0');
  await expect(page.getByTestId('usage-empty')).toBeVisible();
  await page.getByTestId('films-input').fill('8');
  await page.getByTestId('record-usage-button').click();
  await expect(page.getByTestId('detail-status')).toHaveText('已耗尽');

  // B 的台账不受 A 影响：仍是用中、剩余 3
  const batchB = page.getByTestId('batch-item').nth(1);
  await expect(batchB.getByTestId('batch-status')).toHaveText('使用中');
  await expect(batchB.getByTestId('batch-used')).toHaveText('2');
  await expect(batchB.getByTestId('batch-remaining')).toHaveText('3');
});

test('超长额定容量被就地拒绝：不创建异常批次，刷新后已有台账保留', async ({ page }) => {
  await page.getByTestId('nav-ledger').click();

  // 先建立一个正常批次
  await page.getByTestId('batch-name-input').fill('正常批次');
  await page.getByTestId('batch-capacity-input').fill('10');
  await page.getByTestId('create-batch-button').click();
  await expect(page.getByTestId('batch-item')).toHaveCount(1);
  await expect(page.getByTestId('batch-capacity')).toHaveText('10');

  // 超长数字（parseInt 为 Infinity）：就地拒绝，不显示异常数值
  await page.getByTestId('batch-name-input').fill('超长批次');
  await page.getByTestId('batch-capacity-input').fill('9'.repeat(400));
  await page.getByTestId('create-batch-button').click();
  await expect(page.getByTestId('error-batch-capacity')).toHaveText(
    '数值过大，无法精确记录，请填写较小的整数',
  );
  await expect(page.getByTestId('batch-item')).toHaveCount(1);
  await expect(page.getByTestId('batch-name')).toHaveText('正常批次');
  await expect(page.getByTestId('batch-capacity')).toHaveText('10');

  // 精度丢失边界 2^53+1 同样拒绝
  await page.getByTestId('batch-capacity-input').fill(String(2 ** 53 + 1));
  await page.getByTestId('create-batch-button').click();
  await expect(page.getByTestId('error-batch-capacity')).toHaveText(
    '数值过大，无法精确记录，请填写较小的整数',
  );
  await expect(page.getByTestId('batch-item')).toHaveCount(1);

  // 刷新：原台账完好，没有因异常批次而整体消失
  await page.reload();
  await page.getByTestId('nav-ledger').click();
  await expect(page.getByTestId('batch-item')).toHaveCount(1);
  await expect(page.getByTestId('batch-name')).toHaveText('正常批次');
  await expect(page.getByTestId('batch-capacity')).toHaveText('10');
});

test('切换批次时未提交的用量与备注草稿被清空，不会误登记到新批次', async ({ page }) => {
  await page.getByTestId('nav-ledger').click();

  await page.getByTestId('batch-name-input').fill('批次 A');
  await page.getByTestId('batch-capacity-input').fill('10');
  await page.getByTestId('create-batch-button').click();
  await page.getByTestId('batch-name-input').fill('批次 B');
  await page.getByTestId('batch-capacity-input').fill('10');
  await page.getByTestId('create-batch-button').click();
  await expect(page.getByTestId('batch-item')).toHaveCount(2);

  // 当前自动选中 B：填写但不提交
  await expect(page.getByTestId('films-input')).toHaveValue('');
  await page.getByTestId('films-input').fill('3');
  await page.getByTestId('note-input').fill('给 B 的备注');

  // 切到 A：草稿与错误被一并丢弃
  await page.getByTestId('batch-item').first().click();
  await expect(page.getByTestId('films-input')).toHaveValue('');
  await expect(page.getByTestId('note-input')).toHaveValue('');
  await expect(page.getByTestId('usage-empty')).toBeVisible();

  // 直接在 A 提交不会带入 B 的草稿：表单为空，提示必填，且没有任何记录写入
  await page.getByTestId('record-usage-button').click();
  await expect(page.getByTestId('error-films')).toHaveText('请输入等效胶片数量');
  await expect(page.getByTestId('usage-item')).toHaveCount(0);
  await expect(page.getByTestId('detail-used')).toHaveText('0');

  // B 同样没有被误登记
  await page.getByTestId('batch-item').nth(1).click();
  await expect(page.getByTestId('usage-empty')).toBeVisible();
  await expect(page.getByTestId('detail-used')).toHaveText('0');
});

test('配液计算与容量台账切换互不干扰，各自状态保留', async ({ page }) => {
  // 先在配液计算里改参数
  await page.getByTestId('input-total').fill('2000');
  await expect(page.getByTestId('result-total')).toHaveText('2000 mL');

  // 切到台账建批并登记
  await page.getByTestId('nav-ledger').click();
  await page.getByTestId('batch-name-input').fill('停显液');
  await page.getByTestId('batch-capacity-input').fill('20');
  await page.getByTestId('create-batch-button').click();
  await page.getByTestId('films-input').fill('5');
  await page.getByTestId('record-usage-button').click();
  await expect(page.getByTestId('detail-remaining')).toHaveText('15');

  // 切回配液计算：表单与结果保持切换前的状态
  await page.getByTestId('nav-mix').click();
  await expect(page.getByTestId('input-total')).toHaveValue('2000');
  await expect(page.getByTestId('result-total')).toHaveText('2000 mL');
  await expect(page.getByTestId('steps-progress')).toBeVisible();

  // 再切回台账：批次与累计用量仍在
  await page.getByTestId('nav-ledger').click();
  await expect(page.getByTestId('batch-item')).toHaveCount(1);
  await expect(page.getByTestId('batch-used')).toHaveText('5');
  await expect(page.getByTestId('batch-remaining')).toHaveText('15');
});
