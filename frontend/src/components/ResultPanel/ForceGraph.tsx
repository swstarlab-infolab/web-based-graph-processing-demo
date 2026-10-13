import {
  useRef, lazy, Suspense,
  type FC, type MutableRefObject,
} from 'react';
import type { QueryResult, QueryGraph, Schema } from '../../types';
import type { GraphRendererProps } from './ForceGraphCytoscape';

/* ------------------------------------------------------------------ */
/*  ForceGraph — thin shell that lazy-loads the Cytoscape renderer      */
/* ------------------------------------------------------------------ */

interface ForceGraphProps {
  result: QueryResult | null;
  soloPath: number | null;
  queryContext: QueryGraph | null;
  schema?: Schema | null;
  isDark?: boolean;
  onFitRef?: MutableRefObject<(() => void) | null>;
  onZoomToSoloRef?: MutableRefObject<(() => void) | null>;
  onSoloPathChange?: (pathIdx: number | null) => void;
  /** Dataset the result came from — forwarded to the renderer for /api/neighborhood */
  datasetId?: string;
}

const CytoscapeRenderer = lazy(() => import('./ForceGraphCytoscape'));

const ForceGraph: FC<ForceGraphProps> = (props) => {
  const { isDark = true } = props;
  const d = isDark;
  const zoomToSoloRef = useRef<(() => void) | null>(null);

  const rendererProps: GraphRendererProps = {
    result: props.result,
    soloPath: props.soloPath,
    queryContext: props.queryContext,
    schema: props.schema,
    isDark: props.isDark,
    onFitRef: props.onFitRef,
    onZoomToSoloRef: zoomToSoloRef,
    onSoloPathChange: props.onSoloPathChange,
    datasetId: props.datasetId,
  };

  const spinner = (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className={`w-6 h-6 border-2 rounded-full animate-spin ${d ? 'border-gray-700 border-t-cyan-400' : 'border-gray-300 border-t-cyan-500'}`} />
    </div>
  );

  return (
    <div className="relative w-full h-full">
      <Suspense fallback={spinner}>
        <CytoscapeRenderer {...rendererProps} />
      </Suspense>

      {/* Zoom-to-path button — shown when a path is selected */}
      {props.soloPath !== null && props.result && (
        <button
          className={`absolute top-2 right-14 border rounded-lg px-2.5 py-1.5 text-xs transition-all z-30 ${
            d
              ? 'bg-cyan-900/60 hover:bg-cyan-800/80 border-cyan-700/60 text-cyan-300 hover:text-cyan-100'
              : 'bg-cyan-50 hover:bg-cyan-100 border-cyan-200 text-cyan-700 hover:text-cyan-900'
          }`}
          onClick={() => zoomToSoloRef.current?.()}
          title={`Zoom to path #${props.soloPath! + 1}`}
        >
          ⊙ Zoom
        </button>
      )}
    </div>
  );
};

export default ForceGraph;
