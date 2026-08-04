// src/components/NotificationSettings.tsx
'use client';

import React, { useEffect, useState } from 'react';

interface EventMeta {
    label: string;
    description: string;
}

interface Preferences {
    emailEnabled: boolean;
    webhookEnabled: boolean;
    inAppEnabled: boolean;
    webhookUrl: string | null;
    mutedEvents: string[];
}

const cardStyle: React.CSSProperties = {
    background: '#fff',
    border: '1px solid #e2e8f0',
    borderRadius: 16,
    padding: 24,
};

const toggleTrack = (on: boolean): React.CSSProperties => ({
    width: 40,
    height: 22,
    borderRadius: 999,
    background: on ? '#0d7c5f' : '#e2e8f0',
    position: 'relative',
    cursor: 'pointer',
    transition: 'background 0.15s',
    flexShrink: 0,
});

const toggleThumb = (on: boolean): React.CSSProperties => ({
    width: 18,
    height: 18,
    borderRadius: '50%',
    background: '#fff',
    position: 'absolute',
    top: 2,
    left: on ? 20 : 2,
    transition: 'left 0.15s',
    boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
});

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }} onClick={() => onChange(!on)}>
            <div style={toggleTrack(on)}>
                <div style={toggleThumb(on)} />
            </div>
            {label && <span style={{ fontSize: 13, color: '#0f172a' }}>{label}</span>}
        </div>
    );
}

export default function NotificationSettings() {
    const [events, setEvents] = useState<Record<string, EventMeta>>({});
    const [prefs, setPrefs] = useState<Preferences | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [webhookInput, setWebhookInput] = useState('');

    useEffect(() => {
        fetch('/api/merchant/notifications/preferences')
            .then((r) => r.json())
            .then((json) => {
                if (json.success) {
                    setPrefs(json.preferences);
                    setEvents(json.availableEvents);
                    setWebhookInput(json.preferences.webhookUrl || '');
                } else {
                    setError(json.error || 'Failed to load preferences.');
                }
            })
            .catch(() => setError('Failed to load preferences.'))
            .finally(() => setLoading(false));
    }, []);

    const save = async (next: Partial<Preferences>) => {
        if (!prefs) return;
        const merged = { ...prefs, ...next };
        setPrefs(merged);
        setSaving(true);
        setSaved(false);
        try {
            const res = await fetch('/api/merchant/notifications/preferences', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(merged),
            });
            const json = await res.json();
            if (!json.success) throw new Error(json.error);
            setPrefs(json.preferences);
            setSaved(true);
            setTimeout(() => setSaved(false), 1500);
        } catch (err: any) {
            setError(err.message || 'Failed to save.');
        } finally {
            setSaving(false);
        }
    };

    const toggleMuted = (eventKey: string) => {
        if (!prefs) return;
        const isMuted = prefs.mutedEvents.includes(eventKey);
        const next = isMuted
            ? prefs.mutedEvents.filter((e) => e !== eventKey)
            : [...prefs.mutedEvents, eventKey];
        save({ mutedEvents: next });
    };

    if (loading) return <p style={{ color: '#94a3b8', fontSize: 13 }}>Loading notification settings...</p>;
    if (error && !prefs) return <p style={{ color: '#dc2626', fontSize: 13 }}>{error}</p>;
    if (!prefs) return null;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            {/* Channels */}
            <div style={cardStyle}>
                <h3 style={{ fontSize: 14, fontWeight: 700, color: '#0f172a', margin: '0 0 4px' }}>Notification Channels</h3>
                <p style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 18px' }}>Choose how you want to be notified. Per-event muting below applies across all enabled channels.</p>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div>
                            <p style={{ fontSize: 13, fontWeight: 600, color: '#0f172a', margin: 0 }}>Email</p>
                            <p style={{ fontSize: 11, color: '#94a3b8', margin: 0 }}>Sent to your account email</p>
                        </div>
                        <Toggle on={prefs.emailEnabled} onChange={(v) => save({ emailEnabled: v })} />
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div>
                            <p style={{ fontSize: 13, fontWeight: 600, color: '#0f172a', margin: 0 }}>In-app</p>
                            <p style={{ fontSize: 11, color: '#94a3b8', margin: 0 }}>Shows in your dashboard notification bell</p>
                        </div>
                        <Toggle on={prefs.inAppEnabled} onChange={(v) => save({ inAppEnabled: v })} />
                    </div>

                    <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <div>
                                <p style={{ fontSize: 13, fontWeight: 600, color: '#0f172a', margin: 0 }}>Webhook</p>
                                <p style={{ fontSize: 11, color: '#94a3b8', margin: 0 }}>POSTed as JSON to your endpoint</p>
                            </div>
                            <Toggle on={prefs.webhookEnabled} onChange={(v) => save({ webhookEnabled: v })} />
                        </div>
                        {prefs.webhookEnabled && (
                            <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
                                <input
                                    value={webhookInput}
                                    onChange={(e) => setWebhookInput(e.target.value)}
                                    placeholder="https://your-server.com/webhooks/flarehq"
                                    style={{ flex: 1, padding: '8px 10px', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 12, fontFamily: 'monospace' }}
                                />
                                <button
                                    onClick={() => save({ webhookUrl: webhookInput })}
                                    style={{ padding: '8px 14px', borderRadius: 8, border: 'none', background: '#0d7c5f', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                                >
                                    Save URL
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* Per-event toggles */}
            <div style={cardStyle}>
                <h3 style={{ fontSize: 14, fontWeight: 700, color: '#0f172a', margin: '0 0 4px' }}>Events</h3>
                <p style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 18px' }}>All events are on by default. Turn off anything you don't want to hear about.</p>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {Object.entries(events).map(([key, meta]) => {
                        const isOn = !prefs.mutedEvents.includes(key);
                        return (
                            <div key={key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingBottom: 12, borderBottom: '1px solid #f1f5f9' }}>
                                <div>
                                    <p style={{ fontSize: 13, fontWeight: 600, color: '#0f172a', margin: 0 }}>{meta.label}</p>
                                    <p style={{ fontSize: 11, color: '#94a3b8', margin: 0 }}>{meta.description}</p>
                                </div>
                                <Toggle on={isOn} onChange={() => toggleMuted(key)} />
                            </div>
                        );
                    })}
                </div>
            </div>

            {(saving || saved) && (
                <p style={{ fontSize: 11, color: saved ? '#0d7c5f' : '#94a3b8', textAlign: 'right' }}>
                    {saving ? 'Saving...' : '✓ Saved'}
                </p>
            )}
            {error && <p style={{ fontSize: 12, color: '#dc2626' }}>{error}</p>}
        </div>
    );
}
