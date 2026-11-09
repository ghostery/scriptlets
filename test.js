import { test, suite } from "node:test";
import assert from "node:assert";
import vm from "node:vm";
import scriptlets, { run } from "./index.js";

const runSource = run.toString();

test("default export is an object", () => {
  assert(typeof scriptlets === "object");
});

test("each scriptlet has basic properties", () => {
  for (const [name, scriptlet] of Object.entries(scriptlets)) {
    assert(name.length > 0, `${name} - name is too short`);
    assert(
      runSource.includes(`function ${scriptlet.fn}(`),
      `${name} - fn does not name a function of run()`
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

suite("run()", () => {
  // Each hook clones the argument with safe.JSON_parse(safe.JSON_stringify(obj))
  const scriptlet = scriptlets["trusted-edit-inbound-object.js"];
  const HOOKS = 6;
  const calls = Array.from({ length: HOOKS }, (_, i) => [
    scriptlet.fn,
    "JSON.stringify",
    "0",
    `[?.hook${i}]+={"edited${i}":true}`,
  ]);

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

  test("declares safeSelf() once", () => {
    assert.strictEqual(runSource.match(/^function safeSelf\(/gm).length, 1);
  });

  test("shares one safeSelf() cache, so stacked hooks stay linear", () => {
    const page = createPage();
    // Same call as chrome.scripting.executeScript() makes: the function source with JSON arguments
    vm.runInContext(`(${runSource})(...${JSON.stringify([{}, calls])});`, page);

    const result = vm.runInContext(
      "calls.parse = 0; calls.stringify = 0; JSON.stringify({ hook0: true, hook5: true });",
      page
    );
    assert.deepStrictEqual(JSON.parse(result), { hook0: true, hook5: true, edited0: true, edited5: true });
    // One call from the page plus one clone per hook, not 2^n
    assert.deepStrictEqual({ ...page.calls }, { parse: HOOKS, stringify: HOOKS + 1 });
  });

  test("leaves no global behind", () => {
    const page = createPage();
    vm.runInContext(`(${runSource})(...${JSON.stringify([{}, calls])});`, page);

    const keys = vm
      .runInContext("Object.getOwnPropertySymbols(globalThis)", page)
      .filter((key) => key.description.startsWith("safeSelf."));
    assert.strictEqual(keys.length, 0);
  });
});

suite("proxied functions", () => {
  // A fresh realm is the page; returns it with the scriptlet applied
  function createPage(name, ...args) {
    const page = vm.createContext({ EventTarget: class {}, Request: class {} });
    vm.runInContext("self = globalThis; nativeSetTimeout = setTimeout = function setTimeout() {};", page);
    vm.runInContext(`(${runSource})(...${JSON.stringify([{}, [[scriptlets[name].fn, ...args]]])});`, page);
    return page;
  }

  // Akamai Bot Manager's proxy probe
  const probe = (fn) => `
    (() => {
      const fn = ${fn};
      let error;
      try { Object.setPrototypeOf(fn, Object.create(fn)); } catch (e) { error = e; }
      return { error: error?.name, reflect: Reflect.setPrototypeOf(fn, Object.create(fn)), call: typeof fn.call };
    })()
  `;
  const native = vm.runInContext(probe("function native() {}"), vm.createContext({}));

  for (const [name, fn] of [
    ["prevent-setTimeout.js", "Function.prototype.toString"], // proxied by proxyApplyFn()
    ["adjust-setTimeout.js", "setTimeout"], // proxied by the scriptlet itself
  ]) {
    test(`${name}: rejects a cyclic prototype on ${fn} like a native function`, () => {
      const page = createPage(name, "x");
      assert(vm.runInContext("setTimeout !== nativeSetTimeout", page), `${name} did not run`);
      assert.deepStrictEqual({ ...vm.runInContext(probe(fn), page) }, { ...native });
    });
  }

  test("still sets a non-cyclic prototype", () => {
    const page = createPage("prevent-setTimeout.js", "x");
    const set = "const proto = Object.create(Function.prototype); Object.setPrototypeOf(setTimeout, proto) === setTimeout && Object.getPrototypeOf(setTimeout) === proto";
    assert(vm.runInContext(set, page));
  });
});
