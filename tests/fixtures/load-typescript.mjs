// Compile the current production module with explicit, offline dependencies.
// Unexpected imports fail rather than touching real SDKs, RPCs or databases.
import { readFileSync } from 'node:fs';
import ts from 'typescript';

export function loadTypescript(path, dependencies, globals = {}) {
  const source = readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText;
  const exports = {};
  const require = (name) => {
    if (!Object.hasOwn(dependencies, name)) throw new Error(`Unmocked dependency: ${name}`);
    return dependencies[name];
  };
  new Function('require', 'exports', ...Object.keys(globals), compiled)(require, exports, ...Object.values(globals));
  return exports;
}
