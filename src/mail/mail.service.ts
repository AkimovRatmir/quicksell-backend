import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 15_000;

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * Sends transactional email through Resend's HTTP API.
 *
 * Deliberately a thin wrapper over `fetch` rather than an SDK: one endpoint,
 * one shape, and swapping providers later means rewriting this file only.
 *
 * With no RESEND_API_KEY the service does not send. Outside production it logs
 * the message instead, so password reset can be developed without a mailbox;
 * in production it fails loudly, because silently not sending a reset email
 * looks exactly like a broken account to the user.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(private readonly config: ConfigService) {}

  private get apiKey(): string | undefined {
    return this.config.get<string>('RESEND_API_KEY');
  }

  private get from(): string {
    return (
      this.config.get<string>('MAIL_FROM') ??
      'QuickSell <no-reply@quicksell.kz>'
    );
  }

  get isConfigured(): boolean {
    return !!this.apiKey;
  }

  async send(email: OutgoingEmail): Promise<void> {
    if (!this.apiKey) {
      if (this.config.get<string>('NODE_ENV') === 'production') {
        throw new ServiceUnavailableException(
          'Email is not configured (RESEND_API_KEY missing).',
        );
      }
      // Dev convenience. The body carries the reset link, so this must never
      // happen in production — the guard above keeps it that way.
      this.logger.warn(
        `RESEND_API_KEY not set — email not sent. To: ${email.to}\n${email.text}`,
      );
      return;
    }

    let res: Response;
    try {
      res = await fetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.from,
          to: [email.to],
          subject: email.subject,
          html: email.html,
          text: email.text,
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch (e) {
      throw new ServiceUnavailableException(
        `Could not reach the email provider: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }

    if (!res.ok) {
      // Body may name the problem (unverified domain, invalid key). Log it for
      // us; the caller gets a generic failure.
      const body = await res.text().catch(() => '');
      this.logger.error(
        `Resend rejected the email (HTTP ${res.status}): ${body.slice(0, 300)}`,
      );
      throw new ServiceUnavailableException('Could not send the email.');
    }

    // The provider's id is the only handle we have if someone reports a
    // missing email — it's what their dashboard and delivery logs key on.
    const accepted = (await res.json().catch(() => ({}))) as { id?: string };
    this.logger.log(
      `Email accepted by Resend (id ${accepted.id ?? 'unknown'})`,
    );
  }
}
