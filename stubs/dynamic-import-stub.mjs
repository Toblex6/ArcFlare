// Generic stub for packages only ever reached via a lazy/dynamic
// import() that's already guarded by try/catch at runtime (e.g.
// @coinbase/cdp-sdk's importX402Dependency() helper for @x402/svm).
// No named-export analysis applies here since it's not a static
// `import { x } from '...'` — an empty default export is enough.
export default {};
