import cytoscape from 'cytoscape';

/**
 * Safe handling for async cytoscape layouts (ELK).
 *
 * ELK applies node positions from an async callback that cannot be
 * cancelled; destroying the core while a layout is in flight makes that
 * callback crash on a null renderer ("Cannot read properties of null
 * (reading 'notify')") and the uncaught error white-screens the app.
 *
 * Kept in its own module (not a component file) so React Fast Refresh
 * stays functional — non-component exports from component modules force
 * full HMR invalidation.
 */

export type CyWithElk = cytoscape.Core & {
  _elkLayout?: cytoscape.Layouts | null;
};

// Global guard: no-op Collection.layoutPositions when the core is destroyed.
// This covers any async layout applying positions after cy.destroy(),
// regardless of which code path destroyed the instance.
{
  const tmp = cytoscape({ headless: true });
  const CollectionProto = Object.getPrototypeOf(tmp.collection());
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const origLayoutPositions = (CollectionProto as any).layoutPositions;
  if (origLayoutPositions && !(CollectionProto as any).__lpGuarded) {
    (CollectionProto as any).layoutPositions = function (this: any, ...args: any[]) {
      const core = typeof this.cy === 'function' ? this.cy() : null;
      if (core && core.destroyed()) return this;
      return origLayoutPositions.apply(this, args);
    };
    (CollectionProto as any).__lpGuarded = true;
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
  tmp.destroy();
}

/**
 * Destroy a cy instance, deferring until an in-flight ELK layout finishes.
 * The in-flight layout is tracked as a layout OBJECT (not a cy-level
 * 'layoutstop' listener) because other layouts — e.g. the 'preset' layout
 * every cy instance runs at construction — also emit 'layoutstop' on the
 * core and would clear the flag while ELK is still running.
 */
export function safeDestroyCy(inst: CyWithElk | null | undefined) {
  if (!inst || inst.destroyed()) return;
  const inflight = inst._elkLayout;
  if (inflight) {
    inflight.one('layoutstop', () => { if (!inst.destroyed()) inst.destroy(); });
  } else {
    inst.destroy();
  }
}

/** Run an ELK layout with in-flight tracking for safeDestroyCy. */
export function runElkLayout(cy: CyWithElk, opts: unknown, onStop?: () => void) {
  const layout = cy.layout(opts as cytoscape.LayoutOptions);
  cy._elkLayout = layout;
  layout.one('layoutstop', () => {
    if (cy._elkLayout === layout) cy._elkLayout = null;
    onStop?.();
  });
  layout.run();
}
