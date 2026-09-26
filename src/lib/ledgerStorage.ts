/**
 * 药液处理容量台账的 localStorage 持久化与跨标签并发控制。
 *
 * 批次与使用记录整体存为一个 JSON 文档；读取时逐字段校验结构，
 * 损坏或版本不符的数据一律视为不可信，绝不让异常进入界面。
 * 使用记录只追加不修改，因此这里也只提供整体读 / 写，不提供单条更新。
 *
 * 批次的配液来源快照（mixSource）是可选字段：旧数据没有它，照常读取；
 * 一旦出现就必须通过结构校验，否则整份数据视为不可信。
 *
 * 跨标签并发（本模块的核心职责）：
 * 持久化文档带一个单调递增的 revision（每次成功提交 +1）。
 * 提交动作（commitLedger）必须「先读最新文档 → 核对基准 revision →
 * 在最新台账上重放命令 → 带新 revision 原子写回」：
 * - 基准 revision 与存储不一致（其他标签已经写过）→ 拒绝本次动作，
 *   不覆盖任何记录，返回最新完整台账让当前页面对齐；
 * - localStorage 写入抛错（配额 / 安全策略）→ 拒绝本次动作，
 *   存储中的最后完整台账原样保留；
 * 因此多个标签从同一旧状态交错提交时，成功的提交只会追加记录，
 * 绝不会出现「后写覆盖先写」「记录消失」「容量为负」。
 *
 * 旧版本台账（无 revision 字段）读取时按 revision 0 兼容：
 * 第一次成功提交后文档升级为带 revision 的新格式，其余字段保持不变。
 */

import {
  EMPTY_LEDGER,
  isMixSourceSnapshot,
  recordUsage,
  createBatch,
  type ChemicalBatch,
  type CommandResult,
  type CreateBatchInput,
  type LedgerDeps,
  type LedgerState,
  type RecordUsageInput,
  type UsageRecord,
} from './capacityLedger';

export const LEDGER_STORAGE_KEY = 'darkroom.capacity-ledger.v1';

/** 与 Web Storage 对齐的最小接口，便于在 Node 测试中注入内存实现。 */
export interface StorageLike {
  getItem(key: string): string | null;
  /**
   * localStorage 的 setItem 在配额不足或被安全策略拒绝时会抛异常；
   * 内存实现的测试也可故意抛错来模拟写入失败。
   */
  setItem(key: string, value: string): void;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isRevision(value: unknown): value is number {
  // 修订号只做版本比较，不参与任何容量计算；要求非负安全整数即可。
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  // 必须是安全整数：非安全整数（如 Infinity、超长数字解析值、2^53 以上的舍入值）
  // 无法精确往返，JSON 序列化后可能变成 null，会污染整份台账。
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parseBatch(value: unknown): ChemicalBatch | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (
    !isNonEmptyString(candidate.id) ||
    !isNonEmptyString(candidate.name) ||
    !isPositiveInteger(candidate.capacity) ||
    typeof candidate.createdAt !== 'string'
  ) {
    return null;
  }
  const batch: ChemicalBatch = {
    id: candidate.id,
    name: candidate.name,
    capacity: candidate.capacity,
    createdAt: candidate.createdAt,
  };
  // 配液来源快照为可选字段：旧数据没有它，照常接受；
  // 一旦出现就必须结构完整，否则整份数据不可信。
  if (candidate.mixSource !== undefined) {
    if (!isMixSourceSnapshot(candidate.mixSource)) return null;
    const snapshot = candidate.mixSource;
    batch.mixSource = {
      n: snapshot.n,
      total: snapshot.total,
      capacity: snapshot.capacity,
      tanks: snapshot.tanks,
      concentrate: snapshot.concentrate,
      water: snapshot.water,
    };
  }
  return batch;
}

function parseRecord(value: unknown): UsageRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (
    !isNonEmptyString(candidate.id) ||
    !isNonEmptyString(candidate.batchId) ||
    !isPositiveInteger(candidate.films) ||
    typeof candidate.note !== 'string' ||
    !isNonNegativeInteger(candidate.remainingAfter) ||
    typeof candidate.createdAt !== 'string'
  ) {
    return null;
  }
  return {
    id: candidate.id,
    batchId: candidate.batchId,
    films: candidate.films,
    note: candidate.note,
    remainingAfter: candidate.remainingAfter,
    createdAt: candidate.createdAt,
  };
}

/**
 * 持久化文档：台账状态 + 单调递增的修订号。
 * revision 不属于领域状态（LedgerState），容量 / 记录推导与它无关。
 */
export interface LedgerDocument {
  ledger: LedgerState;
  /** 已成功写入存储的修订号；空台账与旧版数据均为 0。 */
  revision: number;
}

export const EMPTY_DOCUMENT: LedgerDocument = { ledger: EMPTY_LEDGER, revision: 0 };

/** 反序列化台账状态：任一环节失败（JSON 损坏、结构不符）都返回 null。 */
export function parseLedger(json: string): LedgerState | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as Record<string, unknown>;
  if (!Array.isArray(candidate.batches) || !Array.isArray(candidate.records)) return null;

  const batches: ChemicalBatch[] = [];
  for (const item of candidate.batches) {
    const batch = parseBatch(item);
    if (!batch) return null;
    batches.push(batch);
  }
  const batchIds = new Set(batches.map((batch) => batch.id));

  const records: UsageRecord[] = [];
  for (const item of candidate.records) {
    const record = parseRecord(item);
    // 记录必须挂在已知批次上，否则整份数据不可信
    if (!record || !batchIds.has(record.batchId)) return null;
    records.push(record);
  }
  return { batches, records };
}

/** 反序列化带修订号的完整文档；缺 revision 的旧版台账按 revision 0 接受。 */
export function parseLedgerDocument(json: string): LedgerDocument | null {
  const ledger = parseLedger(json);
  if (ledger === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const candidate = raw as Record<string, unknown>;
  // 旧版存储没有 revision：按 0 兼容，第一次提交后升级；
  // 一旦携带 revision 就必须是非负安全整数，否则整份文档不可信。
  const revision = candidate.revision === undefined ? 0 : candidate.revision;
  if (!isRevision(revision)) return null;
  return { ledger, revision };
}

export function serializeLedger(state: LedgerState): string {
  return JSON.stringify(state);
}

export function serializeLedgerDocument(doc: LedgerDocument): string {
  return JSON.stringify({ ...doc.ledger, revision: doc.revision });
}

export type LedgerLoadOutcome =
  | { ok: true; doc: LedgerDocument }
  | { ok: false; doc: LedgerDocument; corrupted: true };

/**
 * 从存储还原带修订号的文档。
 * - 无数据：空文档（revision 0）；
 * - 旧版 / 新版合法数据：解析出的台账与修订号；
 * - 数据损坏：返回空文档并标记 corrupted，调用方必须就地提示且不得写回覆盖
 *   （存储里的原文仍保留，避免一次误判永久毁掉可追溯数据）。
 */
export function loadLedgerDocument(
  storage: StorageLike | undefined,
): LedgerLoadOutcome {
  if (!storage) return { ok: true, doc: EMPTY_DOCUMENT };
  let json: string | null;
  try {
    json = storage.getItem(LEDGER_STORAGE_KEY);
  } catch {
    // 安全策略可能连读取都拒绝：按不可信处理，不做任何写入
    return { ok: false, doc: EMPTY_DOCUMENT, corrupted: true };
  }
  if (json === null) return { ok: true, doc: EMPTY_DOCUMENT };
  const doc = parseLedgerDocument(json);
  if (doc === null) return { ok: false, doc: EMPTY_DOCUMENT, corrupted: true };
  return { ok: true, doc };
}

/** 从存储还原台账；无数据或数据损坏时返回空台账（旧调用方兼容入口）。 */
export function loadLedger(storage: StorageLike | undefined): LedgerState {
  return loadLedgerDocument(storage).doc.ledger;
}

/**
 * 整体写入台账（旧入口：不带修订号，主要供既有单元测试使用）。
 * 写入前做一次「序列化 → 反序列化」往返校验：
 * 若产出的状态无法被本模块原样读回（含 Infinity / null 等无法精确表示的值），
 * 则拒绝写入并保留存储中的旧台账，避免一次异常写入让刷新后整份台账消失。
 */
export function saveLedger(storage: StorageLike | undefined, state: LedgerState): void {
  if (!storage) return;
  const json = serializeLedger(state);
  if (parseLedger(json) === null) return;
  storage.setItem(LEDGER_STORAGE_KEY, json);
}

/** 提交意图：在「读取时的最新台账」上重放一条领域命令。 */
export type LedgerIntent =
  | { type: 'createBatch'; input: CreateBatchInput }
  | { type: 'recordUsage'; input: RecordUsageInput };

/** 命令重放结果（携带命令产物，界面可据此选中新建批次等）。 */
export type IntentResult =
  | { type: 'createBatch'; result: CommandResult<ChemicalBatch> }
  | { type: 'recordUsage'; result: CommandResult<UsageRecord> };

export type CommitOutcome =
  | {
      ok: true;
      intent: IntentResult;
      /** 写回后的最新文档（新 revision） */
      doc: LedgerDocument;
    }
  | {
      ok: false;
      /** 命令本身被拒绝（数量非法、超剩余容量等）：存储未被触碰 */
      kind: 'rejected';
      intent: IntentResult;
      doc: LedgerDocument;
    }
  | {
      ok: false;
      /** 其他标签已经写入：本次动作未落账，doc 为存储中的最新完整台账 */
      kind: 'conflict';
      error: string;
      doc: LedgerDocument;
    }
  | {
      ok: false;
      /** localStorage 写入被拒（配额 / 安全策略）：存储保留提交前的完整台账 */
      kind: 'storage';
      error: string;
      doc: LedgerDocument;
    }
  | {
      ok: false;
      /** 存储中的当前文档无法解析：不覆盖任何内容，要求先刷新确认 */
      kind: 'corrupted';
      error: string;
      doc: LedgerDocument;
    };

function replayIntent(ledger: LedgerState, intent: LedgerIntent, deps: LedgerDeps): IntentResult {
  if (intent.type === 'createBatch') {
    return { type: 'createBatch', result: createBatch(ledger, intent.input, deps) };
  }
  return { type: 'recordUsage', result: recordUsage(ledger, intent.input, deps) };
}

function intentRejected(intent: IntentResult): boolean {
  return !intent.result.ok;
}

/**
 * 跨标签安全的提交流程（乐观并发 / 比较并交换）：
 *
 * 1. 重新读取存储中的最新文档（绝不只信调用方手里的旧快照）；
 * 2. 最新 revision 必须等于调用方的基准 revision，否则说明别的标签已经写入，
 *    本次动作整体拒绝并返回最新文档；
 * 3. 在最新台账上重放领域命令：被领域规则拒绝时不写存储；
 * 4. 成功则做序列化往返校验后写回（revision + 1）；setItem 抛错时
 *    存储内容不会被部分更新（localStorage 写入要么成功要么整体失败），
 *    返回 storage 失败并保留旧文档。
 *
 * 任何失败路径都不删除、不覆盖已有批次与记录。
 */
export function commitLedger(
  storage: StorageLike | undefined,
  base: LedgerDocument,
  intent: LedgerIntent,
  deps: LedgerDeps,
): CommitOutcome {
  const load = loadLedgerDocument(storage);
  if (!load.ok) {
    return {
      ok: false,
      kind: 'corrupted',
      error: '本地台账已损坏或被浏览器策略阻止读取，请刷新页面核对后再操作',
      doc: load.doc,
    };
  }
  const latest = load.doc;
  if (latest.revision !== base.revision) {
    return {
      ok: false,
      kind: 'conflict',
      error: '台账已被其他页面更新，本次登记未写入；页面已刷新为最新台账，请核对后重新登记',
      doc: latest,
    };
  }

  const replayed = replayIntent(latest.ledger, intent, deps);
  if (intentRejected(replayed)) {
    return { ok: false, kind: 'rejected', intent: replayed, doc: latest };
  }

  const nextDoc: LedgerDocument = {
    ledger: replayed.result.ok ? replayed.result.state : latest.ledger,
    revision: latest.revision + 1,
  };
  if (!storage) {
    // 无持久化环境（SSR 等）：不伪装成功，按存储失败拒绝
    return {
      ok: false,
      kind: 'storage',
      error: '当前环境不支持本地存储，本次登记未写入',
      doc: latest,
    };
  }
  const json = serializeLedgerDocument(nextDoc);
  // 往返校验：写不进去的异常状态（理论上命令不会产出）绝不落存储
  if (parseLedgerDocument(json) === null) {
    return {
      ok: false,
      kind: 'storage',
      error: '台账无法保存：数据未能通过写入校验，请刷新页面核对后重试',
      doc: latest,
    };
  }
  try {
    storage.setItem(LEDGER_STORAGE_KEY, json);
  } catch {
    // 配额不足 / 安全策略拒绝：旧文档原样保留，本次动作视为失败
    return {
      ok: false,
      kind: 'storage',
      error: '台账保存失败（浏览器存储可能已满或被策略拒绝），本次登记未写入，请释放存储空间后重试',
      doc: latest,
    };
  }
  return { ok: true, intent: replayed, doc: nextDoc };
}

/** 浏览器环境下的默认存储；SSR / 测试环境下为 undefined。 */
export function browserStorage(): StorageLike | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
