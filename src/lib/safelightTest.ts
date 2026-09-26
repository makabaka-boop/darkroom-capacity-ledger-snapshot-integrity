/**
 * 安全灯测试（领域服务）。
 *
 * 暗房更换安全灯、灯距或相纸后，不能凭经验判断可安全操作的时长，
 * 需要用阶梯曝光实测：把相纸按「起始秒数 + 递增秒数」分成若干条带，
 * 在安全灯下逐级曝光，显影后观察首条出现可见灰雾的条带，
 * 其前一条的曝光时长即为安全上限，避免材料起雾。
 *
 * 契约 = 两个命令（纯函数，不修改传入状态，返回新状态）：
 * - createSafelightTest：创建测试草稿（名称 + 起始/递增秒数 + 条带数量），
 *   创建后按曝光顺序生成条带阶梯，等待观察结果；
 * - evaluateSafelightTest：登记观察结果（首条起雾条带序号，或全部未起雾）
 *   并完成评估，结论由领域规则推导：
 *   · 首条起雾为第 k 条（k ≥ 2）→ 安全上限 = 第 k−1 条的曝光时长；
 *   · 首条即起雾（k = 1）→ 安全上限低于起始值；
 *   · 全部未起雾 → 安全时长至少达到末条时长。
 *
 * 评估一旦完成不可修改：命令只写入结论、不更新、不删除；
 * 草稿与已完成结论都保存在状态中，由持久化层整体读写。
 *
 * 校验失败时返回中文原因且不产生任何写入：
 * - 名称为空；
 * - 起始 / 递增秒数为空、非整数、非正整数或超出安全整数范围；
 * - 条带数量为空、非整数或超出 2–20；
 * - 末条曝光时长超过一小时（3600 秒）；
 * - 观察结果不是本次测试的条带；
 * - 重复评估同一测试。
 * 字段校验函数同时导出，界面可借此把错误放到对应字段下方，
 * 但命令本身仍是最终闸门（同样校验在命令内再执行一次）。
 */

import { INTEGER_TOO_LARGE_MESSAGE } from './capacityLedger';

/** 单条曝光时长上限：一小时（秒）。 */
export const EXPOSURE_MAX_SECONDS = 3600;
export const STRIPS_MIN = 2;
export const STRIPS_MAX = 20;

export interface SafelightEvaluation {
  /** 首条出现可见灰雾的条带序号（1 起）；null 表示全部条带均未起雾 */
  firstFogStrip: number | null;
  /** 评估时间（ISO 8601） */
  evaluatedAt: string;
}

export interface SafelightTest {
  id: string;
  /** 测试名称（非空，已去除首尾空白） */
  name: string;
  /** 起始秒数：首条条带的曝光时长（正整数） */
  startSeconds: number;
  /** 递增秒数：相邻条带的曝光时长差（正整数） */
  stepSeconds: number;
  /** 条带数量（2–20 的整数） */
  stripCount: number;
  /** 创建时间（ISO 8601） */
  createdAt: string;
  /** 评估结论来源；未评估时不存在（草稿等待观察） */
  evaluation?: SafelightEvaluation;
}

export interface SafelightState {
  tests: SafelightTest[];
}

export const EMPTY_SAFELIGHT: SafelightState = { tests: [] };

/** 命令依赖：时间与 id 生成器可注入，便于测试复现。 */
export interface SafelightDeps {
  now: () => Date;
  nextId: () => string;
}

/** 生产环境默认依赖。 */
export function defaultSafelightDeps(): SafelightDeps {
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

export type SafelightCommandResult<T> =
  | { ok: true; value: T; state: SafelightState }
  | { ok: false; error: string };

/**
 * 严格解析整数字符串：拒绝空串、小数、非数字字符；
 * 超长数字（超过 Number.MAX_SAFE_INTEGER）也拒绝——
 * 这类数字无法精确表示，一旦入库会造成显示异常、持久化往返失败。
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

/** 阶梯曝光：按曝光顺序列出各条带时长（秒），第 k 条 = 起始 + (k−1) × 递增。 */
export function stripDurations(
  test: Pick<SafelightTest, 'startSeconds' | 'stepSeconds' | 'stripCount'>,
): number[] {
  return Array.from(
    { length: test.stripCount },
    (_, index) => test.startSeconds + index * test.stepSeconds,
  );
}

/** 末条（最长）曝光时长：一小时上限校验与持久化结构校验共用的不变量。 */
export function lastStripSeconds(
  test: Pick<SafelightTest, 'startSeconds' | 'stepSeconds' | 'stripCount'>,
): number {
  return test.startSeconds + (test.stripCount - 1) * test.stepSeconds;
}

/** 测试状态：待评估（草稿）/ 已完成。 */
export type SafelightStatus = 'pending' | 'evaluated';

export const SAFELIGHT_STATUS_LABEL: Record<SafelightStatus, string> = {
  pending: '待评估',
  evaluated: '已完成',
};

export function safelightStatus(test: SafelightTest): SafelightStatus {
  return test.evaluation ? 'evaluated' : 'pending';
}

/**
 * 安全上限结论（仅已评估的测试存在）：
 * - limit：首条起雾为第 k 条（k ≥ 2），安全上限 = 第 k−1 条时长；
 * - below-start：首条即起雾，安全上限低于起始值；
 * - at-least-last：全部未起雾，安全时长至少达到末条时长。
 */
export type SafelightConclusion =
  | { kind: 'limit'; safeSeconds: number }
  | { kind: 'below-start'; startSeconds: number }
  | { kind: 'at-least-last'; lastSeconds: number };

export function conclusionOf(test: SafelightTest): SafelightConclusion | null {
  if (!test.evaluation) return null;
  const firstFog = test.evaluation.firstFogStrip;
  if (firstFog === null) {
    return { kind: 'at-least-last', lastSeconds: lastStripSeconds(test) };
  }
  if (firstFog === 1) {
    return { kind: 'below-start', startSeconds: test.startSeconds };
  }
  return { kind: 'limit', safeSeconds: stripDurations(test)[firstFog - 2] };
}

/** 测试名称校验：空（含纯空白）不允许。 */
export function validateSafelightName(name: string): string | undefined {
  if (name.trim() === '') return '请输入测试名称';
  return undefined;
}

/** 秒数类字段的共用校验：可精确表示的正整数。 */
function validateSeconds(raw: string, label: string): string | undefined {
  if (raw.trim() === '') return `请输入${label}`;
  if (isUnsafeDigits(raw)) return INTEGER_TOO_LARGE_MESSAGE;
  const value = parseStrictInteger(raw);
  if (value === null) return `${label}必须为整数，不能含小数或字母`;
  if (value <= 0) return `${label}须为大于 0 的整数`;
  return undefined;
}

/** 起始秒数校验：可精确表示的正整数。 */
export function validateStartSeconds(raw: string): string | undefined {
  return validateSeconds(raw, '起始秒数');
}

/** 递增秒数校验：可精确表示的正整数。 */
export function validateStepSeconds(raw: string): string | undefined {
  return validateSeconds(raw, '递增秒数');
}

/** 条带数量校验：2–20 的整数。 */
export function validateStripCount(raw: string): string | undefined {
  if (raw.trim() === '') return '请输入条带数量';
  if (isUnsafeDigits(raw)) return INTEGER_TOO_LARGE_MESSAGE;
  const value = parseStrictInteger(raw);
  if (value === null) return '条带数量必须为整数，不能含小数或字母';
  if (value < STRIPS_MIN || value > STRIPS_MAX) {
    return `条带数量须为 ${STRIPS_MIN}–${STRIPS_MAX} 的整数`;
  }
  return undefined;
}

/**
 * 一小时上限校验（跨字段）：末条曝光时长不得超过 3600 秒。
 * 入参为已通过字段校验的数值；命令与持久化读取共用本校验。
 */
export function validateExposureLimit(
  startSeconds: number,
  stepSeconds: number,
  stripCount: number,
): string | undefined {
  const last = lastStripSeconds({ startSeconds, stepSeconds, stripCount });
  if (last > EXPOSURE_MAX_SECONDS) {
    return `末条曝光 ${last} 秒超过一小时上限（${EXPOSURE_MAX_SECONDS} 秒），请缩短秒数或减少条带数量`;
  }
  return undefined;
}

export interface CreateSafelightInput {
  name: string;
  /** 表单原始字符串，由命令内部校验 */
  startSeconds: string;
  stepSeconds: string;
  stripCount: string;
}

/**
 * 命令一：创建安全灯测试草稿。
 * 名称为空、秒数为空 / 非整数 / 非正整数、条带数量越界，
 * 或末条曝光超过一小时时返回原因，不写入任何记录。
 */
export function createSafelightTest(
  state: SafelightState,
  input: CreateSafelightInput,
  deps: SafelightDeps,
): SafelightCommandResult<SafelightTest> {
  const nameError = validateSafelightName(input.name);
  if (nameError) return { ok: false, error: nameError };
  const startError = validateStartSeconds(input.startSeconds);
  if (startError) return { ok: false, error: startError };
  const stepError = validateStepSeconds(input.stepSeconds);
  if (stepError) return { ok: false, error: stepError };
  const stripsError = validateStripCount(input.stripCount);
  if (stripsError) return { ok: false, error: stripsError };

  const startSeconds = parseStrictInteger(input.startSeconds)!;
  const stepSeconds = parseStrictInteger(input.stepSeconds)!;
  const stripCount = parseStrictInteger(input.stripCount)!;
  const exposureError = validateExposureLimit(startSeconds, stepSeconds, stripCount);
  if (exposureError) return { ok: false, error: exposureError };

  const test: SafelightTest = Object.freeze({
    id: deps.nextId(),
    name: input.name.trim(),
    startSeconds,
    stepSeconds,
    stripCount,
    createdAt: deps.now().toISOString(),
  });
  return { ok: true, value: test, state: { tests: [...state.tests, test] } };
}

export interface EvaluateSafelightInput {
  testId: string;
  /** 首条起雾条带序号（1 起）；null 表示全部条带均未起雾 */
  firstFogStrip: number | null;
}

/**
 * 命令二：登记观察结果并完成评估。
 * 观察结果不是本次测试的条带、测试不存在或已评估时返回原因，
 * 不写入任何记录；成功后结论冻结，不可再改。
 */
export function evaluateSafelightTest(
  state: SafelightState,
  input: EvaluateSafelightInput,
  deps: SafelightDeps,
): SafelightCommandResult<SafelightTest> {
  const test = state.tests.find((candidate) => candidate.id === input.testId);
  if (!test) {
    return { ok: false, error: '测试不存在或已被移除' };
  }
  if (test.evaluation) {
    return { ok: false, error: '该测试已完成评估，结论不可修改' };
  }
  const firstFog = input.firstFogStrip;
  if (
    firstFog !== null &&
    (!Number.isSafeInteger(firstFog) || firstFog < 1 || firstFog > test.stripCount)
  ) {
    return { ok: false, error: '观察结果无效：请选择本次测试中首条起雾的条带' };
  }
  const evaluated: SafelightTest = Object.freeze({
    ...test,
    evaluation: Object.freeze({
      firstFogStrip: firstFog,
      evaluatedAt: deps.now().toISOString(),
    }),
  });
  return {
    ok: true,
    value: evaluated,
    state: {
      tests: state.tests.map((candidate) => (candidate.id === test.id ? evaluated : candidate)),
    },
  };
}
