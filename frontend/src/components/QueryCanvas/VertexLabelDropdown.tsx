import type { FC } from 'react';

interface VertexLabelDropdownProps {
  position: { x: number; y: number };
  currentLabel: string;
  vertexLabels: string[];
  onSelect: (label: string) => void;
  onDelete: () => void;
  onClose: () => void;
}

const VertexLabelDropdown: FC<VertexLabelDropdownProps> = ({
  position,
  currentLabel,
  vertexLabels,
  onSelect,
  onDelete,
  onClose,
}) => {
  const allLabels = ['Any', ...vertexLabels];

  return (
    <div
      className="fixed z-50 bg-gray-800 border border-gray-600 rounded-lg shadow-xl py-1 min-w-[160px]"
      style={{ left: position.x, top: position.y }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="px-3 py-1.5 text-xs text-gray-400 uppercase tracking-wider border-b border-gray-700">
        Vertex Label
      </div>
      {allLabels.map((label) => (
        <button
          key={label}
          className={`w-full text-left px-3 py-1.5 text-sm hover:bg-gray-700 transition-colors ${
            label === currentLabel
              ? 'text-cyan-400 bg-gray-750'
              : 'text-gray-200'
          }`}
          onClick={() => {
            onSelect(label);
            onClose();
          }}
        >
          {label}
        </button>
      ))}
      <div className="border-t border-gray-700 mt-1 pt-1 px-1">
        <button
          className="w-full text-left px-2 py-1.5 text-sm text-red-400 hover:bg-red-900/30 rounded transition-colors"
          onClick={onDelete}
        >
          Delete Vertex
        </button>
      </div>
    </div>
  );
};

export default VertexLabelDropdown;
