import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";

interface RepProfileCardProps {
  photoUrl?: string;
  name?: string;
  belowPhoto?: ReactNode;
  children: ReactNode;
}

export function RepProfileCard({ photoUrl, name, belowPhoto, children }: RepProfileCardProps) {
  return (
    <Card className="mb-6 shrink-0">
      <CardContent className="p-6">
        <div className="sm:flex sm:flex-row sm:items-start sm:gap-6 max-sm:grid max-sm:grid-cols-[96px_1fr] max-sm:grid-rows-[96px_auto] max-sm:gap-x-4">
          <div className="relative flex h-24 w-24 shrink-0 overflow-hidden rounded-full border-2 border-muted">
            {photoUrl ? (
              <img src={photoUrl} alt={name} className="aspect-square h-full w-full object-cover object-top" />
            ) : (
              <div className="flex h-full w-full items-center justify-center rounded-full bg-muted text-2xl">{name?.substring(0, 2)}</div>
            )}
          </div>
          <div className="flex-1 min-w-0 max-sm:row-span-2">{children}</div>
          {belowPhoto && <div className="sm:hidden self-start mt-4">{belowPhoto}</div>}
        </div>
      </CardContent>
    </Card>
  );
}
