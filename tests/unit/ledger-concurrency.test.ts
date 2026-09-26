import { describe, expect, it } from 'vitest';
import {
  batchStatus,
  createBatch,
  EMPTY_LEDGER,
  remainingCapacity,
  usedCapacity,
  type LedgerDeps,
} from '../../src/lib/capacityLedger';
import {
  commitLedger,
  LEDGER_STORAGE_KEY,
  loadLedger,
  loadLedgerDocument,
  parseLedger,
  parseLedgerDocument,
  serializeLedgerDocument,
  type LedgerDocument,
  type LedgerIntent,
  type StorageLike,
} from '../../src/lib/ledgerStorage';

/** 确定性依赖：时间逐秒递增，id 递增，便于断言与复现。 */
function testDeps(): LedgerDeps {
  let counter = 0;
  return {
    now: () => {
      counter += 1;
      return new Date(Date.UTC(2026, 8, 23, 12, 0, 0) + counter * 1000);
    },
    nextId: () => `test-id-${counter}`,
  };
}

interface TestStorage extends StorageLike {
  /** 让后续 setItem 全部抛错（模拟配额 / 安全策略拒绝） */
  failWrites(): void;
  /** 恢复写入 */
  recoverWrites(): void;
  /** 存储中的原始 JSON（未经解析） */
  raw(): string | null;
}

function memoryStorage(initial?: Record<string, string>): TestStorage {
  const data = new Map<string, string>(initial ? Object.entries(initial) : []);
  let failing = false;
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      if (failing) throw new Error('QuotaExceededError: mock quota');
      data.set(key, value);
    },
    failWrites: () => {
      failing = true;
    },
    recoverWrites: () => {
      failing = false;
    },
    raw: () => data.get(LEDGER_STORAGE_KEY) ?? null,
  };
}

/** 直接在存储中建立一个容量为 capacity 的批次，返回其 id（绕过页面文档）。 */
function seedBatch(storage: StorageLike, name: string, capacity: string, deps: LedgerDeps): string {
  const result = createBatch(loadLedger(storage), { name, capacity }, deps);
  if (!result.ok) throw new Error(`seed 失败：${result.error}`);
  const doc = loadLedgerDocument(storage).doc;
  storage.setItem(
    LEDGER_STORAGE_KEY,
    serializeLedgerDocument({ ledger: result.state, revision: doc.revision + 1 }),
  );
  return result.value.id;
}

/** 模拟页面刷新：重新从存储读取最新文档。 */
function reload(storage: StorageLike): LedgerDocument {
  return loadLedgerDocument(storage).doc;
}

describe('跨标签并发提交（commitLedger）', () => {
  it('修订号：成功提交 +1；领域拒绝与冲突都不改修订号、不写存储', () => {
    const storage = memoryStorage();
    const deps = testDeps();
    const page = reload(storage);
    expect(page.revision).toBe(0);

    const created = commitLedger(storage, page, { type: 'createBatch', input: { name: '显影液', capacity: '10' } }, deps);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.doc.revision).toBe(1);

    // 领域拒绝：修订号不变
    const rejected = commitLedger(
      storage,
      created.doc,
      { type: 'recordUsage', input: { batchId: 'x', films: '1' } },
      deps,
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.kind).toBe('rejected');
    if (!rejected.ok && rejected.kind === 'rejected') expect(rejected.doc.revision).toBe(1);
    expect(reload(storage).revision).toBe(1);

    // 冲突：旧基准 revision 0，存储已为 1
    const conflict = commitLedger(
      storage,
      { ledger: EMPTY_LEDGER, revision: 0 },
      { type: 'createBatch', input: { name: '旧页面', capacity: '5' } },
      deps,
    );
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.kind).toBe('conflict');
      expect(conflict.doc.revision).toBe(1);
    }
    expect(reload(storage).revision).toBe(1);
  });

  it('同批次：两个页面从同一剩余量交错提交，只有首个提交落账，冲突方刷新后按新余量重试', () => {
    const storage = memoryStorage();
    const deps = testDeps();
    const batchId = seedBatch(storage, 'D-76 显影液', '10', deps);
    // 两个标签页读取同一份旧状态（剩余 10、revision 1）
    const pageA = reload(storage);
    const pageB = reload(storage);
    expect(pageA).toEqual(pageB);

    // A 先登记 6：成功
    const a = commitLedger(
      storage,
      pageA,
      { type: 'recordUsage', input: { batchId, films: '6', note: 'A 页登记' } },
      deps,
    );
    expect(a.ok).toBe(true);
    if (!a.ok) return;

    // B 仍按过期余量 10 提交 6：修订号冲突，本次动作被整体拒绝
    const bStale = commitLedger(
      storage,
      pageB,
      { type: 'recordUsage', input: { batchId, films: '6', note: 'B 页登记' } },
      deps,
    );
    expect(bStale.ok).toBe(false);
    if (!bStale.ok && bStale.kind === 'conflict') {
      expect(bStale.error).toContain('其他页面');
      // 返回存储中的最新完整台账：A 的记录在、B 的记录不在
      expect(bStale.doc.ledger.records).toHaveLength(1);
      expect(bStale.doc.ledger.records[0].note).toBe('A 页登记');
    }
    // 原始存储内容：只有 A 一条记录，容量不为负
    const storedAfterConflict = parseLedger(storage.raw()!)!;
    expect(storedAfterConflict.records).toHaveLength(1);
    expect(storedAfterConflict.records[0].films).toBe(6);

    // B 刷新页面：看到 A 的登记与剩余 4
    const pageBFresh = reload(storage);
    const batch = pageBFresh.ledger.batches[0];
    expect(usedCapacity(pageBFresh.ledger, batchId)).toBe(6);
    expect(remainingCapacity(batch, pageBFresh.ledger)).toBe(4);

    // B 若仍提交 6：领域规则在最新台账上拒绝（超剩余容量），不落账
    const bOver = commitLedger(
      storage,
      pageBFresh,
      { type: 'recordUsage', input: { batchId, films: '6' } },
      deps,
    );
    expect(bOver.ok).toBe(false);
    if (!bOver.ok) expect(bOver.kind).toBe('rejected');

    // B 按新余量改登记 4：成功，批次恰好耗尽，两条记录都可追溯
    const b = commitLedger(
      storage,
      pageBFresh,
      { type: 'recordUsage', input: { batchId, films: '4', note: 'B 页登记' } },
      deps,
    );
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    const final = reload(storage);
    expect(final.ledger.records.map((r) => r.films)).toEqual([6, 4]);
    expect(final.ledger.records.map((r) => r.note)).toEqual(['A 页登记', 'B 页登记']);
    expect(final.ledger.records.map((r) => r.remainingAfter)).toEqual([4, 0]);
    expect(usedCapacity(final.ledger, batchId)).toBe(10);
    expect(batchStatus(batch, final.ledger)).toBe('exhausted');
  });

  it('不同批次：旧页面的提交不会回滚另一页面刚创建的批次与记录', () => {
    const storage = memoryStorage();
    const deps = testDeps();
    const batchA = seedBatch(storage, '显影液 A', '10', deps);
    // 两页都读到只有批次 A 的状态（revision 2）
    const pageA = reload(storage);
    const pageB = reload(storage);

    // B 页稍后创建新批次 B
    const createB = commitLedger(
      storage,
      pageB,
      { type: 'createBatch', input: { name: '定影液 B', capacity: '5' } },
      deps,
    );
    expect(createB.ok).toBe(true);
    if (!createB.ok) return;
    const batchB = createB.intent.result.ok ? createB.intent.result.value.id : '';
    // B 紧接着在自己的新批次上登记 2
    const recordB = commitLedger(
      storage,
      createB.doc,
      { type: 'recordUsage', input: { batchId: batchB, films: '2' } },
      deps,
    );
    expect(recordB.ok).toBe(true);

    // A 页用旧文档向批次 A 登记：冲突被拒，B 的批次与记录原样保留
    const staleA = commitLedger(
      storage,
      pageA,
      { type: 'recordUsage', input: { batchId: batchA, films: '3' } },
      deps,
    );
    expect(staleA.ok).toBe(false);
    if (!staleA.ok) expect(staleA.kind).toBe('conflict');
    const afterReject = reload(storage);
    expect(afterReject.ledger.batches.map((b) => b.name)).toEqual(['显影液 A', '定影液 B']);
    expect(afterReject.ledger.records).toHaveLength(1);
    expect(afterReject.ledger.records[0].batchId).toBe(batchB);

    // A 刷新后重试：两条记录共存，各自批次累计独立、容量均不为负
    const pageAFresh = reload(storage);
    const retryA = commitLedger(
      storage,
      pageAFresh,
      { type: 'recordUsage', input: { batchId: batchA, films: '3' } },
      deps,
    );
    expect(retryA.ok).toBe(true);
    const final = reload(storage);
    expect(final.ledger.records).toHaveLength(2);
    expect(usedCapacity(final.ledger, batchA)).toBe(3);
    expect(usedCapacity(final.ledger, batchB)).toBe(2);
    for (const b of final.ledger.batches) {
      expect(remainingCapacity(b, final.ledger)).toBeGreaterThanOrEqual(0);
    }
  });

  it('外部新建批次：旧页面从过期文档提交被拒，刷新后能向新批次登记且不丢任何记录', () => {
    const storage = memoryStorage();
    const deps = testDeps();
    // 两页打开时台账为空
    const pageA = reload(storage);
    const pageB = reload(storage);

    // A 页创建批次 X
    const createX = commitLedger(
      storage,
      pageA,
      { type: 'createBatch', input: { name: '外来批次 X', capacity: '8' } },
      deps,
    );
    expect(createX.ok).toBe(true);
    if (!createX.ok) return;
    const batchX = createX.intent.result.ok ? createX.intent.result.value.id : '';

    // B 页不知道批次 X，仍尝试创建同名以外的批次 Y：冲突被拒
    const staleCreate = commitLedger(
      storage,
      pageB,
      { type: 'createBatch', input: { name: '旧页面批次 Y', capacity: '3' } },
      deps,
    );
    expect(staleCreate.ok).toBe(false);
    if (!staleCreate.ok) expect(staleCreate.kind).toBe('conflict');

    // B 刷新后看到 X，改向 X 登记
    const freshB = reload(storage);
    const recordX = commitLedger(
      storage,
      freshB,
      { type: 'recordUsage', input: { batchId: batchX, films: '8' } },
      deps,
    );
    expect(recordX.ok).toBe(true);
    const final = reload(storage);
    expect(final.ledger.batches).toHaveLength(1);
    expect(final.ledger.batches[0].name).toBe('外来批次 X');
    expect(usedCapacity(final.ledger, batchX)).toBe(8);
    expect(batchStatus(final.ledger.batches[0], final.ledger)).toBe('exhausted');
  });

  it('写入失败（配额/安全策略）：拒绝当前动作、界面不伪装成功，存储保留最后完整台账', () => {
    const storage = memoryStorage();
    const deps = testDeps();
    const batchId = seedBatch(storage, '显影液', '10', deps);
    const before = reload(storage);
    const rawBefore = storage.raw();

    // 存储开始拒绝写入
    storage.failWrites();
    const failed = commitLedger(
      storage,
      before,
      { type: 'recordUsage', input: { batchId, films: '4' } },
      deps,
    );
    expect(failed.ok).toBe(false);
    if (!failed.ok && failed.kind === 'storage') {
      expect(failed.error).toContain('保存失败');
      // 返回的文档是提交前的最后完整台账，没有那条「幽灵记录」
      expect(failed.doc.ledger.records).toHaveLength(0);
      expect(failed.doc.revision).toBe(before.revision);
    }
    // 原始存储内容一个字节都没变（刷新后恢复旧台账）
    expect(storage.raw()).toBe(rawBefore);
    const refreshed = parseLedger(storage.raw()!)!;
    expect(refreshed.records).toHaveLength(0);

    // 释放配额后用同一基准重试：成功落账
    storage.recoverWrites();
    const retry = commitLedger(
      storage,
      before,
      { type: 'recordUsage', input: { batchId, films: '4' } },
      deps,
    );
    expect(retry.ok).toBe(true);
    const final = reload(storage);
    expect(final.ledger.records).toHaveLength(1);
    expect(usedCapacity(final.ledger, batchId)).toBe(4);
  });

  it('存储损坏：读取报告 corrupted，提交一律拒绝且不覆盖原文', () => {
    const storage = memoryStorage({ [LEDGER_STORAGE_KEY]: '{broken json' });
    const deps = testDeps();
    const load = loadLedgerDocument(storage);
    expect(load.ok).toBe(false);
    // 旧入口兼容：损坏视为空台账
    expect(loadLedger(storage)).toEqual(EMPTY_LEDGER);

    const outcome = commitLedger(
      storage,
      { ledger: EMPTY_LEDGER, revision: 0 },
      { type: 'createBatch', input: { name: '不应写入', capacity: '5' } },
      deps,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.kind).toBe('corrupted');
    // 损坏原文保留，绝不被空台账覆盖
    expect(storage.raw()).toBe('{broken json');
  });

  it('旧版台账（无 revision）按 0 读入，首次提交升级为带修订号文档且其余内容不变', () => {
    const legacy = JSON.stringify({
      batches: [
        { id: 'legacy-batch', name: '旧版显影液', capacity: 10, createdAt: '2026-09-01T00:00:00.000Z' },
      ],
      records: [
        {
          id: 'legacy-record',
          batchId: 'legacy-batch',
          films: 3,
          note: '旧记录',
          remainingAfter: 7,
          createdAt: '2026-09-01T01:00:00.000Z',
        },
      ],
    });
    const storage = memoryStorage({ [LEDGER_STORAGE_KEY]: legacy });
    const deps = testDeps();

    const doc = parseLedgerDocument(legacy);
    expect(doc).not.toBeNull();
    expect(doc!.revision).toBe(0);
    expect(doc!.ledger.batches[0].name).toBe('旧版显影液');

    const page = reload(storage);
    const outcome = commitLedger(
      storage,
      page,
      { type: 'recordUsage', input: { batchId: 'legacy-batch', films: '2' } },
      deps,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // 存储中的新文档带 revision，且旧记录原样保留在前
    const raw = JSON.parse(storage.raw()!);
    expect(raw.revision).toBe(1);
    expect(raw.batches).toHaveLength(1);
    expect(raw.records.map((r: { films: number }) => r.films)).toEqual([3, 2]);
    // 新版文档仍可被无修订号的旧解析入口读出
    expect(parseLedger(storage.raw()!)).not.toBeNull();
  });

  it('交错压力序列：多页面提交-冲突-刷新-重试后，记录集合与累计量严格一致且永不为负', () => {
    const storage = memoryStorage();
    const deps = testDeps();
    const capacity = 30;
    const batchId = seedBatch(storage, '压力批次', String(capacity), deps);

    // 3 个页面各自持有文档基准，交错提交；冲突就刷新并重试
    const pages = [reload(storage), reload(storage), reload(storage)];
    const attempts = [7, 8, 6, 5, 9, 4, 3, 2, 10];
    const accepted: number[] = [];
    for (const films of attempts) {
      const pageIndex = films % pages.length;
      const intent: LedgerIntent = {
        type: 'recordUsage',
        input: { batchId, films: String(films), note: `p${pageIndex}-${films}` },
      };
      // 最多重试 3 轮（冲突 → 刷新）
      let outcome = commitLedger(storage, pages[pageIndex], intent, deps);
      for (let guard = 0; guard < 3 && !outcome.ok && outcome.kind === 'conflict'; guard += 1) {
        pages[pageIndex] = reload(storage);
        outcome = commitLedger(storage, pages[pageIndex], intent, deps);
      }
      if (outcome.ok) {
        accepted.push(films);
        pages[pageIndex] = outcome.doc;
      } else if (!outcome.ok && outcome.kind === 'rejected') {
        pages[pageIndex] = outcome.doc;
      } else {
        throw new Error(`不应出现的失败：${outcome.kind}`);
      }
    }

    const final = reload(storage);
    const storedSum = usedCapacity(final.ledger, batchId);
    // 存储中成功记录的 films 之和 = 累计量
    expect(storedSum).toBe(accepted.reduce((a, b) => a + b, 0));
    expect(storedSum).toBeLessThanOrEqual(capacity);
    const batch = final.ledger.batches[0];
    expect(remainingCapacity(batch, final.ledger)).toBe(capacity - storedSum);
    expect(remainingCapacity(batch, final.ledger)).toBeGreaterThanOrEqual(0);
    // 每条记录的 remainingAfter 与按顺序累计一致
    let running = capacity;
    for (const record of final.ledger.records) {
      running -= record.films;
      expect(record.remainingAfter).toBe(running);
      expect(running).toBeGreaterThanOrEqual(0);
    }
    // 所有页面最终刷新后看到同一批次集合、记录顺序与剩余量
    for (let i = 0; i < pages.length; i += 1) {
      expect(reload(storage)).toEqual(final);
    }
  });

  it('提交成功的原始 JSON 文档可逐字段核对：revision、批次、记录顺序与剩余量', () => {
    const storage = memoryStorage();
    const deps = testDeps();
    const page0 = reload(storage);
    const c = commitLedger(
      storage,
      page0,
      { type: 'createBatch', input: { name: '核对批次', capacity: '5' } },
      deps,
    );
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    const newId = c.intent.result.ok ? c.intent.result.value.id : '';
    const r = commitLedger(
      storage,
      c.doc,
      { type: 'recordUsage', input: { batchId: newId, films: '5' } },
      deps,
    );
    expect(r.ok).toBe(true);

    const raw = JSON.parse(storage.raw()!) as Record<string, unknown>;
    expect(raw.revision).toBe(2);
    expect(Array.isArray(raw.batches)).toBe(true);
    expect(Array.isArray(raw.records)).toBe(true);
    const records = raw.records as Array<Record<string, unknown>>;
    expect(records).toHaveLength(1);
    expect(records[0].films).toBe(5);
    expect(records[0].remainingAfter).toBe(0);
    expect(records[0].batchId).toBe(raw.batches && (raw.batches as unknown[])[0] && (raw.batches as Array<Record<string, unknown>>)[0].id);
  });
});

describe('无持久化环境', () => {
  it('commitLedger 在 storage 为 undefined 时返回 storage 失败而非伪装成功', () => {
    const deps = testDeps();
    const outcome = commitLedger(
      undefined,
      { ledger: EMPTY_LEDGER, revision: 0 },
      { type: 'createBatch', input: { name: 'x', capacity: '5' } },
      deps,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.kind).toBe('storage');
  });
});
