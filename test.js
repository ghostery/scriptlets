import { test, suite } from "node:test";
import assert from "node:assert";
import vm from "node:vm";
import scriptlets, { compose, run } from "./index.js";

test("default export is an object", () => {
  assert(typeof scriptlets === "object");
});

test("each scriptlet has basic properties", () => {
  for (const [name, scriptlet] of Object.entries(scriptlets)) {
    assert(name.length > 0, `${name} - name is too short`);
    assert(
      scriptlet.func instanceof Function,
      `${name} - func is not have a Function`
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
  const func = scriptlet.func;
  const HOOKS = 6;
  const hookArgs = (i) => ["JSON.stringify", "0", `[?.hook${i}]+={"edited${i}":true}`];
  // Same code as the extension makes for each scriptlet; the first argument is scriptletGlobals
  const hooks = Array.from({ length: HOOKS }, (_, i) =>
    `(${func})(...${JSON.stringify([{}, ...hookArgs(i)])});`
  );

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

  function safeSelfSymbols(page) {
    return vm
      .runInContext("Object.getOwnPropertySymbols(globalThis)", page)
      .filter((key) => key.description.startsWith("safeSelf."));
  }

  test("is shared in a realm, so stacked hooks stay linear", () => {
    const page = createPage();
    for (const hook of hooks) {
      vm.runInContext(hook, page);
    }
    assertLinear(page);
  });

  test("is read-only and not enumerable", () => {
    const page = createPage();
    vm.runInContext(hooks.join("\n"), page);

    const keys = safeSelfSymbols(page);
    assert.strictEqual(keys.length, 1);
    const { value, ...flags } = Object.getOwnPropertyDescriptor(page, keys[0]);
    assert.deepStrictEqual(flags, { writable: false, enumerable: false, configurable: false });
  });

  test("compose() shares it in one scope, without a global", () => {
    const page = createPage();
    const code = compose(
      Array.from({ length: HOOKS }, (_, i) => ({ scriptlet, args: hookArgs(i) }))
    );
    assert.strictEqual(code.match(/^function safeSelf\(/gm).length, 1);
    vm.runInContext(code, page);

    assertLinear(page);
    assert.strictEqual(safeSelfSymbols(page).length, 0);
  });

  test("run() shares it in one scope, without a global", () => {
    const page = createPage();
    // Same call as chrome.scripting.executeScript() makes: the function source with JSON arguments
    const calls = Array.from({ length: HOOKS }, (_, i) => [scriptlet.fn, ...hookArgs(i)]);
    vm.runInContext(`(${run})(...${JSON.stringify([{}, calls])});`, page);

    assertLinear(page);
    assert.strictEqual(safeSelfSymbols(page).length, 0);
  });
});
