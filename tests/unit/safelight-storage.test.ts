import { describe, expect, it } from 'vitest';
import {
  createSafelightTest,
  EMPTY_SAFELIGHT,
  evaluateSafelightTest,
  type SafelightDeps,
  type SafelightState,
} from '../../src/lib/safelightTest';
import { LEDGER_STORAGE_KEY } from '../../src/lib/ledgerStorage';
import {
  loadSafelightState,
  parseSafelightState,
  SAFELIGHT_STORAGE_KEY,
  saveSafelightState,
  serializeSafelightState,
} from '../../src/lib/safelightStorage';
import type { StorageLike } from '../../src/lib/ledgerStorage';

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

function memoryStorage(): StorageLike & { dump: () => Map<string, string> } {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    dump: () => data,
  };
}

/** 用命令构建一份含草稿与已完成结论的状态。 */
function buildState(): SafelightState {
  const deps = testDeps();
  const draft = createSafelightTest(
    EMPTY_SAFELIGHT,
    { name: '红色安全灯 1 米', startSeconds: '10', stepSeconds: '5', stripCount: '4' },
    deps,
  );
  if (!draft.ok) throw new Error('setup');
  const done = createSafelightTest(
    draft.state,
    { name: '绿色安全灯 2 米', startSeconds: '20', stepSeconds: '10', stripCount: '3' },
    deps,
  );
  if (!done.ok) throw new Error('setup');
  const evaluated = evaluateSafelightTest(
    done.state,
    { testId: done.value.id, firstFogStrip: 2 },
    deps,
  );
  if (!evaluated.ok) throw new Error('setup');
  return evaluated.state;
}

describe('安全灯测试持久化', () => {
  it('存储键独立于容量台账', () => {
    expect(SAFELIGHT_STORAGE_KEY).not.toBe(LEDGER_STORAGE_KEY);
  });

  it('序列化 → 解析往返后还原同一状态（草稿与已完成结论一致）', () => {
    const state = buildState();
    const restored = parseSafelightState(serializeSafelightState(state));
    expect(restored).not.toBeNull();
    expect(restored).toEqual(state);
    // 草稿保持待评估，已完成的结论原样还原
    expect(restored!.tests[0].evaluation).toBeUndefined();
    expect(restored!.tests[1].evaluation).toEqual({
      firstFogStrip: 2,
      evaluatedAt: '2026-09-12T08:00:03.000Z',
    });
  });

  it('写入存储 → 重新读取，模拟刷新后还原草稿与结论', () => {
    const storage = memoryStorage();
    const state = buildState();
    saveSafelightState(storage, state);
    expect(storage.dump().has(SAFELIGHT_STORAGE_KEY)).toBe(true);

    const loaded = loadSafelightState(storage);
    expect(loaded.corrupted).toBe(false);
    expect(loaded.state).toEqual(state);
  });

  it('空存储与未定义存储都返回空白且不报告损坏，写入未定义存储为空操作', () => {
    expect(loadSafelightState(memoryStorage())).toEqual({
      state: EMPTY_SAFELIGHT,
      corrupted: false,
    });
    expect(loadSafelightState(undefined)).toEqual({ state: EMPTY_SAFELIGHT, corrupted: false });
    expect(() => saveSafelightState(undefined, buildState())).not.toThrow();
  });

  it('JSON 损坏或结构不符时报告损坏并回退空白，不让异常数据进入界面', () => {
    const storage = memoryStorage();
    const badPayloads = [
      'not-json{',
      'null',
      '[]',
      '{}',
      '{"tests":{}}',
      // 空名称
      '{"tests":[{"id":"t1","name":"  ","startSeconds":10,"stepSeconds":5,"stripCount":4,"createdAt":"t"}]}',
      // 非正整数秒数
      '{"tests":[{"id":"t1","name":"x","startSeconds":0,"stepSeconds":5,"stripCount":4,"createdAt":"t"}]}',
      // 条带数量越界（少于 2 条）
      '{"tests":[{"id":"t1","name":"x","startSeconds":10,"stepSeconds":5,"stripCount":1,"createdAt":"t"}]}',
      // 末条曝光超过一小时：3500 + 200 = 3700
      '{"tests":[{"id":"t1","name":"x","startSeconds":3500,"stepSeconds":200,"stripCount":2,"createdAt":"t"}]}',
      // 评估结果指向不存在的条带
      '{"tests":[{"id":"t1","name":"x","startSeconds":10,"stepSeconds":5,"stripCount":4,"createdAt":"t","evaluation":{"firstFogStrip":5,"evaluatedAt":"t"}}]}',
      // 评估结果为 0（条带序号从 1 起）
      '{"tests":[{"id":"t1","name":"x","startSeconds":10,"stepSeconds":5,"stripCount":4,"createdAt":"t","evaluation":{"firstFogStrip":0,"evaluatedAt":"t"}}]}',
      // 评估缺少时间
      '{"tests":[{"id":"t1","name":"x","startSeconds":10,"stepSeconds":5,"stripCount":4,"createdAt":"t","evaluation":{"firstFogStrip":null}}]}',
      // startSeconds 为 null（超长数字 Infinity 被 JSON.stringify 后的形态）
      '{"tests":[{"id":"t1","name":"x","startSeconds":null,"stepSeconds":5,"stripCount":4,"createdAt":"t"}]}',
      // 两条测试共用同一 id：按 id 选中时永远只能打开第一条，其余无法正确打开
      '{"tests":[{"id":"t1","name":"甲","startSeconds":10,"stepSeconds":5,"stripCount":4,"createdAt":"t"},{"id":"t1","name":"乙","startSeconds":20,"stepSeconds":10,"stripCount":3,"createdAt":"t"}]}',
      // 空创建时间（含纯空白）
      '{"tests":[{"id":"t1","name":"x","startSeconds":10,"stepSeconds":5,"stripCount":4,"createdAt":""}]}',
      '{"tests":[{"id":"t1","name":"x","startSeconds":10,"stepSeconds":5,"stripCount":4,"createdAt":"   "}]}',
      // 空评估时间
      '{"tests":[{"id":"t1","name":"x","startSeconds":10,"stepSeconds":5,"stripCount":4,"createdAt":"t","evaluation":{"firstFogStrip":2,"evaluatedAt":""}}]}',
    ];
    for (const payload of badPayloads) {
      storage.setItem(SAFELIGHT_STORAGE_KEY, payload);
      expect(parseSafelightState(payload)).toBeNull();
      const loaded = loadSafelightState(storage);
      expect(loaded.corrupted).toBe(true);
      expect(loaded.state).toEqual(EMPTY_SAFELIGHT);
    }
  });

  it('重复 id 的存档整体视为损坏，即使每条记录各自结构完整', () => {
    const storage = memoryStorage();
    // 两条记录各自的字段都合法，但 id 重复：界面按 id 选中时永远只能打开第一条，
    // 第二条无法正确打开，因此整份数据不可信
    const payload = JSON.stringify({
      tests: [
        {
          id: 't1',
          name: '甲测试',
          startSeconds: 10,
          stepSeconds: 5,
          stripCount: 4,
          createdAt: '2026-09-12T08:00:00.000Z',
        },
        {
          id: 't1',
          name: '乙测试',
          startSeconds: 20,
          stepSeconds: 10,
          stripCount: 3,
          createdAt: '2026-09-12T09:00:00.000Z',
        },
      ],
    });
    expect(parseSafelightState(payload)).toBeNull();
    storage.setItem(SAFELIGHT_STORAGE_KEY, payload);
    const loaded = loadSafelightState(storage);
    expect(loaded.corrupted).toBe(true);
    expect(loaded.state).toEqual(EMPTY_SAFELIGHT);
  });

  it('全部未起雾（firstFogStrip 为 null）的结论是合法数据，照常往返', () => {
    const deps = testDeps();
    const created = createSafelightTest(
      EMPTY_SAFELIGHT,
      { name: '测试', startSeconds: '10', stepSeconds: '5', stripCount: '4' },
      deps,
    );
    if (!created.ok) throw new Error('setup');
    const evaluated = evaluateSafelightTest(
      created.state,
      { testId: created.value.id, firstFogStrip: null },
      deps,
    );
    if (!evaluated.ok) throw new Error('setup');
    const restored = parseSafelightState(serializeSafelightState(evaluated.state));
    expect(restored).toEqual(evaluated.state);
    expect(restored!.tests[0].evaluation?.firstFogStrip).toBeNull();
  });

  it('待写入状态无法往返校验时拒绝写入，存储中的原有数据原样保留', () => {
    const storage = memoryStorage();
    const good = buildState();
    saveSafelightState(storage, good);
    const jsonBefore = storage.dump().get(SAFELIGHT_STORAGE_KEY);
    expect(jsonBefore).toBeDefined();

    // 绕过命令手工构造异常状态（模拟超长秒数解析为 Infinity / null 的脏数据）
    const dirty: SafelightState = {
      tests: [
        ...good.tests,
        {
          id: 'dirty',
          name: '异常测试',
          startSeconds: Number.POSITIVE_INFINITY,
          stepSeconds: 5,
          stripCount: 4,
          createdAt: '2026-09-12T00:00:00.000Z',
        },
      ],
    };
    expect(parseSafelightState(JSON.stringify(dirty))).toBeNull();
    saveSafelightState(storage, dirty);

    // 异常写入被拒绝：旧文档未被覆盖，刷新后仍是原来的完整数据
    expect(storage.dump().get(SAFELIGHT_STORAGE_KEY)).toBe(jsonBefore);
    expect(loadSafelightState(storage).state).toEqual(good);
  });

  it('读回的状态可继续走命令：刷新后接着评估草稿', () => {
    const storage = memoryStorage();
    const deps = testDeps();
    const created = createSafelightTest(
      EMPTY_SAFELIGHT,
      { name: '测试', startSeconds: '10', stepSeconds: '5', stripCount: '4' },
      deps,
    );
    if (!created.ok) throw new Error('setup');
    saveSafelightState(storage, created.state);

    // 模拟「刷新 → 评估 → 保存」：从存储还原草稿再完成评估
    const restored = loadSafelightState(storage);
    expect(restored.corrupted).toBe(false);
    const evaluated = evaluateSafelightTest(
      restored.state,
      { testId: created.value.id, firstFogStrip: 3 },
      deps,
    );
    expect(evaluated.ok).toBe(true);
    if (!evaluated.ok) return;
    saveSafelightState(storage, evaluated.state);

    const finalLoad = loadSafelightState(storage);
    expect(finalLoad.state.tests[0].evaluation?.firstFogStrip).toBe(3);
  });
});
