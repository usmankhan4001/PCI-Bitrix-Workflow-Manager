import { Injectable, Logger } from '@nestjs/common';

/**
 * WhatsApp notifications via WAHA (https://waha.devlike.pro).
 *
 * WAHA is a self-hosted WhatsApp HTTP API. It sends plain-text messages from a
 * logged-in WhatsApp number — no template approval needed. We talk to it over the
 * internal Docker network.
 *
 * Env:
 *   WAHA_URL      base URL of the WAHA service (e.g. http://waha:3000)
 *   WAHA_SESSION  session name (default "default")
 *   WAHA_API_KEY  API key configured on the WAHA container (X-Api-Key header)
 */
@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);

  private get baseUrl(): string {
    return (process.env.WAHA_URL || 'http://waha:3000').replace(/\/$/, '');
  }
  private get session(): string {
    return process.env.WAHA_SESSION || 'default';
  }
  private get apiKey(): string {
    return process.env.WAHA_API_KEY || '';
  }

  // Turn a stored phone number into a WAHA chatId: digits only + "@c.us".
  private toChatId(phone: string): string {
    return `${phone.replace(/[^\d]/g, '')}@c.us`;
  }

  /** Low-level: send a plain text message to one number. */
  async sendText(phone: string, text: string): Promise<boolean> {
    const digits = phone.replace(/[^\d]/g, '');
    if (!digits) {
      this.logger.warn(`WhatsApp skipped — invalid phone "${phone}"`);
      return false;
    }

    try {
      const res = await fetch(`${this.baseUrl}/api/sendText`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { 'X-Api-Key': this.apiKey } : {}),
        },
        body: JSON.stringify({
          session: this.session,
          chatId: this.toChatId(digits),
          text,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as any;
      if (res.ok && !data?.error) {
        this.logger.log(`WhatsApp sent to ${digits}`);
        return true;
      }
      this.logger.warn(`WhatsApp send to ${digits} failed (HTTP ${res.status}): ${JSON.stringify(data)}`);
      return false;
    } catch (err) {
      this.logger.error(`WhatsApp send failed: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Notify an agent that a lead was assigned to them.
   * Message includes: agent name, lead name, lead contact number, time to complete.
   */
  async sendLeadAssignedNotification(
    agentPhone: string,
    agentName: string,
    leadName: string,
    leadContact: string,
    slaMinutes: number,
    source = '',
  ): Promise<boolean> {
    const deadline = new Date(Date.now() + slaMinutes * 60 * 1000);
    const deadlineStr = deadline.toLocaleString('en-GB', {
      timeZone: 'Asia/Karachi',
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true,
    });

    const text =
      `🟢 *New lead assigned to you*\n\n` +
      `👤 Agent: ${agentName}\n` +
      `📋 Lead: ${leadName}\n` +
      `📞 Contact: ${leadContact || 'N/A'}\n` +
      `🌐 Source: ${source || 'N/A'}\n` +
      `⏰ Move it out of "New Lead" within: ${slaMinutes} minutes (by ${deadlineStr}) or it moves to the next agent\n\n` +
      `Please follow up and update the lead in Bitrix24.`;

    return this.sendText(agentPhone, text);
  }

  /**
   * Notify an agent a recycled (Dead/Junk) lead was reassigned to them via
   * the Reshuffle round-robin. Deliberately no deadline/timer language — this
   * is a one-time, permanent reassignment, not an SLA-tracked one.
   */
  async sendReshuffleNotification(
    agentPhone: string,
    agentName: string,
    leadName: string,
    leadContact: string,
    source = '',
  ): Promise<boolean> {
    const text =
      `🔄 *Recycled lead reassigned to you*\n\n` +
      `👤 Agent: ${agentName}\n` +
      `📋 Lead: ${leadName}\n` +
      `📞 Contact: ${leadContact || 'N/A'}\n` +
      `🌐 Source: ${source || 'N/A'}\n\n` +
      `This lead was previously stuck and has been reassigned to you. No auto-timer on this one — please follow up when you can.`;

    return this.sendText(agentPhone, text);
  }

  /** Notify the Escalation Manager that a lead has landed with them. */
  async sendEscalationNotification(
    managerPhone: string,
    managerName: string,
    leadName: string,
    leadContact: string,
    reason: string,
    source = '',
  ): Promise<boolean> {
    const text =
      `🔴 *Lead escalated to you*\n\n` +
      `👤 Manager: ${managerName}\n` +
      `📋 Lead: ${leadName}\n` +
      `📞 Contact: ${leadContact || 'N/A'}\n` +
      `🌐 Source: ${source || 'N/A'}\n` +
      `⚠️ Reason: ${reason}\n\n` +
      `No auto-timer runs until you assign it to someone in Bitrix24.`;

    return this.sendText(managerPhone, text);
  }

  /** Connectivity check for the dashboard "Test" button. */
  async testConnection(phone: string): Promise<{ success: boolean; message: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/api/sessions/${this.session}`, {
        headers: { ...(this.apiKey ? { 'X-Api-Key': this.apiKey } : {}) },
      });
      const data = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) {
        return { success: false, message: `WAHA returned HTTP ${res.status}. Is WAHA running at ${this.baseUrl}?` };
      }
      const status = data?.status || 'UNKNOWN';
      if (status !== 'WORKING') {
        return { success: false, message: `WAHA session "${this.session}" is "${status}" — scan the QR in the WAHA dashboard to log in.` };
      }
      if (phone) {
        const ok = await this.sendText(phone, '✅ WhatsApp test message from Workflow Manager.');
        return ok
          ? { success: true, message: `Connected. Test message sent to ${phone}.` }
          : { success: false, message: 'Session is working but the test message failed — check the number.' };
      }
      return { success: true, message: `Connected. Session "${this.session}" is working.` };
    } catch (err) {
      return { success: false, message: (err as Error).message };
    }
  }
}
