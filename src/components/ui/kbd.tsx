import * as React from "react";
import { cn } from "@/lib/utils";

function Kbd({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 items-center rounded border border-foreground/10 bg-foreground/[0.06] px-1.5 text-[10px] font-medium text-muted-foreground",
        className
      )}
      {...props}
    />
  );
}

export { Kbd };
