const tagName = Deno.args.includes('--tagName')
  ? Deno.args[Deno.args.findIndex((o) => o === '--tagName') + 1]
  : false;

if (!tagName) {
  throw new Error('pass argument --tagName <TAG_NAME>');
}

const { builtinScriptlets: scriptlets } = await import(
  `https://raw.githubusercontent.com/gorhill/uBlock/${tagName}/src/js/resources/scriptlets.js`
);

// Every function once, by name; run() declares them all in one scope, so the scriptlets of an
// injection share one safeSelf() cache without touching globalThis, as in uBO.
const functions = new Map(scriptlets.map((scriptlet) => [scriptlet.fn.name, scriptlet.fn.toString()]));
const entries = scriptlets.filter((scriptlet) => scriptlet.name.endsWith('.js'));

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
const scriptlets = {};
${entries
  .map(
    (scriptlet) => `
scriptlets['${scriptlet.name}'] = {
aliases: ${JSON.stringify(scriptlet.aliases || [])},
${scriptlet.world ? `world: '${scriptlet.world}',` : ''}
requiresTrust: ${scriptlet.requiresTrust || false},
fn: '${scriptlet.fn.name}',
};
`,
  )
  .join('\n')}

// The calls come last, so the class dependencies, which are not hoisted, are declared by then.
export function run(scriptletGlobals, calls) {
${[...functions.values()].join('\n')}
const table = { ${entries.map((scriptlet) => scriptlet.fn.name).join(', ')} };
for (const [name, ...args] of calls) {
  try { table[name](...args); } catch {}
}
}

export default scriptlets;
`);
