import type { Dispatch, RefObject, SetStateAction } from "react";

export function setDesktopPaginationOffset({
  nextOffset,
  isMobile,
  listViewportRef,
  setOffset,
}: {
  nextOffset: number;
  isMobile: boolean;
  listViewportRef: RefObject<HTMLElement | null>;
  setOffset: Dispatch<SetStateAction<number>>;
}) {
  if (!isMobile && listViewportRef.current) {
    listViewportRef.current.scrollTop = 0;
  }
  setOffset(nextOffset);
}
