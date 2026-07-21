// src/components/ResponsiveSidebar.tsx
"use client";

import React, { useState, useEffect } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";

interface NavItem {
  label: string;
  href: string;
  icon?: React.ReactNode;
}

interface NavSection {
  group: string | null;
  items: NavItem[];
}

interface ResponsiveSidebarProps {
  navSections: NavSection[];
  children: React.ReactNode;
}

export default function ResponsiveSidebar({ navSections, children }: ResponsiveSidebarProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 768);
    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  // Close sidebar when navigating on mobile
  useEffect(() => {
    if (isMobile) setIsOpen(false);
  }, [pathname, isMobile]);

  const toggleSidebar = () => setIsOpen(!isOpen);
  const closeSidebar = () => setIsOpen(false);

  return (
    <div style={{ display: "flex", minHeight: "100vh", position: "relative" }}>
      {/* ── Sidebar ── */}
      <aside
        style={{
          width: 240,
          background: "#1f140f",
          display: "flex",
          flexDirection: "column",
          padding: "24px 14px",
          flexShrink: 0,
          position: isMobile ? "fixed" : "sticky",
          top: 0,
          left: isMobile ? (isOpen ? 0 : "-280px") : 0,
          height: "100vh",
          overflowY: "auto",
          zIndex: 1000,
          transition: "left 0.3s ease",
          borderRight: "1px solid #2d2015",
        }}
      >
        {/* Logo */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 36, paddingLeft: 6 }}>
          <Image src="/arcflare-logo.png" alt="FlareHQ" width={36} height={36} style={{ borderRadius: 8, objectFit: "contain" }} />
          <div>
            <p style={{ color: "#fff", fontSize: 14, fontWeight: 700, lineHeight: 1, margin: 0 }}>FlareHQ</p>
            <p style={{ color: "#4b5563", fontSize: 10, margin: "3px 0 0 0" }}>Stablecoin Payment Infrastructure</p>
          </div>
        </div>

        {/* Navigation */}
        <nav style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1 }}>
          {navSections.map((section) => (
            <div key={section.group || "other"} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {section.group && (
                <p style={{ fontSize: 10, color: "#4b5563", textTransform: "uppercase", letterSpacing: 1, padding: "6px 12px 2px", margin: 0 }}>
                  {section.group}
                </p>
              )}
              {section.items.map((item) => {
                const isActive = pathname === item.href;
                return (
                  <Link
                    key={item.label}
                    href={item.href}
                    style={{
                      display: "flex", alignItems: "center", gap: 10,
                      padding: "9px 12px", borderRadius: 9,
                      textDecoration: "none", fontSize: 13, fontWeight: 500,
                      transition: "all 0.15s",
                      background: isActive ? "rgba(34,211,238,0.18)" : "transparent",
                      color: isActive ? "#22d3ee" : "#6b7280",
                      border: isActive ? "1px solid rgba(34,211,238,0.25)" : "1px solid transparent",
                    }}
                    onClick={closeSidebar}
                  >
                    {item.icon}
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        {/* Footer badges */}
        <div style={{ marginTop: "auto" }}>
          <div style={{ background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.15)", borderRadius: 10, padding: "8px 12px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#f59e0b", display: "inline-block" }} />
              <span style={{ fontSize: 9, color: "#f59e0b", fontWeight: 700, letterSpacing: 1, textTransform: "uppercase" }}>Arc Testnet Mode</span>
            </div>
          </div>
        </div>
      </aside>

      {/* ── Overlay (mobile) ── */}
      {isMobile && isOpen && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0,0,0,0.5)",
            zIndex: 999,
          }}
          onClick={closeSidebar}
        />
      )}

      {/* ── Main Content ── */}
      <main style={{ flex: 1, minWidth: 0, padding: "24px", overflowX: "hidden" }}>
        {/* Mobile hamburger */}
        {isMobile && (
          <button
            onClick={toggleSidebar}
            style={{
              background: "transparent",
              border: "none",
              color: "#fff",
              fontSize: 28,
              cursor: "pointer",
              padding: "8px 0 16px",
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            ☰ <span style={{ fontSize: 14, color: "#888" }}>Menu</span>
          </button>
        )}
        {children}
      </main>

      <style>{`
        @media (max-width: 768px) {
          main { padding: 16px; }
        }
        @media (max-width: 480px) {
          main { padding: 12px; }
        }
      `}</style>
    </div>
  );
}