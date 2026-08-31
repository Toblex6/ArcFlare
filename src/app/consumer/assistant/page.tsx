'use client';

// src/app/consumer/assistant/page.tsx
// Fully upgraded speech + multilingual support:
// - Dropdown to select speech input/output language (defaults to browser language).
// - Speech-to-Text (STT) uses the selected language for accurate transcription.
// - Text-to-Speech (TTS) reads every assistant reply aloud in the selected language.
// - Toggle TTS on/off with a single button.

import React, { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  pendingAction?: any;
}

const URL_REGEX = /(https?:\/\/[^\s]+)/g;
// Non-global twin for .test() — the /g regex above is stateful across test()
// calls (lastIndex persists), which could make later links in a message
// un-clickable. Split with URL_REGEX, test with IS_URL.
const IS_URL = /^https?:\/\//;
function extractLink(text: string): string | null {
  const match = text.match(URL_REGEX);
  return match ? match[0] as any : null;
}
function renderTextWithCopyableLinks(text: string, onCopy: (url: string) => void) {
  const parts = text.split(URL_REGEX);
  return parts.map((part, idx) =>
    IS_URL.test(part) ? (
      <span key={idx} onClick={() => onCopy(part)} title="Click to copy link" style={{ color: '#c8975a', textDecoration: 'underline', cursor: 'pointer', wordBreak: 'break-all' }}>{part}</span>
    ) : (
      <span key={idx}>{part}</span>
    )
  );
}

// List of widely supported languages for speech
const SUPPORTED_LANGUAGES = [
  { code: 'en-US', label: 'English (US)' },
  { code: 'es-ES', label: 'Español' },
  { code: 'fr-FR', label: 'Français' },
  { code: 'de-DE', label: 'Deutsch' },
  { code: 'zh-CN', label: '中文 (简体)' },
  { code: 'ja-JP', label: '日本語' },
  { code: 'hi-IN', label: 'हिन्दी' },
  { code: 'ar-SA', label: 'العربية' },
  { code: 'pt-BR', label: 'Português (BR)' },
  // ✅ New Nigerian languages added below
  { code: 'yo-NG', label: 'Yorùbá' },
  { code: 'ha-NG', label: 'Hausa' },
];

export default function FlareHQAssistantPage() {
  const router = useRouter();
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: 'assistant',
      text:
        "Hi! I am FlareHQ Assistant, Tell me what you'd like to do — e.g. \"Send 20 USDC to 0xAbc123...\" or \"Save 5 USDC every week.\" You can type in any language, or tap the mic to speak.",
    },
  ]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [listening, setListening] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(false);
  const [copiedLinkIndex, setCopiedLinkIndex] = useState<number | null>(null);

  // --- NEW: Multilingual states ---
  // Default to the user's browser/OS language, fallback to English
  const [selectedLang, setSelectedLang] = useState<string>(
    typeof navigator !== 'undefined' ? navigator.language || 'en-US' : 'en-US'
  );
  const [speakReplies, setSpeakReplies] = useState<boolean>(true); // TTS on by default

  const recognitionRef = useRef<any>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const synthRef = useRef<SpeechSynthesis | null>(null);

  // --- Scroll to bottom ---
  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // --- Auth guard ---
  useEffect(() => {
    fetch('/api/consumer/session')
      .then((r) => r.json())
      .then((data) => {
        if (!data.success) router.replace('/consumer');
      })
      .catch(() => router.replace('/consumer'));
  }, [router]);

  // --- Text-to-Speech: speak assistant replies ---
  const speakText = (text: string) => {
    if (!synthRef.current || !speakReplies) return;
    // Cancel any ongoing speech to avoid overlapping
    synthRef.current.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = selectedLang;
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    synthRef.current.speak(utterance);
  };

  // Speak the latest assistant message whenever it's added
  useEffect(() => {
    const lastMsg = messages[messages.length - 1];
    if (lastMsg?.role === 'assistant' && lastMsg.text) {
      speakText(lastMsg.text);
    }
  }, [messages]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Speech-to-Text setup (depends on selectedLang) ---
  useEffect(() => {
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setSpeechSupported(false);
      return;
    }
    setSpeechSupported(true);

    // Re-create recognition whenever language changes
    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = selectedLang; // <<-- CRITICAL: sets the listening language

    recognition.onresult = (event: any) => {
      const transcript = event.results[0][0].transcript;
      setInput((prev) => (prev ? `${prev} ${transcript}` : transcript));
    };
    recognition.onend = () => setListening(false);
    recognition.onerror = () => {
      setListening(false);
      // Silently fail - user can just type or try again
    };

    recognitionRef.current = recognition;

    // Cleanup: stop recognition if component unmounts or lang changes
    return () => {
      if (recognitionRef.current) {
        try { recognitionRef.current.stop(); } catch (_) { }
      }
    };
  }, [selectedLang]); // Re-run when language changes

  // Initialize speech synthesis once
  useEffect(() => {
    if (typeof window !== 'undefined') {
      synthRef.current = window.speechSynthesis;
    }
  }, []);

  // --- Mic toggle ---
  const toggleListening = () => {
    if (!recognitionRef.current) return;
    if (listening) {
      recognitionRef.current.stop();
      setListening(false);
    } else {
      // Ensure we use the latest language
      recognitionRef.current.lang = selectedLang;
      recognitionRef.current.start();
      setListening(true);
    }
  };

  // --- Send / Confirm / Cancel (unchanged logic) ---
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

  // --- Render ---
  return (
    <main style={{ minHeight: '100vh', background: '#0e0b08', color: '#f0ece6', display: 'flex', flexDirection: 'column', fontFamily: 'Inter, system-ui, sans-serif' }}>
      {/* Header - added language selector and TTS toggle */}
      <div style={{ padding: '18px 20px', borderBottom: '1px solid #2d2015', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h1 style={{ fontSize: 17, fontWeight: 700, margin: 0 }}>flareHQ Assistant</h1>
          <p style={{ fontSize: 12, color: '#6b5a45', margin: '2px 0 0 0' }}>
            {speakReplies ? '🔊 Voice replies ON' : '🔇 Voice replies OFF'}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {/* Language Selector */}
          <select
            value={selectedLang}
            onChange={(e) => setSelectedLang(e.target.value)}
            style={{
              background: '#1a1410',
              border: '1px solid #2d2015',
              borderRadius: 8,
              padding: '6px 10px',
              color: '#f0ece6',
              fontSize: 13,
              outline: 'none',
              cursor: 'pointer',
            }}
          >
            {SUPPORTED_LANGUAGES.map((lang) => (
              <option key={lang.code} value={lang.code}>
                {lang.label}
              </option>
            ))}
          </select>

          {/* TTS Toggle Button */}
          <button
            onClick={() => setSpeakReplies((prev) => !prev)}
            style={{
              background: speakReplies ? '#0d7c5f' : '#1a1410',
              border: '1px solid #2d2015',
              borderRadius: 8,
              padding: '6px 12px',
              color: speakReplies ? '#fff' : '#6b5a45',
              fontSize: 13,
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            {speakReplies ? '🔊 Speak' : '🔇 Mute'}
          </button>

          <button onClick={() => router.push('/consumer')} style={{ background: 'none', border: '1px solid #2d2015', borderRadius: 8, padding: '6px 12px', color: '#c8975a', fontSize: 12, cursor: 'pointer' }}>
            ← Back
          </button>
        </div>
      </div>

      {/* Messages - unchanged */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {messages.map((m, i) => {
          const link = m.role === 'assistant' ? extractLink(m.text) : null;
          return (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
              <div
                onClick={() => {
                  if (link) {
                    navigator.clipboard.writeText(link).catch(() => {});
                    setCopiedLinkIndex(i);
                    setTimeout(() => setCopiedLinkIndex((cur) => (cur === i ? null : cur)), 1500);
                  }
                }}
                title={link ? 'Click to copy link' : undefined}
                style={{ cursor: link ? 'pointer' as const : undefined, maxWidth: '80%', background: m.role === 'user' ? '#c8975a' : '#1a1410', color: m.role === 'user' ? '#0e0b08' : '#f0ece6', border: m.role === 'assistant' ? '1px solid #2d2015' : 'none', borderRadius: 14, padding: '10px 14px', fontSize: 14, lineHeight: 1.5, wordBreak: 'break-word' }}
              >
                {m.role === 'assistant' ? renderTextWithCopyableLinks(m.text, (url) => { navigator.clipboard.writeText(url).catch(()=>{}); setCopiedLinkIndex(i); setTimeout(()=> setCopiedLinkIndex(c=> c===i?null:c),1500); }) : m.text}
                {link && <span style={{ display: 'block', marginTop: 6, fontSize: 11, color: copiedLinkIndex === i ? '#0d7c5f' : '#6b5a45' }}>{copiedLinkIndex === i ? '✓ Copied' : 'Click link to copy'}</span>}
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

      {/* Input footer - Added Language label next to mic */}
      <div style={{ padding: '16px 20px', borderTop: '1px solid #2d2015', display: 'flex', gap: 10, alignItems: 'center' }}>
        {speechSupported && (
          <button
            onClick={toggleListening}
            style={{
              flexShrink: 0, width: 44, height: 44, borderRadius: 12,
              background: listening ? '#dc2626' : '#1a1410',
              border: '1px solid #2d2015', color: listening ? '#fff' : '#c8975a',
              fontSize: 18, cursor: 'pointer',
              position: 'relative',
            }}
            title={`Listening in ${selectedLang}`}
          >
            {listening ? '⏹' : '🎤'}
            {/* Small indicator of current speech language */}
            <span style={{
              position: 'absolute', bottom: -6, right: -6,
              background: '#0e0b08', fontSize: 8, padding: '1px 4px',
              borderRadius: 4, border: '1px solid #2d2015', color: '#6b5a45'
            }}>
              {selectedLang.split('-')[0]}
            </span>
          </button>
        )}
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSend()}
          placeholder={`Speak or type in ${selectedLang}...`}
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