/**
 * Returns a Proxy constructor wrapper that rejects prototype chains reaching
 * the proxy or its target before changing the target's prototype.
 */
export function createProxy(NativeProxy) {
  const reflectApply = Reflect.apply;
  const reflectGetPrototypeOf = Reflect.getPrototypeOf;
  const reflectSetPrototypeOf = Reflect.setPrototypeOf;
  const objectCreate = Object.create;
  const TypeErrorCtor = TypeError;
  const proxies = new WeakSet();
  const { add, has } = WeakSet.prototype;

  // Stop at other proxies created by this wrapper. Unrecognized proxies are
  // traversed, which can invoke page-owned getPrototypeOf traps unlike native checks.
  const isCyclic = (proxy, target, proto) => {
    const stops = (p) => p === null || p === proxy || p === target || reflectApply(has, proxies, [p]);
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
    if (new.target === undefined) {
      throw new TypeErrorCtor("Constructor Proxy requires 'new'");
    }
    let proxy;
    // Inherit from the handler rather than copy it, so traps defined on a prototype still apply
    if (handler instanceof Object && handler.setPrototypeOf === undefined) {
      // Returning false makes Object.setPrototypeOf throw while Reflect.setPrototypeOf
      // returns false. The error message differs from native cycle rejection.
      const setPrototypeOf = (target, proto) =>
        !(proto !== null && isCyclic(proxy, target, proto)) && reflectSetPrototypeOf(target, proto);
      handler = objectCreate(handler, { setPrototypeOf: { value: setPrototypeOf } });
    }
    proxy = new NativeProxy(target, handler);
    reflectApply(add, proxies, [proxy]);
    return proxy;
  };
}
