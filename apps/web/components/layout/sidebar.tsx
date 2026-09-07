'use client';

/**
 * Sidebar navigation for the control panel.
 *
 * Renders navigation links for each app section plus user info and a logout
 * button. Consumes the auth context for the current user and logout action.
 *
 * Navigation items are declarative — add an entry here to extend the panel.
 */
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Activity,
  Building,
  Calendar,
  ClipboardList,
  Database,
  FileSearch,
  Gauge,
  LayoutDashboard,
  Link as LinkIcon,
  LogOut,
  Settings,
  Target,
  Users,
} from 'lucide-react';
import { useAuth } from '@/lib/auth/auth-context';

interface NavItem {
  label: string;
  href: string;
  icon: React.ElementType;
  group?: string;
}

const navItems: NavItem[] = [
  { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard, group: 'Overview' },
  { label: 'Crawler', href: '/crawler', icon: Activity, group: 'Operations' },
  { label: 'Search Jobs', href: '/jobs', icon: FileSearch, group: 'Operations' },
  { label: 'Sources', href: '/sources', icon: Database, group: 'Operations' },
  { label: 'Properties', href: '/properties', icon: Building, group: 'Data' },
  { label: 'Listings', href: '/listings', icon: LinkIcon, group: 'Data' },
  { label: 'Duplicates', href: '/duplicates', icon: Target, group: 'Data' },
  { label: 'Contacts', href: '/contacts', icon: Users, group: 'CRM' },
  { label: 'Tasks', href: '/tasks', icon: ClipboardList, group: 'CRM' },
  { label: 'Calendar', href: '/calendar', icon: Calendar, group: 'CRM' },
  { label: 'Opportunities', href: '/opportunities', icon: Target, group: 'CRM' },
  { label: 'Metrics', href: '/metrics', icon: Gauge, group: 'Insights' },
  { label: 'Audit', href: '/audit', icon: FileSearch, group: 'Insights' },
  { label: 'Admin', href: '/admin', icon: Settings, group: 'System' },
];

export function Sidebar() {
  const { user, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  const handleLogout = async () => {
    await logout();
    router.replace('/login');
  };

  const groups = navItems.reduce<Record<string, NavItem[]>>((acc, item) => {
    const group = item.group ?? 'Other';
    if (!acc[group]) acc[group] = [];
    acc[group].push(item);
    return acc;
  }, {});

  return (
    <aside className="flex h-screen w-60 flex-col border-r border-noir-700 bg-noir-850">
      <div className="border-b border-noir-700 px-4 py-4">
        <h1 className="text-base font-bold tracking-tight text-noir-50">cre-command</h1>
        <p className="text-[10px] font-medium uppercase tracking-widest text-noir-400">Control Panel</p>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-3">
        {Object.entries(groups).map(([group, items]) => (
          <div key={group} className="mb-4">
            <p className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-widest text-noir-500">
              {group}
            </p>
            {items.map((item) => {
              const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm font-medium transition-colors ${
                    isActive
                      ? 'bg-gold/10 text-gold'
                      : 'text-noir-300 hover:bg-noir-750 hover:text-noir-100'
                  }`}
                >
                  <item.icon className="h-4 w-4" />
                  {item.label}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="border-t border-noir-700 px-4 py-3">
        {user && (
          <div className="mb-3">
            <p className="text-sm font-medium text-noir-100">
              {user.displayName ?? user.email}
            </p>
            <p className="text-[10px] font-medium uppercase tracking-wider text-noir-400">
              {user.role}
            </p>
          </div>
        )}
        <button
          onClick={handleLogout}
          className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm font-medium text-noir-400 transition-colors hover:bg-noir-750 hover:text-noir-200"
        >
          <LogOut className="h-4 w-4" />
          Sign Out
        </button>
      </div>
    </aside>
  );
}
