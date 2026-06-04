import { type ReactNode } from "react";
import { Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { voteBadgeClass } from "@/lib/rep-utils";

type VoteListCardBadge = {
  label: string;
  variant?: "outline" | "secondary";
  className?: string;
};

export function VoteListCard({
  href,
  onClick,
  className,
  badges = [],
  title,
  subtitle,
  date,
  voteCast,
  voteResult,
  children,
}: {
  href?: string | null;
  onClick?: () => void;
  className?: string;
  badges?: VoteListCardBadge[];
  title: ReactNode;
  subtitle?: ReactNode;
  date?: ReactNode;
  voteCast?: string;
  voteResult?: ReactNode;
  children?: ReactNode;
}) {
  const content = (
    <Card
      className={`overflow-hidden${href ? " hover:border-primary transition-colors cursor-pointer" : ""}${className ? ` ${className}` : ""}`}
    >
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            {badges.length > 0 && (
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                {badges.map((badge) => (
                  <Badge
                    key={`${badge.variant ?? "outline"}-${badge.label}`}
                    variant={badge.variant ?? "outline"}
                    className={badge.className ?? "text-xs"}
                  >
                    {badge.label}
                  </Badge>
                ))}
              </div>
            )}
            <p className={`font-medium text-sm line-clamp-2${href ? " hover:text-primary transition-colors" : ""}`}>
              {title}
            </p>
            {subtitle && (
              <p className="text-xs text-muted-foreground mt-0.5">
                {subtitle}
              </p>
            )}
            {date && (
              <p className="text-xs text-muted-foreground mt-1">
                {date}
              </p>
            )}
            {children}
          </div>
          <div className="text-right shrink-0">
            {voteCast && (
              <Badge
                variant="outline"
                className={`text-xs ${voteBadgeClass(voteCast)}`}
              >
                {voteCast}
              </Badge>
            )}
            {voteResult && (
              <p className="text-xs text-muted-foreground mt-1">
                {voteResult}
              </p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );

  if (!href) return content;

  return (
    <Link href={href} onClick={onClick} className="block">
      {content}
    </Link>
  );
}
