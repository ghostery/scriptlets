import test from "node:test";
import assert from "node:assert";
import scriptlets from "./index.js";

test("default export is an object", () => {
  assert(typeof scriptlets === "object");
});

test("each scriptlet has basic properties", () => {
  for (const [name, scriptlet] of Object.entries(scriptlets)) {
    assert(name.length > 0, `${name} - name is too short`);
    assert(scriptlet.func instanceof Function, `${name} - func is not have a Function`);
    assert(scriptlet.aliases instanceof Array, `${name} - aliases is not an Array`);
  }
});
