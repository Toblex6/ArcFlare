import { Resend } from 'resend';
import { randomInt } from 'node:crypto';

const resend = new Resend(process.env.RESEND_API_KEY!);

// Fallback updated to FlareHQ
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'FlareHQ <onboarding@resend.dev>';

export function generateVerificationCode(): string {
  // Cryptographically secure — Math.random() output is recoverable from a
  // handful of samples, which would let an attacker predict a victim's
  // 6-digit email-verification / password-reset code (H9).
  return randomInt(100000, 1000000).toString();
}

export async function sendVerificationEmail(email: string, businessName: string, code: string) {
  console.log("FROM_EMAIL =", FROM_EMAIL);
  const { error } = await resend.emails.send({
    from: FROM_EMAIL,
    to: email,
    subject: `${code} is your FlareHQ verification code`, // Updated Subject
    html: `
      <div style="font-family: Inter, system-ui, sans-serif; background:#0e0b08; color:#f0ece6; padding:32px; border-radius:16px; max-width:480px; margin:0 auto;">
        <h2 style="margin:0 0 8px;">Verify your FlareHQ account</h2> <!-- Updated Heading -->
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

export async function sendPasswordResetEmail(email: string, businessName: string, code: string) {
  const { error } = await resend.emails.send({
    from: FROM_EMAIL,
    to: email,
    subject: `${code} is your FlareHQ password reset code`,
    html: `
      <div style="font-family: Inter, system-ui, sans-serif; background:#0e0b08; color:#f0ece6; padding:32px; border-radius:16px; max-width:480px; margin:0 auto;">
        <h2 style="margin:0 0 8px;">Reset your FlareHQ password</h2>
        <p style="color:#8a7560; font-size:14px;">Hi ${businessName}, use the code below to set a new password. If you didn't request this, you can safely ignore this email — your password won't change.</p>
        <div style="background:#1a1410; border:1px solid #c8975a; border-radius:12px; padding:20px; text-align:center; margin:20px 0;">
          <span style="font-size:32px; font-weight:800; letter-spacing:8px; color:#c8975a;">${code}</span>
        </div>
        <p style="color:#6b5a45; font-size:12px;">This code expires in 15 minutes.</p>
      </div>
    `,
  });

  if (error) {
    console.error('[email] Resend error:', error);
    throw new Error('Failed to send password reset email.');
  }
}