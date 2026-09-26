import { describe, expect, it } from 'vitest';
import {
  batchStatus,
  createBatch,
  EMPTY_LEDGER,
  hasConsistentCapacityTrajectory,
  recordUsage,
  remainingCapacity,
  type LedgerDeps,
  type LedgerState,
} from '../../src/lib/capacityLedger';
import {
  commitLedger,
  LEDGER_STORAGE_KEY,
  loadLedger,
  loadLedgerDocument,
  parseLedger,
  parseLedgerDocument,
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

describe('容量轨迹一致性（异常存档与合法旧档）', () => {
  /** 三种轨迹自相矛盾的存档：逐字段类型都合法，但容量轨迹不可信。 */
  const ANOMALOUS_ARCHIVES: Array<[string, string]> = [
    [
      '两个同 id、不同额定容量的批次（同一组记录被套到两个容量上）',
      JSON.stringify({
        batches: [
          { id: 'dup-batch', name: '显影液（甲）', capacity: 10, createdAt: '2026-09-01T08:00:00.000Z' },
          { id: 'dup-batch', name: '显影液（乙）', capacity: 20, createdAt: '2026-09-01T08:05:00.000Z' },
        ],
        records: [
          { id: 'r1', batchId: 'dup-batch', films: 4, note: '', remainingAfter: 6, createdAt: '2026-09-02T09:00:00.000Z' },
        ],
        revision: 2,
      }),
    ],
    [
      '累计用量超过额定容量的批次（负余量）',
      JSON.stringify({
        batches: [{ id: 'b1', name: '超用批次', capacity: 5, createdAt: '2026-09-01T08:00:00.000Z' }],
        records: [
          { id: 'r1', batchId: 'b1', films: 4, note: '', remainingAfter: 1, createdAt: '2026-09-02T09:00:00.000Z' },
          { id: 'r2', batchId: 'b1', films: 3, note: '', remainingAfter: 0, createdAt: '2026-09-03T09:00:00.000Z' },
        ],
      }),
    ],
    [
      '记录的登记后剩余量与累计用量不符（历史明细与批次汇总矛盾）',
      JSON.stringify({
        batches: [{ id: 'b1', name: '矛盾批次', capacity: 10, createdAt: '2026-09-01T08:00:00.000Z' }],
        records: [
          { id: 'r1', batchId: 'b1', films: 3, note: '', remainingAfter: 7, createdAt: '2026-09-02T09:00:00.000Z' },
          { id: 'r2', batchId: 'b1', films: 2, note: '', remainingAfter: 4, createdAt: '2026-09-03T09:00:00.000Z' },
        ],
        revision: 1,
      }),
    ],
  ];

  it.each(ANOMALOUS_ARCHIVES)('异常存档不可信：%s', (_label, payload) => {
    // 逐字段类型合法，但轨迹校验拒绝：解析与文档解析都返回 null
    expect(parseLedger(payload)).toBeNull();
    expect(parseLedgerDocument(payload)).toBeNull();

    const storage = memoryStorage();
    storage.setItem(LEDGER_STORAGE_KEY, payload);
    // 加载视为损坏：报告 corrupted，台账回退为空，不作为可写台账
    const load = loadLedgerDocument(storage);
    expect(load.ok).toBe(false);
    if (!load.ok) expect(load.corrupted).toBe(true);
    expect(load.doc).toEqual({ ledger: EMPTY_LEDGER, revision: 0 });
    expect(loadLedger(storage)).toEqual(EMPTY_LEDGER);
  });

  it.each(ANOMALOUS_ARCHIVES)('异常存档不被普通操作覆盖：%s', (_label, payload) => {
    const storage = memoryStorage();
    storage.setItem(LEDGER_STORAGE_KEY, payload);
    const deps = testDeps();

    // 创建批次被拒绝：存储原文一个字节都不变
    const created = commitLedger(
      storage,
      loadLedgerDocument(storage).doc,
      { type: 'createBatch', input: { name: '新批次', capacity: '8' } },
      deps,
    );
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.kind).toBe('corrupted');
    expect(storage.dump().get(LEDGER_STORAGE_KEY)).toBe(payload);

    // 登记用量同样被拒绝（即便指向存档中的批次 id），原文保持不动
    const recorded = commitLedger(
      storage,
      loadLedgerDocument(storage).doc,
      { type: 'recordUsage', input: { batchId: 'b1', films: '1' } },
      deps,
    );
    expect(recorded.ok).toBe(false);
    if (!recorded.ok) expect(recorded.kind).toBe('corrupted');
    expect(storage.dump().get(LEDGER_STORAGE_KEY)).toBe(payload);
  });

  it('待写入状态轨迹不一致时，saveLedger 拒绝写入并保留原文', () => {
    const storage = memoryStorage();
    const good = buildLedger();
    saveLedger(storage, good);
    const before = storage.dump().get(LEDGER_STORAGE_KEY);

    // 手工构造「登记后剩余量与累计不符」的脏状态（模拟旧版异常写出的台账）
    const dirty: LedgerState = {
      batches: good.batches,
      records: good.records.map((record, index) =>
        index === 0 ? { ...record, remainingAfter: record.remainingAfter + 1 } : record,
      ),
    };
    expect(hasConsistentCapacityTrajectory(dirty)).toBe(false);
    saveLedger(storage, dirty);
    expect(storage.dump().get(LEDGER_STORAGE_KEY)).toBe(before);
    expect(loadLedger(storage)).toEqual(good);
  });

  it('类型合法且容量轨迹一致的旧版无修订号存档正常恢复，登记后刷新还原同一台账', () => {
    // 旧版存档：无 revision、无快照；两批三条记录，轨迹完全一致
    const legacy = JSON.stringify({
      batches: [
        { id: 'legacy-dev', name: '旧版显影液', capacity: 10, createdAt: '2026-09-01T08:00:00.000Z' },
        { id: 'legacy-fix', name: '旧版定影液', capacity: 5, createdAt: '2026-09-01T08:05:00.000Z' },
      ],
      records: [
        { id: 'r1', batchId: 'legacy-dev', films: 4, note: '4 卷 135', remainingAfter: 6, createdAt: '2026-09-02T09:00:00.000Z' },
        { id: 'r2', batchId: 'legacy-fix', films: 2, note: '', remainingAfter: 3, createdAt: '2026-09-02T10:00:00.000Z' },
        { id: 'r3', batchId: 'legacy-dev', films: 6, note: '', remainingAfter: 0, createdAt: '2026-09-03T09:00:00.000Z' },
      ],
    });
    const storage = memoryStorage();
    storage.setItem(LEDGER_STORAGE_KEY, legacy);

    // 正常恢复：修订号按 0 兼容，派生状态由同一轨迹给出
    const load = loadLedgerDocument(storage);
    expect(load.ok).toBe(true);
    expect(load.doc.revision).toBe(0);
    const [developer, fixer] = load.doc.ledger.batches;
    expect(remainingCapacity(developer, load.doc.ledger)).toBe(0);
    expect(batchStatus(developer, load.doc.ledger)).toBe('exhausted');
    expect(remainingCapacity(fixer, load.doc.ledger)).toBe(3);
    expect(batchStatus(fixer, load.doc.ledger)).toBe('active');

    // 在旧档上登记：首次提交升级为带修订号文档，旧记录原样保留在前
    const deps = testDeps();
    const outcome = commitLedger(
      storage,
      load.doc,
      { type: 'recordUsage', input: { batchId: 'legacy-fix', films: '1', note: '交接班登记' } },
      deps,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.doc.revision).toBe(1);

    // 模拟刷新：还原同一台账，记录集合、顺序与剩余量轨迹一致
    const restored = loadLedgerDocument(storage);
    expect(restored.ok).toBe(true);
    expect(restored.doc).toEqual(outcome.doc);
    expect(restored.doc.ledger.records.map((record) => record.films)).toEqual([4, 2, 6, 1]);
    expect(restored.doc.ledger.records.map((record) => record.remainingAfter)).toEqual([6, 3, 0, 2]);
    expect(restored.doc.ledger.records[3].note).toBe('交接班登记');
    expect(remainingCapacity(fixer, restored.doc.ledger)).toBe(2);
  });
});
