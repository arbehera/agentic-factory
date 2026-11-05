import nodemailer, { type Transporter } from "nodemailer";

export interface EmailMessage {
  to: readonly string[];
  subject: string;
  text: string;
}

/** Email channel (FR-NOT-003: portal inbox and email in Phase 0; Teams/SMS are stubs later). */
export interface EmailChannel {
  send(message: EmailMessage): Promise<void>;
}

/** SMTP delivery through nodemailer (MIT-0). Credentials, if any, come in the SMTP URL from secrets. */
export class SmtpEmailChannel implements EmailChannel {
  private readonly transport: Transporter;

  constructor(
    smtpUrl: string,
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport(smtpUrl);
  }

  async send(message: EmailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.from, to: [...message.to], subject: message.subject, text: message.text });
  }

  close(): void {
    this.transport.close();
  }
}
