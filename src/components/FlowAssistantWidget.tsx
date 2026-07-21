'use client';

// src/components/FlowAssistantWidget.tsx
// A floating chat bubble for Flow, matching Flow's own look (cream/black/
// orange, Fraunces + Inter) rather than the dark merchant dashboard theme.
// Speech-to-text via the browser's Web Speech API. Language handling is
// done by the assistant model itself — it replies in whatever language
// the person used. Nothing executes until the person taps Confirm.

import React, { useEffect, useRef, useState } from 'react';

interface ChatMessage {
    role: 'user' | 'assistant';
    text: string;
    pendingAction?: any;
}

const COLORS = {
    cream: '#FBF8F3',
    ink: '#1C1B19',
    orange: '#E8714A',
    green: '#5C7A5C',
    muted: '#5C5850',
    mutedLight: '#A39C8C',
    border: '#E5DDC9',
    panelBg: '#FFFFFF',
    bubbleBg: '#EDE6D8',
};

export default function FlowAssistantWidget() {
    const [open, setOpen] = useState(false);
    const [hasSession, setHasSession] = useState(false);
    const [messages, setMessages] = useState<ChatMessage[]>([
        {
            role: 'assistant',
            text: "Hi! Try \"Send 20 USDC to 0xAbc...\" or \"Save 5 USDC every week.\" Type in any language, or tap the mic.",
        },
    ]);
    const [input, setInput] = useState('');
    const [sending, setSending] = useState(false);
    const [listening, setListening] = useState(false);
    const [speechSupported, setSpeechSupported] = useState(false);
    const recognitionRef = useRef<any>(null);
    const scrollRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        fetch('/api/consumer/session')
            .then((r) => r.json())
            .then((data) => setHasSession(!!data.success))
            .catch(() => setHasSession(false));
    }, []);

    useEffect(() => {
        if (open) scrollRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages, open]);

    useEffect(() => {
        const SpeechRecognition =
            (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
        if (!SpeechRecognition) return;
        setSpeechSupported(true);
        const recognition = new SpeechRecognition();
        recognition.continuous = false;
        recognition.interimResults = false;
        recognition.onresult = (event: any) => {
            const transcript = event.results[0][0].transcript;
            setInput((prev) => (prev ? `${prev} ${transcript}` : transcript));
        };
        recognition.onend = () => setListening(false);
        recognition.onerror = () => setListening(false);
        recognitionRef.current = recognition;
    }, []);

    const toggleListening = () => {
        if (!recognitionRef.current) return;
        if (listening) {
            recognitionRef.current.stop();
            setListening(false);
        } else {
            recognitionRef.current.start();
            setListening(true);
        }
    };

    const addMessage = (msg: ChatMessage) => setMessages((prev) => [...prev, msg]);

    const handleSend = async () => {
        const text = input.trim();
        if (!text || sending) return;
        setInput('');
        addMessage({ role: 'user', text });
        setSending(true);
        try {
            const res = await fetch('/api/consumer/assistant', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: text }),
            });
            const data = await res.json();
            if (!data.success) throw new Error(data.error || 'Something went wrong.');
            addMessage({ role: 'assistant', text: data.reply, pendingAction: data.action });
        } catch (e: any) {
            addMessage({ role: 'assistant', text: `⚠️ ${e.message}` });
        } finally {
            setSending(false);
        }
    };

    const handleConfirm = async (action: any) => {
        setSending(true);
        try {
            const res = await fetch('/api/consumer/assistant', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ confirmedAction: action }),
            });
            const data = await res.json();
            if (!data.success) throw new Error(data.error || 'Could not complete that.');
            addMessage({ role: 'assistant', text: `✅ ${data.reply}` });
        } catch (e: any) {
            addMessage({ role: 'assistant', text: `⚠️ ${e.message}` });
        } finally {
            setSending(false);
        }
    };

    const handleCancel = () => addMessage({ role: 'assistant', text: 'Okay, cancelled. Anything else?' });

    if (!hasSession) return null; // no wallet connected yet, nothing to act on

    return (
        <>
            {/* Floating toggle button */}
            <button
                onClick={() => setOpen((o) => !o)}
                style={{
                    position: 'fixed',
                    bottom: 84,
                    right: 20,
                    width: 56,
                    height: 56,
                    borderRadius: '50%',
                    background: COLORS.ink,
                    color: COLORS.cream,
                    border: 'none',
                    fontSize: 22,
                    cursor: 'pointer',
                    boxShadow: '0 6px 18px rgba(0,0,0,0.18)',
                    zIndex: 1002,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                }}
                aria-label="Open Flow Assistant"
            >
                {open ? '✕' : '💬'}
            </button>

            {open && (
                <div
                    style={{
                        position: 'fixed',
                        bottom: 150,
                        right: 20,
                        width: 'min(360px, calc(100vw - 40px))',
                        height: 'min(480px, calc(100vh - 220px))',
                        background: COLORS.cream,
                        border: `1px solid ${COLORS.border}`,
                        borderRadius: 20,
                        boxShadow: '0 12px 32px rgba(0,0,0,0.18)',
                        zIndex: 1001,
                        display: 'flex',
                        flexDirection: 'column',
                        overflow: 'hidden',
                        fontFamily: "'Inter', system-ui, sans-serif",
                    }}
                >
                    <div style={{ padding: '14px 16px', borderBottom: `1px solid ${COLORS.border}`, background: COLORS.panelBg }}>
                        <p style={{ fontFamily: "'Fraunces', serif", fontSize: 16, fontWeight: 600, margin: 0, color: COLORS.ink }}>
                            Flow Assistant
                        </p>
                        <p style={{ fontSize: 11, color: COLORS.mutedLight, margin: '2px 0 0 0' }}>Talk or type — any language</p>
                    </div>

                    <div style={{ flex: 1, overflowY: 'auto', padding: '14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                        {messages.map((m, i) => (
                            <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
                                <div
                                    style={{
                                        maxWidth: '85%',
                                        background: m.role === 'user' ? COLORS.orange : COLORS.bubbleBg,
                                        color: m.role === 'user' ? COLORS.cream : COLORS.ink,
                                        borderRadius: 14,
                                        padding: '9px 12px',
                                        fontSize: 13,
                                        lineHeight: 1.5,
                                    }}
                                >
                                    {m.text}
                                </div>
                                {m.pendingAction && (
                                    <div style={{ marginTop: 6, display: 'flex', gap: 6 }}>
                                        <button
                                            onClick={() => handleConfirm(m.pendingAction)}
                                            disabled={sending}
                                            style={{ background: COLORS.green, color: '#fff', border: 'none', borderRadius: 8, padding: '6px 12px', fontSize: 12, fontWeight: 700, cursor: sending ? 'not-allowed' : 'pointer' }}
                                        >
                                            Confirm
                                        </button>
                                        <button
                                            onClick={handleCancel}
                                            disabled={sending}
                                            style={{ background: 'transparent', color: COLORS.muted, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: '6px 12px', fontSize: 12, cursor: sending ? 'not-allowed' : 'pointer' }}
                                        >
                                            Cancel
                                        </button>
                                    </div>
                                )}
                            </div>
                        ))}
                        <div ref={scrollRef} />
                    </div>

                    <div style={{ padding: '10px 12px', borderTop: `1px solid ${COLORS.border}`, background: COLORS.panelBg, display: 'flex', gap: 8 }}>
                        {speechSupported && (
                            <button
                                onClick={toggleListening}
                                style={{
                                    flexShrink: 0, width: 38, height: 38, borderRadius: 10,
                                    background: listening ? '#C0563A' : COLORS.bubbleBg,
                                    border: 'none', color: listening ? '#fff' : COLORS.orange,
                                    fontSize: 15, cursor: 'pointer',
                                }}
                                title={listening ? 'Stop listening' : 'Speak instead of typing'}
                            >
                                {listening ? '⏹' : '🎤'}
                            </button>
                        )}
                        <input
                            type="text"
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                            placeholder="Send 20 USDC to 0x..."
                            style={{ flex: 1, background: COLORS.bubbleBg, border: 'none', borderRadius: 10, padding: '9px 11px', color: COLORS.ink, fontSize: 13, outline: 'none', fontFamily: 'inherit' }}
                        />
                        <button
                            onClick={handleSend}
                            disabled={sending || !input.trim()}
                            style={{
                                flexShrink: 0, padding: '0 14px', borderRadius: 10, border: 'none',
                                background: sending || !input.trim() ? COLORS.mutedLight : COLORS.ink,
                                color: COLORS.cream, fontWeight: 700, fontSize: 13, cursor: sending ? 'not-allowed' : 'pointer',
                            }}
                        >
                            →
                        </button>
                    </div>
                </div>
            )}
        </>
    );
}
