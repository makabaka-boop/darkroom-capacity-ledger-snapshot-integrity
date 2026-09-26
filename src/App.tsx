import { useEffect, useMemo, useState } from 'react';
import {
  computeMix,
  validateInputs,
  N_MIN,
  N_MAX,
  TANKS_MIN,
  TANKS_MAX,
  VOLUME_MIN,
  VOLUME_MAX,
  type MeasureStep,
  type RawInputs,
} from './lib/dilution';
import {
  defaultLedgerDeps,
  validateBatchName,
  validateCapacityInput,
  type MixSourceSnapshot,
} from './lib/capacityLedger';
import {
  browserStorage,
  commitLedger,
  loadLedgerDocument,
  LEDGER_STORAGE_KEY,
  type CommitOutcome,
  type LedgerDocument,
  type LedgerIntent,
} from './lib/ledgerStorage';
import { loadSafelightState, saveSafelightState } from './lib/safelightStorage';
import type { SafelightState } from './lib/safelightTest';
import Ledger from './Ledger';
import Safelight from './Safelight';

type View = 'mix' | 'ledger' | 'safelight';

const FIELDS: Array<{
  key: keyof RawInputs;
  label: string;
  hint: string;
  testId: string;
  errorTestId: string;
}> = [
  {
    key: 'n',
    label: '稀释式 1 + n',
    hint: `n 为 ${N_MIN}–${N_MAX} 的整数`,
    testId: 'input-n',
    errorTestId: 'error-n',
  },
  {
    key: 'total',
    label: '目标总量 (mL)',
    hint: `${VOLUME_MIN}–${VOLUME_MAX} mL 的整数`,
    testId: 'input-total',
    errorTestId: 'error-total',
  },
  {
    key: 'capacity',
    label: '量筒容量 (mL)',
    hint: `${VOLUME_MIN}–${VOLUME_MAX} mL 的整数`,
    testId: 'input-capacity',
    errorTestId: 'error-capacity',
  },
  {
    key: 'tanks',
    label: '显影罐数量',
    hint: `${TANKS_MIN}–${TANKS_MAX} 的整数`,
    testId: 'input-tanks',
    errorTestId: 'error-tanks',
  },
];

export default function App() {
  // 默认进入配液计算；容量台账、安全灯测试通过顶部入口切换，三者状态互不干扰。
  const [view, setView] = useState<View>('mix');
  const [raw, setRaw] = useState<RawInputs>({ n: '4', total: '1000', capacity: '250', tanks: '1' });
  const [checked, setChecked] = useState<boolean[]>([]);

  // 容量台账文档（台账 + 修订号）由本组件持有：
  // - 初始化时从 localStorage 读取（损坏则置空并提示，且不再写回覆盖原文）；
  // - 所有写入都走 commitLedger 乐观并发提交，保证跨标签不覆盖、容量不为负；
  // - 监听 storage 事件：其他标签写入后本页自动对齐同一批次集合、记录顺序与剩余量。
  const storage = useMemo(() => browserStorage(), []);
  const ledgerDeps = useMemo(() => defaultLedgerDeps(), []);
  const [ledgerLoad] = useState(() => loadLedgerDocument(storage));
  const [doc, setDoc] = useState<LedgerDocument>(ledgerLoad.doc);
  const [ledgerCorrupted, setLedgerCorrupted] = useState(!ledgerLoad.ok);
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);

  // 其他标签页提交后，storage 事件把最新文档推送到本页：
  // 比较修订号，避免重复渲染；损坏的外部写入不同步（交由提交路径处理）。
  useEffect(() => {
    if (typeof window === 'undefined' || !window.addEventListener) return;
    const syncFromStorage = (event: StorageEvent) => {
      if (event.key !== LEDGER_STORAGE_KEY) return;
      const load = loadLedgerDocument(storage);
      if (!load.ok) {
        setLedgerCorrupted(true);
        return;
      }
      setDoc((current) => (load.doc.revision === current.revision ? current : load.doc));
    };
    window.addEventListener('storage', syncFromStorage);
    return () => window.removeEventListener('storage', syncFromStorage);
  }, [storage]);

  /**
   * 跨标签安全的台账提交：以当前文档修订号为基准，
   * 在存储最新台账上重放命令并原子写回。
   * 任何失败（冲突 / 存储拒绝 / 损坏）都只拒绝当前动作，
   * 并把视图对齐到存储中的最后完整台账，绝不保留「假装成功」的本地状态。
   */
  const commit = (intent: LedgerIntent): CommitOutcome => {
    const outcome = commitLedger(storage, doc, intent, ledgerDeps);
    if (outcome.ok) {
      // 只有真正写回成功（损坏原文被一次有意的新提交覆盖）才解除损坏标记
      setDoc(outcome.doc);
      setLedgerCorrupted(false);
    } else if (outcome.kind === 'conflict' || outcome.kind === 'storage') {
      // 视图对齐最新（冲突）或保持最后完整（存储失败）台账；损坏标记维持原样
      setDoc(outcome.doc);
    } else if (outcome.kind === 'corrupted') {
      setDoc(outcome.doc);
      setLedgerCorrupted(true);
    }
    return outcome;
  };

  // 安全灯测试状态由本组件持有并持久化到独立的 localStorage 键，与台账互不影响。
  // 存档损坏时 loadSafelightState 报告 corrupted，界面就地提示。
  const [safelightLoad] = useState(() => loadSafelightState(browserStorage()));
  const [safelight, setSafelight] = useState<SafelightState>(safelightLoad.state);
  const [safelightCorrupted, setSafelightCorrupted] = useState(safelightLoad.corrupted);
  // 存档损坏时只在当前页面回退到空白视图：禁止首屏 effect 把浏览器中的
  // 原文档覆盖成空记录（否则最近一次可追溯数据会在未经确认时永久丢失）。
  // 只有命令成功产出新数据（创建 / 评估）后 handleSafelightChange 清除损坏标记，
  // 之后的写入才是操作员有意开始的新记录。
  useEffect(() => {
    if (safelightCorrupted) return;
    saveSafelightState(browserStorage(), safelight);
  }, [safelight, safelightCorrupted]);

  const handleSafelightChange = (next: SafelightState) => {
    // 新数据由命令产出，覆盖损坏存档是操作员的有意行为，提示随之消失
    setSafelightCorrupted(false);
    setSafelight(next);
  };

  // 「存入容量台账」表单（仅在配液结果合法时出现）
  const [storeName, setStoreName] = useState('');
  const [storeCapacity, setStoreCapacity] = useState('');
  const [storeNameError, setStoreNameError] = useState<string | null>(null);
  const [storeCapacityError, setStoreCapacityError] = useState<string | null>(null);
  // 跨标签冲突 / 存储写入失败等动作级错误（非字段校验问题）
  const [storeCommitError, setStoreCommitError] = useState<string | null>(null);

  // 每次输入变化都重新校验、重新计算；任一字段非法则 result 为 null，
  // 旧配液卡随之卸载，不会残留。
  const { inputs, errors } = useMemo(() => validateInputs(raw), [raw]);
  const result = useMemo(() => (inputs ? computeMix(inputs) : null), [inputs]);

  // 展示步骤 = 各罐步骤按罐号顺序拼接（罐数为 1 时即整批步骤）。
  const displaySteps = useMemo(
    () => (result ? result.tankPlans.flatMap((tank) => tank.steps) : []),
    [result],
  );
  // 每罐第一步在展示序列中的下标，用于定位跨罐的勾选状态。
  const tankOffsets = useMemo(() => {
    if (!result) return [];
    const offsets: number[] = [];
    let next = 0;
    for (const tank of result.tankPlans) {
      offsets.push(next);
      next += tank.steps.length;
    }
    return offsets;
  }, [result]);

  // 任一参数变化都会得到新的 result，全部勾选状态随之清空。
  useEffect(() => {
    setChecked(displaySteps.map(() => false));
  }, [displaySteps]);

  // 待建档的名称 / 额定容量只从属于「当前这一次」配液参数：
  // 参数一变化（含变为非法导致结果消失）就重置草稿与错误，
  // 避免旧名称、旧额定容量附着在新计算结果上被误存入台账。
  // 依赖原始参数串而非 result：切换顶部标签页会重挂载结果区、产生新的 result，
  // 但参数未变，草稿应保留（与配液表单/结果跨标签保留的行为一致）。
  const rawSignature = `${raw.n}|${raw.total}|${raw.capacity}|${raw.tanks}`;
  useEffect(() => {
    setStoreName('');
    setStoreCapacity('');
    setStoreNameError(null);
    setStoreCapacityError(null);
    setStoreCommitError(null);
  }, [rawSignature]);

  const doneCount = checked.filter(Boolean).length;
  const stepsSum = displaySteps.reduce((sum, s) => sum + s.amount, 0);
  const cardDate = useMemo(() => new Date().toLocaleDateString('zh-CN'), [result]);

  const setField = (key: keyof RawInputs) => (event: React.ChangeEvent<HTMLInputElement>) => {
    setRaw((prev) => ({ ...prev, [key]: event.target.value }));
  };

  const toggleStep = (index: number) => {
    setChecked((prev) => prev.map((value, i) => (i === index ? !value : value)));
  };

  // 把本次配液结果连同批次一并写入容量台账，随后切换过去展示来源摘要。
  // 名称或容量校验失败时就地说明原因：不切换页面、不写入台账。
  // 跨标签冲突 / 存储写入失败同样不切换页面、不写入，就地说明并保留最后完整台账。
  const submitStoreToLedger = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!result) return;
    const nameErr = validateBatchName(storeName);
    const capacityErr = validateCapacityInput(storeCapacity);
    setStoreNameError(nameErr ?? null);
    setStoreCapacityError(capacityErr ?? null);
    setStoreCommitError(null);
    if (nameErr || capacityErr) return;

    // 快照逐字段取自当前这一次计算结果（同一 result），不做任何重算
    const mixSource: MixSourceSnapshot = {
      n: result.n,
      total: result.total,
      capacity: result.capacity,
      tanks: result.tanks,
      concentrate: result.concentrate,
      water: result.water,
    };
    const outcome = commit({
      type: 'createBatch',
      input: { name: storeName, capacity: storeCapacity, mixSource },
    });
    if (outcome.ok) {
      const created = outcome.intent.result.ok ? outcome.intent.result.value : null;
      setSelectedBatchId(created ? created.id : null);
      setStoreName('');
      setStoreCapacity('');
      setStoreCommitError(null);
      setView('ledger');
      return;
    }
    if (outcome.kind === 'rejected') {
      // 命令级失败（如快照不完整）就地说明，不切换页面、不写入台账
      const commandError = outcome.intent.result.ok ? null : outcome.intent.result.error;
      if (commandError === '请输入药液名称') setStoreNameError(commandError);
      else if (commandError) setStoreCapacityError(commandError);
      return;
    }
    // 冲突 / 存储失败 / 损坏：未建档、未切换页面，表单保留便于核对重试
    setStoreCommitError(outcome.error);
  };

  // tankNumber 仅在分罐时传入：步骤名称必须显式包含罐号，
  // 否则不同罐中相同的液体/次数步骤对读屏用户无法区分。
  const renderStep = (step: MeasureStep, index: number, capacity: number, tankNumber?: number) => (
    <li key={`${step.liquid}-${step.step}-${index}`} data-testid="measure-step">
      <label className={checked[index] ? 'step step--done' : 'step'}>
        <input
          type="checkbox"
          data-testid="step-checkbox"
          checked={checked[index] ?? false}
          onChange={() => toggleStep(index)}
        />
        <span>
          {tankNumber !== undefined && `罐 ${tankNumber}：`}
          {step.liquidLabel} 第 {step.step}/{step.ofSteps} 次：量取{' '}
          <strong data-testid="step-amount">{step.amount}</strong> mL
          {step.amount === capacity ? '（满量筒）' : '（余量）'}
        </span>
      </label>
    </li>
  );

  return (
    <div className="app">
      <header className="no-print">
        <h1>暗房配液台</h1>
        <p className="tagline">按 1+n 稀释式计算浓缩液与清水，自动拆分量筒量取步骤</p>
        <nav className="view-nav" aria-label="功能切换">
          <button
            type="button"
            className={`nav-tab${view === 'mix' ? ' nav-tab--active' : ''}`}
            data-testid="nav-mix"
            aria-pressed={view === 'mix'}
            onClick={() => setView('mix')}
          >
            配液计算
          </button>
          <button
            type="button"
            className={`nav-tab${view === 'ledger' ? ' nav-tab--active' : ''}`}
            data-testid="nav-ledger"
            aria-pressed={view === 'ledger'}
            onClick={() => setView('ledger')}
          >
            容量台账
          </button>
          <button
            type="button"
            className={`nav-tab${view === 'safelight' ? ' nav-tab--active' : ''}`}
            data-testid="nav-safelight"
            aria-pressed={view === 'safelight'}
            onClick={() => setView('safelight')}
          >
            安全灯测试
          </button>
        </nav>
      </header>

      {view === 'ledger' ? (
        <main>
          <Ledger
            doc={doc}
            onCommit={commit}
            selectedId={selectedBatchId}
            onSelectBatch={setSelectedBatchId}
            storageCorrupted={ledgerCorrupted}
          />
        </main>
      ) : view === 'safelight' ? (
        <main>
          <Safelight
            safelight={safelight}
            onSafelightChange={handleSafelightChange}
            storageCorrupted={safelightCorrupted}
          />
        </main>
      ) : (
      <main>
        <section className="panel no-print" aria-label="配液参数">
          <div className="fields">
            {FIELDS.map(({ key, label, hint, testId, errorTestId }) => (
              <div className={`field${errors[key] ? ' field--invalid' : ''}`} key={key}>
                <label htmlFor={testId}>{label}</label>
                <input
                  id={testId}
                  data-testid={testId}
                  inputMode="numeric"
                  value={raw[key]}
                  onChange={setField(key)}
                  aria-invalid={Boolean(errors[key])}
                  aria-describedby={`${errorTestId} ${testId}-hint`}
                />
                <small id={`${testId}-hint`} className="hint">
                  {hint}
                </small>
                {errors[key] && (
                  <p className="error" role="alert" id={errorTestId} data-testid={errorTestId}>
                    {errors[key]}
                  </p>
                )}
              </div>
            ))}
          </div>
        </section>

        {result && (
          <>
            <section className="panel result no-print" data-testid="result-card" aria-label="配液结果">
              <h2>
                配液结果 <span className="ratio">1+{result.n}</span>
                {result.tanks > 1 && <span className="ratio">{result.tanks} 罐</span>}
              </h2>
              <dl className="summary">
                <div>
                  <dt>浓缩液</dt>
                  <dd data-testid="result-concentrate">{result.concentrate} mL</dd>
                </div>
                <div>
                  <dt>清水</dt>
                  <dd data-testid="result-water">{result.water} mL</dd>
                </div>
                <div>
                  <dt>合计</dt>
                  <dd data-testid="result-total">{result.concentrate + result.water} mL</dd>
                </div>
              </dl>
              <p className="note" data-testid="result-exact">
                浓缩液精确值 {result.exactConcentrate.toFixed(2)} mL，按 0.5 mL 为界取整为{' '}
                {result.concentrate} mL；清水 = 目标总量 {result.total} mL − 取整后浓缩液。
              </p>

              {result.tanks === 1 ? (
                <>
                  <h3>
                    量取步骤
                    <span
                      className="progress"
                      data-testid="steps-progress"
                      role="status"
                      aria-live="polite"
                      aria-atomic="true"
                    >
                      已勾选 {doneCount}/{displaySteps.length}
                    </span>
                  </h3>
                  <ol className="steps">
                    {displaySteps.map((step, index) => renderStep(step, index, result.capacity))}
                  </ol>
                </>
              ) : (
                <>
                  <p className="note" data-testid="tank-note">
                    整批工作液只算一次，按下表分装 {result.tanks} 只显影罐：目标总量与浓缩液分别均分，
                    余量依次补给前面的罐，各罐总量相差不超过 1 mL。
                  </p>
                  <h3>
                    分罐量取步骤
                    <span
                      className="progress"
                      data-testid="steps-progress"
                      role="status"
                      aria-live="polite"
                      aria-atomic="true"
                    >
                      已勾选 {doneCount}/{displaySteps.length}
                    </span>
                  </h3>
                  {result.tankPlans.map((tank, tankIndex) => (
                    <section className="tank-plan" data-testid="tank-plan" key={tank.index}>
                      <h4 data-testid="tank-title">
                        罐 {tank.index}：目标 {tank.total} mL ＝ 浓缩液 {tank.concentrate} mL ＋ 清水{' '}
                        {tank.water} mL
                      </h4>
                      <ol className="steps">
                        {tank.steps.map((step, i) =>
                          renderStep(step, tankOffsets[tankIndex] + i, result.capacity, tank.index),
                        )}
                      </ol>
                    </section>
                  ))}
                </>
              )}
              <p className="note" data-testid="steps-sum">
                校验：每步 ≤ 量筒容量 {result.capacity} mL；各步合计 {stepsSum} mL = 目标总量{' '}
                {result.total} mL{stepsSum === result.total ? ' ✓' : ' ✗'}
              </p>

              <button type="button" className="print-button" onClick={() => window.print()}>
                打印配液卡
              </button>

              <div className="store-ledger" data-testid="store-to-ledger">
                <h3>存入容量台账</h3>
                <p className="note">
                  把本次配液参数（1+{result.n}、总量 {result.total} mL、显影罐 {result.tanks}{' '}
                  只）随批次固定保存，台账中可追溯来源。
                </p>
                <form onSubmit={submitStoreToLedger} noValidate>
                  <div className="fields">
                    <div className={`field${storeNameError ? ' field--invalid' : ''}`}>
                      <label htmlFor="store-name-input">药液批次名称</label>
                      <input
                        id="store-name-input"
                        data-testid="store-name-input"
                        value={storeName}
                        onChange={(event) => {
                          setStoreName(event.target.value);
                          setStoreNameError(null);
                          setStoreCommitError(null);
                        }}
                        aria-invalid={Boolean(storeNameError)}
                        aria-describedby="error-store-name store-name-hint"
                      />
                      <small id="store-name-hint" className="hint">
                        如：D-76 显影液（2026-09 配制）
                      </small>
                      {storeNameError && (
                        <p
                          className="error"
                          role="alert"
                          id="error-store-name"
                          data-testid="error-store-name"
                        >
                          {storeNameError}
                        </p>
                      )}
                    </div>
                    <div className={`field${storeCapacityError ? ' field--invalid' : ''}`}>
                      <label htmlFor="store-capacity-input">额定处理容量（等效胶片数）</label>
                      <input
                        id="store-capacity-input"
                        data-testid="store-capacity-input"
                        inputMode="numeric"
                        value={storeCapacity}
                        onChange={(event) => {
                          setStoreCapacity(event.target.value);
                          setStoreCapacityError(null);
                          setStoreCommitError(null);
                        }}
                        aria-invalid={Boolean(storeCapacityError)}
                        aria-describedby="error-store-capacity store-capacity-hint"
                      />
                      <small id="store-capacity-hint" className="hint">
                        整批药液可处理的等效胶片总数，正整数
                      </small>
                      {storeCapacityError && (
                        <p
                          className="error"
                          role="alert"
                          id="error-store-capacity"
                          data-testid="error-store-capacity"
                        >
                          {storeCapacityError}
                        </p>
                      )}
                    </div>
                  </div>
                  <button
                    type="submit"
                    className="action-button"
                    data-testid="store-to-ledger-button"
                  >
                    存入容量台账
                  </button>
                  {storeCommitError && (
                    <p className="error ledger-banner" role="alert" data-testid="store-ledger-error">
                      {storeCommitError}
                    </p>
                  )}
                </form>
              </div>
            </section>

            {result.tanks === 1 ? (
              <section className="print-card" data-testid="print-card" aria-label="配液卡">
                <h2>暗房配液卡</h2>
                <table>
                  <tbody>
                    <tr>
                      <th>日期</th>
                      <td>{cardDate}</td>
                      <th>稀释式</th>
                      <td>1+{result.n}</td>
                    </tr>
                    <tr>
                      <th>目标总量</th>
                      <td>{result.total} mL</td>
                      <th>量筒容量</th>
                      <td>{result.capacity} mL</td>
                    </tr>
                    <tr>
                      <th>浓缩液</th>
                      <td>{result.concentrate} mL</td>
                      <th>清水</th>
                      <td>{result.water} mL</td>
                    </tr>
                  </tbody>
                </table>
                <h3>量取步骤</h3>
                <table>
                  <thead>
                    <tr>
                      <th>✓</th>
                      <th>液体</th>
                      <th>次数</th>
                      <th>体积</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.steps.map((step, stepIndex) => (
                      <tr key={`card-${step.liquid}-${step.step}`}>
                        <td className="box" data-testid="print-step-box">
                          {checked[stepIndex] ? '☑' : '☐'}
                        </td>
                        <td>{step.liquidLabel}</td>
                        <td>
                          {step.step}/{step.ofSteps}
                        </td>
                        <td>{step.amount} mL</td>
                      </tr>
                    ))}
                    <tr className="total-row">
                      <td colSpan={3}>合计</td>
                      <td>{stepsSum} mL</td>
                    </tr>
                  </tbody>
                </table>
                <p className="sign">配制人：＿＿＿＿＿＿　复核人：＿＿＿＿＿＿</p>
              </section>
            ) : (
              <section className="print-card" data-testid="print-card" aria-label="配液卡">
                <h2>暗房配液卡</h2>
                <table>
                  <tbody>
                    <tr>
                      <th>日期</th>
                      <td>{cardDate}</td>
                      <th>稀释式</th>
                      <td>1+{result.n}</td>
                    </tr>
                    <tr>
                      <th>目标总量</th>
                      <td>{result.total} mL</td>
                      <th>量筒容量</th>
                      <td>{result.capacity} mL</td>
                    </tr>
                    <tr>
                      <th>浓缩液</th>
                      <td>{result.concentrate} mL</td>
                      <th>清水</th>
                      <td>{result.water} mL</td>
                    </tr>
                    <tr>
                      <th>显影罐数量</th>
                      <td colSpan={3}>{result.tanks} 只</td>
                    </tr>
                  </tbody>
                </table>
                {result.tankPlans.map((tank, tankIndex) => (
                  <div key={`print-tank-${tank.index}`} data-testid="print-tank">
                    <h3>
                      罐 {tank.index}：目标 {tank.total} mL（浓缩液 {tank.concentrate} mL ＋ 清水{' '}
                      {tank.water} mL）
                    </h3>
                    <table>
                      <thead>
                        <tr>
                          <th>✓</th>
                          <th>液体</th>
                          <th>次数</th>
                          <th>体积</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tank.steps.map((step, stepIndex) => (
                          <tr key={`card-tank-${tank.index}-${step.liquid}-${step.step}`}>
                            <td className="box" data-testid="print-step-box">
                              {checked[tankOffsets[tankIndex] + stepIndex] ? '☑' : '☐'}
                            </td>
                            <td>{step.liquidLabel}</td>
                            <td>
                              {step.step}/{step.ofSteps}
                            </td>
                            <td>{step.amount} mL</td>
                          </tr>
                        ))}
                        <tr className="total-row">
                          <td colSpan={3}>罐 {tank.index} 合计</td>
                          <td>{tank.total} mL</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                ))}
                <p className="batch-total" data-testid="print-batch-total">
                  整批合计 {result.total} mL（浓缩液 {result.concentrate} mL ＋ 清水 {result.water}{' '}
                  mL）
                </p>
                <p className="sign">配制人：＿＿＿＿＿＿　复核人：＿＿＿＿＿＿</p>
              </section>
            )}
          </>
        )}
      </main>
      )}
    </div>
  );
}
