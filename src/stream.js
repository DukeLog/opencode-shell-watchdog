// The event stream of the server, followed for as long as the plugin instance lives.

/** Resolves after ms, or as soon as the signal aborts. Leaves no listener behind. */
export function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref?.();
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Feeds events of the given types to onEvent until the signal aborts. A stream that ends or fails is
 * opened again: commands started while it is down go unseen, so the first retry comes quickly.
 */
export async function follow(ctx, types, signal, onEvent, onError, { firstDelay = 1000, maxDelay = 30_000 } = {}) {
  let delay = firstDelay;
  while (!signal.aborted) {
    try {
      for await (const event of ctx.event.subscribe({ types, signal })) {
        delay = firstDelay;
        onEvent(event);
      }
    } catch (error) {
      if (signal.aborted) return;
      onError(error);
    }
    if (signal.aborted) return;
    await sleep(delay, signal);
    delay = Math.min(delay * 2, maxDelay);
  }
}
