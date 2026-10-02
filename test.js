import { test, suite } from "node:test";
import assert from "node:assert";
import vm from "node:vm";
import scriptlets from "./index.js";

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
  const func = scriptlets["trusted-edit-inbound-object.js"].func;
  const HOOKS = 6;
  // Same code as the extension makes for each scriptlet; the first argument is scriptletGlobals
  const hooks = Array.from({ length: HOOKS }, (_, i) =>
    `(${func})(...${JSON.stringify([{}, "JSON.stringify", "0", `[?.hook${i}]+={"edited${i}":true}`])});`
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

  test("is shared in a realm, so stacked hooks stay linear", () => {
    const page = createPage();
    for (const hook of hooks) {
      vm.runInContext(hook, page);
    }

    const result = vm.runInContext(
      "calls.parse = 0; calls.stringify = 0; JSON.stringify({ hook0: true, hook5: true });",
      page
    );
    assert.deepStrictEqual(JSON.parse(result), { hook0: true, hook5: true, edited0: true, edited5: true });
    // One call from the page plus one clone per hook, not 2^n
    assert.deepStrictEqual({ ...page.calls }, { parse: HOOKS, stringify: HOOKS + 1 });
  });

  test("is read-only and not enumerable", () => {
    const page = createPage();
    vm.runInContext(hooks.join("\n"), page);

    const keys = vm
      .runInContext("Object.getOwnPropertySymbols(globalThis)", page)
      .filter((key) => key.description.startsWith("safeSelf."));
    assert.strictEqual(keys.length, 1);
    const { value, ...flags } = Object.getOwnPropertyDescriptor(page, keys[0]);
    assert.deepStrictEqual(flags, { writable: false, enumerable: false, configurable: false });
  });
});
