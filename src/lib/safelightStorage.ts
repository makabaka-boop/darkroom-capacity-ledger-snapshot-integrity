/**
 * 安全灯测试的 localStorage 持久化（与容量台账不同的独立存储键）。
 *
 * 测试草稿与已完成结论整体存为一个 JSON 文档；读取时逐字段校验结构，
 * 并强制执行与创建命令相同的不变量（条带数量范围、末条曝光不超过一小时、
 * 评估结果必须指向本次测试的条带），创建 / 评估时间不得为空字符串。
 *
 * 数据损坏时不静默当作空白：loadSafelightState 报告 corrupted，
 * 由界面就地反馈。
 */

import {
  EMPTY_SAFELIGHT,
  EXPOSURE_MAX_SECONDS,
  lastStripSeconds,
  STRIPS_MAX,
  STRIPS_MIN,
  type SafelightEvaluation,
  type SafelightState,
  type SafelightTest,
} from './safelightTest';
import type { StorageLike } from './ledgerStorage';

export const SAFELIGHT_STORAGE_KEY = 'darkroom.safelight-tests.v1';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isPositiveInteger(value: unknown): value is number {
  // 必须是安全整数：非安全整数无法精确往返，JSON 序列化后可能变成 null
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function parseEvaluation(value: unknown, stripCount: number): SafelightEvaluation | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  // 评估时间必须是非空字符串：空时间无法向操作员展示「评估于何时」
  if (!isNonEmptyString(candidate.evaluatedAt)) return null;
  const firstFog = candidate.firstFogStrip;
  // null = 全部未起雾；否则必须是指向本次测试条带的序号
  if (
    firstFog !== null &&
    (typeof firstFog !== 'number' ||
      !Number.isSafeInteger(firstFog) ||
      firstFog < 1 ||
      firstFog > stripCount)
  ) {
    return null;
  }
  return { firstFogStrip: firstFog, evaluatedAt: candidate.evaluatedAt };
}

function parseTest(value: unknown): SafelightTest | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (
    !isNonEmptyString(candidate.id) ||
    !isNonEmptyString(candidate.name) ||
    !isPositiveInteger(candidate.startSeconds) ||
    !isPositiveInteger(candidate.stepSeconds) ||
    typeof candidate.stripCount !== 'number' ||
    !Number.isSafeInteger(candidate.stripCount) ||
    candidate.stripCount < STRIPS_MIN ||
    candidate.stripCount > STRIPS_MAX ||
    !isNonEmptyString(candidate.createdAt)
  ) {
    return null;
  }
  const test: SafelightTest = {
    id: candidate.id,
    name: candidate.name,
    startSeconds: candidate.startSeconds,
    stepSeconds: candidate.stepSeconds,
    stripCount: candidate.stripCount,
    createdAt: candidate.createdAt,
  };
  // 与创建命令相同的不变量：末条曝光不得超过一小时
  if (lastStripSeconds(test) > EXPOSURE_MAX_SECONDS) return null;
  // 评估结论为可选字段：草稿没有它，照常接受；一旦出现就必须结构完整
  if (candidate.evaluation !== undefined) {
    const evaluation = parseEvaluation(candidate.evaluation, test.stripCount);
    if (!evaluation) return null;
    test.evaluation = evaluation;
  }
  return test;
}

/** 反序列化：任一环节失败（JSON 损坏、结构不符）都返回 null。 */
export function parseSafelightState(json: string): SafelightState | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as Record<string, unknown>;
  if (!Array.isArray(candidate.tests)) return null;
  const tests: SafelightTest[] = [];
  const seenIds = new Set<string>();
  for (const item of candidate.tests) {
    const test = parseTest(item);
    if (!test) return null;
    // id 必须唯一：重复 id 时界面按 id 选中永远只能打开第一条，
    // 其余记录的名称 / 阶梯 / 表单无法正确展示，整份文档不可信
    if (seenIds.has(test.id)) return null;
    seenIds.add(test.id);
    tests.push(test);
  }
  return { tests };
}

export function serializeSafelightState(state: SafelightState): string {
  return JSON.stringify({
    tests: state.tests.map((test) => ({
      ...test,
      // 注意：firstFogStrip 为 null 是合法结论（全部未起雾），
      // 不能用真值判断，否则该结论会被丢弃、刷新后退回待评估。
      evaluation: test.evaluation ?? undefined,
    })),
  });
}

export interface SafelightLoad {
  state: SafelightState;
  /** 存储键存在但内容损坏（无法解析或结构不符）：界面应就地反馈，且不得写回覆盖 */
  corrupted: boolean;
}

/** 从存储还原测试；无数据返回空白，数据损坏时报告 corrupted（state 为空白）。 */
export function loadSafelightState(storage: StorageLike | undefined): SafelightLoad {
  if (!storage) return { state: EMPTY_SAFELIGHT, corrupted: false };
  const json = storage.getItem(SAFELIGHT_STORAGE_KEY);
  if (json === null) return { state: EMPTY_SAFELIGHT, corrupted: false };
  const parsed = parseSafelightState(json);
  if (parsed === null) return { state: EMPTY_SAFELIGHT, corrupted: true };
  return { state: parsed, corrupted: false };
}

/**
 * 整体写入（调用方保证传入的是命令产出的新状态）。
 * 写入前做一次「序列化 → 反序列化」往返校验：无法被原样读回的状态拒绝写入，
 * 保留存储中的旧数据，避免一次异常写入让刷新后整份测试记录消失。
 */
export function saveSafelightState(storage: StorageLike | undefined, state: SafelightState): void {
  if (!storage) return;
  const json = serializeSafelightState(state);
  if (parseSafelightState(json) === null) return;
  storage.setItem(SAFELIGHT_STORAGE_KEY, json);
}
