import { describe, expect, it } from 'vitest';
import {
  conclusionOf,
  createSafelightTest,
  EMPTY_SAFELIGHT,
  evaluateSafelightTest,
  EXPOSURE_MAX_SECONDS,
  lastStripSeconds,
  SAFELIGHT_STATUS_LABEL,
  safelightStatus,
  stripDurations,
  validateExposureLimit,
  type SafelightDeps,
  type SafelightState,
} from '../../src/lib/safelightTest';

/** 确定性依赖：时间逐秒递增，id 递增，便于断言与复现。 */
function testDeps(): SafelightDeps {
  let counter = 0;
  return {
    now: () => {
      counter += 1;
      return new Date(Date.UTC(2026, 8, 12, 8, 0, 0) + counter * 1000);
    },
    nextId: () => `safelight-id-${counter}`,
  };
}

function mustCreate(
  state: SafelightState,
  input: { name: string; startSeconds: string; stepSeconds: string; stripCount: string },
  deps: SafelightDeps,
) {
  const result = createSafelightTest(state, input, deps);
  if (!result.ok) throw new Error(`测试前置创建失败：${result.error}`);
  return result;
}

describe('阶梯生成', () => {
  it('按曝光顺序生成等差阶梯：第 k 条 = 起始 + (k−1) × 递增', () => {
    const durations = stripDurations({ startSeconds: 10, stepSeconds: 5, stripCount: 4 });
    expect(durations).toEqual([10, 15, 20, 25]);
    // 条数与参数一致，且严格递增、公差恒为递增秒数
    expect(durations).toHaveLength(4);
    for (let i = 1; i < durations.length; i += 1) {
      expect(durations[i] - durations[i - 1]).toBe(5);
    }
  });

  it('末条时长 = 起始 + (条数−1) × 递增，与阶梯最后一项一致', () => {
    const test = { startSeconds: 30, stepSeconds: 15, stripCount: 6 };
    expect(lastStripSeconds(test)).toBe(30 + 5 * 15);
    expect(lastStripSeconds(test)).toBe(stripDurations(test).at(-1));
  });

  it('一小时边界：末条恰好 3600 秒允许，超出 1 秒即拒绝', () => {
    // 3500 + (2−1) × 100 = 3600，恰好一小时
    expect(validateExposureLimit(3500, 100, 2)).toBeUndefined();
    expect(EXPOSURE_MAX_SECONDS).toBe(3600);
    // 3500 + 200 = 3700 > 3600
    expect(validateExposureLimit(3500, 200, 2)).toBe(
      '末条曝光 3700 秒超过一小时上限（3600 秒），请缩短秒数或减少条带数量',
    );
    // 条带数量放大同样触发：10 + 19 × 200 = 3810
    expect(validateExposureLimit(10, 200, 20)).toContain('超过一小时上限');
  });
});

describe('createSafelightTest 命令', () => {
  it('合法输入创建草稿：名称去空白、等待评估，原状态不被修改', () => {
    const deps = testDeps();
    const before = EMPTY_SAFELIGHT;
    const result = createSafelightTest(
      before,
      { name: '  红色安全灯 1 米  ', startSeconds: ' 10 ', stepSeconds: '5', stripCount: '4' },
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe('红色安全灯 1 米');
    expect(result.value.startSeconds).toBe(10);
    expect(result.value.stepSeconds).toBe(5);
    expect(result.value.stripCount).toBe(4);
    expect(result.value.createdAt).toBe('2026-09-12T08:00:01.000Z');
    // 草稿：尚未评估，等待观察结果
    expect(result.value.evaluation).toBeUndefined();
    expect(safelightStatus(result.value)).toBe('pending');
    expect(SAFELIGHT_STATUS_LABEL[safelightStatus(result.value)]).toBe('待评估');
    expect(conclusionOf(result.value)).toBeNull();
    // 阶梯按曝光顺序列出
    expect(stripDurations(result.value)).toEqual([10, 15, 20, 25]);
    expect(result.state.tests).toHaveLength(1);
    // 纯函数：传入状态原封不动
    expect(before.tests).toHaveLength(0);
  });

  it('名称为空（含纯空白）拒绝创建且不写入', () => {
    const deps = testDeps();
    for (const name of ['', '   ']) {
      const result = createSafelightTest(
        EMPTY_SAFELIGHT,
        { name, startSeconds: '10', stepSeconds: '5', stripCount: '4' },
        deps,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('请输入测试名称');
    }
    expect(EMPTY_SAFELIGHT.tests).toHaveLength(0);
  });

  it('起始 / 递增秒数为空、非整数或非正整数时分别说明原因', () => {
    const deps = testDeps();
    const cases: Array<[Partial<Record<'startSeconds' | 'stepSeconds', string>>, string]> = [
      [{ startSeconds: '' }, '请输入起始秒数'],
      [{ startSeconds: 'abc' }, '起始秒数必须为整数，不能含小数或字母'],
      [{ startSeconds: '2.5' }, '起始秒数必须为整数，不能含小数或字母'],
      [{ startSeconds: '0' }, '起始秒数须为大于 0 的整数'],
      [{ startSeconds: '-3' }, '起始秒数须为大于 0 的整数'],
      [{ stepSeconds: '' }, '请输入递增秒数'],
      [{ stepSeconds: '1.5' }, '递增秒数必须为整数，不能含小数或字母'],
      [{ stepSeconds: '0' }, '递增秒数须为大于 0 的整数'],
    ];
    for (const [patch, message] of cases) {
      const result = createSafelightTest(
        EMPTY_SAFELIGHT,
        {
          name: '测试',
          startSeconds: '10',
          stepSeconds: '5',
          stripCount: '4',
          ...patch,
        },
        deps,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe(message);
      expect(EMPTY_SAFELIGHT.tests).toHaveLength(0);
    }
  });

  it('条带数量为空、非整数或超出 2–20 时分别说明原因', () => {
    const deps = testDeps();
    const cases: Array<[string, string]> = [
      ['', '请输入条带数量'],
      ['2.5', '条带数量必须为整数，不能含小数或字母'],
      ['abc', '条带数量必须为整数，不能含小数或字母'],
      ['0', '条带数量须为 2–20 的整数'],
      ['1', '条带数量须为 2–20 的整数'],
      ['21', '条带数量须为 2–20 的整数'],
    ];
    for (const [stripCount, message] of cases) {
      const result = createSafelightTest(
        EMPTY_SAFELIGHT,
        { name: '测试', startSeconds: '10', stepSeconds: '5', stripCount },
        deps,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe(message);
      expect(EMPTY_SAFELIGHT.tests).toHaveLength(0);
    }
    // 边界：2 与 20 均可创建
    for (const stripCount of ['2', '20']) {
      const result = createSafelightTest(
        EMPTY_SAFELIGHT,
        { name: '测试', startSeconds: '10', stepSeconds: '5', stripCount },
        deps,
      );
      expect(result.ok).toBe(true);
    }
  });

  it('末条曝光超过一小时拒绝创建；恰好一小时允许', () => {
    const deps = testDeps();
    const rejected = createSafelightTest(
      EMPTY_SAFELIGHT,
      { name: '测试', startSeconds: '3500', stepSeconds: '200', stripCount: '2' },
      deps,
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error).toBe(
        '末条曝光 3700 秒超过一小时上限（3600 秒），请缩短秒数或减少条带数量',
      );
    }
    expect(EMPTY_SAFELIGHT.tests).toHaveLength(0);

    const allowed = createSafelightTest(
      EMPTY_SAFELIGHT,
      { name: '测试', startSeconds: '3500', stepSeconds: '100', stripCount: '2' },
      deps,
    );
    expect(allowed.ok).toBe(true);
    if (allowed.ok) expect(lastStripSeconds(allowed.value)).toBe(3600);
  });

  it('超出安全整数范围的输入被拒绝，不写入且已有测试不受影响', () => {
    const deps = testDeps();
    const existing = mustCreate(
      EMPTY_SAFELIGHT,
      { name: '已有测试', startSeconds: '10', stepSeconds: '5', stripCount: '4' },
      deps,
    );
    const cases: Array<Partial<Record<'startSeconds' | 'stepSeconds' | 'stripCount', string>>> = [
      { startSeconds: '9'.repeat(400) },
      { stepSeconds: String(2 ** 53 + 1) },
      { stripCount: String(2 ** 60) },
    ];
    for (const patch of cases) {
      const result = createSafelightTest(
        existing.state,
        { name: '异常测试', startSeconds: '10', stepSeconds: '5', stripCount: '4', ...patch },
        deps,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('数值过大，无法精确记录，请填写较小的整数');
      // 失败不写入：原测试保留，异常数据绝不进入状态
      expect(existing.state.tests).toHaveLength(1);
      expect(existing.state.tests[0].name).toBe('已有测试');
    }
  });
});

describe('evaluateSafelightTest 命令与三种结论边界', () => {
  /** 阶梯 10/15/20/25 秒的草稿。 */
  function setup() {
    const deps = testDeps();
    const created = mustCreate(
      EMPTY_SAFELIGHT,
      { name: '红色安全灯', startSeconds: '10', stepSeconds: '5', stripCount: '4' },
      deps,
    );
    return { deps, test: created.value, state: created.state };
  }

  it('首条起雾为中间条（k ≥ 2）：安全上限 = 前一条时长', () => {
    const { deps, test, state } = setup();
    // 首条起雾为条带 3（20 秒）→ 安全上限 = 条带 2 的 15 秒
    const result = evaluateSafelightTest(state, { testId: test.id, firstFogStrip: 3 }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.evaluation).toEqual({
      firstFogStrip: 3,
      evaluatedAt: '2026-09-12T08:00:02.000Z',
    });
    expect(safelightStatus(result.value)).toBe('evaluated');
    expect(SAFELIGHT_STATUS_LABEL[safelightStatus(result.value)]).toBe('已完成');
    expect(conclusionOf(result.value)).toEqual({ kind: 'limit', safeSeconds: 15 });
    // 末条（条带 4）起雾 → 安全上限 = 条带 3 的 20 秒
    const last = evaluateSafelightTest(state, { testId: test.id, firstFogStrip: 4 }, deps);
    expect(last.ok).toBe(true);
    if (last.ok) expect(conclusionOf(last.value)).toEqual({ kind: 'limit', safeSeconds: 20 });
    // 条带 2 起雾 → 安全上限 = 起始值 10 秒
    const second = evaluateSafelightTest(state, { testId: test.id, firstFogStrip: 2 }, deps);
    expect(second.ok).toBe(true);
    if (second.ok) expect(conclusionOf(second.value)).toEqual({ kind: 'limit', safeSeconds: 10 });
  });

  it('首条即起雾：安全上限低于起始值', () => {
    const { deps, test, state } = setup();
    const result = evaluateSafelightTest(state, { testId: test.id, firstFogStrip: 1 }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(conclusionOf(result.value)).toEqual({ kind: 'below-start', startSeconds: 10 });
  });

  it('全部未起雾：安全时长至少达到末条时长', () => {
    const { deps, test, state } = setup();
    const result = evaluateSafelightTest(state, { testId: test.id, firstFogStrip: null }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(conclusionOf(result.value)).toEqual({ kind: 'at-least-last', lastSeconds: 25 });
  });

  it('测试不存在或重复评估时拒绝，不写入', () => {
    const { deps, test, state } = setup();
    const missing = evaluateSafelightTest(state, { testId: 'no-such-id', firstFogStrip: 2 }, deps);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toBe('测试不存在或已被移除');

    const evaluated = evaluateSafelightTest(state, { testId: test.id, firstFogStrip: 2 }, deps);
    expect(evaluated.ok).toBe(true);
    if (!evaluated.ok) return;
    const again = evaluateSafelightTest(
      evaluated.state,
      { testId: test.id, firstFogStrip: 3 },
      deps,
    );
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toBe('该测试已完成评估，结论不可修改');
    // 重复评估被拒绝：原结论保持不变
    expect(evaluated.state.tests[0].evaluation?.firstFogStrip).toBe(2);
  });

  it('观察结果不是本次测试的条带时拒绝，不写入', () => {
    const { deps, test, state } = setup();
    for (const firstFogStrip of [0, 5, 1.5, Number.POSITIVE_INFINITY]) {
      const result = evaluateSafelightTest(state, { testId: test.id, firstFogStrip }, deps);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('观察结果无效：请选择本次测试中首条起雾的条带');
      // 失败不写入：仍是待评估草稿
      expect(state.tests[0].evaluation).toBeUndefined();
    }
  });

  it('评估结论与测试对象被冻结，命令不修改传入状态', () => {
    const { deps, test, state } = setup();
    const result = evaluateSafelightTest(state, { testId: test.id, firstFogStrip: 3 }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.evaluation)).toBe(true);
    // 传入状态中的原测试对象不被触碰：仍是草稿
    expect(state.tests[0]).toBe(test);
    expect(state.tests[0].evaluation).toBeUndefined();
    // 新状态中只有该测试被替换为已评估版本
    expect(result.state.tests).toHaveLength(1);
    expect(result.state.tests[0]).not.toBe(test);
    expect(result.state.tests[0].evaluation?.firstFogStrip).toBe(3);
  });

  it('多个测试各自独立评估，互不影响', () => {
    const deps = testDeps();
    const a = mustCreate(
      EMPTY_SAFELIGHT,
      { name: '测试 A', startSeconds: '10', stepSeconds: '5', stripCount: '4' },
      deps,
    );
    const b = mustCreate(
      a.state,
      { name: '测试 B', startSeconds: '20', stepSeconds: '10', stripCount: '3' },
      deps,
    );
    // 只评估 B：全部未起雾 → 至少达到末条 40 秒
    const evaluated = evaluateSafelightTest(
      b.state,
      { testId: b.value.id, firstFogStrip: null },
      deps,
    );
    expect(evaluated.ok).toBe(true);
    if (!evaluated.ok) return;
    const [testA, testB] = evaluated.state.tests;
    expect(safelightStatus(testA)).toBe('pending');
    expect(conclusionOf(testA)).toBeNull();
    expect(safelightStatus(testB)).toBe('evaluated');
    expect(conclusionOf(testB)).toEqual({ kind: 'at-least-last', lastSeconds: 40 });
  });
});
