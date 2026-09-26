import { describe, expect, it } from 'vitest';
import { computeMix } from '../../src/lib/dilution';
import {
  createBatch,
  EMPTY_LEDGER,
  isMixSourceSnapshot,
  recordUsage,
  remainingCapacity,
  type LedgerDeps,
  type MixSourceSnapshot,
} from '../../src/lib/capacityLedger';
import {
  LEDGER_STORAGE_KEY,
  loadLedger,
  parseLedger,
  saveLedger,
  serializeLedger,
  type StorageLike,
} from '../../src/lib/ledgerStorage';

/** 确定性依赖：时间逐秒递增，id 递增，便于断言与复现。 */
function testDeps(): LedgerDeps {
  let counter = 0;
  return {
    now: () => {
      counter += 1;
      return new Date(Date.UTC(2026, 8, 10, 12, 0, 0) + counter * 1000);
    },
    nextId: () => `test-id-${counter}`,
  };
}

function memoryStorage(): StorageLike {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

/** 与界面相同的构造方式：从同一次 computeMix 结果逐字段拷贝快照。 */
function snapshotFromMix(raw: { n: number; total: number; capacity: number; tanks: number }) {
  const mix = computeMix(raw);
  const mixSource: MixSourceSnapshot = {
    n: mix.n,
    total: mix.total,
    capacity: mix.capacity,
    tanks: mix.tanks,
    concentrate: mix.concentrate,
    water: mix.water,
  };
  return { mix, mixSource };
}

describe('配液来源快照（领域命令）', () => {
  it('快照取自同一次计算：createBatch 原样固定保存 computeMix 当次结果', () => {
    const { mix, mixSource } = snapshotFromMix({ n: 4, total: 1000, capacity: 250, tanks: 3 });
    const deps = testDeps();
    const created = createBatch(
      EMPTY_LEDGER,
      { name: 'D-76 显影液', capacity: '12', mixSource },
      deps,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    // 与当次计算结果逐字段一致（不是重算值，也不是旧参数残留）
    expect(created.value.mixSource).toEqual({
      n: mix.n,
      total: mix.total,
      capacity: mix.capacity,
      tanks: mix.tanks,
      concentrate: mix.concentrate,
      water: mix.water,
    });
    expect(created.value.mixSource).toEqual({
      n: 4,
      total: 1000,
      capacity: 250,
      tanks: 3,
      concentrate: 200,
      water: 800,
    });
  });

  it('快照在创建时逐字段拷贝并冻结：之后修改传入对象不影响已存批次', () => {
    const { mixSource } = snapshotFromMix({ n: 4, total: 1000, capacity: 250, tanks: 1 });
    const deps = testDeps();
    const created = createBatch(EMPTY_LEDGER, { name: '显影液', capacity: '10', mixSource }, deps);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(Object.isFrozen(created.value.mixSource)).toBe(true);
    // 修改传入对象不回溯到批次里的快照
    mixSource.total = 9999;
    mixSource.concentrate = 1;
    expect(created.value.mixSource?.total).toBe(1000);
    expect(created.value.mixSource?.concentrate).toBe(200);
  });

  it('手工创建（不带快照）保持原行为：批次没有 mixSource 字段', () => {
    const deps = testDeps();
    const created = createBatch(EMPTY_LEDGER, { name: '定影液', capacity: '5' }, deps);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect('mixSource' in created.value).toBe(false);
    expect(created.value.mixSource).toBeUndefined();
  });

  it('快照结构不完整或违反「浓缩液 + 清水 = 目标总量」时拒绝创建且不写入', () => {
    const deps = testDeps();
    const badSnapshots: unknown[] = [
      // 缺字段
      { n: 4, total: 1000, capacity: 250, tanks: 3, concentrate: 200 },
      // 浓缩液 + 清水 ≠ 目标总量
      { n: 4, total: 1000, capacity: 250, tanks: 3, concentrate: 200, water: 799 },
      // 非正整数
      { n: 0, total: 1000, capacity: 250, tanks: 1, concentrate: 500, water: 500 },
      // 非整数
      { n: 4, total: 1000.5, capacity: 250, tanks: 1, concentrate: 200, water: 800 },
      // 非对象
      '1+4',
      null,
    ];
    for (const snapshot of badSnapshots) {
      const result = createBatch(
        EMPTY_LEDGER,
        { name: '显影液', capacity: '10', mixSource: snapshot as MixSourceSnapshot },
        deps,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('配液来源数据不完整，请重新计算后再存入');
      // 失败不写入：状态保持原样
      expect(EMPTY_LEDGER.batches).toHaveLength(0);
    }
  });

  it('带快照的批次仍可正常登记用量，快照不受登记影响', () => {
    const { mixSource } = snapshotFromMix({ n: 4, total: 1000, capacity: 250, tanks: 1 });
    const deps = testDeps();
    const created = createBatch(EMPTY_LEDGER, { name: '显影液', capacity: '10', mixSource }, deps);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const recorded = recordUsage(created.state, { batchId: created.value.id, films: '4' }, deps);
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    expect(remainingCapacity(created.value, recorded.state)).toBe(6);
    expect(recorded.state.batches[0].mixSource).toEqual({
      n: 4,
      total: 1000,
      capacity: 250,
      tanks: 1,
      concentrate: 200,
      water: 800,
    });
  });
});

describe('isMixSourceSnapshot 结构校验', () => {
  it('接受完整快照（浓缩液 + 清水 = 目标总量）', () => {
    expect(
      isMixSourceSnapshot({ n: 4, total: 1000, capacity: 250, tanks: 3, concentrate: 200, water: 800 }),
    ).toBe(true);
  });

  it('拒绝缺字段、非整数、非正数与总量不守恒的快照', () => {
    expect(isMixSourceSnapshot(undefined)).toBe(false);
    expect(isMixSourceSnapshot({})).toBe(false);
    expect(
      isMixSourceSnapshot({ n: 4, total: 1000, capacity: 250, tanks: 1, concentrate: 200 }),
    ).toBe(false);
    expect(
      isMixSourceSnapshot({ n: 4, total: 1000, capacity: 250, tanks: 1.5, concentrate: 200, water: 800 }),
    ).toBe(false);
    expect(
      isMixSourceSnapshot({ n: 4, total: 1000, capacity: 250, tanks: 1, concentrate: 0, water: 1000 }),
    ).toBe(false);
    expect(
      isMixSourceSnapshot({ n: 4, total: 1000, capacity: 250, tanks: 1, concentrate: 201, water: 800 }),
    ).toBe(false);
  });
});

describe('配液来源快照（持久化）', () => {
  it('序列化 → 解析往返后快照原样还原', () => {
    const { mixSource } = snapshotFromMix({ n: 9, total: 2500, capacity: 400, tanks: 2 });
    const deps = testDeps();
    const created = createBatch(EMPTY_LEDGER, { name: '停显液', capacity: '20', mixSource }, deps);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const restored = parseLedger(serializeLedger(created.state));
    expect(restored).not.toBeNull();
    expect(restored).toEqual(created.state);
    expect(restored!.batches[0].mixSource).toEqual({
      n: 9,
      total: 2500,
      capacity: 400,
      tanks: 2,
      concentrate: 250,
      water: 2250,
    });
  });

  it('写入存储 → 重新读取，模拟刷新后来源摘要仍在', () => {
    const { mixSource } = snapshotFromMix({ n: 4, total: 1000, capacity: 250, tanks: 3 });
    const deps = testDeps();
    const created = createBatch(
      EMPTY_LEDGER,
      { name: 'D-76 显影液', capacity: '12', mixSource },
      deps,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const storage = memoryStorage();
    saveLedger(storage, created.state);
    const restored = loadLedger(storage);
    expect(restored.batches[0].mixSource).toEqual(created.value.mixSource);
  });

  it('旧格式存储（批次无 mixSource 字段）照常读取，且可继续登记用量', () => {
    const legacy = JSON.stringify({
      batches: [{ id: 'b1', name: '旧批次', capacity: 10, createdAt: '2026-01-01T00:00:00.000Z' }],
      records: [
        {
          id: 'r1',
          batchId: 'b1',
          films: 3,
          note: '',
          remainingAfter: 7,
          createdAt: '2026-01-02T00:00:00.000Z',
        },
      ],
    });
    const storage = memoryStorage();
    storage.setItem(LEDGER_STORAGE_KEY, legacy);

    const restored = loadLedger(storage);
    expect(restored.batches).toHaveLength(1);
    expect(restored.batches[0].mixSource).toBeUndefined();
    expect(restored.records).toHaveLength(1);

    // 旧台账继续走命令：登记到恰好耗尽
    const deps = testDeps();
    const recorded = recordUsage(restored, { batchId: 'b1', films: '7' }, deps);
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    expect(remainingCapacity(restored.batches[0], recorded.state)).toBe(0);
  });

  it('快照字段存在但结构损坏时，整份数据视为不可信', () => {
    const corrupt = JSON.stringify({
      batches: [
        {
          id: 'b1',
          name: '显影液',
          capacity: 10,
          createdAt: '2026-01-01T00:00:00.000Z',
          mixSource: { n: 4 },
        },
      ],
      records: [],
    });
    expect(parseLedger(corrupt)).toBeNull();
    const storage = memoryStorage();
    storage.setItem(LEDGER_STORAGE_KEY, corrupt);
    expect(loadLedger(storage)).toEqual(EMPTY_LEDGER);
  });
});
