import { useCallback, useEffect, useRef, useState } from "react";

export function useResizableContentHeight(
  maxCardHeight: number,
  resizeHandleHeight = 16,
) {
  const chromeRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [naturalHeight, setNaturalHeight] = useState(0);
  const [chromeHeight, setChromeHeight] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);
  const userDraggedRef = useRef(false);

  useEffect(() => {
    if (!chromeRef.current) return;

    const element = chromeRef.current;
    const updateChromeHeight = () => {
      const nextHeight = element.offsetHeight;
      if (nextHeight >= 0) {
        setChromeHeight(nextHeight);
      }
    };

    updateChromeHeight();

    const observer = new ResizeObserver(() => {
      updateChromeHeight();
    });
    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!contentRef.current) return;

    const element = contentRef.current;
    const updateNaturalHeight = () => {
      const nextHeight = element.scrollHeight;
      if (nextHeight > 0) {
        setNaturalHeight(nextHeight);
      }
    };

    updateNaturalHeight();

    const observer = new ResizeObserver(() => {
      updateNaturalHeight();
    });
    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  const isExpandable =
    naturalHeight > 0 && naturalHeight + chromeHeight > maxCardHeight;
  const maxCollapsedContentHeight = isExpandable
    ? Math.max(maxCardHeight - chromeHeight - resizeHandleHeight, 0)
    : Math.max(maxCardHeight - chromeHeight, 0);
  const collapsedHeight =
    naturalHeight > 0
      ? Math.min(naturalHeight, maxCollapsedContentHeight)
      : 0;

  useEffect(() => {
    if (collapsedHeight <= 0) return;
    if (!userDraggedRef.current) {
      setHeight(collapsedHeight);
      return;
    }
    setHeight((currentHeight) => {
      if (currentHeight == null) return collapsedHeight;
      return Math.min(naturalHeight, Math.max(collapsedHeight, currentHeight));
    });
  }, [collapsedHeight, naturalHeight]);

  const handleMouseDown = useCallback(
    (event: React.MouseEvent) => {
      if (naturalHeight <= collapsedHeight) return;
      event.preventDefault();
      userDraggedRef.current = true;
      setIsDragging(true);
      startYRef.current = event.clientY;
      startHeightRef.current = height ?? collapsedHeight;
    },
    [collapsedHeight, height, naturalHeight],
  );

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (event: MouseEvent) => {
      const delta = event.clientY - startYRef.current;
      const nextHeight = Math.min(
        naturalHeight,
        Math.max(collapsedHeight, startHeightRef.current + delta),
      );
      setHeight(nextHeight);
    };
    const handleMouseUp = () => setIsDragging(false);

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [collapsedHeight, isDragging, naturalHeight]);

  const appliedHeight =
    height ?? (collapsedHeight > 0 ? collapsedHeight : null);
  const isScrollable =
    appliedHeight !== null && naturalHeight > 0 && appliedHeight < naturalHeight;

  return {
    chromeRef,
    contentRef,
    height: appliedHeight,
    naturalHeight,
    chromeHeight,
    collapsedHeight,
    isExpandable,
    isScrollable,
    handleMouseDown,
  };
}
