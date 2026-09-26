import { useMemo, useState } from 'react';
import {
  conclusionOf,
  createSafelightTest,
  defaultSafelightDeps,
  evaluateSafelightTest,
  EXPOSURE_MAX_SECONDS,
  lastStripSeconds,
  SAFELIGHT_STATUS_LABEL,
  safelightStatus,
  STRIPS_MAX,
  STRIPS_MIN,
  stripDurations,
  validateSafelightName,
  validateStartSeconds,
  validateStepSeconds,
  validateStripCount,
  type SafelightState,
} from './lib/safelightTest';

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('zh-CN', { hour12: false });
}

export interface SafelightProps {
  /** 当前安全灯测试状态（由 App 持有并持久化到独立存储键） */
  safelight: SafelightState;
  /** 命令产出新状态后回写 */
  onSafelightChange: (next: SafelightState) => void;
  /** 存储内容损坏：就地提示 */
  storageCorrupted: boolean;
}

/**
 * 安全灯测试视图：创建阶梯曝光测试 → 按曝光顺序逐级曝光 →
 * 选择首条出现可见灰雾的条带并完成评估 → 得出安全操作上限。
 * 所有写入都经过领域命令，失败原因就地展示；草稿与结论由 App 持久化，
 * 刷新后还原。评估一旦完成不可修改。
 */
export default function Safelight({
  safelight,
  onSafelightChange,
  storageCorrupted,
}: SafelightProps) {
  const deps = useMemo(() => defaultSafelightDeps(), []);

  // 新建测试表单
  const [name, setName] = useState('');
  const [start, setStart] = useState('');
  const [step, setStep] = useState('');
  const [strips, setStrips] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [stepError, setStepError] = useState<string | null>(null);
  const [stripsError, setStripsError] = useState<string | null>(null);
  const [exposureError, setExposureError] = useState<string | null>(null);

  // 当前选中查看的测试
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // 观察结果草稿：undefined = 尚未选择；null = 全部未起雾；数字 = 首条起雾条带序号
  const [fogChoice, setFogChoice] = useState<number | null | undefined>(undefined);
  const [observationError, setObservationError] = useState<string | null>(null);

  const selected = safelight.tests.find((test) => test.id === selectedId) ?? null;

  // 草稿隔离：切换到另一条测试时，未提交的观察选择与缺失提示立即丢弃，
  // 不会把 A 上选了一半的条带带到 B（否则 B 直接提交会沿用 A 的选择得出结论）。
  const selectTest = (id: string) => {
    if (id !== selectedId) {
      setFogChoice(undefined);
      setObservationError(null);
    }
    setSelectedId(id);
  };

  const submitCreate = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // 先把字段级错误放到对应输入框下方；命令仍会再校验一次（最终闸门）
    const nameErr = validateSafelightName(name);
    const startErr = validateStartSeconds(start);
    const stepErr = validateStepSeconds(step);
    const stripsErr = validateStripCount(strips);
    setNameError(nameErr ?? null);
    setStartError(startErr ?? null);
    setStepError(stepErr ?? null);
    setStripsError(stripsErr ?? null);
    setExposureError(null);
    if (nameErr || startErr || stepErr || stripsErr) return;

    const result = createSafelightTest(
      safelight,
      { name, startSeconds: start, stepSeconds: step, stripCount: strips },
      deps,
    );
    if (!result.ok) {
      // 命令级失败（含末条曝光超过一小时）就地说明，不写入
      setExposureError(result.error);
      return;
    }
    onSafelightChange(result.state);
    setSelectedId(result.value.id);
    // 新测试自身从未观察：清掉此前选中测试上残留的草稿与提示
    setFogChoice(undefined);
    setObservationError(null);
    setName('');
    setStart('');
    setStep('');
    setStrips('');
  };

  const submitEvaluation = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected) return;
    if (fogChoice === undefined) {
      // 缺失观察：就地反馈，不写入
      setObservationError('请选择观察结果：首条出现可见灰雾的条带，或「全部未起雾」');
      return;
    }
    const result = evaluateSafelightTest(
      safelight,
      { testId: selected.id, firstFogStrip: fogChoice },
      deps,
    );
    if (!result.ok) {
      setObservationError(result.error);
      return;
    }
    onSafelightChange(result.state);
    setFogChoice(undefined);
  };

  const selectedDurations = selected ? stripDurations(selected) : [];
  const selectedConclusion = selected ? conclusionOf(selected) : null;

  return (
    <>
      {storageCorrupted && (
        <p className="storage-warning" role="alert" data-testid="safelight-storage-corrupted">
          安全灯测试存档已损坏，无法读取；浏览器中的原数据未被覆盖，新建测试后将重新开始记录。
        </p>
      )}

      <section className="panel no-print" aria-label="新建安全灯测试">
        <h2 className="panel-title">新建安全灯测试</h2>
        <form onSubmit={submitCreate} noValidate>
          <div className="fields">
            <div className={`field${nameError ? ' field--invalid' : ''}`}>
              <label htmlFor="safelight-name-input">测试名称</label>
              <input
                id="safelight-name-input"
                data-testid="safelight-name-input"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setNameError(null);
                  setExposureError(null);
                }}
                aria-invalid={Boolean(nameError)}
                aria-describedby="error-safelight-name safelight-name-hint"
              />
              <small id="safelight-name-hint" className="hint">
                如：红色安全灯 1 米 + ILFORD MGIV 相纸
              </small>
              {nameError && (
                <p
                  className="error"
                  role="alert"
                  id="error-safelight-name"
                  data-testid="error-safelight-name"
                >
                  {nameError}
                </p>
              )}
            </div>
            <div className={`field${startError ? ' field--invalid' : ''}`}>
              <label htmlFor="safelight-start-input">起始秒数</label>
              <input
                id="safelight-start-input"
                data-testid="safelight-start-input"
                inputMode="numeric"
                value={start}
                onChange={(event) => {
                  setStart(event.target.value);
                  setStartError(null);
                  setExposureError(null);
                }}
                aria-invalid={Boolean(startError)}
                aria-describedby="error-safelight-start safelight-start-hint"
              />
              <small id="safelight-start-hint" className="hint">
                首条条带的曝光时长，正整数秒
              </small>
              {startError && (
                <p
                  className="error"
                  role="alert"
                  id="error-safelight-start"
                  data-testid="error-safelight-start"
                >
                  {startError}
                </p>
              )}
            </div>
            <div className={`field${stepError ? ' field--invalid' : ''}`}>
              <label htmlFor="safelight-step-input">递增秒数</label>
              <input
                id="safelight-step-input"
                data-testid="safelight-step-input"
                inputMode="numeric"
                value={step}
                onChange={(event) => {
                  setStep(event.target.value);
                  setStepError(null);
                  setExposureError(null);
                }}
                aria-invalid={Boolean(stepError)}
                aria-describedby="error-safelight-step safelight-step-hint"
              />
              <small id="safelight-step-hint" className="hint">
                相邻条带的曝光时长差，正整数秒
              </small>
              {stepError && (
                <p
                  className="error"
                  role="alert"
                  id="error-safelight-step"
                  data-testid="error-safelight-step"
                >
                  {stepError}
                </p>
              )}
            </div>
            <div className={`field${stripsError ? ' field--invalid' : ''}`}>
              <label htmlFor="safelight-strips-input">条带数量</label>
              <input
                id="safelight-strips-input"
                data-testid="safelight-strips-input"
                inputMode="numeric"
                value={strips}
                onChange={(event) => {
                  setStrips(event.target.value);
                  setStripsError(null);
                  setExposureError(null);
                }}
                aria-invalid={Boolean(stripsError)}
                aria-describedby="error-safelight-strips safelight-strips-hint"
              />
              <small id="safelight-strips-hint" className="hint">
                {STRIPS_MIN}–{STRIPS_MAX} 条；末条曝光不得超过一小时（{EXPOSURE_MAX_SECONDS} 秒）
              </small>
              {stripsError && (
                <p
                  className="error"
                  role="alert"
                  id="error-safelight-strips"
                  data-testid="error-safelight-strips"
                >
                  {stripsError}
                </p>
              )}
            </div>
          </div>
          {exposureError && (
            <p className="error" role="alert" data-testid="error-safelight-exposure">
              {exposureError}
            </p>
          )}
          <button type="submit" className="action-button" data-testid="create-safelight-button">
            创建测试
          </button>
        </form>
      </section>

      <section className="panel no-print" aria-label="安全灯测试列表">
        <h2 className="panel-title">安全灯测试</h2>
        {safelight.tests.length === 0 ? (
          <p className="note" data-testid="safelight-empty">
            还没有安全灯测试，请先在上方创建。
          </p>
        ) : (
          <ul className="batch-list" data-testid="safelight-list">
            {safelight.tests.map((test) => {
              const status = safelightStatus(test);
              const isSelected = test.id === selectedId;
              return (
                <li key={test.id}>
                  <button
                    type="button"
                    className={`batch-item${isSelected ? ' batch-item--selected' : ''}`}
                    data-testid="safelight-item"
                    aria-pressed={isSelected}
                    onClick={() => {
                      selectTest(test.id);
                    }}
                  >
                    <span className="batch-item__head">
                      <strong data-testid="safelight-item-name">{test.name}</strong>
                      <span
                        className={`status ${status === 'pending' ? 'status--active' : 'status--done'}`}
                        data-testid="safelight-item-status"
                      >
                        {SAFELIGHT_STATUS_LABEL[status]}
                      </span>
                    </span>
                    <span className="batch-item__meta">
                      起始 {test.startSeconds} 秒　递增 {test.stepSeconds} 秒　共 {test.stripCount}{' '}
                      条（末条 {lastStripSeconds(test)} 秒）
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {selected && (
        <section className="panel no-print" aria-label="测试详情" data-testid="safelight-detail">
          <h2 className="panel-title">{selected.name}</h2>
          <p className="note">
            创建于 {formatTime(selected.createdAt)}；按曝光顺序在安全灯下逐级遮挡曝光，正常显影后观察灰雾。
          </p>
          <h3>条带阶梯（按曝光顺序）</h3>
          <ol className="strip-list" data-testid="strip-list">
            {selectedDurations.map((seconds, index) => (
              <li key={index} data-testid="strip-item">
                条带 {index + 1}：曝光 <strong data-testid="strip-seconds">{seconds}</strong> 秒
              </li>
            ))}
          </ol>

          {selected.evaluation === undefined ? (
            <>
              <p className="note" data-testid="safelight-awaiting">
                等待观察结果：显影并干燥后，选择首条出现可见灰雾的条带。
              </p>
              <form onSubmit={submitEvaluation} noValidate>
                <fieldset className="fog-options">
                  <legend>首条出现可见灰雾的条带</legend>
                  {selectedDurations.map((seconds, index) => (
                    <label key={index}>
                      <input
                        type="radio"
                        name="fog-strip"
                        data-testid={`fog-option-${index + 1}`}
                        checked={fogChoice === index + 1}
                        onChange={() => {
                          setFogChoice(index + 1);
                          setObservationError(null);
                        }}
                      />
                      条带 {index + 1}（{seconds} 秒）
                    </label>
                  ))}
                  <label>
                    <input
                      type="radio"
                      name="fog-strip"
                      data-testid="fog-option-none"
                      checked={fogChoice === null}
                      onChange={() => {
                        setFogChoice(null);
                        setObservationError(null);
                      }}
                    />
                    全部条带均未起雾
                  </label>
                </fieldset>
                {observationError && (
                  <p className="error" role="alert" data-testid="error-safelight-observation">
                    {observationError}
                  </p>
                )}
                <button type="submit" className="action-button" data-testid="evaluate-button">
                  完成评估
                </button>
              </form>
            </>
          ) : (
            selectedConclusion && (
              <div className="conclusion" data-testid="safelight-conclusion">
                {selectedConclusion.kind === 'limit' && (
                  <p>
                    首条起雾为条带 {selected.evaluation.firstFogStrip}
                    ，安全操作上限为前一条时长：
                    <strong data-testid="conclusion-seconds">
                      {selectedConclusion.safeSeconds} 秒
                    </strong>
                  </p>
                )}
                {selectedConclusion.kind === 'below-start' && (
                  <p>
                    首条即出现灰雾：安全操作上限
                    <strong data-testid="conclusion-seconds">
                      低于起始值（不足 {selectedConclusion.startSeconds} 秒）
                    </strong>
                    ，请检查安全灯、灯距或相纸后重新测试。
                  </p>
                )}
                {selectedConclusion.kind === 'at-least-last' && (
                  <p>
                    全部条带均未起雾：安全操作时间
                    <strong data-testid="conclusion-seconds">
                      至少达到末条时长（≥ {selectedConclusion.lastSeconds} 秒）
                    </strong>
                  </p>
                )}
                <p className="note">评估于 {formatTime(selected.evaluation.evaluatedAt)}，结论不可修改。</p>
              </div>
            )
          )}
        </section>
      )}
    </>
  );
}
