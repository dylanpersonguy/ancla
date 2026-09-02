/**
 * Which table keys canonicalise which publisher.
 *
 * The mapping lives here rather than on Source because a source describes how to
 * fetch an archive, and the ingest package has no business importing the
 * canonicaliser to say so. This is the one place the two meet.
 *
 * A source that is absent has no schema yet, which is different from having an
 * empty one: canonicalising with the wrong keys would produce records whose
 * identity is invented, and every later comparison would be against nothing.
 */

import { PANAMA_TABLES } from '../../canonicalize/src/schema-pa.ts';
import { type Schema, TABLES } from '../../canonicalize/src/schema.ts';

const BY_SOURCE: Record<string, Schema> = {
  'cr-observatorio': TABLES,
  'pa-panamacompra': PANAMA_TABLES,
};

export function schemaFor(sourceId: string): Schema {
  const s = BY_SOURCE[sourceId];
  if (!s) {
    throw new Error(
      `no canonicalisation schema for "${sourceId}". Its archives can be mirrored ` +
        'and hashed, but not turned into records. Add one in packages/cli/src/schemas.ts.',
    );
  }
  return s;
}

export function hasSchema(sourceId: string): boolean {
  return sourceId in BY_SOURCE;
}
