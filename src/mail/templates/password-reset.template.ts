import type { OutgoingEmail } from '../mail.service';

/** Escapes anything from our data before it goes into the HTML body. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * «Восстановление пароля» — the only email we send today.
 *
 * Plain text alongside HTML: some clients show it, and spam filters treat a
 * text part as a sign the sender is not a bulk mailer. Nothing about the
 * account goes in the body beyond the name — a reset email may land in the
 * wrong inbox if someone mistypes their address at signup.
 */
export function passwordResetEmail(args: {
  to: string;
  name: string;
  resetUrl: string;
  expiresInMinutes: number;
}): OutgoingEmail {
  const { to, name, resetUrl, expiresInMinutes } = args;
  const greeting = name.trim()
    ? `${name.trim()}, здравствуйте!`
    : 'Здравствуйте!';

  const text = [
    greeting,
    '',
    'Вы запросили восстановление пароля в QuickSell Analytics.',
    'Перейдите по ссылке, чтобы задать новый пароль:',
    resetUrl,
    '',
    `Ссылка действует ${expiresInMinutes} минут и сработает один раз.`,
    '',
    'Если вы не запрашивали восстановление — просто проигнорируйте это письмо,',
    'пароль останется прежним.',
    '',
    'QuickSell Analytics',
  ].join('\n');

  const html = `<!doctype html>
<html lang="ru">
  <body style="margin:0;padding:24px;background:#f5f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;">
    <table role="presentation" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:14px;padding:32px;">
      <tr><td>
        <div style="font-size:18px;font-weight:600;margin-bottom:18px;">QuickSell Analytics</div>
        <p style="font-size:15px;line-height:1.6;margin:0 0 14px;">${esc(greeting)}</p>
        <p style="font-size:15px;line-height:1.6;margin:0 0 22px;">
          Вы запросили восстановление пароля. Нажмите кнопку, чтобы задать новый.
        </p>
        <p style="margin:0 0 22px;">
          <a href="${esc(resetUrl)}"
             style="display:inline-block;background:#7F77DD;color:#ffffff;text-decoration:none;font-size:15px;font-weight:500;padding:12px 26px;border-radius:9px;">
            Задать новый пароль
          </a>
        </p>
        <p style="font-size:13px;line-height:1.6;color:#666;margin:0 0 14px;">
          Ссылка действует ${expiresInMinutes} минут и сработает один раз.
          Если кнопка не открывается, скопируйте адрес в браузер:<br />
          <span style="color:#534AB7;word-break:break-all;">${esc(resetUrl)}</span>
        </p>
        <p style="font-size:13px;line-height:1.6;color:#666;margin:0;">
          Если вы не запрашивали восстановление — просто проигнорируйте это письмо,
          пароль останется прежним.
        </p>
      </td></tr>
    </table>
  </body>
</html>`;

  return {
    to,
    subject: 'Восстановление пароля — QuickSell Analytics',
    html,
    text,
  };
}
