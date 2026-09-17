import { Controller, Get, Post, Put, Delete, Body, Param, Query, Redirect } from '@nestjs/common';
import { WorkflowService } from './workflow.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';

@Controller('api/workflow')
export class WorkflowController {
  constructor(
    private readonly workflowService: WorkflowService,
    private readonly whatsapp: WhatsappService,
  ) {}

  // ─── Agents ────────────────────────────────────────────────────────────────

  @Get('agents')
  getAgents() { return this.workflowService.getAgents(); }

  @Post('agents')
  addAgent(@Body() body: { bitrix_user_id: string; name: string; team: string; whatsapp_phone?: string; department_id?: string; department_name?: string }) {
    return this.workflowService.addAgent(body);
  }

  // IMPORTANT: reorder must come BEFORE :id routes so NestJS doesn't match "reorder" as an ID
  @Put('agents/reorder')
  reorderAgents(@Body('orderedIds') orderedIds: string[]) {
    return this.workflowService.reorderAgents(orderedIds);
  }

  @Put('agents/:id')
  updateAgent(@Param('id') id: string, @Body() body: { name?: string; team?: string; whatsapp_phone?: string; department_id?: string; department_name?: string }) {
    return this.workflowService.updateAgent(id, body);
  }

  @Put('agents/:id/active')
  toggleAgentActive(@Param('id') id: string, @Body('is_active') isActive: boolean) {
    return this.workflowService.toggleAgentActive(id, isActive);
  }

  @Delete('agents/:id')
  deleteAgent(@Param('id') id: string) { return this.workflowService.deleteAgent(id); }

  // ─── Settings ──────────────────────────────────────────────────────────────

  @Get('settings')
  getSettings() { return this.workflowService.getSettings(); }

  @Put('settings')
  updateSetting(@Body() body: { key: string; value: string }) {
    return this.workflowService.updateSetting(body.key, body.value);
  }

  // ─── Late Leads ────────────────────────────────────────────────────────────

  @Get('late-leads')
  getLateLeads() { return this.workflowService.getLateLeads(); }

  // ─── Assignment Log ────────────────────────────────────────────────────────

  @Get('assignment-log')
  getAssignmentLog(@Query('limit') limit?: string) {
    return this.workflowService.getAssignmentLog(limit ? parseInt(limit, 10) : 50);
  }

  @Get('assigned-today')
  getAssignedTodayCount() { return this.workflowService.getAssignedTodayCount(); }

  // ─── Duplicate Review Queue ─────────────────────────────────────────────────

  @Get('duplicates')
  getDuplicates(@Query('resolved') resolved?: string) {
    const parsed = resolved === 'true' ? true : resolved === 'false' ? false : undefined;
    return this.workflowService.getDuplicates(parsed);
  }

  @Put('duplicates/:id/resolve')
  resolveDuplicate(@Param('id') id: string) {
    return this.workflowService.resolveDuplicate(id);
  }

  @Get('merged-leads')
  getMergedLeads(@Query('limit') limit?: string) {
    return this.workflowService.getMergedLeads(limit ? parseInt(limit, 10) : 100);
  }

  // ─── SLA Rotations (live "who's holding what, since when") ────────────────

  @Get('rotations')
  getActiveRotations() { return this.workflowService.getActiveRotations(); }

  @Post('rotations/sweep')
  sweepRotations() { return this.workflowService.sweepRotationTimeouts(); }

  // ─── Stale-lead recycling (manual trigger — useful for testing/recovery) ──

  @Post('recycle-stale-leads')
  recycleStaleLeads() { return this.workflowService.recycleStaleLeads(); }

  // ─── Workflow Status (dashboard snapshot) ──────────────────────────────────

  @Get('status')
  getWorkflowStatus() { return this.workflowService.getWorkflowStatus(); }

  @Get('teams')
  getTeams() { return this.workflowService.getTeams(); }

  // ─── Lead Assignment ───────────────────────────────────────────────────────
  // Accepts the lead ID from the JSON body, a query string, or a Bitrix24 event
  // payload (data.FIELDS.ID). Exposed on both POST and GET so it works regardless
  // of how the Bitrix24 outbound-webhook automation rule sends the request.

  @Post('assign-lead')
  async assignLeadPost(@Body() body: any, @Query() query: any) {
    return this.runAssignLead(body || {}, query || {});
  }

  @Get('assign-lead')
  async assignLeadGet(@Query() query: any) {
    return this.runAssignLead({}, query || {});
  }

  private async runAssignLead(body: any, query: any) {
    const leadId = body.lead_id || query.lead_id || query.id || body.data?.FIELDS?.ID;
    if (!leadId) {
      return { success: false, message: 'No lead_id provided in body or query' };
    }

    // An explicit team (body/query) pins the assignment to that rotation.
    // Otherwise the service resolves it per-lead from SOURCE_TEAM_MAP /
    // LEAD_ASSIGNMENT_TEAM once it knows the lead's source. Trimmed since
    // this is free text from whatever calls this endpoint (e.g. a Bitrix
    // automation rule URL param) — stray whitespace would otherwise silently
    // match zero agents instead of the intended team.
    const rawTeam = body.team || query.team;
    const team: string | undefined = rawTeam ? String(rawTeam).trim() || undefined : undefined;

    const force = body.force === true || body.force === 'true' || query.force === 'true';

    return this.workflowService.processLeadAssignment(
      String(leadId),
      team,
      (this.workflowService as any).getWebhookCreds(),
      force,
    );
  }

  // ─── Manual cron trigger (useful for testing / recovery) ───────────────────

  @Post('process-late-leads')
  async processLateLeads() {
    return this.workflowService.processAllLateLeads();
  }

  @Post('clear-queue')
  async clearQueue() {
    return this.workflowService.clearQueue();
  }

  // ─── Bitrix24 Inbound Webhook (Lead Change) ───────────────────────────────
  // Fired on lead update (ONCRMLEADUPDATE). Closes the SLA rotation when a lead
  // leaves the "New Lead" stage, and restarts it for whoever a lead is manually
  // reassigned to (WhatsApp + Bitrix in-app alert).

  @Post('webhook/lead-change')
  async leadChangeWebhook(@Body() payload: any) {
    return this.workflowService.handleLeadChangeWebhook(payload);
  }

  // ─── WhatsApp ─────────────────────────────────────────────────────────────

  @Get('chat/:phone')
  @Redirect('https://wa.me', 302)
  redirectWhatsApp(@Param('phone') phone: string) {
    const match = phone.match(/(\d{9,15})$/);
    const cleanPhone = match ? match[1] : phone.replace(/[^\d]/g, '');
    return { url: `https://wa.me/${cleanPhone}` };
  }

  @Post('whatsapp/test')
  testWhatsapp(@Body() body: { phone: string }) { return this.whatsapp.testConnection(body.phone); }
}
