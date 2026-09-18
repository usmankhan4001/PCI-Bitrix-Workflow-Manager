import React, { useState, useEffect } from 'react';
import { apiFetch } from '../lib/api';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ── Tooltip ───────────────────────────────────────────────────────────────────
const Tip: React.FC<{ text: string; children: React.ReactNode }> = ({ text, children }) => {
  const [show, setShow] = useState(false);
  return (
    <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}
      onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      {children}
      {show && (
        <span style={{
          position: 'absolute', bottom: 'calc(100% + 6px)', left: '50%', transform: 'translateX(-50%)',
          background: '#1a1a1a', border: '1px solid var(--b24-divider)', borderRadius: 6,
          padding: '7px 11px', fontSize: 12, color: 'var(--b24-text)', zIndex: 50,
          pointerEvents: 'none', boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
          maxWidth: 280, whiteSpace: 'pre-line',
        }}>
          {text}
        </span>
      )}
    </span>
  );
};

const HelpIcon: React.FC<{ text: string }> = ({ text }) => (
  <Tip text={text}>
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: 14, height: 14, borderRadius: '50%', border: '1px solid var(--b24-text-faint)',
      color: 'var(--b24-text-faint)', fontSize: 9, fontWeight: 700, cursor: 'help', flexShrink: 0,
    }}>?</span>
  </Tip>
);

// ── Section ───────────────────────────────────────────────────────────────────
const Section: React.FC<{ icon: React.ReactNode; title: string; desc: string; children: React.ReactNode }> = ({ icon, title, desc, children }) => (
  <div style={{ width: '100%' }}>
    <div className="b24-section-top" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={{ width: 36, height: 36, borderRadius: 8, background: 'var(--b24-primary-dim)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--b24-primary)', flexShrink: 0 }}>
        {icon}
      </div>
      <div>
        <p style={{ fontWeight: 700, fontSize: 14, color: 'var(--b24-text)', marginBottom: 2, margin: 0 }}>{title}</p>
        <p style={{ fontSize: 12, color: 'var(--b24-text-muted)', margin: 0 }}>{desc}</p>
      </div>
    </div>
    <div className="b24-section-body" style={{ padding: '20px' }}>{children}</div>
  </div>
);

// ── FormRow ───────────────────────────────────────────────────────────────────
const FormRow: React.FC<{ label: string; desc?: string; tip?: string; right: React.ReactNode }> = ({ label, desc, tip, right }) => (
  <div className="b24-form-row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0', borderBottom: '1px solid var(--b24-divider-light)', gap: 16 }}>
    <div style={{ flex: 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: desc ? 3 : 0 }}>
        <p style={{ fontSize: 13, fontWeight: 500, color: 'var(--b24-text)', margin: 0 }}>{label}</p>
        {tip && <HelpIcon text={tip} />}
      </div>
      {desc && <p style={{ fontSize: 12, color: 'var(--b24-text-muted)', margin: 0 }}>{desc}</p>}
    </div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>{right}</div>
  </div>
);

const SaveBtn: React.FC<{ onClick: () => void; saving: boolean }> = ({ onClick, saving }) => (
  <button onClick={onClick} disabled={saving} className="b24-btn b24-btn-secondary" style={{ height: 28, fontSize: 12, padding: '0 12px' }}>
    {saving ? 'Saving…' : 'Save'}
  </button>
);

// ── Escalation Flow Diagram ───────────────────────────────────────────────────
const EscalationDiagram: React.FC = () => (
  <div style={{ padding: '0 0 14px 0', borderBottom: '1px solid var(--b24-divider-light)' }}>
    <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--b24-text-muted)', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 12px 0' }}>
      How assignment works
    </p>
    <div style={{ display: 'flex', alignItems: 'center', gap: 0, flexWrap: 'wrap', rowGap: 8 }}>
      {[
        { label: 'Fresh lead (in hours)', sub: 'Round-robin → next agent', color: 'var(--b24-primary-dim)', border: 'var(--b24-primary-ring)', text: 'var(--b24-primary)' },
        { arrow: true },
        { label: 'SLA minutes elapse', sub: 'Still "New Lead" → rotates to next agent (up to Max Laps)', color: 'rgba(224,152,0,0.1)', border: 'rgba(224,152,0,0.3)', text: '#e09800' },
        { arrow: true },
        { label: 'Escalation Manager', sub: 'No active agent, laps exhausted, or out-of-hours queue drain failed', color: 'rgba(242,71,61,0.1)', border: 'rgba(242,71,61,0.3)', text: 'var(--b24-red)' },
        { arrow: true },
        { label: 'Manager reassigns', sub: 'New rep gets WhatsApp + Bitrix alert, SLA restarts', color: 'var(--b24-green-dim)', border: 'var(--b24-green-ring)', text: 'var(--b24-green)' },
      ].map((item: any, i) => item.arrow
        ? <span key={i} style={{ color: 'var(--b24-text-faint)', margin: '0 6px', fontSize: 16 }}>→</span>
        : (
          <div key={i} style={{
            padding: '8px 12px', borderRadius: 8,
            background: item.color, border: `1px solid ${item.border}`,
            minWidth: 130,
          }}>
            <p style={{ fontSize: 12, fontWeight: 600, color: item.text, marginBottom: 2, margin: 0 }}>{item.label}</p>
            <p style={{ fontSize: 11, color: 'var(--b24-text-muted)', margin: 0 }}>{item.sub}</p>
          </div>
        )
      )}
    </div>
  </div>
);

// ── Main ──────────────────────────────────────────────────────────────────────
interface BitrixUser { id: string; name: string; active: boolean; }
interface BitrixDept { id: string; name: string; }
interface BitrixSource { id: string; name: string; }

const Settings: React.FC = () => {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);
  const [bitrixUsers, setBitrixUsers] = useState<BitrixUser[]>([]);
  const [departments, setDepartments] = useState<BitrixDept[]>([]);
  const [bitrixSources, setBitrixSources] = useState<BitrixSource[]>([]);
  const [teams, setTeams] = useState<string[]>(['B2C', 'Sales Executives', 'Telly Sales', 'B2B']);

  useEffect(() => {
    Promise.all([
      apiFetch('/api/workflow/settings').then(r => r.ok ? r.json() : {} as Record<string, string>),
      apiFetch('/api/bitrix/webhook-users').then(r => r.ok ? r.json() : { users: [], departments: [] }),
      apiFetch('/api/workflow/teams').then(r => r.ok ? r.json() : []),
      apiFetch('/api/bitrix/webhook-sources').then(r => r.ok ? r.json() : { sources: [] }),
    ]).then(([sData, u, t, src]) => {
      const s = sData as Record<string, string>;
      const activeTeams = t && t.length > 0 ? t : ['B2C', 'Sales Executives', 'Telly Sales', 'B2B'];
      if (t && t.length > 0) {
        setTeams(t);
      }
      if (!s.LEAD_ASSIGNMENT_TEAM && activeTeams.length > 0) {
        s.LEAD_ASSIGNMENT_TEAM = activeTeams[0];
      }
      setSettings(s);
      setBitrixUsers((u.users || []).filter((u: BitrixUser) => u.active));
      setDepartments(u.departments || []);
      setBitrixSources(src.sources || []);
    }).catch(console.error).finally(() => setLoading(false));
  }, []);

  const save = async (key: string, value: string) => {
    setSaving(key);
    try {
      await apiFetch('/api/workflow/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, value }) });
      setSettings(s => ({ ...s, [key]: value }));
      showToast('success', 'Saved successfully');
    } catch (e) {
      console.error(e);
      showToast('error', 'Failed to save');
    } finally {
      setSaving(null);
    }
  };

  const showToast = (type: 'success' | 'error', msg: string) => {
    setToast({ type, msg }); setTimeout(() => setToast(null), 2500);
  };

  type DayWindow = { start: string; end: string };
  const DEFAULT_BUSINESS_HOURS: Record<string, DayWindow> = {
    '1': { start: '10:00', end: '19:00' }, '2': { start: '10:00', end: '19:00' },
    '3': { start: '10:00', end: '19:00' }, '4': { start: '10:00', end: '19:00' },
    '5': { start: '10:00', end: '19:00' }, '6': { start: '11:00', end: '16:00' },
  };
  const businessHours: Record<string, DayWindow> = (() => {
    try { return JSON.parse(settings.BUSINESS_HOURS || ''); } catch { return DEFAULT_BUSINESS_HOURS; }
  })();
  const toggleDayOpen = (i: number) => {
    const key = String(i);
    const next = { ...businessHours };
    if (next[key]) delete next[key];
    else next[key] = { start: '10:00', end: '19:00' };
    setSettings(s => ({ ...s, BUSINESS_HOURS: JSON.stringify(next) }));
  };
  const setDayTime = (i: number, field: 'start' | 'end', value: string) => {
    const key = String(i);
    const next = { ...businessHours, [key]: { ...(businessHours[key] || { start: '10:00', end: '19:00' }), [field]: value } };
    setSettings(s => ({ ...s, BUSINESS_HOURS: JSON.stringify(next) }));
  };

  const eligibleDeptIds: string[] = (() => { try { return JSON.parse(settings.ELIGIBLE_DEPT_IDS || '[]'); } catch { return []; } })();
  const toggleEligibleDept = (id: string) => {
    const next = eligibleDeptIds.includes(id) ? eligibleDeptIds.filter(d => d !== id) : [...eligibleDeptIds, id];
    setSettings(s => ({ ...s, ELIGIBLE_DEPT_IDS: JSON.stringify(next) }));
  };

  const allowedSourceIds: string[] = (() => { try { return JSON.parse(settings.ALLOWED_SOURCES || '[]'); } catch { return []; } })();
  const toggleAllowedSource = (id: string) => {
    const next = allowedSourceIds.includes(id) ? allowedSourceIds.filter(s => s !== id) : [...allowedSourceIds, id];
    setSettings(s => ({ ...s, ALLOWED_SOURCES: JSON.stringify(next) }));
  };

  const selfCreatedSourceIds: string[] = (() => { try { return JSON.parse(settings.SELF_CREATED_SOURCE_IDS || '[]'); } catch { return []; } })();
  const toggleSelfCreatedSource = (id: string) => {
    const next = selfCreatedSourceIds.includes(id) ? selfCreatedSourceIds.filter(s => s !== id) : [...selfCreatedSourceIds, id];
    setSettings(s => ({ ...s, SELF_CREATED_SOURCE_IDS: JSON.stringify(next) }));
  };

  const sourceTeamMap: Record<string, string> = (() => { try { return JSON.parse(settings.SOURCE_TEAM_MAP || '{}'); } catch { return {}; } })();
  const setSourceTeam = (sourceId: string, team: string) => {
    const next = { ...sourceTeamMap };
    if (team) next[sourceId] = team; else delete next[sourceId];
    setSettings(s => ({ ...s, SOURCE_TEAM_MAP: JSON.stringify(next) }));
  };

  const managerName = bitrixUsers.find(u => u.id === settings.WORKFLOW_MANAGER_ID)?.name;
  const workflowEnabled = settings.WORKFLOW_ENABLED !== 'false';
  const toggleEngine = () => save('WORKFLOW_ENABLED', workflowEnabled ? 'false' : 'true');

  if (loading) return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--b24-bg)' }}>
      <span style={{ color: 'var(--b24-text-muted)', fontSize: 13 }}>Loading settings…</span>
    </div>
  );

  return (
    <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div className="b24-navbar">
        <h1 style={{ fontSize: 16, fontWeight: 700, color: 'var(--b24-text)' }}>Settings</h1>
        <button
          onClick={toggleEngine}
          disabled={saving === 'WORKFLOW_ENABLED'}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '5px 14px 5px 10px', borderRadius: 20, border: 'none', cursor: 'pointer',
            background: workflowEnabled ? 'var(--b24-green-dim)' : 'rgba(180,40,30,0.10)',
            color: workflowEnabled ? 'var(--b24-green)' : 'var(--b24-red)',
            fontWeight: 600, fontSize: 12, transition: 'background 0.2s, color 0.2s',
            outline: `1px solid ${workflowEnabled ? 'var(--b24-green-ring)' : 'rgba(180,40,30,0.25)'}`,
          }}
        >
          {/* Toggle knob */}
          <span style={{
            width: 34, height: 18, borderRadius: 9, position: 'relative', flexShrink: 0,
            background: workflowEnabled ? 'var(--b24-green)' : '#ccc',
            transition: 'background 0.2s',
            display: 'inline-block',
          }}>
            <span style={{
              position: 'absolute', top: 2,
              left: workflowEnabled ? 18 : 2,
              width: 14, height: 14, borderRadius: '50%',
              background: '#fff', transition: 'left 0.2s',
              boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
            }} />
          </span>
          {saving === 'WORKFLOW_ENABLED' ? 'Saving…' : workflowEnabled ? 'Engine Running' : 'Engine Paused'}
        </button>
      </div>

      {!workflowEnabled && (
        <div style={{
          background: 'rgba(180,40,30,0.08)', borderBottom: '1px solid rgba(180,40,30,0.2)',
          padding: '10px 20px', display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24" style={{ color: 'var(--b24-red)', flexShrink: 0 }}>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
          <p style={{ fontSize: 13, color: 'var(--b24-red)', fontWeight: 500, margin: 0 }}>
            Workflow engine is <strong>paused</strong> — no leads are being assigned. Toggle "Engine Running" above to resume.
          </p>
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', padding: '20px' }}>
        {toast && (
          <div style={{ position: 'fixed', top: 18, right: 18, zIndex: 100, padding: '10px 16px', borderRadius: 8, fontSize: 13, fontWeight: 500, background: toast.type === 'success' ? 'var(--b24-green-dim)' : 'var(--b24-red-dim)', border: `1px solid ${toast.type === 'success' ? 'var(--b24-green-ring)' : 'var(--b24-red-ring)'}`, color: toast.type === 'success' ? 'var(--b24-green)' : 'var(--b24-red)', boxShadow: '0 4px 16px rgba(0,0,0,0.3)' }}>
            {toast.msg}
          </div>
        )}

        <div style={{ maxWidth: '800px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Business Hours */}
          <Section
            icon={<svg width="17" height="17" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>}
            title="Business Hours"
            desc="Leads that arrive outside these hours are queued and assigned automatically the moment the window opens"
          >
            <div style={{ padding: '8px 0 4px' }}>
              <p style={{ fontSize: 12, color: 'var(--b24-text-muted)', marginBottom: 12, margin: '0 0 12px 0' }}>
                Each day can have its own hours, or be off entirely — e.g. a shorter Saturday window. The SLA rotation clock (below) only counts time inside these windows.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
                {DAYS.map((day, i) => {
                  const window = businessHours[String(i)];
                  const open = !!window;
                  return (
                    <div key={day} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0' }}>
                      <button type="button" onClick={() => toggleDayOpen(i)}
                        className={`b24-btn ${open ? 'b24-btn-primary' : 'b24-btn-secondary'}`}
                        style={{ height: 28, fontSize: 12, padding: '0 12px', width: 90, flexShrink: 0 }}>
                        {day.slice(0, 3)}
                      </button>
                      {open ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <input type="time" value={window.start} onChange={e => setDayTime(i, 'start', e.target.value)} className="b24-input" style={{ width: 110 }} />
                          <span style={{ fontSize: 12, color: 'var(--b24-text-faint)' }}>to</span>
                          <input type="time" value={window.end} onChange={e => setDayTime(i, 'end', e.target.value)} className="b24-input" style={{ width: 110 }} />
                        </div>
                      ) : (
                        <span style={{ fontSize: 12, color: 'var(--b24-text-faint)', fontStyle: 'italic' }}>Closed — leads queue</span>
                      )}
                    </div>
                  );
                })}
              </div>
              <button onClick={() => save('BUSINESS_HOURS', JSON.stringify(businessHours))} disabled={saving === 'BUSINESS_HOURS'} className="b24-btn b24-btn-primary">
                {saving === 'BUSINESS_HOURS' ? 'Saving…' : 'Save Business Hours'}
              </button>
            </div>

            <FormRow
              label="SLA Minutes"
              desc="How long an agent has, in business minutes, to move a lead out of the New Lead stage before it rotates to the next agent."
              tip="Counted only during business hours — a lead assigned near closing time picks up its remaining minutes at the start of the next open window instead of rotating overnight."
              right={<><input type="number" min={1} max={480} value={settings.SLA_MINUTES || '60'} onChange={e => setSettings(s => ({ ...s, SLA_MINUTES: e.target.value }))} className="b24-input" style={{ width: 72, textAlign: 'center' }} /><span style={{ fontSize: 12, color: 'var(--b24-text-faint)', marginRight: 8 }}>minutes</span><SaveBtn onClick={() => save('SLA_MINUTES', settings.SLA_MINUTES || '60')} saving={saving === 'SLA_MINUTES'} /></>}
            />
            <FormRow
              label="Max Rotation Laps"
              desc="How many full passes through the active team roster before an untouched lead escalates to the Escalation Manager."
              tip="Lap 1: everyone in the team gets one turn in order. If nobody moves it, lap 2 restarts from the first agent. Still untouched after that → Escalation Manager, with no further auto-timer."
              right={<><input type="number" min={1} max={10} value={settings.MAX_ROTATION_LAPS || '2'} onChange={e => setSettings(s => ({ ...s, MAX_ROTATION_LAPS: e.target.value }))} className="b24-input" style={{ width: 72, textAlign: 'center' }} /><SaveBtn onClick={() => save('MAX_ROTATION_LAPS', settings.MAX_ROTATION_LAPS || '2')} saving={saving === 'MAX_ROTATION_LAPS'} /></>}
            />
          </Section>

          {/* Self-Created Leads */}
          <Section
            icon={<svg width="17" height="17" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>}
            title="Self-Created Leads"
            desc="Leads an agent creates for themselves never enter the workflow — pick the Bitrix24 Source(s) used for that"
          >
            <div style={{ padding: '14px 0 6px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <p style={{ fontSize: 12, color: 'var(--b24-text-muted)', margin: 0, maxWidth: 480 }}>
                  {selfCreatedSourceIds.length === 0
                    ? 'No source designated yet — self-created leads will be treated like any other lead until one is selected.'
                    : `${selfCreatedSourceIds.length} source${selfCreatedSourceIds.length > 1 ? 's' : ''} marked as self-created — matching leads are left exactly as Bitrix set them up, no auto-assignment or SLA tracking.`}
                </p>
                <SaveBtn onClick={() => save('SELF_CREATED_SOURCE_IDS', settings.SELF_CREATED_SOURCE_IDS || '[]')} saving={saving === 'SELF_CREATED_SOURCE_IDS'} />
              </div>
              {bitrixSources.length === 0 ? (
                <p style={{ fontSize: 12, color: 'var(--b24-text-faint)', fontStyle: 'italic', margin: 0 }}>No lead sources loaded — check Bitrix24 credentials.</p>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {bitrixSources.map(src => {
                    const checked = selfCreatedSourceIds.includes(src.id);
                    return (
                      <button
                        key={src.id}
                        type="button"
                        onClick={() => toggleSelfCreatedSource(src.id)}
                        className={`b24-btn ${checked ? 'b24-btn-primary' : 'b24-btn-secondary'}`}
                        style={{ height: 28, fontSize: 12, padding: '0 12px', gap: 5, display: 'flex', alignItems: 'center' }}
                      >
                        {checked && (
                          <svg width="10" height="10" viewBox="0 0 20 20" fill="currentColor">
                            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414L8.414 15l-4.121-4.121a1 1 0 011.414-1.414L8.414 12.172l6.879-6.879a1 1 0 011.414 0z" clipRule="evenodd"/>
                          </svg>
                        )}
                        {src.name} <span style={{ fontSize: 10, opacity: 0.6, fontFamily: 'monospace' }}>({src.id})</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </Section>

          {/* Assignment Scope */}
          <Section
            icon={<svg width="17" height="17" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /></svg>}
            title="Assignment Scope"
            desc="Which team, departments and lead sources receive incoming leads"
          >
            <FormRow
              label="Default Team"
              desc={`Used when a lead's source isn't mapped below. Currently: "${settings.LEAD_ASSIGNMENT_TEAM || 'B2C'}"`}
              tip="Every lead is routed by its source using the mapping below. A source with no mapping falls back to this team's rotation. Make sure your agents on the Team page have this exact team name."
              right={
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <select
                    className="b24-select"
                    style={{ width: 160 }}
                    value={settings.LEAD_ASSIGNMENT_TEAM || 'B2C'}
                    onChange={e => setSettings(s => ({ ...s, LEAD_ASSIGNMENT_TEAM: e.target.value }))}
                  >
                    {teams.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <SaveBtn onClick={() => save('LEAD_ASSIGNMENT_TEAM', settings.LEAD_ASSIGNMENT_TEAM || 'B2C')} saving={saving === 'LEAD_ASSIGNMENT_TEAM'} />
                </div>
              }
            />

            {/* Source → Team Routing */}
            <div style={{ padding: '14px 0 6px', borderBottom: '1px solid var(--b24-divider-light)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <div>
                  <p style={{ fontSize: 13, fontWeight: 500, color: 'var(--b24-text)', marginBottom: 2, margin: 0 }}>
                    Route by Source
                  </p>
                  <p style={{ fontSize: 12, color: 'var(--b24-text-muted)', margin: 0 }}>
                    Send leads from a specific source straight to a team. One shared Bitrix24 webhook handles every source — this is what keeps them from mixing into the wrong team's rotation. Sources left on "Default" use the Default Team above. Mapping a source here always lets it through, even if it's also excluded below in Allowed Lead Sources.
                  </p>
                </div>
                <SaveBtn onClick={() => save('SOURCE_TEAM_MAP', settings.SOURCE_TEAM_MAP || '{}')} saving={saving === 'SOURCE_TEAM_MAP'} />
              </div>
              {bitrixSources.length === 0 ? (
                <p style={{ fontSize: 12, color: 'var(--b24-text-faint)', fontStyle: 'italic', margin: 0 }}>No lead sources loaded — check Bitrix24 credentials.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {bitrixSources.map(src => (
                    <div key={src.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '5px 0' }}>
                      <span style={{ fontSize: 12, color: 'var(--b24-text)' }}>
                        {src.name} <span style={{ fontSize: 10, opacity: 0.6, fontFamily: 'monospace' }}>({src.id})</span>
                      </span>
                      <select
                        className="b24-select"
                        style={{ width: 170 }}
                        value={sourceTeamMap[src.id] || ''}
                        onChange={e => setSourceTeam(src.id, e.target.value)}
                      >
                        <option value="">— Default team —</option>
                        {teams.map(t => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Eligible Departments */}
            <div style={{ padding: '14px 0 6px', borderBottom: '1px solid var(--b24-divider-light)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <div>
                  <p style={{ fontSize: 13, fontWeight: 500, color: 'var(--b24-text)', marginBottom: 2, margin: 0 }}>
                    Eligible Departments
                  </p>
                  <p style={{ fontSize: 12, color: 'var(--b24-text-muted)', margin: 0 }}>
                    {eligibleDeptIds.length === 0
                      ? 'All Bitrix24 departments receive leads'
                      : `${eligibleDeptIds.length} selected B2C department${eligibleDeptIds.length > 1 ? 's' : ''} receive leads — all other departments are excluded`}
                  </p>
                </div>
                <SaveBtn onClick={() => save('ELIGIBLE_DEPT_IDS', settings.ELIGIBLE_DEPT_IDS || '[]')} saving={saving === 'ELIGIBLE_DEPT_IDS'} />
              </div>
              {departments.length === 0 ? (
                <p style={{ fontSize: 12, color: 'var(--b24-text-faint)', fontStyle: 'italic', margin: 0 }}>No departments loaded — check Bitrix24 credentials.</p>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {departments.map(d => {
                    const checked = eligibleDeptIds.includes(d.id);
                    return (
                      <button
                        key={d.id}
                        type="button"
                        onClick={() => toggleEligibleDept(d.id)}
                        className={`b24-btn ${checked ? 'b24-btn-primary' : 'b24-btn-secondary'}`}
                        style={{ height: 28, fontSize: 12, padding: '0 12px', gap: 5, display: 'flex', alignItems: 'center' }}
                      >
                        {checked && (
                          <svg width="10" height="10" viewBox="0 0 20 20" fill="currentColor">
                            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414L8.414 15l-4.121-4.121a1 1 0 011.414-1.414L8.414 12.172l6.879-6.879a1 1 0 011.414 0z" clipRule="evenodd"/>
                          </svg>
                        )}
                        {d.name}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Whitelisted Lead Sources */}
            <div style={{ padding: '14px 0 6px', marginTop: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <div>
                  <p style={{ fontSize: 13, fontWeight: 500, color: 'var(--b24-text)', marginBottom: 2, margin: 0 }}>
                    Allowed Lead Sources (Allow List)
                  </p>
                  <p style={{ fontSize: 12, color: 'var(--b24-text-muted)', margin: 0 }}>
                    {allowedSourceIds.length === 0
                      ? 'All lead sources are allowed by default'
                      : `${allowedSourceIds.length} selected source${allowedSourceIds.length > 1 ? 's' : ''} allowed — all other sources will be ignored`}
                  </p>
                </div>
                <SaveBtn onClick={() => save('ALLOWED_SOURCES', settings.ALLOWED_SOURCES || '[]')} saving={saving === 'ALLOWED_SOURCES'} />
              </div>
              {bitrixSources.length === 0 ? (
                <p style={{ fontSize: 12, color: 'var(--b24-text-faint)', fontStyle: 'italic', margin: 0 }}>No lead sources loaded — check Bitrix24 credentials.</p>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {bitrixSources.map(src => {
                    const checked = allowedSourceIds.includes(src.id);
                    return (
                      <button
                        key={src.id}
                        type="button"
                        onClick={() => toggleAllowedSource(src.id)}
                        className={`b24-btn ${checked ? 'b24-btn-primary' : 'b24-btn-secondary'}`}
                        style={{ height: 28, fontSize: 12, padding: '0 12px', gap: 5, display: 'flex', alignItems: 'center' }}
                      >
                        {checked && (
                          <svg width="10" height="10" viewBox="0 0 20 20" fill="currentColor">
                            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414L8.414 15l-4.121-4.121a1 1 0 011.414-1.414L8.414 12.172l6.879-6.879a1 1 0 011.414 0z" clipRule="evenodd"/>
                          </svg>
                        )}
                        {src.name} <span style={{ fontSize: 10, opacity: 0.6, fontFamily: 'monospace' }}>({src.id})</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </Section>

          {/* Stale-Lead Recycling */}
          <Section
            icon={<svg width="17" height="17" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>}
            title="Stale-Lead Recycling"
            desc="Leads stuck in Dead Lead or Junk Lead for too long get reset to New Lead and re-enter the normal pipeline"
          >
            <FormRow
              label="Recycling enabled"
              desc="Turn off to stop this feature entirely, independent of the main engine toggle above."
              right={
                <button
                  onClick={() => save('RECYCLE_ENABLED', settings.RECYCLE_ENABLED === 'true' ? 'false' : 'true')}
                  disabled={saving === 'RECYCLE_ENABLED'}
                  className="b24-toggle"
                  style={{ background: settings.RECYCLE_ENABLED === 'true' ? 'var(--b24-green)' : '#3a3a3a' }}
                >
                  <span className="b24-toggle-knob" style={{ left: settings.RECYCLE_ENABLED === 'true' ? 23 : 3 }} />
                </button>
              }
            />
            <FormRow
              label="Check Frequency"
              desc="How often the recycle sweep actually runs."
              tip="The cron checks every hour whether it's time to run, but only actually recycles anything once this many hours have passed since the last run. 24 = once daily, 1 = every hour."
              right={<><input type="number" min={1} max={168} value={settings.RECYCLE_FREQUENCY_HOURS || '24'} onChange={e => setSettings(s => ({ ...s, RECYCLE_FREQUENCY_HOURS: e.target.value }))} className="b24-input" style={{ width: 72, textAlign: 'center' }} /><span style={{ fontSize: 12, color: 'var(--b24-text-faint)', marginRight: 8 }}>hours</span><SaveBtn onClick={() => save('RECYCLE_FREQUENCY_HOURS', settings.RECYCLE_FREQUENCY_HOURS || '24')} saving={saving === 'RECYCLE_FREQUENCY_HOURS'} /></>}
            />
            <FormRow
              label="Dead Lead → New Lead after"
              desc="Days with no stage change before a Dead Lead gets recycled."
              right={<><input type="number" min={1} max={365} value={settings.DEAD_LEAD_RECYCLE_DAYS || '90'} onChange={e => setSettings(s => ({ ...s, DEAD_LEAD_RECYCLE_DAYS: e.target.value }))} className="b24-input" style={{ width: 72, textAlign: 'center' }} /><span style={{ fontSize: 12, color: 'var(--b24-text-faint)', marginRight: 8 }}>days</span><SaveBtn onClick={() => save('DEAD_LEAD_RECYCLE_DAYS', settings.DEAD_LEAD_RECYCLE_DAYS || '90')} saving={saving === 'DEAD_LEAD_RECYCLE_DAYS'} /></>}
            />
            <FormRow
              label="Junk Lead → New Lead after"
              desc="Days with no stage change before a Junk Lead gets recycled."
              tip="This is the status literally named 'Junk Lead' — separate from the 'Duplicate' status the auto-merge feature sets, which is never touched by this."
              right={<><input type="number" min={1} max={365} value={settings.JUNK_LEAD_RECYCLE_DAYS || '7'} onChange={e => setSettings(s => ({ ...s, JUNK_LEAD_RECYCLE_DAYS: e.target.value }))} className="b24-input" style={{ width: 72, textAlign: 'center' }} /><span style={{ fontSize: 12, color: 'var(--b24-text-faint)', marginRight: 8 }}>days</span><SaveBtn onClick={() => save('JUNK_LEAD_RECYCLE_DAYS', settings.JUNK_LEAD_RECYCLE_DAYS || '7')} saving={saving === 'JUNK_LEAD_RECYCLE_DAYS'} /></>}
            />
          </Section>

          {/* Escalation Manager */}
          <Section
            icon={<svg width="17" height="17" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" /></svg>}
            title="Escalation & Assignment Rules"
            desc="Where a lead goes when it can't be auto-assigned"
          >
            <EscalationDiagram />

            <FormRow
              label="Escalation Manager"
              desc={managerName ? `Currently: ${managerName}` : 'No manager selected yet'}
              tip="A lead is sent to this person when no active sales agent is available, or when a repeat customer's original rep has left/been deactivated. They can then assign it manually."
              right={
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  {bitrixUsers.length > 0
                    ? (
                      <select
                        className="b24-select"
                        style={{ width: 200 }}
                        value={settings.WORKFLOW_MANAGER_ID || ''}
                        onChange={e => setSettings(s => ({ ...s, WORKFLOW_MANAGER_ID: e.target.value }))}
                      >
                        <option value="">— Choose manager —</option>
                        {bitrixUsers.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                      </select>
                    ) : (
                      <input
                        type="text"
                        className="b24-input"
                        style={{ width: 80, textAlign: 'center', fontFamily: 'monospace' }}
                        placeholder="User ID"
                        value={settings.WORKFLOW_MANAGER_ID || ''}
                        onChange={e => setSettings(s => ({ ...s, WORKFLOW_MANAGER_ID: e.target.value }))}
                      />
                    )
                  }
                  <SaveBtn onClick={() => save('WORKFLOW_MANAGER_ID', settings.WORKFLOW_MANAGER_ID || '')} saving={saving === 'WORKFLOW_MANAGER_ID'} />
                </div>
              }
            />
          </Section>
        </div>
      </div>
    </div>
  );
};

export default Settings;
