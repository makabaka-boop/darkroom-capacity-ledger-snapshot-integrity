import { describe, expect, it } from 'vitest';
import {
  createBatch,
  EMPTY_LEDGER,
  hasConsistentCapacityTrajectory,
  recordUsage,
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
  serializeLedger,
  type StorageLike,
} from '../../src/lib/ledgerStorage';

/**
 * 存档容量轨迹完整性：旧浏览器保存的台账可能带有
 * 「同 id 不同容量的批次」「累计用量超额定容量」「登记后剩余量与累计不符」
 * 三类异常。这些存档不得作为可信台账加载，也不得被普通操作覆盖；
 * 类型合法且轨迹一致的旧版（无 revision）存档仍应正常恢复。
 */

function testDeps(): LedgerDeps {
  let counter = 0;
  return {
    now: () => {
      counter += 1;
      return new Date(Date.UTC(2026, 8, 26, 12, 0, 0) + counter * 1000);
    },
    nextId: () => `test-id-${counter}`,
  };
}

interface TestStorage extends StorageLike {
  raw(): string | null;
}

function memoryStorage(initial?: Record<string, string>): TestStorage {
  const data = new Map<string, string>(initial ? Object.entries(initial) : []);
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    raw: () => data.get(LEDGER_STORAGE_KEY) ?? null,
  };
}

function batch(id: string, capacity: number, name = `批次 ${id}`) {
  return { id, name, capacity, createdAt: '2026-09-01T08:00:00.000Z' };
}

function record(id: string, batchId: string, films: number, remainingAfter: number) {
  return {
    id,
    batchId,
    films,
    note: '',
    remainingAfter,
    createdAt: '2026-09-01T09:00:00.000Z',
  };
}

/** 异常存档一：两个同 id、不同额定容量的批次共享同一组记录。 */
const DUPLICATE_ID_ARCHIVE = JSON.stringify({
  batches: [batch('dup', 10, '显影液（卡 A）'), batch('dup', 20, '显影液（卡 B）')],
  records: [record('dup-r1', 'dup', 4, 6)],
  revision: 3,
});

/** 异常存档二：记录用量总和（8 + 6 = 14）超过额定容量 10。 */
const OVER_USED_ARCHIVE = JSON.stringify({
  batches: [batch('over', 10, '定影液')],
  records: [record('over-r1', 'over', 8, 2), record('over-r2', 'over', 6, 0)],
});

/** 异常存档三：第二条记录的登记后剩余量（5）与累计用量（4 + 3 → 应剩 3）不符。 */
const DRIFTED_REMAINING_ARCHIVE = JSON.stringify({
  batches: [batch('drift', 10, '停显液')],
  records: [record('drift-r1', 'drift', 4, 6), record('drift-r2', 'drift', 3, 5)],
});

/** 合法旧档：无 revision、无快照字段，容量轨迹一致。 */
const LEGACY_VALID_ARCHIVE = JSON.stringify({
  batches: [batch('legacy', 10, '旧版显影液')],
  records: [record('legacy-r1', 'legacy', 4, 6), record('legacy-r2', 'legacy', 6, 0)],
});

describe('容量轨迹一致性校验（hasConsistentCapacityTrajectory）', () => {
  it('命令产出的台账恒通过校验；空台账也通过', () => {
    expect(hasConsistentCapacityTrajectory(EMPTY_LEDGER)).toBe(true);
    const deps = testDeps();
    const created = createBatch(EMPTY_LEDGER, { name: '显影液', capacity: '10' }, deps);
    if (!created.ok) throw new Error('setup');
    expect(hasConsistentCapacityTrajectory(created.state)).toBe(true);
    const recorded = recordUsage(created.state, { batchId: created.value.id, films: '4' }, deps);
    if (!recorded.ok) throw new Error('setup');
    expect(hasConsistentCapacityTrajectory(recorded.state)).toBe(true);
  });

  it('同 id 批次、累计超额、剩余量漂移三种异常都被判定为不一致', () => {
    const duplicate: LedgerState = {
      batches: [
        { id: 'b', name: '卡 A', capacity: 10, createdAt: 't' },
        { id: 'b', name: '卡 B', capacity: 20, createdAt: 't' },
      ],
      records: [],
    };
    expect(hasConsistentCapacityTrajectory(duplicate)).toBe(false);

    const overUsed: LedgerState = {
      batches: [{ id: 'b', name: 'x', capacity: 10, createdAt: 't' }],
      records: [
        { id: 'r1', batchId: 'b', films: 8, note: '', remainingAfter: 2, createdAt: 't' },
        { id: 'r2', batchId: 'b', films: 6, note: '', remainingAfter: 0, createdAt: 't' },
      ],
    };
    expect(hasConsistentCapacityTrajectory(overUsed)).toBe(false);

    const drifted: LedgerState = {
      batches: [{ id: 'b', name: 'x', capacity: 10, createdAt: 't' }],
      records: [
        { id: 'r1', batchId: 'b', films: 4, note: '', remainingAfter: 6, createdAt: 't' },
        { id: 'r2', batchId: 'b', films: 3, note: '', remainingAfter: 5, createdAt: 't' },
      ],
    };
    expect(hasConsistentCapacityTrajectory(drifted)).toBe(false);
  });
});

describe('异常存档不作为可信台账加载', () => {
  const archives = [
    ['同 id 不同容量的两个批次', DUPLICATE_ID_ARCHIVE],
    ['累计用量超过额定容量', OVER_USED_ARCHIVE],
    ['登记后剩余量与累计用量不符', DRIFTED_REMAINING_ARCHIVE],
  ] as const;

  for (const [label, payload] of archives) {
    it(`${label}：解析拒绝、读取报告 corrupted、提交被拒且原文不被覆盖`, () => {
      expect(parseLedger(payload)).toBeNull();
      expect(parseLedgerDocument(payload)).toBeNull();

      const storage = memoryStorage({ [LEDGER_STORAGE_KEY]: payload });
      const load = loadLedgerDocument(storage);
      expect(load.ok).toBe(false);
      // 旧入口兼容：异常视为空台账，绝不让异常进入界面
      expect(loadLedger(storage)).toEqual(EMPTY_LEDGER);

      // 任何提交（新建批次 / 登记用量）都被拒绝，异常档不作为可写台账
      const created = commitLedger(
        storage,
        load.doc,
        { type: 'createBatch', input: { name: '新批次', capacity: '5' } },
        testDeps(),
      );
      expect(created.ok).toBe(false);
      if (!created.ok) expect(created.kind).toBe('corrupted');

      const recorded = commitLedger(
        storage,
        load.doc,
        { type: 'recordUsage', input: { batchId: 'dup', films: '1' } },
        testDeps(),
      );
      expect(recorded.ok).toBe(false);
      if (!recorded.ok) expect(recorded.kind).toBe('corrupted');

      // 原始存储一个字节都不变：异常档不被普通操作覆盖
      expect(storage.raw()).toBe(payload);
    });
  }
});

describe('合法旧版存档（无 revision、容量轨迹一致）', () => {
  it('正常恢复：按 revision 0 读入，批次与记录原样还原', () => {
    const storage = memoryStorage({ [LEDGER_STORAGE_KEY]: LEGACY_VALID_ARCHIVE });
    const load = loadLedgerDocument(storage);
    expect(load.ok).toBe(true);
    expect(load.doc.revision).toBe(0);
    expect(load.doc.ledger.batches).toHaveLength(1);
    expect(load.doc.ledger.records.map((r) => r.remainingAfter)).toEqual([6, 0]);
  });

  it('首次提交升级为带修订号文档，旧记录原样保留且轨迹延续', () => {
    const storage = memoryStorage({ [LEDGER_STORAGE_KEY]: LEGACY_VALID_ARCHIVE });
    const deps = testDeps();
    const page = loadLedgerDocument(storage);
    if (!page.ok) throw new Error('setup');

    // 旧档已恰好耗尽（10 = 4 + 6）：继续登记被领域规则拒绝，余量不为负
    const rejected = commitLedger(
      storage,
      page.doc,
      { type: 'recordUsage', input: { batchId: 'legacy', films: '1' } },
      deps,
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.kind).toBe('rejected');
    expect(storage.raw()).toBe(LEGACY_VALID_ARCHIVE);

    // 新建批次可正常落账：旧记录保留，revision 升级
    const created = commitLedger(
      storage,
      page.doc,
      { type: 'createBatch', input: { name: '新定影液', capacity: '5' } },
      deps,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.doc.revision).toBe(1);
    const raw = JSON.parse(storage.raw()!);
    expect(raw.revision).toBe(1);
    expect(raw.batches).toHaveLength(2);
    expect(raw.records.map((r: { films: number }) => r.films)).toEqual([4, 6]);
    // 升级后的文档仍通过轨迹校验，刷新可原样恢复
    expect(parseLedgerDocument(storage.raw()!)).not.toBeNull();
  });

  it('命令产出的状态序列化后恒通过轨迹校验（往返不会误伤正常台账）', () => {
    const deps = testDeps();
    let state = EMPTY_LEDGER;
    const created = createBatch(state, { name: '显影液', capacity: '3' }, deps);
    if (!created.ok) throw new Error('setup');
    state = created.state;
    for (const films of ['1', '2']) {
      const recorded = recordUsage(state, { batchId: created.value.id, films }, deps);
      if (!recorded.ok) throw new Error('setup');
      state = recorded.state;
    }
    const restored = parseLedger(serializeLedger(state));
    expect(restored).toEqual(state);
  });
});
