import React, { useState } from 'react';
import { Badge, Tooltip } from '@shopify/polaris';
import { LocPill } from '../../warehouse/whShared';
import { Fit, Amt, DiffText, AmountInput, Checkbox, linkBtn, useRowNotes, NoteModal } from './CashTable';
import { fmtMoney, fmtDiff, dateParts, depositStamp, depositDay, SUBDUED, RED } from './cashShared';

// Cash Payments day blocks (2026-11-27, Hera). Used by Collect, Audit ›
// Discrepancy and Audit › Deposits (a card opened).
//
// One block per location / day, split into grey boxes:
//   [☐] [Date]  [drawer lines: D-no · Expected · ← Diff. → · StoreCounted]          [Removed]                    [note · status]
//               [Total:        Σ Expected · diff1 · Σ StoreCounted · diff2 · Counted] [Σ Removed · diff3 · Receipted]
//   Expected      = expectedCashAtClose − cash at open (Shopify's "should be")
//   StoreCounted  = cashCountedAtClose − cash at open (what the store counted)
//   Counted       = finance's count (day total only, typed in Collect)
//   Receipted     = removed cash backed by receipts (day total only, typed in Collect)
//   diff1 = StoreCounted − Expected (each drawer and the total)
//   diff2 = Counted − StoreCounted;  diff3 = Receipted − Removed
// Amounts: null → nothing, 0 → "-", a diff of 0 → nothing (same rules as before).
// Column widths are fixed; a value wider than its column is cut with "…" and
// shows in full on hover (Fit).

const GREY = '#f1f1f1';
const BOX = { background: GREY, borderRadius: 10, padding: '6px 8px', boxSizing: 'border-box', minWidth: 0 };
const NUM = { fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const HEAD_PILL = { display: 'inline-block', padding: '2px 10px', borderRadius: 999, background: '#ebebeb', color: '#303030', fontWeight: 500 };
const HEAD = { fontSize: 12, fontWeight: 450, color: SUBDUED, whiteSpace: 'nowrap' };
const CELL = { fontSize: 13, color: '#303030', minWidth: 0, overflow: 'hidden' };
const LINE_H = 32;

// Inner columns of the two amount boxes (px). Header and every line share them.
const MAIN_COLS = '40px 76px 56px 100px 56px 80px'; // D-no · Expected · Diff · StoreCounted · Diff · Counted
const REM_COLS = '72px 56px 80px';                  // Removed · Diff · Receipted
const MAIN_W = 40 + 76 + 56 + 100 + 56 + 80 + 16;   // + box padding
const REM_W = 72 + 56 + 80 + 16;
const OUTER = (check) => ({
  display: 'grid',
  gridTemplateColumns: `${check ? '24px ' : ''}64px ${MAIN_W}px ${REM_W}px minmax(130px, 1fr)`,
  columnGap: 6,
  rowGap: 6,
  alignItems: 'stretch',
});
const ARROW_DIFF = '← Diff. →';

function Head({ children, pill, tip, align = 'center' }) {
  const inner = <span style={pill ? { ...HEAD_PILL, cursor: tip ? 'default' : undefined } : { cursor: tip ? 'default' : undefined }}>{children}</span>;
  return (
    <div style={{ ...HEAD, textAlign: align }}>
      {tip ? <Tooltip content={tip} preferredPosition="above">{inner}</Tooltip> : inner}
    </div>
  );
}

// One line inside a box: cells laid out on the box's columns.
function Line({ cols, children, total }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: cols, alignItems: 'center', minHeight: LINE_H, fontWeight: total ? 600 : undefined }}>
      {children}
    </div>
  );
}
const C = ({ children, align = 'center', style }) => <div style={{ ...CELL, textAlign: align, ...style }}>{children}</div>;

function DateBox({ row, currentYear, showLocation }) {
  const p = dateParts(row.date);
  return (
    <div style={{ ...BOX, gridRow: 'span 2', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4, padding: '8px 8px' }}>
      {showLocation && <LocPill name={row.location} />}
      {p.year !== currentYear && <div style={{ fontSize: 11, color: SUBDUED, lineHeight: '14px' }}>{p.year}</div>}
      <div style={{ fontWeight: 600, fontSize: 13, lineHeight: '16px' }}>{p.main}</div>
      <div style={{ fontSize: 12, color: SUBDUED, lineHeight: '14px' }}>{p.dow}</div>
    </div>
  );
}

// Status pill. Collect: Pending / Collected / Deposited (+ deposit day under it).
// Audit: Pending / Not deposited / Deposited.
function Status({ row, mode }) {
  if (mode === 'deposit') return null;
  if (row.status === 'deposited') {
    return (
      <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
        <Badge tone="success">Deposited</Badge>
        {row.depositedAt && (
          <Tooltip content={row.deposit || ''} preferredPosition="below">
            <span style={{ fontSize: 11, color: SUBDUED, cursor: 'default' }}>{depositDay(row.depositedAt)}</span>
          </Tooltip>
        )}
      </span>
    );
  }
  if (row.status === 'pending') return <span style={{ whiteSpace: 'nowrap' }}><Badge tone="attention">Pending</Badge></span>;
  return (
    <span style={{ whiteSpace: 'nowrap' }}>
      {mode === 'audit' ? <Badge tone="warning">Not deposited</Badge> : <Badge tone="info">Collected</Badge>}
    </span>
  );
}

function NoteBox({ row, mode, notes }) {
  return (
    <div style={{ ...BOX, gridRow: 'span 2', padding: '8px 8px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      {/* wraps (status under "Add note") when the box is too narrow for both */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 6, flexWrap: 'wrap', rowGap: 4 }}>
        <button type="button" style={{ ...linkBtn('#005bd3'), fontSize: 13, whiteSpace: 'nowrap' }} onClick={() => notes.edit(row)}>
          {row.note ? 'Edit' : 'Add note'}
        </button>
        <Status row={row} mode={mode} />
      </div>
      {row.note && (
        <div style={{ fontSize: 12, lineHeight: '16px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {row.note}
          <button type="button" aria-label="Delete note" title="Delete note" style={{ ...linkBtn(RED), fontSize: 15, lineHeight: '16px', marginLeft: 6 }} onClick={() => notes.del(row)}>×</button>
        </div>
      )}
    </div>
  );
}

// Read-only amount entered by finance (bold), or the input in Collect.
function Entered({ row, field, editable, onSaveAmount, label }) {
  if (editable) {
    return <AmountInput cents={row[field]} label={`${label} ${row.date}`} width={74} onCommit={(c) => onSaveAmount(row, field, c)} />;
  }
  return <Amt cents={row[field]} bold />;
}

function DayBlock({ row, mode, currentYear, check, onSaveAmount, notes }) {
  const editable = mode === 'collect' && !row.depositId;
  const drawers = row.drawers || [];
  return (
    <div style={{ ...OUTER(!!check), padding: '10px 0', borderBottom: '1px solid #e1e3e5' }}>
      {check && (
        <div style={{ gridRow: 'span 2', display: 'flex', justifyContent: 'center', paddingTop: 10 }}>{check}</div>
      )}
      <DateBox row={row} currentYear={currentYear} showLocation={mode === 'audit'} />
      {/* drawer lines */}
      <div style={BOX}>
        {drawers.length === 0 && <Line cols={MAIN_COLS}><C align="left" style={{ color: SUBDUED, gridColumn: 'span 6' }}>No drawer data</C></Line>}
        {drawers.map(d => (
          <Line key={d.id} cols={MAIN_COLS}>
            <C align="left"><Fit text={d.name} /></C>
            <C style={NUM}><Amt cents={d.expected} /></C>
            <C style={NUM}><DiffText cents={d.diff1} /></C>
            <C style={NUM}><Amt cents={d.storeCounted} /></C>
            <C />
            <C />
          </Line>
        ))}
      </div>
      <div style={BOX}>
        {drawers.map(d => (
          <Line key={d.id} cols={REM_COLS}>
            <C style={NUM}><Amt cents={d.removed} /></C>
            <C />
            <C />
          </Line>
        ))}
      </div>
      <NoteBox row={row} mode={mode} notes={notes} />
      {/* totals */}
      <div style={BOX}>
        <Line cols={MAIN_COLS} total>
          <C align="left">Total</C>
          <C style={NUM}><Amt cents={row.expected} /></C>
          <C style={{ ...NUM, fontWeight: 400 }}><DiffText cents={row.diff1} /></C>
          <C style={NUM}><Amt cents={row.storeCounted} /></C>
          <C style={{ ...NUM, fontWeight: 400 }}><DiffText cents={row.diff2} /></C>
          <C style={NUM}><Entered row={row} field="counted" editable={editable} onSaveAmount={onSaveAmount} label="Counted" /></C>
        </Line>
      </div>
      <div style={BOX}>
        <Line cols={REM_COLS} total>
          <C style={NUM}><Amt cents={row.removed} /></C>
          <C style={{ ...NUM, fontWeight: 400 }}><DiffText cents={row.diff3} /></C>
          <C style={NUM}><Entered row={row} field="receipted" editable={editable} onSaveAmount={onSaveAmount} label="Receipted" /></C>
        </Line>
      </div>
    </div>
  );
}

function HeaderRow({ check, mode }) {
  return (
    <div style={{ ...OUTER(!!check), padding: '10px 0', borderBottom: '1px solid #e1e3e5', alignItems: 'center' }}>
      {check && <div style={{ display: 'flex', justifyContent: 'center' }}>{check}</div>}
      <Head align="left"><span style={{ paddingLeft: 8 }}>Date</span></Head>
      <div style={{ display: 'grid', gridTemplateColumns: MAIN_COLS, alignItems: 'center', padding: '0 8px' }}>
        <Head align="left">Drawer</Head>
        <Head pill tip="What Shopify says should be in the drawer at closing (Expected cash), minus the opening float.">Expected</Head>
        <Head tip="StoreCounted − Expected">{ARROW_DIFF}</Head>
        <Head pill tip="What the store counted at closing (Counted cash), minus the opening float.">StoreCounted</Head>
        <Head tip="Counted − StoreCounted (day total)">{ARROW_DIFF}</Head>
        <Head pill tip="Counted by finance: the cash in the envelope.">Counted</Head>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: REM_COLS, alignItems: 'center', padding: '0 8px' }}>
        <Head tip="Cash removed from the drawer during the day">Removed</Head>
        <Head tip="Receipted − Removed (day total)">{ARROW_DIFF}</Head>
        <Head tip="Removed cash backed by receipts">Receipted</Head>
      </div>
      <Head align={mode === 'deposit' ? 'left' : 'right'}><span style={{ padding: '0 10px' }}>{mode === 'deposit' ? 'Note' : 'Status'}</span></Head>
    </div>
  );
}

const rowKey = (r) => `${r.location}|${r.date}`;

// mode: 'collect' | 'audit' | 'deposit'. selectable(row) → can be ticked
// (no checkboxes when not given).
export function DayList({ rows, mode, currentYear, selectable, selected, onSelect, onSaveAmount, onSaveNote, emptyText }) {
  const notes = useRowNotes(onSaveNote);
  const withCheck = typeof selectable === 'function';
  const can = withCheck ? rows.filter(selectable) : [];
  const selCount = withCheck ? can.filter(r => selected.has(rowKey(r))).length : 0;
  const allOn = can.length > 0 && selCount === can.length;
  const toggleAll = (on) => {
    const next = new Set(selected);
    can.forEach(r => (on ? next.add(rowKey(r)) : next.delete(rowKey(r))));
    onSelect(next);
  };
  const toggle = (r, on) => {
    const next = new Set(selected);
    if (on) next.add(rowKey(r)); else next.delete(rowKey(r));
    onSelect(next);
  };
  return (
    <>
      <div style={{ overflowX: 'auto', padding: '0 12px' }}>
        <div style={{ minWidth: 890 }}>
          <HeaderRow mode={mode} check={withCheck ? <Checkbox label="Select all" checked={allOn} indeterminate={selCount > 0 && !allOn} disabled={!can.length} onChange={toggleAll} /> : null} />
          {rows.length === 0 && <div style={{ padding: '24px 8px', textAlign: 'center', color: SUBDUED, fontSize: 13 }}>{emptyText || 'Nothing to show.'}</div>}
          {rows.map(row => {
            const ok = withCheck && selectable(row);
            return (
              <DayBlock
                key={rowKey(row)}
                row={row}
                mode={mode}
                currentYear={currentYear}
                onSaveAmount={onSaveAmount}
                notes={notes}
                check={withCheck ? <Checkbox label={`Select ${row.location} ${row.date}`} checked={ok && selected.has(rowKey(row))} disabled={!ok} onChange={(on) => toggle(row, on)} /> : null}
              />
            );
          })}
        </div>
      </div>
      {notes.modal}
    </>
  );
}

// ─── Audit › Deposits ────────────────────────────────────────────────────────

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const isoNext = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d, 12)); t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
};
const dayLabel = (iso, withMonth = true) => {
  const [, m, d] = iso.split('-').map(Number);
  return withMonth ? `${MON[m - 1]}.${String(d).padStart(2, '0')}` : String(d).padStart(2, '0');
};
// The days of a deposit as ranges of consecutive days (2026-11-27):
// ['2026-11-01'…'2026-11-07'] → "Nov.01 – 07"; gaps → "Nov.01 – 05, Nov.08, Nov.10 – 12".
export function daysSummary(dates) {
  const list = [...(dates || [])].sort();
  const runs = [];
  for (const d of list) {
    const last = runs[runs.length - 1];
    if (last && isoNext(last[1]) === d) last[1] = d; else runs.push([d, d]);
  }
  return runs.map(([a, b]) => {
    if (a === b) return dayLabel(a);
    const sameMonth = a.slice(0, 7) === b.slice(0, 7);
    return `${dayLabel(a)} – ${dayLabel(b, !sameMonth)}`;
  }).join(', ');
}

const SUM_PILL = { display: 'inline-block', padding: '2px 10px', borderRadius: 999, background: '#ebebeb', fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap' };

function DaysLine({ dates }) {
  const text = daysSummary(dates);
  const n = (dates || []).length;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: '1 1 auto' }}>
      <span style={{ ...SUM_PILL, background: '#e3e3e3' }}>{n} day{n === 1 ? '' : 's'}</span>
      <Tooltip content={<div style={{ maxWidth: 360 }}>{(dates || []).map(d => `${dayLabel(d)} ${dateParts(d).dow}`).join(' · ')}</div>} preferredPosition="above">
        <span style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, cursor: 'default', display: 'block' }}>{text}</span>
      </Tooltip>
    </div>
  );
}

export function DepositCard({ deposit, currentYear, open, onToggle, rows, loading, onSaveNote, onSaveDepositNote }) {
  const [editing, setEditing] = useState(false);
  const d = deposit;
  const delNote = async () => {
    if (!window.confirm('Delete this deposit note?')) return;
    try { await onSaveDepositNote(d, ''); } catch (e) { window.alert(e.message); }
  };
  return (
    <div style={{ background: '#fff', borderRadius: 12, boxShadow: '0 1px 0 rgba(0,0,0,0.07), 0 0 0 1px rgba(0,0,0,0.08)', overflow: 'hidden' }}>
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
        style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', cursor: 'pointer', borderBottom: open ? '1px solid #e1e3e5' : 'none', minWidth: 0 }}
      >
        <LocPill name={d.location} />
        <Tooltip content={d.title} preferredPosition="above">
          <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{depositStamp(d.createdAt)}</span>
        </Tooltip>
        <DaysLine dates={d.dates} />
        {d.discrepancy !== 0 && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flex: 'none' }}>
            <Tooltip content="Total Counted − Total StoreCounted of every day in this deposit" preferredPosition="above">
              <span style={{ ...SUM_PILL, background: '#fee9e8', color: RED, cursor: 'default' }}>Discrepancy</span>
            </Tooltip>
            <span style={{ ...NUM, fontSize: 13, fontWeight: 600, color: RED }}>{fmtDiff(d.discrepancy)}</span>
          </span>
        )}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flex: 'none' }}>
          <span style={SUM_PILL}>Total StoreCounted</span>
          <span style={{ ...NUM, fontSize: 13, fontWeight: 600 }}>{fmtMoney(d.storeCounted)}</span>
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flex: 'none' }}>
          <span style={SUM_PILL}>Total Counted</span>
          <span style={{ ...NUM, fontSize: 13, fontWeight: 600 }}>{fmtMoney(d.counted)}</span>
        </span>
        <span aria-hidden="true" style={{ flex: 'none', fontSize: 14, color: SUBDUED, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}>▾</span>
      </div>
      {open && (
        <div style={{ paddingBottom: 8 }}>
          {/* Deposit note (kept from the 2026-11-20 deposit card) */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px 0', fontSize: 13, minWidth: 0 }}>
            <span style={{ color: SUBDUED, flex: 'none' }}>Deposit note</span>
            {d.note ? (
              <>
                <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', minWidth: 0 }}>{d.note}</span>
                <button type="button" aria-label="Delete note" title="Delete note" style={{ ...linkBtn(RED), fontSize: 15, lineHeight: '16px', flex: 'none' }} onClick={delNote}>×</button>
                <button type="button" style={{ ...linkBtn('#005bd3'), flex: 'none' }} onClick={() => setEditing(true)}>Edit</button>
              </>
            ) : (
              <button type="button" style={{ ...linkBtn('#005bd3'), flex: 'none' }} onClick={() => setEditing(true)}>Add</button>
            )}
          </div>
          {loading && !rows
            ? <div style={{ padding: 16, fontSize: 13, color: SUBDUED }}>Loading...</div>
            : <DayList rows={rows || []} mode="deposit" currentYear={currentYear} onSaveNote={onSaveNote} emptyText="No days." />}
        </div>
      )}
      {editing && (
        <NoteModal
          target={{ title: d.title, note: d.note }}
          onClose={() => setEditing(false)}
          onSave={(text) => onSaveDepositNote(d, text)}
        />
      )}
    </div>
  );
}
