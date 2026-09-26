import { describe, expect, it } from 'vitest';
import {
  batchStatus,
  createBatch,
  EMPTY_LEDGER,
  recordUsage,
  remainingCapacity,
  type LedgerDeps,
  type LedgerState,
} from '../../src/lib/capacityLedger';
import {
  LEDGER_STORAGE_KEY,
  loadLedger,
  parseLedger,
  saveLedger,
  serializeLedger,
  type StorageLike,
} from '../../src/lib/ledgerStorage';

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

/** 用命令构建一份含两个批次、三条记录的台账。 */
function buildLedger(): LedgerState {
  const deps = testDeps();
  const a = createBatch(EMPTY_LEDGER, { name: 'D-76 显影液', capacity: '10' }, deps);
  if (!a.ok) throw new Error('setup');
  const b = createBatch(a.state, { name: '定影液', capacity: '5' }, deps);
  if (!b.ok) throw new Error('setup');
  let state = b.state;
  for (const [batchId, films, note] of [
    [a.value.id, '4', '4 卷 135'],
    [a.value.id, '6', ''],
    [b.value.id, '2', '2 卷 120'],
  ] as const) {
    const result = recordUsage(state, { batchId, films, note }, deps);
    if (!result.ok) throw new Error('setup');
    state = result.state;
  }
  return state;
}

describe('容量台账持久化', () => {
  it('序列化 → 解析往返后还原同一台账（批次、记录、派生状态一致）', () => {
    const state = buildLedger();
    const restored = parseLedger(serializeLedger(state));
    expect(restored).not.toBeNull();
    expect(restored).toEqual(state);
    // 派生量一致：显影液恰好耗尽，定影液仍在用
    const [developer, fixer] = restored!.batches;
    expect(remainingCapacity(developer, restored!)).toBe(0);
    expect(batchStatus(developer, restored!)).toBe('exhausted');
    expect(remainingCapacity(fixer, restored!)).toBe(3);
    expect(batchStatus(fixer, restored!)).toBe('active');
  });

  it('写入存储 → 重新读取，模拟刷新后还原同一台账', () => {
    const storage = memoryStorage();
    const state = buildLedger();
    saveLedger(storage, state);
    expect(storage.dump().has(LEDGER_STORAGE_KEY)).toBe(true);

    const restored = loadLedger(storage);
    expect(restored).toEqual(state);
    expect(restored.records).toHaveLength(3);
    // 记录内容（含写入时算好的剩余量）原样还原
    expect(restored.records.map((record) => record.remainingAfter)).toEqual([6, 0, 3]);
  });

  it('空存储与未定义存储都返回空台账，写入未定义存储为空操作', () => {
    expect(loadLedger(memoryStorage())).toEqual(EMPTY_LEDGER);
    expect(loadLedger(undefined)).toEqual(EMPTY_LEDGER);
    expect(() => saveLedger(undefined, buildLedger())).not.toThrow();
  });

  it('JSON 损坏或结构不符时视为空台账，不让异常数据进入界面', () => {
    const storage = memoryStorage();
    const badPayloads = [
      'not-json{',
      'null',
      '[]',
      '{}',
      '{"batches":[],"records":{}}',
      // 记录挂在不存在的批次上
      '{"batches":[],"records":[{"id":"r1","batchId":"ghost","films":1,"note":"","remainingAfter":0,"createdAt":"x"}]}',
      // 负剩余量
      '{"batches":[{"id":"b1","name":"x","capacity":10,"createdAt":"t"}],"records":[{"id":"r1","batchId":"b1","films":1,"note":"","remainingAfter":-1,"createdAt":"t"}]}',
      // 非整数用量
      '{"batches":[{"id":"b1","name":"x","capacity":10,"createdAt":"t"}],"records":[{"id":"r1","batchId":"b1","films":1.5,"note":"","remainingAfter":8,"createdAt":"t"}]}',
      // 空名称批次
      '{"batches":[{"id":"b1","name":"  ","capacity":10,"createdAt":"t"}],"records":[]}',
      // capacity 为 null（超长数字 Infinity 被 JSON.stringify 后的形态）
      '{"batches":[{"id":"b1","name":"超长批次","capacity":null,"createdAt":"t"}],"records":[]}',
      // capacity 超出安全整数范围（精度已丢失）
      `{"batches":[{"id":"b1","name":"超长批次","capacity":${2 ** 54},"createdAt":"t"}],"records":[]}`,
      // remainingAfter 超出安全整数范围
      '{"batches":[{"id":"b1","name":"x","capacity":10,"createdAt":"t"}],"records":[{"id":"r1","batchId":"b1","films":1,"note":"","remainingAfter":9007199254740993,"createdAt":"t"}]}',
    ];
    for (const payload of badPayloads) {
      storage.setItem(LEDGER_STORAGE_KEY, payload);
      expect(parseLedger(payload)).toBeNull();
      expect(loadLedger(storage)).toEqual(EMPTY_LEDGER);
    }
  });

  it('待写入状态无法往返校验时拒绝写入，存储中的原有台账原样保留', () => {
    const storage = memoryStorage();
    const good = buildLedger();
    saveLedger(storage, good);
    const jsonBefore = storage.dump().get(LEDGER_STORAGE_KEY);
    expect(jsonBefore).toBeDefined();

    // 绕过命令手工构造异常状态（模拟超长容量解析为 Infinity / null 的脏数据）
    const dirty: LedgerState = {
      batches: [
        ...good.batches,
        {
          id: 'dirty',
          name: '异常批次',
          capacity: Number.POSITIVE_INFINITY,
          createdAt: '2026-09-12T00:00:00.000Z',
        },
      ],
      records: good.records,
    };
    expect(parseLedger(JSON.stringify(dirty))).toBeNull();
    saveLedger(storage, dirty);

    // 异常写入被拒绝：旧文档未被覆盖，刷新后仍是原来的完整台账
    expect(storage.dump().get(LEDGER_STORAGE_KEY)).toBe(jsonBefore);
    expect(loadLedger(storage)).toEqual(good);
  });

  it('台账只通过命令增长：读回的状态可继续登记且剩余量连续', () => {    const storage = memoryStorage();
    const deps = testDeps();
    const created = createBatch(EMPTY_LEDGER, { name: '显影液', capacity: '3' }, deps);
    if (!created.ok) throw new Error('setup');
    saveLedger(storage, created.state);

    // 模拟三次「刷新 → 登记 → 保存」：每次都从存储还原再继续
    for (const films of ['1', '1', '1']) {
      const restored = loadLedger(storage);
      const result = recordUsage(restored, { batchId: created.value.id, films }, deps);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      saveLedger(storage, result.state);
    }
    const finalState = loadLedger(storage);
    expect(remainingCapacity(created.value, finalState)).toBe(0);
    expect(batchStatus(created.value, finalState)).toBe('exhausted');
    // 已耗尽后第四次登记被拒绝
    const rejected = recordUsage(finalState, { batchId: created.value.id, films: '1' }, deps);
    expect(rejected.ok).toBe(false);
  });
});
