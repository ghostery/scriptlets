/**
 * Returns a Proxy constructor wrapper that rejects prototype chains reaching
 * the proxy or its target before changing the target's prototype.
 */
export function createProxy(NativeProxy) {
  const { getPrototypeOf, setPrototypeOf } = Reflect;
  const objectCreate = Object.create;

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
      // Returning false makes Object.setPrototypeOf throw and Reflect.setPrototypeOf
      // return false, as both do for a native function.
      setPrototypeOf: { value: (target, proto) => !reaches(proto, proxy, target) && setPrototypeOf(target, proto) },
    }));
    return proxy;
  };
}
