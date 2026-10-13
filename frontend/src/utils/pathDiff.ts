import type { SamplePath, WESamplePair } from '../types';
import { isWESamplePair } from '../types';

export interface PathAnnotation {
  /** Which hop (edge index) this annotation applies to. -1 = whole path. */
  hopIndex: number;
  kind: 'equality_violation' | 'length_exceeded' | 'retained';
  reason: string;
}

/**
 * Annotate a single sample path for display in the "plain" column.
 * Shows which hops would be affected by the applied constraints.
 */
export function annotateSample(
  sample: SamplePath | WESamplePair,
  maxLength: number | null,
): PathAnnotation[] {
  const annotations: PathAnnotation[] = [];

  if (isWESamplePair(sample)) {
    // WE pair: check edge label equality between path1 and path2
    const labels1 = sample.path1.edge_labels ?? [];
    const labels2 = sample.path2.edge_labels ?? [];
    const minLen = Math.min(labels1.length, labels2.length);

    for (let i = 0; i < minLen; i++) {
      if (labels1[i] !== labels2[i]) {
        annotations.push({
          hopIndex: i,
          kind: 'equality_violation',
          reason: `Labels diverge at hop ${i + 1}: "${labels1[i]}" vs "${labels2[i]}"`,
        });
      }
    }
    // Length mismatch itself is also a violation for exact WE
    if (labels1.length !== labels2.length && annotations.length === 0) {
      annotations.push({
        hopIndex: -1,
        kind: 'equality_violation',
        reason: `Path lengths differ: ${labels1.length} vs ${labels2.length} hops`,
      });
    }
  }

  // Length constraint: mark hops beyond maxLength
  if (maxLength != null) {
    const path = isWESamplePair(sample) ? sample.path1 : sample;
    const pathLen = path.vertices.length - 1;
    if (pathLen > maxLength) {
      for (let i = maxLength; i < pathLen; i++) {
        annotations.push({
          hopIndex: i,
          kind: 'length_exceeded',
          reason: `Hop ${i + 1} exceeds max length ${maxLength}`,
        });
      }
    }
  }

  return annotations;
}

/**
 * Check if a hop is annotated with a specific kind.
 */
export function getAnnotationAt(
  annotations: PathAnnotation[],
  hopIndex: number,
): PathAnnotation | undefined {
  return annotations.find(a => a.hopIndex === hopIndex) ??
         annotations.find(a => a.hopIndex === -1);
}

/**
 * Derive overall status of a sample from its annotations.
 */
export function sampleStatus(
  annotations: PathAnnotation[],
): 'accepted' | 'equality_violation' | 'length_exceeded' {
  if (annotations.some(a => a.kind === 'equality_violation')) return 'equality_violation';
  if (annotations.some(a => a.kind === 'length_exceeded')) return 'length_exceeded';
  return 'accepted';
}

/**
 * Get a single summary reason string for the most significant violation.
 */
export function summaryReason(annotations: PathAnnotation[]): string {
  const eqViolation = annotations.find(a => a.kind === 'equality_violation');
  if (eqViolation) return eqViolation.reason;
  const lenViolation = annotations.find(a => a.kind === 'length_exceeded');
  if (lenViolation) return lenViolation.reason;
  return '';
}
