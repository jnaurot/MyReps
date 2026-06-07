import { type ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { GripHorizontal } from "lucide-react";
import { useResizableContentHeight } from "@/hooks/useResizableContentHeight";

export function ResizableDetailCard({
  title,
  children,
  className = "",
  contentClassName = "",
  maxHeight = 300,
}: {
  title: string;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  maxHeight?: number;
}) {
  const {
    chromeRef,
    contentRef,
    height,
    isExpandable,
    isScrollable,
    handleMouseDown,
  } = useResizableContentHeight(maxHeight);

  return (
    <Card className={`overflow-hidden flex flex-col ${className}`}>
      <CardHeader ref={chromeRef} className="pb-3 shrink-0">
        <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent
        ref={contentRef}
        className={`pt-0 pr-3 ${isScrollable ? "overflow-y-auto" : "overflow-hidden"} ${contentClassName}`}
        style={height !== null ? { height } : undefined}
      >
        {children}
      </CardContent>
      {isExpandable && (
        <div
          className="shrink-0 h-4 flex items-center justify-center cursor-ns-resize bg-muted/30 hover:bg-muted/50 transition-colors"
          onMouseDown={handleMouseDown}
        >
          <GripHorizontal className="h-3 w-3 text-muted-foreground/50" />
        </div>
      )}
    </Card>
  );
}
