import { useMemo } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { LogOut, Moon, Settings, Sun, User } from 'lucide-react'

import { AppShell } from '@/components/ui/app-shell'
import { Button } from '@/components/ui/button'
import { ALL_UNITS, teamItems } from '@/lib/org'
import { DWOS } from '@/config/dwos'
import { toggleTheme, useTheme } from '@/lib/theme'

/**
 * The DWOS dashboard frame.
 *
 * Everything structural comes from `DWOS` in config/dwos.ts — this file only
 * supplies the three things a shell cannot know: how a link becomes a route,
 * who is signed in, and how the theme toggles.
 *
 * The unit is derived from the URL rather than held in state. A pasted link to
 * /unit-6/jobs has to land in Unit 6 with the right nav showing; a shell whose
 * unit lives only in React state opens that link in whatever unit was last used
 * and quietly shows the wrong sidebar.
 */

/** `/unit-4/vessels/map` -> `unit-4`. Anything else is the cross-unit view. */
function unitFromPath(pathname: string): string {
  const m = /^\/(unit-\d+)\b/.exec(pathname)
  return m ? m[1] : ALL_UNITS
}

export default function DwosShell({ children }: { children: React.ReactNode }) {
  const location = useLocation()
  const navigate = useNavigate()
  const theme = useTheme()

  const unitId = unitFromPath(location.pathname)

  /**
   * The active nav item is the one whose href is the longest prefix of the
   * current path. Exact matching breaks the moment a screen has a detail route
   * (/vessels/reports/CA3/2026-05-06) and the nav goes blank on it.
   */
  const activeItemId = useMemo(() => {
    const candidates = teamItems(DWOS)
      .filter(i => location.pathname === i.href || location.pathname.startsWith(i.href + '/'))
      .sort((a, b) => b.href.length - a.href.length)
    return candidates[0]?.id
  }, [location.pathname])

  return (
    <AppShell
      team={DWOS}
      unitId={unitId}
      onUnitChange={id => {
        // Switching unit lands on that unit's first item rather than holding the
        // current path: /unit-4/vessels/map does not exist under Unit 2, and a
        // 404 is a poor answer to "show me Unit 2".
        if (id === ALL_UNITS) { navigate('/'); return }
        const first = DWOS.units.find(u => u.id === id)?.groups[0]?.items[0]
        navigate(first?.href ?? '/')
      }}
      activeItemId={activeItemId}
      user={{ name: 'Saud Alkharji', role: 'Operational Support' }}
      renderLink={(item, content) => <Link to={item.href}>{content}</Link>}
      userMenu={[
        [
          { id: 'profile', label: 'Profile', icon: User },
          { id: 'settings', label: 'Settings', icon: Settings },
        ],
        [{ id: 'signout', label: 'Sign out', icon: LogOut, destructive: true }],
      ]}
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center justify-end px-4 pt-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleTheme}
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          >
            {theme === 'dark' ? <Sun /> : <Moon />}
          </Button>
        </div>
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    </AppShell>
  )
}
