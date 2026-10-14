import { useCallback, type FC } from 'react';
import type { WalkthroughDef } from '../data/walkthroughSteps';
import type { DemoScript, DemoScriptStep } from '../data/walkthroughSteps';
import type { ConstraintToggles } from '../utils/queryToggle';
import { DEFAULT_TOGGLES } from '../utils/queryToggle';

export interface StepResult {
  count: number;
  elapsed_ms: number;
}

interface GuidedWalkthroughProps {
  walkthrough: WalkthroughDef;
  currentStep: number;
  stepResults: (StepResult | null)[];
  isRunning: boolean;
  onRunStep: (toggles: ConstraintToggles) => void;
  onClose: () => void;
  isDark: boolean;
}

/* ── Demo Script props ── */
interface DemoScriptPanelProps {
  script: DemoScript;
  currentStep: number;
  stepResults: (StepResult | null)[];
  isRunning: boolean;
  onRunStep: (step: DemoScriptStep) => void;
  onClose: () => void;
  isDark: boolean;
}

function fmtCount(n: number): string {
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

/* Scenario badge color by type */
function scenarioBadgeColor(id: string, d: boolean): string {
  if (id.match(/^S([6-9]|1[0-4])$/)) return d ? 'bg-cyan-900/40 text-cyan-400' : 'bg-cyan-100 text-cyan-700';
  if (id.match(/^S1[5-8]$/)) return d ? 'bg-violet-900/40 text-violet-400' : 'bg-violet-100 text-violet-700';
  if (id.match(/^S(19|2[0-3])$/)) return d ? 'bg-amber-900/40 text-amber-400' : 'bg-amber-100 text-amber-700';
  return d ? 'bg-gray-700 text-gray-300' : 'bg-gray-200 text-gray-600';
}

/* ── Single-scenario walkthrough ── */

const GuidedWalkthrough: FC<GuidedWalkthroughProps> = ({
  walkthrough,
  currentStep,
  stepResults,
  isRunning,
  onRunStep,
  onClose,
  isDark: d,
}) => {
  const steps = walkthrough.steps;
  const canAdvance = currentStep < steps.length && !isRunning;
  const isDone = currentStep >= steps.length;

  const handleNext = useCallback(() => {
    if (!canAdvance) return;
    const step = steps[currentStep];
    const toggles: ConstraintToggles = { ...DEFAULT_TOGGLES, ...step.toggles };
    onRunStep(toggles);
  }, [canAdvance, currentStep, steps, onRunStep]);

  return (
    <div className={`flex flex-col gap-2 p-3 border-l ${
      d ? 'bg-gray-900/80 border-gray-700/60' : 'bg-white border-gray-200'
    }`} style={{ width: 260 }}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`text-xs font-bold uppercase tracking-wider ${d ? 'text-cyan-400' : 'text-cyan-600'}`}>
            Walkthrough
          </span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${scenarioBadgeColor(walkthrough.scenarioId, d)}`}>
            {walkthrough.scenarioId}
          </span>
        </div>
        <button
          onClick={onClose}
          className={`text-xs px-1.5 py-0.5 rounded transition-colors ${
            d ? 'text-gray-500 hover:text-gray-300 hover:bg-gray-800' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'
          }`}
        >
          Exit
        </button>
      </div>

      {/* Progress bar */}
      <div className={`flex gap-1 ${d ? 'bg-gray-800/60' : 'bg-gray-100'} rounded-full p-1`}>
        {steps.map((_, i) => (
          <div
            key={i}
            className="flex-1 h-1 rounded-full transition-all"
            style={{
              background: i < currentStep
                ? '#22d3ee'
                : i === currentStep && isRunning
                ? '#fbbf24'
                : d ? '#1f2937' : '#e5e7eb',
            }}
          />
        ))}
      </div>

      {/* Step list */}
      <div className="flex flex-col gap-1.5">
        {steps.map((step, i) => {
          const res = stepResults[i];
          const isActive = i === currentStep;
          const isPast = i < currentStep;
          const isFuture = i > currentStep;

          // Compute delta from previous step
          const prevRes = i > 0 ? stepResults[i - 1] : null;
          const delta = res && prevRes && prevRes.count > 0
            ? ((prevRes.count - res.count) / prevRes.count * 100)
            : null;

          return (
            <div
              key={i}
              className={`rounded-lg border px-2.5 py-2 transition-all ${
                isActive
                  ? d ? 'border-cyan-700/60 bg-cyan-900/20' : 'border-cyan-300 bg-cyan-50'
                  : isPast
                  ? d ? 'border-gray-700/40 bg-gray-800/30' : 'border-gray-200 bg-gray-50'
                  : d ? 'border-gray-800/40 bg-gray-900/40 opacity-50' : 'border-gray-100 bg-gray-50/50 opacity-50'
              }`}
            >
              {/* Step header */}
              <div className="flex items-center gap-1.5 mb-0.5">
                <span className={`text-[10px] font-bold w-4 h-4 flex items-center justify-center rounded-full shrink-0 ${
                  isPast
                    ? 'bg-emerald-500 text-white'
                    : isActive
                    ? d ? 'bg-cyan-600 text-white' : 'bg-cyan-500 text-white'
                    : d ? 'bg-gray-700 text-gray-500' : 'bg-gray-200 text-gray-400'
                }`}>
                  {isPast ? '\u2713' : i + 1}
                </span>
                <span className={`text-xs font-semibold ${
                  isFuture ? (d ? 'text-gray-600' : 'text-gray-400') : (d ? 'text-gray-200' : 'text-gray-700')
                }`}>
                  {step.title}
                </span>
              </div>

              {/* Description */}
              <p className={`text-[10px] leading-snug pl-5.5 ml-[22px] ${d ? 'text-gray-500' : 'text-gray-400'}`}>
                {step.description}
              </p>

              {/* Result (if completed) */}
              {res && (
                <div className="flex items-center gap-2 mt-1.5 ml-[22px]">
                  <span className={`text-xs font-bold font-mono ${d ? 'text-cyan-400' : 'text-cyan-600'}`}>
                    {fmtCount(res.count)}
                  </span>
                  <span className={`text-[10px] font-mono ${d ? 'text-gray-600' : 'text-gray-400'}`}>
                    {res.elapsed_ms < 0.1 ? '<0.001' : (res.elapsed_ms / 1000).toFixed(3)}s
                  </span>
                  {delta != null && delta > 0 && (
                    <span className={`text-[10px] font-bold px-1 py-0.5 rounded ${
                      d ? 'bg-emerald-900/40 text-emerald-400' : 'bg-emerald-100 text-emerald-700'
                    }`}>
                      -{delta.toFixed(1)}%
                    </span>
                  )}
                </div>
              )}

              {/* Running indicator */}
              {isActive && isRunning && (
                <div className="flex items-center gap-1.5 mt-1.5 ml-[22px]">
                  <span className="animate-spin inline-block w-2.5 h-2.5 border-2 border-cyan-400 border-t-transparent rounded-full" />
                  <span className={`text-[10px] ${d ? 'text-gray-500' : 'text-gray-400'}`}>Running...</span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Action button */}
      <button
        onClick={handleNext}
        disabled={!canAdvance}
        className={`mt-1 w-full py-2 rounded-lg text-xs font-bold transition-all ${
          isDone
            ? d ? 'bg-emerald-900/40 text-emerald-400 cursor-default' : 'bg-emerald-100 text-emerald-700 cursor-default'
            : canAdvance
            ? d ? 'bg-cyan-600 hover:bg-cyan-500 text-white shadow-lg shadow-cyan-600/20' : 'bg-cyan-500 hover:bg-cyan-400 text-white shadow-lg shadow-cyan-500/20'
            : d ? 'bg-gray-800 text-gray-600 cursor-not-allowed' : 'bg-gray-200 text-gray-400 cursor-not-allowed'
        }`}
      >
        {isDone
          ? 'Walkthrough Complete'
          : isRunning
          ? 'Running...'
          : currentStep === 0
          ? `Start: ${steps[0]?.title}`
          : `Next: ${steps[currentStep]?.title}`
        }
      </button>
    </div>
  );
};

/* ── Compact horizontal walkthrough banner (for top of results page) ── */

export const WalkthroughBanner: FC<GuidedWalkthroughProps> = ({
  walkthrough,
  currentStep,
  stepResults,
  isRunning,
  onRunStep,
  onClose,
  isDark: d,
}) => {
  const steps = walkthrough.steps;
  const canAdvance = currentStep < steps.length && !isRunning;
  const isDone = currentStep >= steps.length;

  const handleNext = useCallback(() => {
    if (!canAdvance) return;
    const step = steps[currentStep];
    const toggles: ConstraintToggles = { ...DEFAULT_TOGGLES, ...step.toggles };
    onRunStep(toggles);
  }, [canAdvance, currentStep, steps, onRunStep]);

  // Compute reduction from previous step
  const prevRes = currentStep > 0 ? stepResults[currentStep - 1] : null;
  const curRes = currentStep >= 2 ? stepResults[currentStep - 1] : null;
  const prevPrevRes = currentStep >= 2 ? stepResults[currentStep - 2] : null;
  const delta = curRes && prevPrevRes && prevPrevRes.count > 0
    ? ((prevPrevRes.count - curRes.count) / prevPrevRes.count * 100)
    : null;

  return (
    <div className={`shrink-0 flex items-center gap-3 px-4 py-2.5 border-b ${
      d ? 'bg-gray-800/80 border-gray-700/60' : 'bg-gray-100/80 border-gray-200'
    }`}>
      {/* Scenario badge */}
      <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold shrink-0 ${scenarioBadgeColor(walkthrough.scenarioId, d)}`}>
        {walkthrough.scenarioId}
      </span>

      {/* Progress dots */}
      <div className="flex gap-1.5 shrink-0">
        {steps.map((_, i) => (
          <div
            key={i}
            className={`w-2.5 h-2.5 rounded-full transition-all ${
              i < currentStep
                ? 'bg-cyan-400'
                : i === currentStep && isRunning
                ? 'bg-amber-400 animate-pulse'
                : i === currentStep
                ? d ? 'bg-cyan-600 ring-2 ring-cyan-400/40' : 'bg-cyan-500 ring-2 ring-cyan-300/40'
                : d ? 'bg-gray-700' : 'bg-gray-300'
            }`}
          />
        ))}
      </div>

      {/* Current step info */}
      <div className="flex-1 min-w-0 flex items-center gap-2">
        {!isDone && steps[currentStep] && (
          <>
            <span className={`text-xs font-bold truncate ${d ? 'text-gray-200' : 'text-gray-700'}`}>
              {steps[currentStep].title}
            </span>
            <span className={`text-[10px] truncate ${d ? 'text-gray-500' : 'text-gray-400'}`}>
              {steps[currentStep].description}
            </span>
          </>
        )}
        {isDone && (
          <span className={`text-xs font-bold ${d ? 'text-emerald-400' : 'text-emerald-600'}`}>
            Walkthrough Complete
          </span>
        )}
      </div>

      {/* Last step result */}
      {prevRes && (
        <span className={`text-xs font-mono shrink-0 ${d ? 'text-cyan-400' : 'text-cyan-600'}`}>
          {fmtCount(prevRes.count)}
        </span>
      )}

      {/* Delta badge */}
      {delta != null && delta > 0 && (
        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0 ${
          d ? 'bg-emerald-900/40 text-emerald-400' : 'bg-emerald-100 text-emerald-700'
        }`}>
          -{delta.toFixed(1)}%
        </span>
      )}

      {/* Action button */}
      {!isDone && (
        <button
          onClick={handleNext}
          disabled={!canAdvance}
          className={`shrink-0 px-4 py-1.5 rounded-lg text-xs font-bold transition-all ${
            canAdvance
              ? d ? 'bg-cyan-600 hover:bg-cyan-500 text-white shadow-lg shadow-cyan-600/20' : 'bg-cyan-500 hover:bg-cyan-400 text-white shadow-lg shadow-cyan-500/20'
              : d ? 'bg-gray-800 text-gray-600 cursor-not-allowed' : 'bg-gray-200 text-gray-400 cursor-not-allowed'
          }`}
        >
          {isRunning
            ? 'Running...'
            : currentStep === 0
            ? 'Start'
            : `Next: ${steps[currentStep]?.title}`
          }
        </button>
      )}

      {/* Close */}
      <button
        onClick={onClose}
        className={`shrink-0 w-6 h-6 flex items-center justify-center rounded transition-colors ${
          d ? 'text-gray-500 hover:text-gray-300 hover:bg-gray-700' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-200'
        }`}
      >
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M2 2l8 8M10 2l-8 8" />
        </svg>
      </button>
    </div>
  );
};

/* ── Multi-scenario Demo Script panel ── */

export const DemoScriptPanel: FC<DemoScriptPanelProps> = ({
  script,
  currentStep,
  stepResults,
  isRunning,
  onRunStep,
  onClose,
  isDark: d,
}) => {
  const steps = script.steps;
  const canAdvance = currentStep < steps.length && !isRunning;
  const isDone = currentStep >= steps.length;

  const handleNext = useCallback(() => {
    if (!canAdvance) return;
    onRunStep(steps[currentStep]);
  }, [canAdvance, currentStep, steps, onRunStep]);

  // Group consecutive steps by scenarioId for visual section dividers
  let prevScenario = '';

  return (
    <div className={`flex flex-col gap-2 p-3 border-l overflow-y-auto ${
      d ? 'bg-gray-900/80 border-gray-700/60' : 'bg-white border-gray-200'
    }`} style={{ width: 280 }}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className={`text-xs font-bold uppercase tracking-wider ${d ? 'text-cyan-400' : 'text-cyan-600'}`}>
          Demo Script
        </span>
        <button
          onClick={onClose}
          className={`text-xs px-1.5 py-0.5 rounded transition-colors ${
            d ? 'text-gray-500 hover:text-gray-300 hover:bg-gray-800' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'
          }`}
        >
          Exit
        </button>
      </div>

      {/* Progress bar */}
      <div className={`flex gap-0.5 ${d ? 'bg-gray-800/60' : 'bg-gray-100'} rounded-full p-1`}>
        {steps.map((_, i) => (
          <div
            key={i}
            className="flex-1 h-1 rounded-full transition-all"
            style={{
              background: i < currentStep
                ? '#22d3ee'
                : i === currentStep && isRunning
                ? '#fbbf24'
                : d ? '#1f2937' : '#e5e7eb',
            }}
          />
        ))}
      </div>

      {/* Step list */}
      <div className="flex flex-col gap-1">
        {steps.map((step, i) => {
          const res = stepResults[i];
          const isActive = i === currentStep;
          const isPast = i < currentStep;
          const isFuture = i > currentStep;
          const showScenarioHeader = step.scenarioId !== prevScenario;
          prevScenario = step.scenarioId;

          // Delta from previous step within same scenario
          const prevRes = i > 0 && steps[i - 1].scenarioId === step.scenarioId ? stepResults[i - 1] : null;
          const delta = res && prevRes && prevRes.count > 0
            ? ((prevRes.count - res.count) / prevRes.count * 100)
            : null;

          return (
            <div key={i}>
              {/* Scenario section header */}
              {showScenarioHeader && (
                <div className={`flex items-center gap-1.5 mt-1 mb-0.5 ${i > 0 ? `pt-1.5 border-t ${d ? 'border-gray-800' : 'border-gray-200'}` : ''}`}>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${scenarioBadgeColor(step.scenarioId, d)}`}>
                    {step.scenarioId}
                  </span>
                </div>
              )}

              <div
                className={`rounded-lg border px-2 py-1.5 transition-all ${
                  isActive
                    ? d ? 'border-cyan-700/60 bg-cyan-900/20' : 'border-cyan-300 bg-cyan-50'
                    : isPast
                    ? d ? 'border-gray-700/40 bg-gray-800/30' : 'border-gray-200 bg-gray-50'
                    : d ? 'border-gray-800/40 bg-gray-900/40 opacity-50' : 'border-gray-100 bg-gray-50/50 opacity-50'
                }`}
              >
                {/* Step header */}
                <div className="flex items-center gap-1.5">
                  <span className={`text-[10px] font-bold w-4 h-4 flex items-center justify-center rounded-full shrink-0 ${
                    isPast
                      ? 'bg-emerald-500 text-white'
                      : isActive
                      ? d ? 'bg-cyan-600 text-white' : 'bg-cyan-500 text-white'
                      : d ? 'bg-gray-700 text-gray-500' : 'bg-gray-200 text-gray-400'
                  }`}>
                    {isPast ? '\u2713' : i + 1}
                  </span>
                  <span className={`text-[11px] font-semibold ${
                    isFuture ? (d ? 'text-gray-600' : 'text-gray-400') : (d ? 'text-gray-200' : 'text-gray-700')
                  }`}>
                    {step.title}
                  </span>
                </div>

                {/* Description */}
                <p className={`text-[10px] leading-snug ml-[22px] ${d ? 'text-gray-500' : 'text-gray-400'}`}>
                  {step.description}
                </p>

                {/* Result */}
                {res && (
                  <div className="flex flex-col gap-0.5 mt-1 ml-[22px]">
                    <div className="flex items-center gap-2">
                      <span className={`text-xs font-bold font-mono ${d ? 'text-cyan-400' : 'text-cyan-600'}`}>
                        {fmtCount(res.count)}
                      </span>
                      <span className={`text-[10px] font-mono ${d ? 'text-gray-600' : 'text-gray-400'}`}>
                        {res.elapsed_ms < 0.1 ? '<0.001' : (res.elapsed_ms / 1000).toFixed(3)}s
                      </span>
                      {delta != null && delta > 0 && (
                        <span className={`text-[10px] font-bold px-1 py-0.5 rounded ${
                          d ? 'bg-emerald-900/40 text-emerald-400' : 'bg-emerald-100 text-emerald-700'
                        }`}>
                          -{delta.toFixed(1)}%
                        </span>
                      )}
                    </div>
                    {/* Insight text */}
                    <p className={`text-[10px] italic ${d ? 'text-cyan-600' : 'text-cyan-500'}`}>
                      {step.insight}
                    </p>
                  </div>
                )}

                {/* Running indicator */}
                {isActive && isRunning && (
                  <div className="flex items-center gap-1.5 mt-1 ml-[22px]">
                    <span className="animate-spin inline-block w-2.5 h-2.5 border-2 border-cyan-400 border-t-transparent rounded-full" />
                    <span className={`text-[10px] ${d ? 'text-gray-500' : 'text-gray-400'}`}>Running...</span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Action button */}
      <button
        onClick={handleNext}
        disabled={!canAdvance}
        className={`mt-1 w-full py-2 rounded-lg text-xs font-bold transition-all ${
          isDone
            ? d ? 'bg-emerald-900/40 text-emerald-400 cursor-default' : 'bg-emerald-100 text-emerald-700 cursor-default'
            : canAdvance
            ? d ? 'bg-cyan-600 hover:bg-cyan-500 text-white shadow-lg shadow-cyan-600/20' : 'bg-cyan-500 hover:bg-cyan-400 text-white shadow-lg shadow-cyan-500/20'
            : d ? 'bg-gray-800 text-gray-600 cursor-not-allowed' : 'bg-gray-200 text-gray-400 cursor-not-allowed'
        }`}
      >
        {isDone
          ? 'Demo Complete'
          : isRunning
          ? 'Running...'
          : currentStep === 0
          ? 'Start Demo'
          : `Next: ${steps[currentStep]?.title}`
        }
      </button>
    </div>
  );
};

export default GuidedWalkthrough;
