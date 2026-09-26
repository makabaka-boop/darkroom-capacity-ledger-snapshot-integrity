import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import App from '../../src/App';

/**
 * 无浏览器环境下的界面冒烟测试：
 * 确认关键 data-testid 与计算结果真实渲染（Playwright 覆盖交互部分）。
 */
describe('App 渲染冒烟（默认 1+4 / 1000 mL / 250 mL 量筒）', () => {
  // SSR 会在文本插值间插入 <!-- --> 注释节点，先去除再断言
  const html = renderToString(<App />).replace(/<!-- -->/g, '');

  it('渲染浓缩液 200 mL、清水 800 mL', () => {
    expect(html).toContain('data-testid="result-concentrate"');
    expect(html).toContain('200 mL');
    expect(html).toContain('800 mL');
  });

  it('渲染 5 个量取步骤（浓缩液 1 步 + 清水 4 步）且各步不超容量', () => {
    expect((html.match(/data-testid="measure-step"/g) ?? []).length).toBe(5);
    const amounts = [...html.matchAll(/data-testid="step-amount">(\d+)</g)].map((m) =>
      Number.parseInt(m[1], 10),
    );
    expect(amounts).toEqual([200, 250, 250, 250, 50]);
    expect(amounts.reduce((a, b) => a + b, 0)).toBe(1000);
    for (const amount of amounts) {
      expect(amount).toBeLessThanOrEqual(250);
    }
  });

  it('渲染可打印配液卡与勾选框', () => {
    expect(html).toContain('data-testid="print-card"');
    expect(html).toContain('data-testid="step-checkbox"');
  });

  it('顶部提供容量台账与安全灯测试入口', () => {
    expect(html).toContain('data-testid="nav-ledger"');
    expect(html).toContain('data-testid="nav-safelight"');
    expect(html).toContain('安全灯测试');
  });

  it('默认罐数为 1：不出现分罐区块，打印卡保持单批格式', () => {
    expect(html).toContain('data-testid="input-tanks"');
    expect(html).not.toContain('data-testid="tank-plan"');
    expect(html).not.toContain('data-testid="print-tank"');
    expect(html).not.toContain('<th>显影罐数量</th>');
  });

  it('进度区带 polite live region 语义，勾选后最新进度可被读屏整体播报', () => {
    const progress = html.match(/data-testid="steps-progress"[^>]*/)?.[0] ?? '';
    expect(progress).toContain('role="status"');
    expect(progress).toContain('aria-live="polite"');
    expect(progress).toContain('aria-atomic="true"');
  });

  it('打印卡完成标记初始为空框（勾选后由状态渲染为 ☑）', () => {
    expect((html.match(/data-testid="print-step-box"/g) ?? []).length).toBe(5);
    expect(html).toContain('data-testid="print-step-box">☐</td>');
    expect(html).not.toContain('data-testid="print-step-box">☑</td>');
  });
});
