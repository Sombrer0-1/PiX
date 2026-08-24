import { onUnmounted, ref, unref, watch, type MaybeRef, type Ref } from "vue";

/**
 * Wall-clock ticker while `active` is true. Used to render live elapsed time
 * from a `startedAt` timestamp without waiting for a terminal snapshot.
 */
export function useLiveNow(active: MaybeRef<boolean>, intervalMs = 250): Ref<number> {
  const nowMs = ref(Date.now());
  let timer: ReturnType<typeof setInterval> | null = null;

  function stop(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  function start(): void {
    stop();
    nowMs.value = Date.now();
    timer = setInterval(() => {
      nowMs.value = Date.now();
    }, intervalMs);
  }

  watch(
    () => unref(active),
    (on) => {
      if (on) start();
      else stop();
    },
    { immediate: true },
  );
  onUnmounted(stop);
  return nowMs;
}
