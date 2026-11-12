import { test, suite } from "node:test";
import assert from "node:assert";
import vm from "node:vm";
import scriptlets, { run } from "./index.js";
import { createProxy } from "./proxy.js";

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

  test("rejects a cycle spanning two proxied functions like native functions", () => {
    const probeBoth = (a, b) => `
      (() => {
        const a = ${a};
        const b = ${b};
        Object.setPrototypeOf(a, Object.create(b));
        let error;
        try { Object.setPrototypeOf(b, Object.create(a)); } catch (e) { error = e; }
        return { error: error?.name, reflect: Reflect.setPrototypeOf(b, Object.create(a)), call: typeof b.call };
      })()
    `;
    const expected = vm.runInContext(probeBoth("function a() {}", "function b() {}"), vm.createContext({}));
    const page = createPage("prevent-setTimeout.js", "x");
    assert.deepStrictEqual({ ...vm.runInContext(probeBoth("setTimeout", "Function.prototype.toString"), page) }, { ...expected });
  });

  test("still sets a non-cyclic prototype", () => {
    const page = createPage("prevent-setTimeout.js", "x");
    const set = "const proto = Object.create(Function.prototype); Object.setPrototypeOf(setTimeout, proto) === setTimeout && Object.getPrototypeOf(setTimeout) === proto";
    assert(vm.runInContext(set, page));
  });
});

suite("createProxy", () => {
  test("preserves a handler's own setPrototypeOf trap", () => {
    const Proxy = createProxy(globalThis.Proxy);
    const target = function fn() {};
    const calls = [];
    const proxy = new Proxy(target, {
      setPrototypeOf(t, proto) {
        calls.push(proto);
        return Reflect.setPrototypeOf(t, proto);
      },
    });

    // Non-cyclic: the handler's trap runs and its result is honored.
    const proto = Object.create(Function.prototype);
    assert.strictEqual(Reflect.setPrototypeOf(proxy, proto), true);
    assert.deepStrictEqual(calls, [proto]);
    assert.strictEqual(Object.getPrototypeOf(target), proto);

    // A falsish result from the handler's trap is honored, too.
    const rejecting = new Proxy(target, {
      setPrototypeOf() {
        calls.push("reject");
        return false;
      },
    });
    assert.strictEqual(Reflect.setPrototypeOf(rejecting, Object.create(Function.prototype)), false);

    // Cyclic: rejected before the handler's trap runs, like a native function.
    assert.throws(() => Object.setPrototypeOf(proxy, Object.create(proxy)), TypeError);
    assert.strictEqual(Reflect.setPrototypeOf(proxy, Object.create(proxy)), false);
    assert.deepStrictEqual(calls, [proto, "reject"]);
  });

  test("calls the handler's trap with the handler as this, like a native Proxy", () => {
    const Proxy = createProxy(globalThis.Proxy);
    let self;
    const handler = {
      setPrototypeOf() {
        self = this;
        return true;
      },
    };
    Reflect.setPrototypeOf(new Proxy(function fn() {}, handler), {});
    assert.strictEqual(self, handler);
  });

  test("treats a null trap as absent, like a native Proxy", () => {
    const Proxy = createProxy(globalThis.Proxy);
    const target = function fn() {};
    const proto = Object.create(Function.prototype);
    assert.strictEqual(Reflect.setPrototypeOf(new Proxy(target, { setPrototypeOf: null }), proto), true);
    assert.strictEqual(Object.getPrototypeOf(target), proto);
  });

  test("applies a trap added to the handler after construction, like a native Proxy", () => {
    const Proxy = createProxy(globalThis.Proxy);
    const target = function fn() {};
    const handler = {};
    const proxy = new Proxy(target, handler);
    handler.setPrototypeOf = () => false;
    assert.strictEqual(Reflect.setPrototypeOf(proxy, Object.create(Function.prototype)), false);
    assert.strictEqual(Object.getPrototypeOf(target), Function.prototype);

    // The cycle check still comes first.
    handler.setPrototypeOf = () => true;
    assert.strictEqual(Reflect.setPrototypeOf(proxy, Object.create(proxy)), false);
  });

  test("ignores a trap injected through Object.prototype", () => {
    const Proxy = createProxy(globalThis.Proxy);
    const target = function fn() {};
    const proxy = new Proxy(target, {});
    const proto = Object.create(Function.prototype);
    Object.prototype.setPrototypeOf = () => false;
    try {
      assert.strictEqual(Reflect.setPrototypeOf(proxy, proto), true);
    } finally {
      delete Object.prototype.setPrototypeOf;
    }
    assert.strictEqual(Object.getPrototypeOf(target), proto);
  });
});
