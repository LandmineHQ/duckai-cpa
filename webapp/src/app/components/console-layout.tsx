import { useEffect, useState, type ReactNode } from 'react';
import { Menu } from 'lucide-react';
import { ROUTE_META, type Route } from '@/app/lib/hash-route';
import { useOverview } from '@/app/lib/overview-context';
import { Button } from '@/components/ui/button';
import { Brand } from './brand';
import { QueueStatusChips } from './queue-status-chips';
import { Sidebar } from './sidebar';

const FULL_HEIGHT_ROUTES = new Set<Route>(['chat', 'images']);

export function ConsoleLayout({
  route,
  onLogout,
  children
}: {
  route: Route;
  onLogout: () => void;
  children: ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const { data } = useOverview();

  useEffect(() => {
    setMobileOpen(false);
  }, [route]);

  const meta = ROUTE_META[route];
  const fullHeight = FULL_HEIGHT_ROUTES.has(route);

  return (
    <div className="flex min-h-screen bg-background">
      <Sidebar
        route={route}
        mobileOpen={mobileOpen}
        onCloseMobile={() => setMobileOpen(false)}
        onLogout={onLogout}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border/70 bg-card/85 px-4 backdrop-blur-md lg:px-6">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            aria-label="打开菜单"
            onClick={() => setMobileOpen(true)}
          >
            <Menu className="h-4 w-4" />
          </Button>
          <div className="lg:hidden">
            <Brand compact />
          </div>
          <div className="hidden min-w-0 items-center gap-2 text-sm lg:flex">
            <span className="font-medium text-muted-foreground">DuckAI CPA</span>
            <span className="text-muted-foreground/50">/</span>
            <span className="truncate font-semibold text-foreground">{meta?.title ?? '控制台'}</span>
          </div>
          <div className="ml-auto flex items-center gap-2 overflow-x-auto">
            <QueueStatusChips />
          </div>
        </header>

        {fullHeight ? (
          <main className="flex min-h-0 flex-1 flex-col">{children}</main>
        ) : (
          <>
            <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-5 sm:px-6 lg:px-8 lg:py-6">
              {children}
            </main>
            <footer className="px-4 pb-5 text-center text-[11px] text-muted-foreground sm:px-6 lg:px-8">
              DuckAI CPA v{data?.service?.version ?? '—'} · 仅供学习与私有部署 · 遵守 duck.ai 服务条款
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
