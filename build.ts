const tagName = Deno.args.includes('--tagName')
  ? Deno.args[Deno.args.findIndex((o) => o === '--tagName') + 1]
  : false;

if (!tagName) {
  throw new Error('pass argument --tagName <TAG_NAME>');
}

const { builtinScriptlets: scriptlets } = await import(
  `https://raw.githubusercontent.com/gorhill/uBlock/${tagName}/src/js/resources/scriptlets.js`
);

const index = new Map();
for (const scriptlet of scriptlets) {
  index.set(scriptlet.name, scriptlet);
  for (const name of scriptlet.aliases || []) {
    index.set(name, scriptlet);
  }
}

// Each function once, by name, so compose() and run() can declare them in one shared scope.
const functions = new Map();
const entryFunctions = [];

const entries = scriptlets
  .filter(scriptlet => scriptlet.name.endsWith('.js'))
  .map((scriptlet) => {
    const allDependencies = new Set();

    const addDeps = (aScriptlet) => {
      for (const dep of aScriptlet.dependencies || []) {
        allDependencies.add(dep);
        const bScriptlet = index.get(dep);
        addDeps(bScriptlet);
      }
    };

    addDeps(scriptlet);

    const deps = [...allDependencies].reverse().map((dep) => index.get(dep).fn);

    for (const fn of [...deps, scriptlet.fn]) {
      functions.set(fn.name, fn.toString());
    }
    entryFunctions.push(scriptlet.fn.name);

    return `
scriptlets['${scriptlet.name}'] = {
aliases: ${JSON.stringify(scriptlet.aliases || [])},
${scriptlet.world ? `world: '${scriptlet.world}',` : '' }
requiresTrust: ${scriptlet.requiresTrust || false},
fn: '${scriptlet.fn.name}',
dependencies: ${JSON.stringify(deps.map((dep) => dep.name))},
};
`;
  })
  .join('\n');

console.log(`
/*******************************************************************************

    uBlock Origin - a comprehensive, efficient content blocker
    Copyright (C) 2019-present Raymond Hill

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/gorhill/uBlock

*/
const functions = {};
${[...functions].map(([name, source]) => `functions['${name}'] = ${source};`).join('\n')}

const scriptlets = {};
${entries}

// For chrome.scripting.executeScript(), which takes a function and JSON arguments but no code.
export function run(scriptletGlobals, calls) {
${[...functions.values()].join('\n')}
const table = { ${entryFunctions.join(', ')} };
for (const [name, ...args] of calls) {
  try { table[name](...args); } catch {}
}
}

export { functions };
export default scriptlets;
`);
