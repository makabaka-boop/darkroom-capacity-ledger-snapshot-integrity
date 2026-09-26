/**
 * 药液处理容量台账（领域服务）。
 *
 * 与配液计算相互独立：这里跟踪一批药液按「等效胶片数」计的额定容量、
 * 逐次登记的处理用量与剩余容量，避免凭记忆继续使用已耗尽的药液。
 *
 * 契约 = 两个命令（纯函数，不修改传入状态，返回新状态）：
 * - createBatch：创建带名称与额定容量的药液批次，可附带一份配液来源快照；
 * - recordUsage：向指定批次登记一次处理用量，写入前重新计算剩余量，
 *   剩余量 = 额定容量 − 该批全部已登记用量之和；登记后剩余为 0 即「已耗尽」。
 *
 * 使用记录一旦写入不可修改：命令只追加、不更新、不删除；
 * 累计用量 / 剩余容量 / 状态均由记录推导，不单独存储。
 *
 * 配液来源快照（可选）：从配液计算结果区「存入容量台账」时，
 * 把同一次计算的稀释比例、目标总量、量筒容量、分罐数与浓缩液/清水体积
 * 逐字段拷贝固定保存，之后不随界面参数变化；手工创建的批次没有该字段。
 *
 * 校验失败时返回中文原因且不产生任何写入：
 * - 名称为空；
 * - 额定容量 / 胶片数量为空、非整数或非正整数；
 * - 数值超出安全整数范围（超长数字无法精确表示，显示会异常）；
 * - 登记数量超过当前剩余容量；
 * - 附带的配液来源快照结构不完整或违反「浓缩液 + 清水 = 目标总量」。
 * 字段校验函数同时导出，界面可借此把错误放到对应字段下方，
 * 但命令本身仍是最终闸门（同样校验在命令内再执行一次）。
 */

/** 批次状态：使用中 / 已耗尽 */
export type BatchStatus = 'active' | 'exhausted';

export const BATCH_STATUS_LABEL: Record<BatchStatus, string> = {
  active: '使用中',
  exhausted: '已耗尽',
};

export interface ChemicalBatch {
  id: string;
  /** 药液名称（非空，已去除首尾空白） */
  name: string;
  /** 额定容量：整批药液可处理的等效胶片总数（正整数） */
  capacity: number;
  /** 创建时间（ISO 8601） */
  createdAt: string;
  /**
   * 配液来源快照（可选）：创建时从同一次配液计算结果固定保存，
   * 之后不再变化；手工创建的批次没有该字段。
   */
  mixSource?: MixSourceSnapshot;
}

/**
 * 配液来源快照：一批药液「来自哪次配液计算」的完整参数与结果。
 * 字段名与 dilution.ts 的 MixResult 对齐，由界面从当次计算结果逐字段拷贝。
 */
export interface MixSourceSnapshot {
  /** 稀释式 1+n 的 n */
  n: number;
  /** 目标总量（mL） */
  total: number;
  /** 量筒容量（mL） */
  capacity: number;
  /** 显影罐数量（分罐数） */
  tanks: number;
  /** 取整后的浓缩液体积（mL） */
  concentrate: number;
  /** 清水体积（mL），恒满足 concentrate + water = total */
  water: number;
}

export interface UsageRecord {
  id: string;
  batchId: string;
  /** 本次处理的等效胶片数量（正整数） */
  films: number;
  /** 备注（可为空字符串） */
  note: string;
  /** 写入前重新计算出的、本次登记之后的剩余容量（恒 ≥ 0） */
  remainingAfter: number;
  /** 登记时间（ISO 8601） */
  createdAt: string;
}

export interface LedgerState {
  batches: ChemicalBatch[];
  records: UsageRecord[];
}

export const EMPTY_LEDGER: LedgerState = { batches: [], records: [] };

/** 命令依赖：时间与 id 生成器可注入，便于测试复现。 */
export interface LedgerDeps {
  now: () => Date;
  nextId: () => string;
}

/** 生产环境默认依赖。 */
export function defaultLedgerDeps(): LedgerDeps {
  let counter = 0;
  return {
    now: () => new Date(),
    nextId: () => {
      counter += 1;
      return `${Date.now().toString(36)}-${counter.toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
    },
  };
}

export type CommandResult<T> =
  | { ok: true; value: T; state: LedgerState }
  | { ok: false; error: string };

/**
 * 严格解析整数字符串：拒绝空串、小数、非数字字符；
 * 超长数字（超过 Number.MAX_SAFE_INTEGER）也拒绝——
 * 这类数字无法精确表示（可能变为 Infinity 或被舍入），
 * 一旦入库会造成界面显示异常、持久化往返失败。
 */
function parseStrictInteger(raw: string): number | null {
  const text = raw.trim();
  if (text === '') return null;
  if (!/^[+-]?\d+$/.test(text)) return null;
  const value = Number.parseInt(text, 10);
  if (!Number.isSafeInteger(value)) return null;
  return value;
}

/** 是否为「全是数字、但已超出安全整数范围」的超长输入（用于给出专用提示）。 */
function isUnsafeDigits(raw: string): boolean {
  const text = raw.trim();
  if (!/^[+-]?\d+$/.test(text)) return false;
  return !Number.isSafeInteger(Number.parseInt(text, 10));
}

/** 判断未知值是否为正的安全整数（用于快照结构校验）。 */
function isPositiveIntegerValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * 配液来源快照结构校验：六个数值均为正整数，
 * 且满足配液计算的核心不变量「浓缩液 + 清水 = 目标总量」。
 * 命令与持久化读取共用本校验。
 */
export function isMixSourceSnapshot(value: unknown): value is MixSourceSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (
    !isPositiveIntegerValue(candidate.n) ||
    !isPositiveIntegerValue(candidate.total) ||
    !isPositiveIntegerValue(candidate.capacity) ||
    !isPositiveIntegerValue(candidate.tanks) ||
    !isPositiveIntegerValue(candidate.concentrate) ||
    !isPositiveIntegerValue(candidate.water)
  ) {
    return false;
  }
  return candidate.concentrate + candidate.water === candidate.total;
}

/** 批次名称校验：空（含纯空白）不允许。 */
export function validateBatchName(name: string): string | undefined {
  if (name.trim() === '') return '请输入药液名称';
  return undefined;
}

/** 数字过大（超出安全整数范围）时的统一提示。 */
export const INTEGER_TOO_LARGE_MESSAGE = '数值过大，无法精确记录，请填写较小的整数';

/** 额定容量校验：可精确表示的正整数（拒绝超出安全整数范围的超长数字）。 */
export function validateCapacityInput(raw: string): string | undefined {
  if (raw.trim() === '') return '请输入额定容量';
  if (isUnsafeDigits(raw)) return INTEGER_TOO_LARGE_MESSAGE;
  const value = parseStrictInteger(raw);
  if (value === null) return '额定容量必须为整数，不能含小数或字母';
  if (value <= 0) return '额定容量须为大于 0 的整数';
  return undefined;
}

/** 登记数量校验：可精确表示的正整数（是否超过剩余容量由 recordUsage 判定）。 */
export function validateFilmsInput(raw: string): string | undefined {
  if (raw.trim() === '') return '请输入等效胶片数量';
  if (isUnsafeDigits(raw)) return INTEGER_TOO_LARGE_MESSAGE;
  const value = parseStrictInteger(raw);
  if (value === null) return '数量必须为整数，不能含小数或字母';
  if (value <= 0) return '数量须为大于 0 的整数';
  return undefined;
}

/** 某批次已登记用量之和（累计用量）。 */
export function usedCapacity(state: LedgerState, batchId: string): number {
  return state.records
    .filter((record) => record.batchId === batchId)
    .reduce((sum, record) => sum + record.films, 0);
}

/** 某批次当前剩余容量 = 额定容量 − 累计用量。 */
export function remainingCapacity(batch: ChemicalBatch, state: LedgerState): number {
  return batch.capacity - usedCapacity(state, batch.id);
}

/** 状态由剩余量推导：剩余为 0 即已耗尽，否则使用中。 */
export function batchStatus(batch: ChemicalBatch, state: LedgerState): BatchStatus {
  return remainingCapacity(batch, state) === 0 ? 'exhausted' : 'active';
}

/** 某批次的全部使用记录，按登记时间（写入顺序）排列。 */
export function batchRecords(state: LedgerState, batchId: string): UsageRecord[] {
  return state.records.filter((record) => record.batchId === batchId);
}

export interface CreateBatchInput {
  name: string;
  /** 表单原始字符串，由命令内部校验 */
  capacity: string;
  /**
   * 可选：配液来源快照，必须取自同一次配液计算结果。
   * 命令会校验其结构完整性，不合格时拒绝创建（不写入任何数据）。
   */
  mixSource?: MixSourceSnapshot;
}

/**
 * 命令一：创建药液批次。
 * 名称为空、额定容量为空 / 非整数 / 非正整数，或附带的配液来源快照
 * 结构不完整时返回原因，不写入任何记录。
 * 快照通过校验后逐字段拷贝并冻结，自此与后续计算无关（固定保存）。
 */
export function createBatch(
  state: LedgerState,
  input: CreateBatchInput,
  deps: LedgerDeps,
): CommandResult<ChemicalBatch> {
  const nameError = validateBatchName(input.name);
  if (nameError) return { ok: false, error: nameError };
  const capacityError = validateCapacityInput(input.capacity);
  if (capacityError) return { ok: false, error: capacityError };
  if (input.mixSource !== undefined && !isMixSourceSnapshot(input.mixSource)) {
    return { ok: false, error: '配液来源数据不完整，请重新计算后再存入' };
  }

  const batch: ChemicalBatch = Object.freeze({
    id: deps.nextId(),
    name: input.name.trim(),
    capacity: parseStrictInteger(input.capacity)!,
    createdAt: deps.now().toISOString(),
    ...(input.mixSource === undefined
      ? {}
      : {
          mixSource: Object.freeze({
            n: input.mixSource.n,
            total: input.mixSource.total,
            capacity: input.mixSource.capacity,
            tanks: input.mixSource.tanks,
            concentrate: input.mixSource.concentrate,
            water: input.mixSource.water,
          }),
        }),
  });
  return {
    ok: true,
    value: batch,
    state: { ...state, batches: [...state.batches, batch] },
  };
}

export interface RecordUsageInput {
  batchId: string;
  /** 表单原始字符串，由命令内部校验 */
  films: string;
  note?: string;
}

/**
 * 命令二：登记一次处理用量。
 * 写入前重新计算剩余量（额定容量 − 已登记用量之和）：
 * 数量为空 / 非整数 / 非正整数 / 超过剩余容量时返回原因，不写入记录；
 * 成功后追加一条不可修改的使用记录，remainingAfter 记录登记后的剩余容量。
 */
export function recordUsage(
  state: LedgerState,
  input: RecordUsageInput,
  deps: LedgerDeps,
): CommandResult<UsageRecord> {
  const batch = state.batches.find((candidate) => candidate.id === input.batchId);
  if (!batch) {
    return { ok: false, error: '批次不存在或已被移除' };
  }
  const filmsError = validateFilmsInput(input.films);
  if (filmsError) return { ok: false, error: filmsError };

  const films = parseStrictInteger(input.films)!;
  // 每条记录写入前重新计算剩余量，而不是沿用界面上的旧值。
  const remaining = remainingCapacity(batch, state);
  if (films > remaining) {
    return {
      ok: false,
      error: `超过剩余容量：本批仅剩 ${remaining}，无法登记 ${films}`,
    };
  }
  const record: UsageRecord = Object.freeze({
    id: deps.nextId(),
    batchId: batch.id,
    films,
    note: (input.note ?? '').trim(),
    remainingAfter: remaining - films,
    createdAt: deps.now().toISOString(),
  });
  return {
    ok: true,
    value: record,
    state: { ...state, records: [...state.records, record] },
  };
}
