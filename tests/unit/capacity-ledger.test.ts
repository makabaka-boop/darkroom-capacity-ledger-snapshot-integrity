import { describe, expect, it } from 'vitest';
import {
  BATCH_STATUS_LABEL,
  batchRecords,
  batchStatus,
  createBatch,
  EMPTY_LEDGER,
  recordUsage,
  remainingCapacity,
  usedCapacity,
  type ChemicalBatch,
  type LedgerDeps,
  type LedgerState,
} from '../../src/lib/capacityLedger';

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

function mustCreate(state: LedgerState, name: string, capacity: string, deps: LedgerDeps) {
  const result = createBatch(state, { name, capacity }, deps);
  if (!result.ok) throw new Error(`测试前置创建批次失败：${result.error}`);
  return result;
}

function mustRecord(state: LedgerState, batchId: string, films: string, deps: LedgerDeps) {
  const result = recordUsage(state, { batchId, films }, deps);
  if (!result.ok) throw new Error(`测试前置登记失败：${result.error}`);
  return result;
}

describe('createBatch 命令', () => {
  it('空名称（含纯空白）拒绝创建且不写入', () => {
    const deps = testDeps();
    for (const name of ['', '   ']) {
      const result = createBatch(EMPTY_LEDGER, { name, capacity: '10' }, deps);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('请输入药液名称');
    }
    expect(EMPTY_LEDGER.batches).toHaveLength(0);
  });

  it('额定容量为空、非整数或非正整数时分别说明原因', () => {
    const deps = testDeps();
    const cases: Array<[string, string]> = [
      ['', '请输入额定容量'],
      ['abc', '额定容量必须为整数，不能含小数或字母'],
      ['2.5', '额定容量必须为整数，不能含小数或字母'],
      ['0', '额定容量须为大于 0 的整数'],
      ['-3', '额定容量须为大于 0 的整数'],
    ];
    let state = EMPTY_LEDGER;
    for (const [capacity, message] of cases) {
      const result = createBatch(state, { name: '显影液', capacity }, deps);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe(message);
      // 失败不写入：状态保持原样
      expect(state.batches).toHaveLength(0);
    }
  });

  it('合法输入创建批次：名称去空白，容量为正整数，原状态不被修改', () => {
    const deps = testDeps();
    const before = EMPTY_LEDGER;
    const result = createBatch(before, { name: '  D-76 显影液  ', capacity: ' 12 ' }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe('D-76 显影液');
    expect(result.value.capacity).toBe(12);
    expect(result.value.createdAt).toBe('2026-09-10T12:00:01.000Z');
    expect(result.state.batches).toHaveLength(1);
    // 纯函数：传入状态原封不动
    expect(before.batches).toHaveLength(0);
  });

  it('超长 / 超出安全整数范围的额定容量被拒绝，不写入且已有批次不受影响', () => {
    const deps = testDeps();
    const existing = mustCreate(EMPTY_LEDGER, '已有批次', '10', deps);
    const cases = [
      '9'.repeat(400), // parseInt 得 Infinity
      String(2 ** 53 + 1), // 可解析但无法精确表示，会被静默舍入
      String(2 ** 60),
    ];
    for (const capacity of cases) {
      const result = createBatch(existing.state, { name: '异常批次', capacity }, deps);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('数值过大，无法精确记录，请填写较小的整数');
      // 失败不写入：原批次保留，异常批次绝不进入状态
      expect(existing.state.batches).toHaveLength(1);
      expect(existing.state.batches[0].name).toBe('已有批次');
      expect(Number.isFinite(existing.state.batches[0].capacity)).toBe(true);
    }
  });
});

describe('recordUsage 命令', () => {
  function setup(capacity = '10') {
    const deps = testDeps();
    const created = mustCreate(EMPTY_LEDGER, '显影液', capacity, deps);
    return { deps, batch: created.value, state: created.state };
  }

  it('批次不存在时拒绝登记', () => {
    const { deps, state } = setup();
    const result = recordUsage(state, { batchId: 'no-such-id', films: '1' }, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('批次不存在或已被移除');
    expect(state.records).toHaveLength(0);
  });

  it('数量为空、非整数或非正整数时分别说明原因且不写入', () => {
    const { deps, batch, state } = setup();
    const cases: Array<[string, string]> = [
      ['', '请输入等效胶片数量'],
      ['1.5', '数量必须为整数，不能含小数或字母'],
      ['abc', '数量必须为整数，不能含小数或字母'],
      ['0', '数量须为大于 0 的整数'],
      ['-2', '数量须为大于 0 的整数'],
    ];
    for (const [films, message] of cases) {
      const result = recordUsage(state, { batchId: batch.id, films }, deps);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe(message);
      expect(state.records).toHaveLength(0);
    }
  });

  it('超过剩余容量时说明原因且不写入记录', () => {
    const { deps, batch, state } = setup('10');
    const after4 = mustRecord(state, batch.id, '4', deps).state;
    const result = recordUsage(after4, { batchId: batch.id, films: '7' }, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('超过剩余容量：本批仅剩 6，无法登记 7');
    // 不写入：记录数与累计用量保持登记前水平
    expect(after4.records).toHaveLength(1);
    expect(usedCapacity(after4, batch.id)).toBe(4);
  });

  it('超出安全整数范围的数量被拒绝且不写入，不会产生 Infinity 剩余量', () => {
    const { deps, batch, state } = setup('10');
    for (const films of ['9'.repeat(400), String(2 ** 53 + 1)]) {
      const result = recordUsage(state, { batchId: batch.id, films }, deps);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('数值过大，无法精确记录，请填写较小的整数');
      expect(state.records).toHaveLength(0);
      expect(remainingCapacity(batch, state)).toBe(10);
    }
  });

  it('每条记录写入前重新计算剩余量：remainingAfter 逐条递减且与派生剩余一致', () => {
    const { deps, batch, state } = setup('10');
    let current = state;
    const expectedRemaining = [7, 4, 0];
    ['3', '3', '4'].forEach((films, index) => {
      const result = recordUsage(current, { batchId: batch.id, films }, deps);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.remainingAfter).toBe(expectedRemaining[index]);
      current = result.state;
      // 记录中的剩余量与由记录重新推导的剩余量一致
      expect(remainingCapacity(batch, current)).toBe(expectedRemaining[index]);
    });
    expect(current.records.map((record) => record.remainingAfter)).toEqual([7, 4, 0]);
  });

  it('连续登记永远不会产生负剩余（确定性序列 + 伪随机序列）', () => {
    const deps = testDeps();
    // 确定性序列：故意包含超量尝试
    {
      const created = mustCreate(EMPTY_LEDGER, '显影液', '10', deps);
      let state = created.state;
      const batch = created.value;
      for (const films of ['4', '3', '3', '2', '1', '5']) {
        const before = state;
        const result = recordUsage(state, { batchId: batch.id, films }, deps);
        if (result.ok) {
          expect(result.value.remainingAfter).toBeGreaterThanOrEqual(0);
          state = result.state;
        } else {
          // 失败不写入，状态对象保持同一引用
          expect(result.error).toContain('超过剩余容量');
          expect(state).toBe(before);
        }
        expect(remainingCapacity(batch, state)).toBeGreaterThanOrEqual(0);
      }
      // 4+3+2+1 = 10 全部成功，3 与 5 被拒；最终恰好耗尽
      expect(usedCapacity(state, batch.id)).toBe(10);
      expect(remainingCapacity(batch, state)).toBe(0);
    }
    // 伪随机序列（线性同余，种子固定，可复现）
    {
      let seed = 42;
      const next = (bound: number) => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return (seed % bound) + 1;
      };
      for (let round = 0; round < 20; round += 1) {
        const capacity = next(50);
        const created = mustCreate(EMPTY_LEDGER, `药液 ${round}`, String(capacity), deps);
        let state = created.state;
        const batch = created.value;
        for (let attempt = 0; attempt < 30; attempt += 1) {
          const films = String(next(60));
          const result = recordUsage(state, { batchId: batch.id, films }, deps);
          if (result.ok) {
            expect(result.value.remainingAfter).toBeGreaterThanOrEqual(0);
            expect(result.value.remainingAfter).toBeLessThanOrEqual(capacity);
            state = result.state;
          }
          const used = usedCapacity(state, batch.id);
          expect(used).toBeLessThanOrEqual(capacity);
          expect(remainingCapacity(batch, state)).toBe(capacity - used);
          expect(remainingCapacity(batch, state)).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('恰好用完时状态确定转为已耗尽，之后任何登记都被拒绝', () => {
    const { deps, batch, state } = setup('10');
    expect(batchStatus(batch, state)).toBe('active');

    const after4 = mustRecord(state, batch.id, '4', deps).state;
    expect(batchStatus(batch, after4)).toBe('active');
    expect(remainingCapacity(batch, after4)).toBe(6);

    // 恰好登记完剩余 6：剩余 0，状态转为已耗尽
    const after10 = mustRecord(after4, batch.id, '6', deps).state;
    expect(remainingCapacity(batch, after10)).toBe(0);
    expect(batchStatus(batch, after10)).toBe('exhausted');
    expect(BATCH_STATUS_LABEL[batchStatus(batch, after10)]).toBe('已耗尽');
    expect(BATCH_STATUS_LABEL[batchStatus(batch, after4)]).toBe('使用中');

    // 已耗尽后继续登记：超过剩余容量，不写入
    const rejected = recordUsage(after10, { batchId: batch.id, films: '1' }, deps);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error).toBe('超过剩余容量：本批仅剩 0，无法登记 1');
    expect(after10.records).toHaveLength(2);
  });

  it('使用记录不可修改：记录对象被冻结，命令不修改传入状态', () => {
    const { deps, batch, state } = setup('10');
    const result = recordUsage(state, { batchId: batch.id, films: '4', note: ' 4 卷 135 ' }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const record = result.value;
    expect(Object.isFrozen(record)).toBe(true);
    expect(() => {
      (record as { films: number }).films = 99;
    }).toThrow(TypeError);
    expect(record.films).toBe(4);
    // 备注去空白；空备注存为空字符串
    expect(record.note).toBe('4 卷 135');

    // 命令不修改传入状态：原状态快照不变
    expect(state.records).toHaveLength(0);
    expect(result.state.records).toHaveLength(1);
    // 再次登记基于新状态，旧记录对象不被触碰
    const again = recordUsage(result.state, { batchId: batch.id, films: '1' }, deps);
    expect(again.ok).toBe(true);
    if (again.ok) {
      expect(again.state.records[0]).toBe(record);
      expect(again.state.records[0].remainingAfter).toBe(6);
    }
  });

  it('多批次各自独立累计：记录按批次隔离，互不影响剩余量', () => {
    const deps = testDeps();
    const a = mustCreate(EMPTY_LEDGER, '显影液', '8', deps);
    const b = mustCreate(a.state, '定影液', '5', deps);
    let state = b.state;
    const batchA = a.value;
    const batchB = b.value;

    state = mustRecord(state, batchA.id, '8', deps).state;
    state = mustRecord(state, batchB.id, '2', deps).state;

    expect(usedCapacity(state, batchA.id)).toBe(8);
    expect(remainingCapacity(batchA, state)).toBe(0);
    expect(batchStatus(batchA, state)).toBe('exhausted');

    expect(usedCapacity(state, batchB.id)).toBe(2);
    expect(remainingCapacity(batchB, state)).toBe(3);
    expect(batchStatus(batchB, state)).toBe('active');

    expect(batchRecords(state, batchA.id)).toHaveLength(1);
    expect(batchRecords(state, batchB.id)).toHaveLength(1);
    expect(batchRecords(state, batchA.id)[0].batchId).toBe(batchA.id);
  });

  it('使用记录按写入顺序（登记时间）排列，时间逐条递增', () => {
    const deps = testDeps();
    const created = mustCreate(EMPTY_LEDGER, '显影液', '10', deps);
    let state = created.state;
    const batch: ChemicalBatch = created.value;
    state = mustRecord(state, batch.id, '2', deps).state;
    state = mustRecord(state, batch.id, '3', deps).state;
    state = mustRecord(state, batch.id, '1', deps).state;

    const records = batchRecords(state, batch.id);
    expect(records.map((record) => record.films)).toEqual([2, 3, 1]);
    const times = records.map((record) => new Date(record.createdAt).getTime());
    expect(times[0]).toBeLessThan(times[1]);
    expect(times[1]).toBeLessThan(times[2]);
  });
});
