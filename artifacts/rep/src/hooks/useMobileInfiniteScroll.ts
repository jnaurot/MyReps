import { useEffect, useRef } from "react";

/**
 * Drives mobile infinite scroll for a fixed-height scroll container.
 *
 * Two complementary triggers fire `onLoadNext(nextOffset)`:
 *   1. IntersectionObserver watching a sentinel element at the end of the list.
 *      rootMargin "400px" fires before the sentinel is actually visible, giving
 *      time to fetch the next page while the user is still reading.
 *   2. `triggerIfNearBottom` — call this from the container's onScroll handler
 *      as a fallback for cases where scroll-snap or momentum scrolling prevents
 *      the sentinel from entering the observer's detection zone.
 *
 * Callers must:
 *   - Render `<div ref={sentinelRef} className="h-16" />` as the last child of
 *     the scroll container (the extra height ensures the observer can detect it).
 *   - Pass `listViewportRef` pointing at the scroll container so it is used as
 *     the observer root.
 *   - NOT apply scroll-snap to the list container — proximity snap traps the
 *     scroll position before the sentinel becomes reachable.
 */
export function useMobileInfiniteScroll({
  isMobile,
  listViewportRef,
  allItemsLength,
  totalCount,
  loading,
  isPlaceholder,
  onLoadNext,
}: {
  isMobile: boolean;
  listViewportRef: React.RefObject<HTMLDivElement | null>;
  allItemsLength: number;
  totalCount: number;
  loading: boolean;
  isPlaceholder: boolean;
  onLoadNext: (nextOffset: number) => void;
}) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  // Keep a ref so the callback always sees the latest value without being a dep.
  const onLoadNextRef = useRef(onLoadNext);
  onLoadNextRef.current = onLoadNext;

  useEffect(() => {
    if (!isMobile) return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !loading && !isPlaceholder) {
          const next = allItemsLength;
          if (next < totalCount) onLoadNextRef.current(next);
        }
      },
      { root: listViewportRef.current, rootMargin: "400px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [isMobile, loading, isPlaceholder, allItemsLength, totalCount, listViewportRef]);

  function triggerIfNearBottom(el: HTMLDivElement) {
    if (!isMobile || loading || isPlaceholder) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    if (scrollHeight - scrollTop - clientHeight < 300) {
      const next = allItemsLength;
      if (next < totalCount) onLoadNextRef.current(next);
    }
  }

  return { sentinelRef, triggerIfNearBottom };
}
