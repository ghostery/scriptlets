import { test, suite } from "node:test";
import assert from "node:assert";
import vm from "node:vm";
import scriptlets, { compose, run } from "./index.js";
import { functions } from "./ubo.js";

test("default export is an object", () => {
  assert(typeof scriptlets === "object");
});

test("each scriptlet has basic properties", () => {
  for (const [name, scriptlet] of Object.entries(scriptlets)) {
    assert(name.length > 0, `${name} - name is too short`);
    assert(
      functions[scriptlet.fn] instanceof Function,
      `${name} - fn does not name a function`
    );
    assert(
      scriptlet.dependencies.every((dep) => functions[dep] instanceof Function),
      `${name} - a dependency does not name a function`
    );
    assert(
      scriptlet.aliases instanceof Array,
      `${name} - aliases is not an Array`
    );
  }
});

suite("uBO", () => {
  test("handles aliases", () => {
    assert(scriptlets["set-constant.js"]);
    assert.strictEqual(scriptlets["set-constant.js"], scriptlets["set.js"]);
  });
});

suite("safeSelf() cache", () => {
  // Each hook clones the argument with safe.JSON_parse(safe.JSON_stringify(obj))
  const scriptlet = scriptlets["trusted-edit-inbound-object.js"];
  const HOOKS = 6;
  const hookArgs = (i) => ["JSON.stringify", "0", `[?.hook${i}]+={"edited${i}":true}`];

  // A fresh realm is the page; counters wrap the native JSON methods before the scriptlets run
  function createPage() {
    const page = vm.createContext({ EventTarget: class {}, Request: class {} });
    vm.runInContext(
      `
        const { parse, stringify } = JSON;
        globalThis.calls = { parse: 0, stringify: 0 };
        JSON.parse = function (...args) { calls.parse += 1; return parse.apply(JSON, args); };
        JSON.stringify = function (...args) { calls.stringify += 1; return stringify.apply(JSON, args); };
      `,
      page
    );
    return page;
  }

  function assertLinear(page) {
    const result = vm.runInContext(
      "calls.parse = 0; calls.stringify = 0; JSON.stringify({ hook0: true, hook5: true });",
      page
    );
    assert.deepStrictEqual(JSON.parse(result), { hook0: true, hook5: true, edited0: true, edited5: true });
    // One call from the page plus one clone per hook, not 2^n
    assert.deepStrictEqual({ ...page.calls }, { parse: HOOKS, stringify: HOOKS + 1 });
  }

  function assertNoGlobal(page) {
    const keys = vm
      .runInContext("Object.getOwnPropertySymbols(globalThis)", page)
      .filter((key) => key.description.startsWith("safeSelf."));
    assert.strictEqual(keys.length, 0);
  }

  test("compose() shares it in one scope, without a global", () => {
    const page = createPage();
    const code = compose(
      Array.from({ length: HOOKS }, (_, i) => ({ scriptlet, args: hookArgs(i) }))
    );
    assert.strictEqual(code.match(/^function safeSelf\(/gm).length, 1);
    vm.runInContext(code, page);

    assertLinear(page);
    assertNoGlobal(page);
  });

  test("run() shares it in one scope, without a global", () => {
    const page = createPage();
    // Same call as chrome.scripting.executeScript() makes: the function source with JSON arguments
    const calls = Array.from({ length: HOOKS }, (_, i) => [scriptlet.fn, ...hookArgs(i)]);
    vm.runInContext(`(${run})(...${JSON.stringify([{}, calls])});`, page);

    assertLinear(page);
    assertNoGlobal(page);
  });
});
