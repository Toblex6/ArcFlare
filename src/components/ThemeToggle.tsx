// src/components/ThemeToggle.tsx
'use client';

import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';

/**
 * Drop this into any layout or page. Reads/writes the shared theme state
 * from next-themes — no page-specific logic, no local color values.
 */
export default function ThemeToggle({ className = '' }: { className?: string }) {
    const { theme, setTheme } = useTheme();
    // Avoid a hydration mismatch: next-themes doesn't know the real theme
    // until after mount (it reads localStorage client-side).
    const [mounted, setMounted] = useState(false);
    useEffect(() => setMounted(true), []);

    if (!mounted) {
        return <span style={{ display: 'inline-block', width: 32, height: 32 }} />;
    }

    const isDark = theme === 'dark';

    return (
        <button
            type="button"
            aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            onClick={() => setTheme(isDark ? 'light' : 'dark')}
            className={className}
            style={{
                width: 32,
                height: 32,
                borderRadius: '50%',
                border: '1px solid var(--border)',
                background: 'var(--surface-secondary)',
                color: 'var(--text)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 16,
                cursor: 'pointer',
                flexShrink: 0,
            }}
        >
            {isDark ? '☀️' : '🌙'}
        </button>
    );
}
