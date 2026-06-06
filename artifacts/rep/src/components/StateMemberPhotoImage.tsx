import { useEffect, useState } from "react";

interface StateMemberPhotoImageProps {
  proxyPhotoUrl?: string;
  rawPhotoUrl?: string;
  alt?: string;
  className?: string;
  fallbackClassName?: string;
  fallbackText?: string;
}

export function StateMemberPhotoImage({
  proxyPhotoUrl,
  rawPhotoUrl,
  alt,
  className,
  fallbackClassName,
  fallbackText,
}: StateMemberPhotoImageProps) {
  const [displaySrc, setDisplaySrc] = useState<string | null>(proxyPhotoUrl ?? null);

  useEffect(() => {
    setDisplaySrc(proxyPhotoUrl ?? null);
  }, [proxyPhotoUrl]);

  useEffect(() => {
    if (!proxyPhotoUrl || !rawPhotoUrl) return;

    let cancelled = false;

    void (async () => {
      try {
        const probe = await fetch(proxyPhotoUrl, {
          method: "HEAD",
          cache: "no-store",
        });
        if (cancelled) return;

        const stale = probe.headers.get("x-photo-stale") === "1";
        if (!stale) {
          setDisplaySrc(proxyPhotoUrl);
          return;
        }
        setDisplaySrc(rawPhotoUrl);
      } catch {
        if (!cancelled) {
          setDisplaySrc(proxyPhotoUrl);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [proxyPhotoUrl, rawPhotoUrl]);

  if (!displaySrc) {
    return (
      <div className={fallbackClassName}>
        {fallbackText}
      </div>
    );
  }

  return <img src={displaySrc} alt={alt} className={className} />;
}
