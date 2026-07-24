// src/app/dashboard/page.tsx
// This used to be a public, unauthenticated dashboard showing every
// merchant's data, with an exposed API key. It's retired — redirect to
// the real, scoped one at /merchant/dashboard.
import { redirect } from 'next/navigation';

export default function OldDashboardRedirect() {
  redirect('/merchant/dashboard');
}
