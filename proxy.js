/**
 * Returns a Proxy constructor for scriptlets. Their handlers do not define
 * setPrototypeOf; the page-provided prototype chains are untrusted.
 */
export function createProxy(NativeProxy) {
  const reflectGetPrototypeOf = Reflect.getPrototypeOf;
  const reflectSetPrototypeOf = Reflect.setPrototypeOf;

  // Walk through other scriptlet proxies to catch cycles spanning several hooks.
  // This can invoke page-owned getPrototypeOf traps, unlike native cycle checks.
  const isCyclic = (proxy, target, proto) => {
    const stops = (p) => p === null || p === proxy || p === target;
    let slow = proto;
    let fast = proto;
    // Classic "tortoise and hare" cycle check
    while (!stops(fast)) {
      fast = reflectGetPrototypeOf(fast);
      if (stops(fast)) break;
      fast = reflectGetPrototypeOf(fast);
      slow = reflectGetPrototypeOf(slow);
      if (slow === fast) return false;
    }
    return fast === proxy || fast === target;
  };

  return function Proxy(target, handler) {
    // Copy only the scriptlet's own traps; never inherit traps from the page.
    const proxy = new NativeProxy(target, {
      __proto__: null,
      ...handler,
      setPrototypeOf(target, proto) {
        // Do not inspect the target: it may itself be a page-owned proxy.
        if (isCyclic(proxy, target, proto)) {
          // Object.setPrototypeOf throws; Reflect.setPrototypeOf returns false.
          // The engine's error text still differs from native cycle rejection.
          return false;
        }
        return reflectSetPrototypeOf(target, proto);
      },
    });
    return proxy;
  };
}
