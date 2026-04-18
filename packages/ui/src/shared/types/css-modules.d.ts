/**
 * CSS module declarations.
 *
 * The imported default is typed as a string-keyed map. We keep dot access
 * available because CSS-module consumers throughout the UI use it extensively
 * and the upstream Vite CSS modules plugin resolves names at bundle time.
 * If we enable `noPropertyAccessFromIndexSignature` later, we'll either adopt
 * CSS-module codegen (typed per module) or migrate call sites to bracket
 * access in one sweep.
 */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}

declare module '*.css';
