import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { PanelLeftClose } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/lib/stores/settings-store";

const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

interface SidebarContextValue {
  isTranslucent: boolean;
  isOpen: boolean;
  toggle: () => void;
}

const SidebarContext = createContext<SidebarContextValue>({
  isTranslucent: false,
  isOpen: true,
  toggle: () => {},
});

export function useSidebarContext() {
  return useContext(SidebarContext);
}

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const translucentSidebar = useSettingsStore((s) => s.settings.translucentSidebar);
  const isTranslucent = translucentSidebar !== false;
  const [isOpen, setIsOpen] = useState(true);
  const toggle = useCallback(() => setIsOpen((o) => !o), []);
  const value = useMemo(
    () => ({ isTranslucent, isOpen, toggle }),
    [isTranslucent, isOpen, toggle]
  );

  return <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>;
}

const DEFAULT_WIDTH = 220;
const MIN_WIDTH = 180;
const MAX_WIDTH = 320;

interface SidebarSlot {
  className?: string;
}

interface SidebarShellContextValue {
  container: HTMLDivElement | null;
  setSlot: (slot: SidebarSlot | null) => void;
}

const SidebarShellContext = createContext<SidebarShellContextValue | null>(null);

export function AppSidebarLayout({ children }: { children: React.ReactNode }) {
  const { isTranslucent, toggle } = useSidebarContext();
  const [width, setWidth] = useState(() => {
    const stored = localStorage.getItem("singularity-sidebar-width");
    return stored ? Number(stored) : DEFAULT_WIDTH;
  });
  const [isResizing, setIsResizing] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [slot, setSlotState] = useState<SidebarSlot | null>(null);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);

  useEffect(() => setHydrated(true), []);

  const setSlot = useCallback((next: SidebarSlot | null) => {
    setSlotState((prev) => {
      if (prev?.className === next?.className && prev !== null && next !== null) {
        return prev;
      }
      if (prev === next) return prev;
      return next;
    });
  }, []);

  const shellValue = useMemo(
    () => ({ container, setSlot }),
    [container, setSlot]
  );

  const beginResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    setIsResizing(true);
    const startX = e.clientX;
    const startWidth = width;

    const onMove = (ev: PointerEvent) => {
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + ev.clientX - startX));
      setWidth(next);
    };
    const onUp = () => {
      setIsResizing(false);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }, [width]);

  useEffect(() => {
    localStorage.setItem("singularity-sidebar-width", String(width));
  }, [width]);

  return (
    <SidebarShellContext.Provider value={shellValue}>
      <div className="flex h-screen min-h-0 overflow-hidden bg-transparent">
        {slot && (
          <div
            style={{ width }}
            className={cn(
              "relative my-2 ml-2 flex flex-col min-h-0 flex-shrink-0 rounded-2xl border",
              isResizing || !hydrated ? "" : "transition-[width] duration-slow",
              isTranslucent
                ? "vibrant-sidebar shadow-glass"
                : "border-sidebar-border bg-sidebar shadow-glass-sm",
              slot.className
            )}
          >
            {/*
              The sidebar is a full-height column beside the page, so the app
              header does not cover it. Reserve the header's height here or the
              macOS traffic lights (titleBarStyle "hiddenInset") land on top of
              the brand row. Also doubles as a drag handle, and now carries the
              app brand + the sidebar collapse control (moved out of the
              content header so workspace identity lives in the rail).
            */}
            <div className="drag-region flex h-12 shrink-0 items-center justify-between px-3">
              <span className="text-sm font-semibold tracking-tight text-foreground">
                Singularity
              </span>
              <button
                type="button"
                onClick={toggle}
                aria-label="Hide sidebar"
                className="no-drag inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors duration-fast hover:bg-foreground/10 hover:text-foreground"
              >
                <PanelLeftClose className="h-4 w-4" />
              </button>
            </div>
            <div
              ref={setContainer}
              className="flex flex-col min-h-0 flex-1 overflow-x-hidden overflow-y-auto scrollbar-hide px-2 pb-3"
            />
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize sidebar"
              onPointerDown={beginResize}
              className="absolute top-0 right-0 h-full w-1.5 -mr-[3px] z-20 cursor-col-resize group/resize"
            >
              <div
                className={cn(
                  "absolute inset-y-0 right-[3px] w-px transition-colors",
                  isResizing
                    ? "bg-foreground/25"
                    : "bg-transparent group-hover/resize:bg-foreground/10"
                )}
              />
            </div>
          </div>
        )}
        {children}
      </div>
    </SidebarShellContext.Provider>
  );
}

export function AppSidebar({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const shell = useContext(SidebarShellContext);
  const setSlot = shell?.setSlot;

  useIsomorphicLayoutEffect(() => {
    if (!setSlot) return;
    setSlot({ className });
    return () => setSlot(null);
  }, [setSlot, className]);

  if (!shell?.container) return null;
  return createPortal(children, shell.container);
}
