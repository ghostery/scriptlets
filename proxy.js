/**
 * Returns a Proxy constructor wrapper that rejects prototype chains reaching
 * the proxy or its target before changing the target's prototype.
 */
export function createProxy(NativeProxy) {
  const { apply, getPrototypeOf, setPrototypeOf } = Reflect;
  const objectCreate = Object.create;
  const hasOwnProperty = Object.prototype.hasOwnProperty;

  // Proxies are walked like any other object, so a cycle spanning several scriptlet
  // proxies is found. The tortoise ends walks over chains that are already cyclic.
  const reaches = (proto, proxy, target) => {
    let slow = proto;
    let fast = proto;
    for (let i = 1; fast !== null; i++) {
      if (fast === proxy || fast === target) return true;
      fast = getPrototypeOf(fast);
      if (i % 2 === 0) {
        slow = getPrototypeOf(slow);
        if (slow === fast) return false;
      }
    }
    return false;
  };

  return function Proxy(target, handler) {
    // Compose with the handler's own setPrototypeOf trap, if any: read it once, as an own
    // property only, so page code cannot inject one through Object.prototype. It runs after
    // the cycle check below, so it only ever sees non-cyclic prototypes.
    const trap = apply(hasOwnProperty, handler, ['setPrototypeOf']) ? handler.setPrototypeOf : undefined;

    // Inherit from the handler rather than copy it, so other traps added to it later still apply.
    // A setPrototypeOf trap added to the handler after construction stays shadowed by the composed one.
    const proxy = new NativeProxy(target, objectCreate(handler, {
      setPrototypeOf: { value(target, proto) {
        // Returning false makes Object.setPrototypeOf throw and Reflect.setPrototypeOf
        // return false, as both do for a native function.
        if (reaches(proto, proxy, target)) return false;
        return trap === undefined ? setPrototypeOf(target, proto) : apply(trap, this, [target, proto]);
      } },
    }));
    return proxy;
  };
}
