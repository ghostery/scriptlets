import SCRIPTLETS from './ubo.js';

const scriptlets = {};

for (const [name, scriptlet] of Object.entries(SCRIPTLETS)) {
  scriptlets[name] = scriptlet;
  for (const alias of scriptlet.aliases) {
    scriptlets[alias] = scriptlet;
  }
}

export default scriptlets;
