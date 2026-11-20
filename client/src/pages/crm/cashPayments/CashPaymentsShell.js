import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Page, Card, BlockStack, Button, Text, InlineStack, Banner } from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';
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
// own locations in Collect and Audit; it changes nothing else (Settings is
// open to everyone).

export const CASH_TABS = [
  { id: 'collect', label: 'Collect', path: '/crm/cash-payments' },
  { id: 'audit', label: 'Audit', path: '/crm/cash-payments/audit' },
  { id: 'settings', label: 'Settings', path: '/crm/cash-payments/settings' },
];

// Worked out once per visit; reset when leaving through the back arrow or Log out.
let visitState = null; // { settings, groupId }
export function leaveCashPayments() { visitState = null; newVisit(); }

function TabBar({ tab, onSelect }) {
  return (
    <div style={{ borderBottom: '1px solid #e1e3e5', marginBottom: 4 }}>
      <InlineStack gap="100" wrap>
        {CASH_TABS.map(t => {
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

function ChooseGroup({ groups, onChosen, onBack }) {
  const [busy, setBusy] = useState(null);
  const pick = async (gid) => {
    setBusy(gid);
    await chooseMyGroup(gid);
    setBusy(null);
    onChosen(gid);
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
          <Button size="large" fullWidth onClick={() => pick(ADMIN_ID)} loading={busy === ADMIN_ID} disabled={busy !== null}>
            Admin
          </Button>
        </BlockStack>
      </Card>
    </Page>
  );
}

export default function CashPaymentsShell({ tab = 'collect', children }) {
  const navigate = useNavigate();
  const [state, setState] = useState(visitState);
  const [error, setError] = useState('');
  const { names: mapNames, loading: mapLoading } = useLocationMap({ excludeHQ: true });

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
        onBack={back}
        onChosen={(gid) => { visitState = { ...state, groupId: gid }; setState(visitState); }}
      />
    );
  }

  const group = state.groupId === ADMIN_ID
    ? { id: ADMIN_ID, name: 'Admin' }
    : (state.settings.groups || []).find(x => Number(x.id) === state.groupId);

  return (
    <>
      <Page title="Cash Payments" backAction={{ onAction: back }}>
        <TabBar tab={tab} onSelect={(t) => { if (t.id !== tab) navigate(t.path); }} />
        {/* Preview & Test Mode (2026-11-19, temporary — remove after live testing) */}
        {state.settings.test && state.settings.test.on && (
          <div style={{ marginTop: 12 }}>
            <Banner tone="warning">Preview &amp; Test Mode is on — the data in Collect and Audit is fake. It is deleted when the mode is turned off or the Starting date comes.</Banner>
          </div>
        )}
      </Page>
      {children({ settings: state.settings, group, locations, allLocations, reloadSettings, logout })}
    </>
  );
}
