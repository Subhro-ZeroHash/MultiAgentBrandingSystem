export * from './client.js';
export * as schema from './schema/index.js';
// Row types (`Brand`, `Product`, `ProbeRunRow`, ...) are re-exported flat so
// consumers can type a function parameter without reaching into the namespace.
export type * from './schema/index.js';
export {
  sql,
  eq,
  ne,
  and,
  or,
  desc,
  asc,
  inArray,
  isNotNull,
  isNull,
  gte,
  lte,
  lt,
  count,
  avg,
} from 'drizzle-orm';

// The Context Manager: task-specific brand context assembly, shared by
// content-api (via BrandContextService) and content-worker (directly).
export * from './context/context-manager.js';
