/**
 * 暗房配液核心计算。
 *
 * 规则（全部由本模块实时计算，界面不使用任何固定结果）：
 * - 稀释式 1+n：n 为 1–99 的整数；
 * - 目标总量、量筒容量：100–5000 mL 的整数；
 * - 显影罐数量：1–20 的整数（默认 1，即整批不分罐）；
 * - 浓缩液精确值 = 总量 ÷ (n+1)，以 0.5 mL 为界四舍五入到整数；
 * - 清水量 = 目标总量 − 取整后的浓缩液，保证两者之和恒等于目标总量；
 * - 单项液体超过量筒容量时，拆成「若干满量筒 + 最后余量」；
 *   恰好等于容量时不产生零余量步骤；
 * - 分罐：整批只算一次工作液，再把目标总量与浓缩液分别按罐均分，
 *   不能整除的余量依次补给前面的罐；每罐清水 = 该罐目标量 − 该罐浓缩液，
 *   因此各罐汇总严格还原整批结果，且各罐总量相差不超过 1 mL。
 */

export const N_MIN = 1;
export const N_MAX = 99;
export const VOLUME_MIN = 100;
export const VOLUME_MAX = 5000;
export const TANKS_MIN = 1;
export const TANKS_MAX = 20;

export interface RawInputs {
  n: string;
  total: string;
  capacity: string;
  tanks: string;
}

export interface MixInputs {
  n: number;
  total: number;
  capacity: number;
  tanks: number;
}

export interface FieldErrors {
  n?: string;
  total?: string;
  capacity?: string;
  tanks?: string;
}

export type LiquidKind = 'concentrate' | 'water';

export interface MeasureStep {
  liquid: LiquidKind;
  liquidLabel: string;
  /** 本步量取体积（mL），保证 ≤ 量筒容量 */
  amount: number;
  /** 该液体的第几步（从 1 开始） */
  step: number;
  /** 该液体共需几步 */
  ofSteps: number;
}

export interface TankPlan {
  /** 罐号（从 1 开始） */
  index: number;
  /** 该罐目标量（mL） */
  total: number;
  /** 该罐浓缩液（mL） */
  concentrate: number;
  /** 该罐清水（mL），= 该罐目标量 − 该罐浓缩液 */
  water: number;
  /** 该罐受量筒容量约束的量取步骤 */
  steps: MeasureStep[];
}

export interface MixResult {
  n: number;
  total: number;
  capacity: number;
  /** 显影罐数量 */
  tanks: number;
  /** 浓缩液精确值（未取整），仅用于展示 */
  exactConcentrate: number;
  /** 取整后的浓缩液体积（mL） */
  concentrate: number;
  /** 清水体积（mL），= total − concentrate */
  water: number;
  /** 整批量取步骤（罐数为 1 时与罐 1 的步骤一致） */
  steps: MeasureStep[];
  /** 分罐计划：按罐号排列，各罐汇总严格还原整批结果 */
  tankPlans: TankPlan[];
}

/** 以 0.5 为界四舍五入到整数（0.5 进位）。 */
export function roundHalfUpToInt(value: number): number {
  return Math.floor(value + 0.5);
}

/** 严格解析整数字符串：拒绝空串、小数、非数字字符。 */
function parseStrictInteger(raw: string): number | null {
  const text = raw.trim();
  if (text === '') return null;
  if (!/^[+-]?\d+$/.test(text)) return null;
  return Number.parseInt(text, 10);
}

export function validateField(field: keyof RawInputs, raw: string): string | undefined {
  if (raw.trim() === '') return '请输入数值';
  const value = parseStrictInteger(raw);
  if (value === null) return '必须为整数，不能含小数或字母';
  if (field === 'n') {
    if (value < N_MIN || value > N_MAX) {
      return `n 须为 ${N_MIN}–${N_MAX} 的整数`;
    }
  } else if (field === 'tanks') {
    if (value < TANKS_MIN || value > TANKS_MAX) {
      return `罐数须为 ${TANKS_MIN}–${TANKS_MAX} 的整数`;
    }
  } else if (value < VOLUME_MIN || value > VOLUME_MAX) {
    return `须为 ${VOLUME_MIN}–${VOLUME_MAX} mL 的整数`;
  }
  return undefined;
}

/**
 * 校验全部输入。任一字段非法时 inputs 为 null，
 * 调用方必须丢弃旧配液结果（不保留旧配液卡）。
 */
export function validateInputs(raw: RawInputs): {
  inputs: MixInputs | null;
  errors: FieldErrors;
} {
  const errors: FieldErrors = {
    n: validateField('n', raw.n),
    total: validateField('total', raw.total),
    capacity: validateField('capacity', raw.capacity),
    tanks: validateField('tanks', raw.tanks),
  };
  if (errors.n || errors.total || errors.capacity || errors.tanks) {
    return { inputs: null, errors };
  }
  return {
    inputs: {
      n: Number.parseInt(raw.n.trim(), 10),
      total: Number.parseInt(raw.total.trim(), 10),
      capacity: Number.parseInt(raw.capacity.trim(), 10),
      tanks: Number.parseInt(raw.tanks.trim(), 10),
    },
    errors: {},
  };
}

/**
 * 把单项液体体积拆成量取步骤：若干满量筒 + 最后余量。
 * 体积恰好为容量整数倍时不追加零余量步骤；体积为 0 时返回空数组。
 */
export function splitVolume(volume: number, capacity: number): number[] {
  const amounts: number[] = [];
  let remaining = volume;
  while (remaining > capacity) {
    amounts.push(capacity);
    remaining -= capacity;
  }
  if (remaining > 0) {
    amounts.push(remaining);
  }
  return amounts;
}

function toSteps(liquid: LiquidKind, liquidLabel: string, amounts: number[]): MeasureStep[] {
  return amounts.map((amount, index) => ({
    liquid,
    liquidLabel,
    amount,
    step: index + 1,
    ofSteps: amounts.length,
  }));
}

/**
 * 把总体积按罐均分：每罐先得 ⌊volume ÷ tanks⌋，
 * 不能整除的余量按罐号顺序依次各补 1 mL 给前面的罐。
 * 任意两罐相差不超过 1 mL，且各罐之和严格等于 volume。
 */
export function distributeVolume(volume: number, tanks: number): number[] {
  const base = Math.floor(volume / tanks);
  const remainder = volume - base * tanks;
  return Array.from({ length: tanks }, (_, i) => base + (i < remainder ? 1 : 0));
}

/** 由合法输入计算完整配液结果（含分罐计划）。 */
export function computeMix(inputs: MixInputs): MixResult {
  const { n, total, capacity, tanks } = inputs;
  const exactConcentrate = total / (n + 1);
  const concentrate = roundHalfUpToInt(exactConcentrate);
  // 清水必须由目标总量减去取整后的浓缩液，保证两者之和不变。
  const water = total - concentrate;
  const steps = [
    ...toSteps('concentrate', '浓缩液', splitVolume(concentrate, capacity)),
    ...toSteps('water', '清水', splitVolume(water, capacity)),
  ];
  // 整批只算一次工作液，再把目标总量与浓缩液分别按罐均分（余量补给前面的罐）；
  // 每罐清水由该罐目标量减去该罐浓缩液得出，因此各罐汇总严格还原整批结果。
  const tankTotals = distributeVolume(total, tanks);
  const tankConcentrates = distributeVolume(concentrate, tanks);
  const tankPlans = tankTotals.map((tankTotal, i) => {
    const tankConcentrate = tankConcentrates[i];
    const tankWater = tankTotal - tankConcentrate;
    return {
      index: i + 1,
      total: tankTotal,
      concentrate: tankConcentrate,
      water: tankWater,
      steps: [
        ...toSteps('concentrate', '浓缩液', splitVolume(tankConcentrate, capacity)),
        ...toSteps('water', '清水', splitVolume(tankWater, capacity)),
      ],
    };
  });
  return { n, total, capacity, tanks, exactConcentrate, concentrate, water, steps, tankPlans };
}
