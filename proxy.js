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
    // Inherit from the handler rather than copy it, so traps added to it later still apply.
    const proxy = new NativeProxy(target, objectCreate(handler, {
      setPrototypeOf: { value(target, proto) {
        // Returning false makes Object.setPrototypeOf throw and Reflect.setPrototypeOf
        // return false, as both do for a native function.
        if (reaches(proto, proxy, target)) return false;

        // The handler's trap only ever sees non-cyclic prototypes. Own property only,
        // so page code cannot inject a trap through Object.prototype.
        const trap = apply(hasOwnProperty, handler, ['setPrototypeOf']) ? handler.setPrototypeOf : undefined;

        // Same `this` as the handler's other traps get, so state they share through it lines up.
        return trap == null ? setPrototypeOf(target, proto) : apply(trap, this, [target, proto]);
      } },
    }));
    return proxy;
  };
}
