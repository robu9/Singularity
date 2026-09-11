import React from "react";
import { PanelLeftOpen } from "lucide-react";
import { AppSidebar, useSidebarContext } from "@/components/app-sidebar";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface AppShellProps {
  /** Nav content portalled into the resizable sidebar. */
  nav: React.ReactNode;
  /** Right-aligned header content — status pills, search, primary actions. */
  headerActions?: React.ReactNode;
  /** Extra content next to the sidebar-reopen control (e.g. Back). */
  headerLeading?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * The window chrome shared by /home and /settings: a floating draggable
 * header bar, the portalled sidebar, and the main content pane. The app
 * brand and the sidebar collapse control live in the sidebar itself
 * (see app-sidebar.tsx) — this header only needs a reopen control, and only
 * when the sidebar is currently hidden.
 */
export function AppShell({ nav, headerActions, headerLeading, children }: AppShellProps) {
  const { isOpen, toggle } = useSidebarContext();

  return (
    <TooltipProvider>
      <div className="flex h-screen min-h-0 min-w-0 flex-1 flex-col">
        <header
          className={cn(
            "drag-region glass-panel mx-2 mt-2 flex h-11 shrink-0 items-center justify-between gap-3 rounded-xl px-3"
          )}
        >
          <div className="no-drag flex items-center gap-2">
            {!isOpen && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={toggle}
                    aria-label="Show sidebar"
                  >
                    <PanelLeftOpen className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Show sidebar</TooltipContent>
              </Tooltip>
            )}
            {headerLeading}
          </div>

          {headerActions && (
            <div className="no-drag flex items-center gap-2">{headerActions}</div>
          )}
        </header>

        <div className="flex min-h-0 min-w-0 flex-1">
          {isOpen && (
            <AppSidebar>
              <nav className="flex min-h-0 flex-1 flex-col gap-0.5">{nav}</nav>
            </AppSidebar>
          )}
          <main className="flex min-h-0 w-full min-w-0 flex-1 bg-transparent">{children}</main>
        </div>
      </div>
    </TooltipProvider>
  );
}

/** A single sidebar nav row. Shared by the main nav and the settings nav. */
export function NavButton({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: React.ElementType;
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn("nav-item w-full", active && "nav-item-active")}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {label}
    </button>
  );
}
