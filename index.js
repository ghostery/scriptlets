import SCRIPTLETS, { functions, run } from './ubo.js';

const scriptlets = {};

for (const [name, scriptlet] of Object.entries(SCRIPTLETS)) {
  scriptlets[name] = scriptlet;
  for (const alias of scriptlet.aliases) {
    scriptlets[alias] = scriptlet;
  }
}

// One scope for all calls of an injection, as in uBO: each dependency is declared once, so the
// scriptlets share one safeSelf() cache without touching globalThis. The calls come last, so the
// class dependencies, which are not hoisted, are declared by the time they run.
export function compose(calls, scriptletGlobals = {}) {
  const declarations = new Map();
  const body = [];
  for (const { scriptlet, args } of calls) {
    for (const name of [...scriptlet.dependencies, scriptlet.fn]) {
      declarations.set(name, functions[name].toString());
    }
    body.push(`try { ${scriptlet.fn}(...${JSON.stringify(args)}); } catch {}`);
  }
  return [
    '(function () {',
    `const scriptletGlobals = ${JSON.stringify(scriptletGlobals)};`,
    ...declarations.values(),
    ...body,
    '})();',
  ].join('\n');
}

export { run };
export default scriptlets;
