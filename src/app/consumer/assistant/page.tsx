'use client';

// src/app/consumer/assistant/page.tsx
// Flow's chat assistant. Speech-to-text is handled by the browser's own
// Web Speech API (no extra service needed) — the mic button just
// transcribes speech into the text box before sending. Language
// translation isn't a separate step: the assistant model itself
// understands and replies in whatever language the person typed or spoke.
// Nothing ever executes until the person taps Confirm on a specific
// parsed action.

import React, { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  pendingAction?: any;
}

// Assistant replies that contain a generated payment link look like:
// "Your payment link for 3 USDC is ready: https://.../checkout/arc_ref_..."
// Pull the URL out so we can offer a one-tap copy instead of making
// people select the text by hand.
const URL_REGEX = /(https?:\/\/[^\s]+)/;
function extractLink(text: string): string | null {
  const match = text.match(URL_REGEX);
  return match ? match[1] : null;
}

export default function FlowAssistantPage() {
  const router = useRouter();
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: 'assistant',
      text:
        "Hi! Tell me what you'd like to do — e.g. \"Send 20 USDC to 0xAbc123...\" or \"Save 5 USDC every week.\" You can type in any language, or tap the mic to speak.",
    },
  ]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [listening, setListening] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(false);
  const [copiedLinkIndex, setCopiedLinkIndex] = useState<number | null>(null);
  const recognitionRef = useRef<any>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // ── Auth guard — Flow's own session, not merchant ──
  useEffect(() => {
    fetch('/api/consumer/session')
      .then((r) => r.json())
      .then((data) => {
        if (!data.success) router.replace('/consumer');
      })
      .catch(() => router.replace('/consumer'));
  }, [router]);

  // ── Speech-to-text setup ──
  useEffect(() => {
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setSpeechSupported(false);
      return;
    }
    setSpeechSupported(true);
    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    // Browser auto-detects language reasonably well when lang isn't pinned;
    // leaving it unset lets it follow the browser/device locale.
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

  const handleCancel = () => {
    addMessage({ role: 'assistant', text: 'Okay, cancelled. Anything else?' });
  };

  return (
    <main style={{ minHeight: '100vh', background: '#0e0b08', color: '#f0ece6', display: 'flex', flexDirection: 'column', fontFamily: 'Inter, system-ui, sans-serif' }}>
      <div style={{ padding: '18px 20px', borderBottom: '1px solid #2d2015', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h1 style={{ fontSize: 17, fontWeight: 700, margin: 0 }}>Flow Assistant</h1>
          <p style={{ fontSize: 12, color: '#6b5a45', margin: '2px 0 0 0' }}>Talk or type — any language</p>
        </div>
        <button onClick={() => router.push('/consumer')} style={{ background: 'none', border: '1px solid #2d2015', borderRadius: 8, padding: '6px 12px', color: '#c8975a', fontSize: 12, cursor: 'pointer' }}>
          ← Back to Flow
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {messages.map((m, i) => {
          const link = m.role === 'assistant' ? extractLink(m.text) : null;
          return (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
              <div
                style={{
                  maxWidth: '80%',
                  background: m.role === 'user' ? '#c8975a' : '#1a1410',
                  color: m.role === 'user' ? '#0e0b08' : '#f0ece6',
                  border: m.role === 'assistant' ? '1px solid #2d2015' : 'none',
                  borderRadius: 14,
                  padding: '10px 14px',
                  fontSize: 14,
                  lineHeight: 1.5,
                }}
              >
                {m.text}
              </div>

              {link && (
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(link);
                    setCopiedLinkIndex(i);
                    setTimeout(() => setCopiedLinkIndex((cur) => (cur === i ? null : cur)), 1500);
                  }}
                  style={{
                    marginTop: 8,
                    background: copiedLinkIndex === i ? '#0d7c5f' : '#1a1410',
                    color: copiedLinkIndex === i ? '#fff' : '#c8975a',
                    border: '1px solid #2d2015',
                    borderRadius: 8,
                    padding: '8px 16px',
                    fontSize: 13,
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  {copiedLinkIndex === i ? '✓ Copied' : '📋 Copy link'}
                </button>
              )}

              {m.pendingAction && (
                <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                  <button
                    onClick={() => handleConfirm(m.pendingAction)}
                    disabled={sending}
                    style={{ background: '#0d7c5f', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 16px', fontSize: 13, fontWeight: 700, cursor: sending ? 'not-allowed' : 'pointer' }}
                  >
                    Confirm
                  </button>
                  <button
                    onClick={handleCancel}
                    disabled={sending}
                    style={{ background: 'transparent', color: '#9ca3af', border: '1px solid #2d2015', borderRadius: 8, padding: '8px 16px', fontSize: 13, cursor: sending ? 'not-allowed' : 'pointer' }}
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          );
        })}
        <div ref={scrollRef} />
      </div>

      <div style={{ padding: '16px 20px', borderTop: '1px solid #2d2015', display: 'flex', gap: 10 }}>
        {speechSupported && (
          <button
            onClick={toggleListening}
            style={{
              flexShrink: 0, width: 44, height: 44, borderRadius: 12,
              background: listening ? '#dc2626' : '#1a1410',
              border: '1px solid #2d2015', color: listening ? '#fff' : '#c8975a',
              fontSize: 18, cursor: 'pointer',
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
          style={{ flex: 1, background: '#1a1410', border: '1px solid #2d2015', borderRadius: 12, padding: '12px 14px', color: '#f0ece6', fontSize: 14, outline: 'none' }}
        />
        <button
          onClick={handleSend}
          disabled={sending || !input.trim()}
          style={{
            flexShrink: 0, padding: '0 20px', borderRadius: 12, border: 'none',
            background: sending || !input.trim() ? '#6b5a45' : '#c8975a',
            color: '#0e0b08', fontWeight: 700, fontSize: 14, cursor: sending ? 'not-allowed' : 'pointer',
          }}
        >
          Send
        </button>
      </div>
    </main>
  );
}
