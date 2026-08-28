'use client';

import { useAuth } from '@/context/AuthContext';

/** Client island in the (server-component) root layout's nav — the only
 *  piece that needs to know who's signed in. Renders nothing while signed
 *  out (the login page has no nav chrome of its own to fill this slot). */
export function AccountNav() {
  const { user, logout } = useAuth();
  if (!user) return null;

  return (
    <div className="ml-auto flex items-center gap-3 text-sm">
      <span className="text-[var(--color-muted)]">{user.email}</span>
      <button
        type="button"
        onClick={() => void logout()}
        className="text-[var(--color-muted)] hover:text-[var(--color-ink)]"
      >
        Sign out
      </button>
    </div>
  );
}
