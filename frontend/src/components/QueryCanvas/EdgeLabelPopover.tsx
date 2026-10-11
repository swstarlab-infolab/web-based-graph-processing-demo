import { useState, useEffect, type FC } from 'react';
import type { QueryEdge } from '../../types';

interface EdgeLabelPopoverProps {
  position: { x: number; y: number };
  edge: QueryEdge;
  edgeLabels: string[];
  onUpdate: (props: Partial<Omit<QueryEdge, 'id'>>) => void;
  onDelete: () => void;
  onClose: () => void;
}

const QUANTIFIER_OPTIONS: Array<{ value: QueryEdge['quantifier']; label: string; title: string }> = [
  { value: '1', label: '\u00B7', title: 'Exactly once' },
  { value: '*', label: '*', title: 'Zero or more' },
  { value: '+', label: '+', title: 'One or more' },
  { value: '?', label: '?', title: 'Zero or one' },
];

const DIRECTION_OPTIONS: Array<{ value: QueryEdge['direction']; label: string; title: string }> = [
  { value: 'forward', label: '\u2192', title: 'Forward' },
  { value: 'reverse', label: '\u2190', title: 'Reverse' },
  { value: 'both', label: '\u2194', title: 'Both directions' },
];

const EdgeLabelPopover: FC<EdgeLabelPopoverProps> = ({
  position,
  edge,
  edgeLabels,
  onUpdate,
  onDelete,
  onClose,
}) => {
  const [label, setLabel] = useState(edge.label);
  const [quantifier, setQuantifier] = useState(edge.quantifier);
  const [direction, setDirection] = useState(edge.direction);
  const [minLength, setMinLength] = useState(edge.minLength?.toString() || '');
  const [maxLength, setMaxLength] = useState(edge.maxLength?.toString() || '');
  const [alternateLabels, setAlternateLabels] = useState<string[]>(
    edge.alternateLabels || [],
  );
  const [showAltInput, setShowAltInput] = useState(false);

  useEffect(() => {
    onUpdate({
      label,
      quantifier,
      direction,
      minLength: minLength ? parseInt(minLength, 10) : undefined,
      maxLength: maxLength ? parseInt(maxLength, 10) : undefined,
      alternateLabels: alternateLabels.length > 0 ? alternateLabels : undefined,
    });
  }, [label, quantifier, direction, minLength, maxLength, alternateLabels, onUpdate]);

  const addAlternateLabel = (altLabel: string) => {
    if (altLabel && !alternateLabels.includes(altLabel) && altLabel !== label) {
      setAlternateLabels([...alternateLabels, altLabel]);
    }
    setShowAltInput(false);
  };

  const removeAlternateLabel = (idx: number) => {
    setAlternateLabels(alternateLabels.filter((_, i) => i !== idx));
  };

  return (
    <div
      className="fixed z-50 bg-gray-800 border border-gray-600 rounded-lg shadow-xl p-3 min-w-[260px]"
      style={{ left: position.x, top: position.y }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs text-gray-400 uppercase tracking-wider">
          Edge Properties
        </span>
        <button
          className="text-gray-500 hover:text-gray-300 text-lg leading-none"
          onClick={onClose}
        >
          &times;
        </button>
      </div>

      {/* Label selector */}
      <div className="mb-3">
        <label className="block text-xs text-gray-400 mb-1">Label</label>
        <select
          className="w-full bg-gray-700 text-gray-200 border border-gray-600 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-cyan-500"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        >
          {edgeLabels.map((el) => (
            <option key={el} value={el}>
              {el}
            </option>
          ))}
        </select>
      </div>

      {/* Alternate labels (alternation) */}
      {alternateLabels.length > 0 && (
        <div className="mb-3">
          <label className="block text-xs text-gray-400 mb-1">
            Alternation ({label}|{alternateLabels.join('|')})
          </label>
          <div className="flex flex-wrap gap-1">
            {alternateLabels.map((al, i) => (
              <span
                key={al}
                className="inline-flex items-center bg-gray-700 text-gray-300 text-xs px-2 py-0.5 rounded"
              >
                {al}
                <button
                  className="ml-1 text-gray-500 hover:text-red-400"
                  onClick={() => removeAlternateLabel(i)}
                >
                  &times;
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Quantifier */}
      <div className="mb-3">
        <label className="block text-xs text-gray-400 mb-1">Quantifier</label>
        <div className="flex gap-1">
          {QUANTIFIER_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              title={opt.title}
              className={`flex-1 py-1 text-sm rounded border transition-colors ${
                quantifier === opt.value
                  ? 'bg-cyan-600 border-cyan-500 text-white'
                  : 'bg-gray-700 border-gray-600 text-gray-300 hover:border-gray-500'
              }`}
              onClick={() => setQuantifier(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Length constraints */}
      <div className="mb-3">
        <div className="flex items-center gap-1.5 mb-1.5">
          <label className="text-xs font-semibold text-amber-400">Length</label>
          {(minLength || maxLength) && (
            <span className="text-[14px] font-mono bg-amber-900/40 text-amber-300 border border-amber-700/50 px-1.5 py-0.5 rounded">
              [{minLength || '0'}..{maxLength || '∞'}]
            </span>
          )}
        </div>
        <div className="flex gap-1 items-center bg-gray-750 rounded-lg border border-amber-700/30 px-2 py-1.5">
          <span className="text-amber-600 text-sm font-mono">[</span>
          <input
            type="number"
            placeholder="min"
            min={0}
            className="w-14 bg-gray-700 text-amber-200 border border-gray-600 rounded px-2 py-1 text-sm focus:outline-none focus:border-amber-500 text-center"
            value={minLength}
            onChange={(e) => setMinLength(e.target.value)}
          />
          <span className="text-amber-600 text-sm font-mono">..</span>
          <input
            type="number"
            placeholder="max"
            min={0}
            className="w-14 bg-gray-700 text-amber-200 border border-gray-600 rounded px-2 py-1 text-sm focus:outline-none focus:border-amber-500 text-center"
            value={maxLength}
            onChange={(e) => setMaxLength(e.target.value)}
          />
          <span className="text-amber-600 text-sm font-mono">]</span>
          {(minLength || maxLength) && (
            <button
              className="ml-auto text-gray-600 hover:text-red-400 text-sm leading-none transition-colors"
              title="Clear length constraint"
              onClick={() => { setMinLength(''); setMaxLength(''); }}
            >
              ×
            </button>
          )}
        </div>
      </div>

      {/* Direction */}
      <div className="mb-3">
        <label className="block text-xs text-gray-400 mb-1">Direction</label>
        <div className="flex gap-1">
          {DIRECTION_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              title={opt.title}
              className={`flex-1 py-1 text-sm rounded border transition-colors ${
                direction === opt.value
                  ? 'bg-cyan-600 border-cyan-500 text-white'
                  : 'bg-gray-700 border-gray-600 text-gray-300 hover:border-gray-500'
              }`}
              onClick={() => setDirection(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Add alternation */}
      <div className="mb-3">
        {showAltInput ? (
          <div className="flex gap-1">
            <select
              className="flex-1 bg-gray-700 text-gray-200 border border-gray-600 rounded px-2 py-1 text-sm focus:outline-none focus:border-cyan-500"
              defaultValue=""
              onChange={(e) => {
                if (e.target.value) addAlternateLabel(e.target.value);
              }}
            >
              <option value="" disabled>
                Select label...
              </option>
              {edgeLabels
                .filter((el) => el !== label && !alternateLabels.includes(el))
                .map((el) => (
                  <option key={el} value={el}>
                    {el}
                  </option>
                ))}
            </select>
            <button
              className="text-gray-500 hover:text-gray-300 text-sm px-2"
              onClick={() => setShowAltInput(false)}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            className="text-cyan-400 hover:text-cyan-300 text-xs"
            onClick={() => setShowAltInput(true)}
          >
            + Add alternation (|)
          </button>
        )}
      </div>

      {/* Delete edge */}
      <button
        className="w-full py-1.5 text-sm rounded border border-red-700/50 bg-red-900/30 text-red-400 hover:bg-red-900/50 transition-colors"
        onClick={onDelete}
      >
        Delete Edge
      </button>
    </div>
  );
};

export default EdgeLabelPopover;
