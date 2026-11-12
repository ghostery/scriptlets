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

  test("can change prototypes when the page supplied a proxy target", () => {
    const page = vm.createContext({ EventTarget: class {}, Request: class {} });
    vm.runInContext(`
      self = globalThis;
      nativeSetTimeout = function setTimeout() {};
      pageSetTimeout = setTimeout = new Proxy(nativeSetTimeout, {
        getPrototypeOf() { throw new Error("page target trap ran"); },
      });
    `, page);
    const calls = [[scriptlets["prevent-setTimeout.js"].fn, "x"]];
    vm.runInContext(`(${runSource})(...${JSON.stringify([{}, calls])});`, page);
    assert(vm.runInContext("setTimeout !== pageSetTimeout", page));
    assert(vm.runInContext(`
      const proto = Object.create(Function.prototype);
      Object.setPrototypeOf(setTimeout, proto) === setTimeout &&
        Object.getPrototypeOf(nativeSetTimeout) === proto;
    `, page));
    assert.deepStrictEqual({ ...vm.runInContext(probe("setTimeout"), page) }, { ...native });
  });

  for (const timing of ["before", "after"]) {
    test(`ignores page-defined traps added ${timing} scriptlet injection`, () => {
      const page = vm.createContext({ EventTarget: class {}, Request: class {} });
      vm.runInContext(`
        self = globalThis;
        nativeSetTimeout = setTimeout = function setTimeout(callback) { callback(); return 42; };
      `, page);
      const pollute = `
        for (const trap of ["get", "getPrototypeOf", "setPrototypeOf", "apply"]) {
          Object.defineProperty(Object.prototype, trap, {
            __proto__: null,
            value() { throw new Error("page trap ran: " + trap); },
          });
        }
      `;
      if (timing === "before") vm.runInContext(pollute, page);
      const calls = [[scriptlets["prevent-setTimeout.js"].fn, "blockedProbe"]];
      vm.runInContext(`(${runSource})(...${JSON.stringify([{}, calls])});`, page);
      if (timing === "after") vm.runInContext(pollute, page);
      assert(vm.runInContext("setTimeout !== nativeSetTimeout", page));
      assert.deepStrictEqual({ ...vm.runInContext(probe("setTimeout"), page) }, { ...native });
      const result = vm.runInContext(`
        const original = Object.getPrototypeOf(setTimeout);
        Object.setPrototypeOf(setTimeout, Object.create(Function.prototype.toString));
        const cycle = Reflect.setPrototypeOf(Function.prototype.toString, Object.create(setTimeout));
        Object.setPrototypeOf(setTimeout, original);
        let blocked = false, allowed = false;
        const blockedResult = setTimeout(function blockedProbe() { blocked = true; });
        const allowedResult = setTimeout(function allowedProbe() { allowed = true; });
        ({ cycle, name: setTimeout.name, blocked, allowed, blockedResult, allowedResult });
      `, page);
      assert.deepStrictEqual({ ...result }, {
        cycle: false, name: "setTimeout", blocked: false, allowed: true,
        blockedResult: 42, allowedResult: 42,
      });
    });
  }
});
