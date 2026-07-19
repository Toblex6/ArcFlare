// src/lib/email.ts
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY!);

// Resend's free tier only sends FROM their shared onboarding domain
// (onboarding@resend.dev) until you verify your own domain in the
// Resend dashboard. Swap FROM_EMAIL once you've verified arcflare's domain.
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'ArcFlare <onboarding@resend.dev>';

export function generateVerificationCode(): string {
  // 6-digit numeric code, e.g. "042817"
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export async function sendVerificationEmail(email: string, businessName: string, code: string) {
  const { error } = await resend.emails.send({
    from: FROM_EMAIL,
    to: email,
    subject: `${code} is your ArcFlare verification code`,
    html: `
      <div style="font-family: Inter, system-ui, sans-serif; background:#0e0b08; color:#f0ece6; padding:32px; border-radius:16px; max-width:480px; margin:0 auto;">
        <h2 style="margin:0 0 8px;">Verify your ArcFlare account</h2>
        <p style="color:#8a7560; font-size:14px;">Hi ${businessName}, use the code below to finish creating your merchant account.</p>
        <div style="background:#1a1410; border:1px solid #c8975a; border-radius:12px; padding:20px; text-align:center; margin:20px 0;">
          <span style="font-size:32px; font-weight:800; letter-spacing:8px; color:#c8975a;">${code}</span>
        </div>
        <p style="color:#6b5a45; font-size:12px;">This code expires in 10 minutes. If you didn't request this, you can ignore this email.</p>
      </div>
    `,
  });

  if (error) {
    console.error('[email] Resend error:', error);
    throw new Error('Failed to send verification email.');
  }
}
