import React, { useState } from 'react';
import {
  Page, Card, BlockStack, InlineStack, Button, Banner, Text, Modal, TextField, Popover, DatePicker, Box,
} from '@shopify/polaris';
import MultiSelectDropdown from '../../../components/MultiSelectDropdown';
import { LocPill } from '../../warehouse/whShared';
import { api, shortDate, CalendarIcon, smallBtnStyle } from './cashShared';
import { Switch } from '../../warehouse/supplyShared';

// Cash Payments › Settings (2026-11-19, Hera — claude/CASH_PAYMENTS_SPEC.md).
//   User Groups: name + locations (no HQ). A group only sees its locations
//     in Collect and Audit. Add / edit / delete. (Admin = every location,
//     always offered when choosing a group, not listed here.)
//   Starting date: nothing before it is fetched, shown or counted. Saving
//     fetches every missing day from it to yesterday.
//   Log out (top right): forget this account's group and go back to Operation.
//   Preview & Test Mode (2026-11-19, TEMPORARY — remove after live testing):
//     switch under the Starting date, shown only while the Starting date is
//     empty or in the future. On → Populate Data fills 30 fake days per
//     location (last 7 Pending). Off → every fake row is deleted. See
//     server/services/cashPaymentsTest.js.

const toLocalDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
const toIso = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;

function GroupModal({ group, allLocations, onClose, onSaved }) {
  const [name, setName] = useState(group ? group.name : '');
  const [locs, setLocs] = useState(group ? group.locations : []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    setBusy(true); setError('');
    try {
      const body = { name, locations: locs };
      if (group) await api('PUT', `/groups/${group.id}`, body); else await api('POST', '/groups', body);
      await onSaved();
      onClose();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={group ? 'Edit group' : 'Add group'}
      primaryAction={{ content: 'Save', onAction: save, loading: busy, disabled: !name.trim() || locs.length === 0 }}
      secondaryActions={[{ content: 'Cancel', onAction: onClose }]}
    >
      <Modal.Section>
        <BlockStack gap="300">
          {error && <Banner tone="critical">{error}</Banner>}
          <TextField label="Name" value={name} onChange={setName} maxLength={40} autoComplete="off" autoFocus />
          <MultiSelectDropdown
            label="Locations"
            options={allLocations}
            selected={locs}
            onChange={setLocs}
            showSelectAll
            placeholder="Choose locations"
          />
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

function StartingDateCard({ settings, onSaved }) {
  const year = Number(settings.today.slice(0, 4));
  const [value, setValue] = useState(settings.startingDate);
  const initial = toLocalDate(value || settings.yesterday);
  const [view, setView] = useState({ month: initial.getMonth(), year: initial.getFullYear() });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const changed = value && value !== settings.startingDate;
  const save = async () => {
    // Preview & Test Mode: a date that is today or earlier ends it.
    if (settings.test && settings.test.on && value <= settings.today
      && !window.confirm('This Starting date is today or earlier: Preview & Test Mode will be turned off and all test data deleted. Continue?')) return;
    setBusy(true); setError(''); setInfo('');
    try {
      await api('PUT', '/starting-date', { date: value });
      await onSaved();
      setInfo(value <= settings.yesterday
        ? 'Saved. System amounts for the missing days are being fetched from Shopify — this can take a minute.'
        : 'Saved. Days will appear from this date on, each one the morning after (3:10 AM).');
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const activator = (
    <button type="button" style={smallBtnStyle(false)} onClick={() => setOpen(o => !o)}>
      <CalendarIcon />{value ? shortDate(value, year) : 'Choose a date'}
    </button>
  );
  return (
    <Card>
      <BlockStack gap="300">
        <Text variant="headingMd" as="h2">Starting date</Text>
        <Text variant="bodySm" tone="subdued">
          Collect and Audit only show days from this date to yesterday. Earlier days can’t be picked and aren’t counted.
          Until a Starting date is saved, nothing is fetched from Shopify. A future date is allowed: days appear once it has passed.
        </Text>
        {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}
        {info && <Banner tone="success" onDismiss={() => setInfo('')}>{info}</Banner>}
        <InlineStack gap="300" blockAlign="center">
          <Popover active={open} activator={activator} onClose={() => setOpen(false)} preferredAlignment="left" autofocusTarget="none">
            <Box padding="400" minWidth="300px">
              <DatePicker
                month={view.month}
                year={view.year}
                onMonthChange={(month, y) => setView({ month, year: y })}
                selected={value ? toLocalDate(value) : undefined}
                onChange={(r) => { setValue(toIso(r.start)); setOpen(false); }}
              />
            </Box>
          </Popover>
          <Button onClick={save} disabled={!changed || busy} loading={busy}>Save</Button>
        </InlineStack>
        {settings.startingDate && settings.startingDate <= settings.yesterday && (
          <Text variant="bodySm" tone="subdued">
            {settings.lastFetchedDay
              ? `System amounts fetched up to ${shortDate(settings.lastFetchedDay, year)}. Every day at 3:10 AM the previous day is added.`
              : 'No System amounts fetched yet.'}
          </Text>
        )}
        {settings.test && settings.test.allowed && <TestModeSection settings={settings} onSaved={onSaved} />}
      </BlockStack>
    </Card>
  );
}

// Preview & Test Mode (temporary). Shown only while the Starting date is
// empty or in the future (settings.test.allowed, worked out by the server).
function TestModeSection({ settings, onSaved }) {
  const test = settings.test;
  const year = Number(settings.today.slice(0, 4));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const toggle = async (on) => {
    if (!on && !window.confirm('Turn off Preview & Test Mode? All test data will be deleted.')) return;
    setBusy(true); setError(''); setInfo('');
    try {
      const d = await api('PUT', '/test-mode', { on });
      await onSaved();
      if (!on) setInfo(`Test data deleted (${d.deleted || 0} rows).`);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const populate = async () => {
    if (test.from && !window.confirm('Populate again? The current test data, including anything typed in it, is replaced.')) return;
    setBusy(true); setError(''); setInfo('');
    try {
      const d = await api('POST', '/test-mode/populate');
      await onSaved();
      setInfo(`Test data added for ${d.locations} locations, ${shortDate(d.from, year)} – ${shortDate(d.to, year)}. The last 7 days are Pending.`);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <div style={{ borderTop: '1px solid #e1e3e5', paddingTop: 12 }}>
      <BlockStack gap="200">
        <InlineStack gap="400" blockAlign="center" wrap>
          <Switch on={test.on} disabled={busy} label="Preview & Test Mode" onChange={toggle} />
          {test.on && <Button onClick={populate} loading={busy} disabled={busy}>Populate Data</Button>}
        </InlineStack>
        <Text variant="bodySm" tone="subdued">
          {test.on
            ? (test.from
              ? `Test data from ${shortDate(test.from, year)}. Every new day gets Pending test rows until the mode is turned off. Turning it off, or reaching the Starting date, deletes all test data.`
              : 'Populate Data fills 30 days of test data for every location, the last 7 days left Pending.')
            : 'Try Collect and Audit with fake data before the Starting date. Only available while the Starting date is empty or in the future.'}
        </Text>
        {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}
        {info && <Banner tone="success" onDismiss={() => setInfo('')}>{info}</Banner>}
      </BlockStack>
    </div>
  );
}

export default function CashSettings({ settings, allLocations, reloadSettings, logout }) {
  const [editing, setEditing] = useState(null); // null | 'new' | group
  const [error, setError] = useState('');
  const [loggingOut, setLoggingOut] = useState(false);
  const groups = settings.groups || [];

  const del = async (g) => {
    if (!window.confirm(`Delete the group “${g.name}”? Accounts using it will choose a group again.`)) return;
    try { await api('DELETE', `/groups/${g.id}`); await reloadSettings(); } catch (e) { setError(e.message); }
  };

  return (
    <Page>
      <BlockStack gap="400">
        <InlineStack align="end">
          <Button loading={loggingOut} onClick={async () => { setLoggingOut(true); await logout(); }}>Log out</Button>
        </InlineStack>
        {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text variant="headingMd" as="h2">User Groups</Text>
              <Button onClick={() => setEditing('new')}>Add group</Button>
            </InlineStack>
            <Text variant="bodySm" tone="subdued">
              A group only sees its own locations in Collect and Audit. Admin always sees every location.
            </Text>
            {groups.length === 0 && <Text tone="subdued">No groups yet.</Text>}
            {groups.map(g => (
              <div key={g.id} style={{ border: '1px solid #e1e3e5', borderRadius: 10, padding: '10px 12px' }}>
                <InlineStack align="space-between" blockAlign="center" gap="300" wrap={false}>
                  <BlockStack gap="150">
                    <Text fontWeight="semibold">{g.name}</Text>
                    <InlineStack gap="100" wrap>
                      {g.locations.map(l => <LocPill key={l} name={l} />)}
                    </InlineStack>
                  </BlockStack>
                  <InlineStack gap="200" wrap={false}>
                    <Button size="slim" onClick={() => setEditing(g)}>Edit</Button>
                    <Button size="slim" tone="critical" variant="plain" onClick={() => del(g)}>Delete</Button>
                  </InlineStack>
                </InlineStack>
              </div>
            ))}
          </BlockStack>
        </Card>

        <StartingDateCard settings={settings} onSaved={reloadSettings} />
      </BlockStack>

      {editing && (
        <GroupModal
          group={editing === 'new' ? null : editing}
          allLocations={allLocations}
          onClose={() => setEditing(null)}
          onSaved={reloadSettings}
        />
      )}
    </Page>
  );
}
