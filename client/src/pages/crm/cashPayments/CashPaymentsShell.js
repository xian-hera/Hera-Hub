import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Page, Card, BlockStack, Button, Text, InlineStack, Banner, Modal, TextField } from '@shopify/polaris';
import { useNavigate, Navigate } from 'react-router-dom';
import { useLocationMap } from '../../shared/locationMap';
import { api, loadMyGroupId, chooseMyGroup, forgetMyGroup, compareLocations, ADMIN_ID, newVisit } from './cashShared';

// Operation › Cash Payments shell (2026-11-19, Hera — claude/CASH_PAYMENTS_SPEC.md).
// "Cash Payments" header (back → Operation) + tabs Collect / Audit / Settings;
// each tab keeps its own URL and App.js wraps the tab page in
// <CashPaymentsShell tab="…">. Same pattern as Online / Warehouse.
//
// User group: the first time a Shopify account opens Cash Payments it picks a
// group (or Admin = every location). Remembered for the account (server) and
// this device (localStorage), until Settings › Log out. A group only sees its
// own locations in Collect.
// Admin (2026-11-20, Hera): choosing Admin asks for the Admin password (set in
// Settings; none set yet → no password). Only Admin opens Audit (the tab is
// hidden for other groups) and the full Settings (other groups see only Log
// out there).

export const CASH_TABS = [
  { id: 'collect', label: 'Collect', path: '/crm/cash-payments' },
  { id: 'audit', label: 'Audit', path: '/crm/cash-payments/audit' },
  { id: 'settings', label: 'Settings', path: '/crm/cash-payments/settings' },
];

// Worked out once per visit; reset when leaving through the back arrow or Log out.
let visitState = null; // { settings, groupId }
export function leaveCashPayments() { visitState = null; newVisit(); }

function TabBar({ tab, onSelect, isAdmin }) {
  return (
    <div style={{ borderBottom: '1px solid #e1e3e5', marginBottom: 4 }}>
      <InlineStack gap="100" wrap>
        {CASH_TABS.filter(t => isAdmin || t.id !== 'audit').map(t => {
          const active = t.id === tab;
          return (
            <button key={t.id} type="button" onClick={() => onSelect(t)}
              style={{
                border: 'none', background: active ? '#e3e3e3' : 'transparent', cursor: 'pointer',
                padding: '8px 14px', margin: '0 0 6px', borderRadius: 8, fontSize: 14,
                fontWeight: active ? 600 : 450, color: '#303030',
              }}>
              {t.label}
            </button>
          );
        })}
      </InlineStack>
    </div>
  );
}

function ChooseGroup({ groups, adminPinSet, onChosen, onBack }) {
  const [busy, setBusy] = useState(null);
  const [askPin, setAskPin] = useState(false);
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState('');
  const pick = async (gid, pinValue) => {
    setBusy(gid); setPinError('');
    const r = await chooseMyGroup(gid, pinValue);
    setBusy(null);
    if (r.ok) { setAskPin(false); onChosen(gid); return; }
    if (r.wrongPin) { setPinError('Incorrect password. Please try again.'); setPin(''); return; }
    setPinError(r.error || 'Something went wrong');
  };
  const chooseAdmin = () => {
    if (!adminPinSet) { pick(ADMIN_ID, ''); return; }
    setPin(''); setPinError(''); setAskPin(true);
  };
  return (
    <Page title="Choose User Group" backAction={{ onAction: onBack }} narrowWidth>
      <Card>
        <BlockStack gap="300">
          <Text tone="subdued">Pick your group. It decides which locations you see, and is remembered for this account until you log out.</Text>
          {groups.map(g => (
            <Button key={g.id} size="large" fullWidth onClick={() => pick(Number(g.id))} loading={busy === Number(g.id)} disabled={busy !== null}>
              {g.name}
            </Button>
          ))}
          <Button size="large" fullWidth onClick={chooseAdmin} loading={busy === ADMIN_ID && !askPin} disabled={busy !== null}>
            Admin
          </Button>
          {pinError && !askPin && <Banner tone="critical">{pinError}</Banner>}
        </BlockStack>
      </Card>
      <Modal
        open={askPin}
        onClose={() => setAskPin(false)}
        title="Admin password"
        primaryAction={{ content: 'Confirm', onAction: () => pick(ADMIN_ID, pin), disabled: !pin || busy !== null, loading: busy === ADMIN_ID }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setAskPin(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            {pinError && <Banner tone="critical" onDismiss={() => setPinError('')}>{pinError}</Banner>}
            {/* Enter = Confirm (key handler on the wrapper; works whatever TextField passes on) */}
            <div onKeyDown={(e) => { if (e.key === 'Enter' && pin) pick(ADMIN_ID, pin); }}>
              <TextField
                label="Enter the Admin password"
                type="password"
                value={pin}
                onChange={(v) => { if (/^\d{0,8}$/.test(v)) setPin(v); setPinError(''); }}
                autoComplete="off"
                autoFocus
              />
            </div>
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}

export default function CashPaymentsShell({ tab = 'collect', children }) {
  const navigate = useNavigate();
  const [state, setState] = useState(visitState);
  const [error, setError] = useState('');
  const { names: mapNames, loading: mapLoading } = useLocationMap({ excludeHQ: true });

  // Sticky headers (2026-11-27, Hera). public/index.html gives #root
  // overflow-x: hidden, which (by the CSS rules) also makes #root a scroll box
  // of its own — a position: sticky header inside it then never sticks, since
  // the page scrolls in <body>. While Cash Payments is open, #root uses
  // overflow-x: clip instead: same clipping, but no scroll box. Put back on leave.
  useEffect(() => {
    const root = document.getElementById('root');
    if (!root) return undefined;
    const before = root.style.overflowX;
    root.style.overflowX = 'clip';
    return () => { root.style.overflowX = before; };
  }, []);

  const load = useCallback(async () => {
    setError('');
    try {
      const settings = await api('GET', '/settings');
      const groupId = await loadMyGroupId(settings.groups || []);
      visitState = { settings, groupId };
      setState(visitState);
    } catch (e) {
      setError(e.message);
    }
  }, []);
  useEffect(() => { if (!state) load(); }, [state, load]);

  // Settings changed something (groups / starting date) → reload, keep the group.
  const reloadSettings = useCallback(async () => {
    const settings = await api('GET', '/settings');
    const groupId = await loadMyGroupId(settings.groups || []);
    visitState = { settings, groupId };
    setState(visitState);
    return visitState;
  }, []);

  const logout = useCallback(async () => {
    await forgetMyGroup();
    leaveCashPayments();
    navigate('/crm');
  }, [navigate]);

  // Every active location but HQ, in Cash Payments order (Settings › groups).
  const allLocations = useMemo(() => [...mapNames].sort(compareLocations), [mapNames]);
  // Locations this group may see (Collect / Audit).
  const locations = useMemo(() => {
    if (!state) return [];
    const all = allLocations;
    if (state.groupId === ADMIN_ID || state.groupId === null) return all;
    const g = (state.settings.groups || []).find(x => Number(x.id) === state.groupId);
    const allowed = new Set(g ? g.locations : []);
    return all.filter(n => allowed.has(n));
  }, [state, allLocations]);

  const back = () => { leaveCashPayments(); navigate('/crm'); };

  if (error) {
    return (
      <Page title="Cash Payments" backAction={{ onAction: back }}>
        <Banner tone="critical" action={{ content: 'Retry', onAction: load }}>{error}</Banner>
      </Page>
    );
  }
  if (!state || mapLoading) {
    return <Page title="Cash Payments" backAction={{ onAction: back }}><Text tone="subdued">Loading...</Text></Page>;
  }
  if (state.groupId === null) {
    return (
      <ChooseGroup
        groups={state.settings.groups || []}
        adminPinSet={!!state.settings.adminPinSet}
        onBack={back}
        onChosen={(gid) => { visitState = { ...state, groupId: gid }; setState(visitState); }}
      />
    );
  }

  const group = state.groupId === ADMIN_ID
    ? { id: ADMIN_ID, name: 'Admin' }
    : (state.settings.groups || []).find(x => Number(x.id) === state.groupId);
  const isAdmin = state.groupId === ADMIN_ID;
  // Audit is Admin only → others go to Collect.
  if (tab === 'audit' && !isAdmin) return <Navigate to="/crm/cash-payments" replace />;

  return (
    <>
      <Page title="Cash Payments" backAction={{ onAction: back }}>
        <TabBar tab={tab} isAdmin={isAdmin} onSelect={(t) => { if (t.id !== tab) navigate(t.path); }} />
        {/* Preview & Test Mode (2026-11-19, temporary — remove after live testing) */}
        {state.settings.test && state.settings.test.on && (
          <div style={{ marginTop: 12 }}>
            <Banner tone="warning">Preview &amp; Test Mode is on — the data in Collect and Audit is fake. It is deleted when the mode is turned off or the Starting date comes.</Banner>
          </div>
        )}
      </Page>
      {children({ settings: state.settings, group, isAdmin, locations, allLocations, reloadSettings, logout })}
    </>
  );
}
