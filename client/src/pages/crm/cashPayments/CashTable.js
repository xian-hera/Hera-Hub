import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Badge, Tooltip, Modal, TextField, BlockStack, Banner } from '@shopify/polaris';
import { LocPill } from '../../warehouse/whShared';
import { fmtMoney, fmtDiff, parseMoney, dateParts, depositStamp, depositDay, SUBDUED, GREEN, RED } from './cashShared';

// Cash Payments tables (2026-11-19, Hera; drawer-based since 2026-11-20).
// 2026-11-27 (Hera): Collect and Audit now use the day blocks in CashDays.js
// (Expected / StoreCounted / Counted per drawer). CollectTable, DetailTable and
// DepositTable below are no longer used by the pages; the small parts (Fit,
// Amt, DiffText, AmountInput, NoteModal, useRowNotes…) are shared with CashDays.js.
//
//   CollectTable  ☐ | Date | Expected | Removed | Diff. | Counted | Receipted removed | Removed diff. | Status | Note
//   DetailTable   Location | Date | Drawer · Ending · Removed (one line per drawer) | Total Ending |
//                 ← Diff. → | Counted | Total removed | ← Diff. → | Receipted removed | Status
//                 (+ the note on a line under the row)          (Audit, read-only but notes)
//   DepositTable  Deposit | Date | Expected | ← Diff. → | Counted | Removed | ← Diff. → | Receipted | Note
//
// Expected = Σ drawers (Ending − cash at open); Removed = Σ cash removed;
// Diff. = Counted − Expected; Removed diff. = Receipted removed − Removed
// (only when Receipted is entered — empty means Removed is fine).
// Green "+x" = more, red "-x" = less, 0 empty. Fixed column widths: typing
// never makes a table jump. Everything centred, except Expected (right) and
// Removed (left), which sit together in Collect.

const TH = { padding: '10px 6px', fontSize: 12, fontWeight: 450, color: SUBDUED, textAlign: 'center', whiteSpace: 'nowrap', borderBottom: '1px solid #e1e3e5' };
const TD = { padding: '10px 6px', fontSize: 13, color: '#303030', verticalAlign: 'middle', borderBottom: '1px solid #ebebeb', textAlign: 'center' };
const NUM = { fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const HEAD_PILL = { display: 'inline-block', padding: '2px 10px', borderRadius: 999, background: '#ebebeb', color: '#303030', fontWeight: 500 };
const VAL_PILL = { display: 'inline-block', padding: '2px 8px', borderRadius: 999, background: '#f1f1f1', fontVariantNumeric: 'tabular-nums' };
const ENTERED = { fontWeight: 600 };
const GREY_ROW = { background: '#f7f7f7', color: '#8a8a8a' };

// Header text, optionally in a pill and / or with a hover tooltip.
function Head({ children, pill, tip }) {
  const inner = <span style={pill ? { ...HEAD_PILL, cursor: tip ? 'default' : undefined } : { cursor: tip ? 'default' : undefined }}>{children}</span>;
  return tip ? <Tooltip content={tip} preferredPosition="above">{inner}</Tooltip> : inner;
}

// Fit (2026-11-20, Hera): a value wider than its column is cut with "…"
// (column widths never change); hovering it shows the whole value. No
// tooltip when it fits.
export function Fit({ text, style }) {
  const ref = useRef(null);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const check = () => setCut(el.scrollWidth > el.clientWidth + 1);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, [text]);
  const span = (
    <span ref={ref} style={{
      ...style, display: 'inline-block', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis',
      whiteSpace: 'nowrap', verticalAlign: 'middle', boxSizing: 'border-box', cursor: cut ? 'default' : undefined,
    }}>{text}</span>
  );
  return cut ? <Tooltip content={text} preferredPosition="above">{span}</Tooltip> : span;
}

export function DiffText({ cents, dim }) {
  const t = fmtDiff(cents);
  if (!t) return null;
  return <Fit text={t} style={{ ...NUM, color: dim ? '#8a8a8a' : (cents > 0 ? GREEN : RED) }} />;
}

// Deposited: the pill, and the deposit day in small text under it.
function StatusBadge({ row }) {
  if (row.status === 'deposited') {
    return (
      <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
        <Badge tone="info">Deposited</Badge>
        {row.depositedAt && (
          <Tooltip content={row.deposit || ''} preferredPosition="below">
            <span style={{ fontSize: 11, color: SUBDUED, cursor: 'default' }}>{depositDay(row.depositedAt)}</span>
          </Tooltip>
        )}
      </span>
    );
  }
  if (row.status === 'matched') return <Badge tone="success">Matched</Badge>;
  if (row.status === 'mismatch') return <Badge tone="critical">Mismatch</Badge>;
  if (row.status === 'pending') return <Badge tone="attention">Pending</Badge>;
  if (row.status === 'nocash') return <span style={{ fontSize: 12, color: '#8a8a8a' }}>No cash</span>;
  return null;
}

function DateCell({ iso, currentYear }) {
  const p = dateParts(iso);
  return (
    <td style={{ ...TD, whiteSpace: 'nowrap' }}>
      {p.year !== currentYear && <div style={{ fontSize: 11, color: SUBDUED, lineHeight: '14px' }}>{p.year}</div>}
      <span style={{ fontWeight: 600 }}>{p.main}</span>
      <span style={{ fontSize: 12, color: SUBDUED, marginLeft: 6 }}>{p.dow}</span>
    </td>
  );
}

// Moves focus to the next amount box of the table (Enter).
function focusNext(current) {
  const all = Array.from(document.querySelectorAll('input[data-cash-amount]'));
  const i = all.indexOf(current);
  if (i >= 0 && all[i + 1]) { all[i + 1].focus(); all[i + 1].select(); } else current.blur();
}

export function AmountInput({ cents, onCommit, label, width = 92 }) {
  const [text, setText] = useState(fmtMoney(cents));
  const [bad, setBad] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setText(fmtMoney(cents)); setBad(false); }, [cents]);
  const commit = async () => {
    const next = parseMoney(text);
    if (next === undefined) { setBad(true); return; }
    setBad(false);
    if (next === cents) { setText(fmtMoney(cents)); return; }
    setSaving(true);
    const ok = await onCommit(next);
    setSaving(false);
    if (!ok) setText(fmtMoney(cents));
  };
  return (
    <input
      data-cash-amount=""
      aria-label={label}
      inputMode="decimal"
      value={text}
      title={bad ? 'Enter an amount like 1234.56' : undefined}
      onChange={(e) => { setText(e.target.value); if (bad) setBad(false); }}
      onFocus={(e) => e.target.select()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); focusNext(e.target); }
        if (e.key === 'Escape') { setText(fmtMoney(cents)); setBad(false); e.target.blur(); }
      }}
      style={{
        width, maxWidth: '100%', height: 32, boxSizing: 'border-box', padding: '0 8px', textAlign: 'center',
        border: `1px solid ${bad ? RED : '#c9cccf'}`, borderRadius: 8, font: 'inherit', fontSize: 13,
        fontVariantNumeric: 'tabular-nums', background: saving ? '#f6f6f7' : '#fff', outline: 'none',
      }}
    />
  );
}

export const linkBtn = (color) => ({ border: 'none', background: 'none', padding: 0, cursor: 'pointer', font: 'inherit', fontSize: 13, color });

// One line, cut with "…"; the whole note in a tooltip on hover.
export function NoteCell({ note, onEdit, onDelete }) {
  if (!note) {
    return (
      <td style={TD}>
        <button type="button" style={linkBtn('#8a8a8a')} onClick={onEdit}>Add</button>
      </td>
    );
  }
  return (
    <td style={{ ...TD, textAlign: 'left' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Tooltip content={<div style={{ whiteSpace: 'pre-wrap', maxWidth: 320 }}>{note}</div>} preferredPosition="above">
            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, lineHeight: '16px', cursor: 'default' }}>{note}</div>
          </Tooltip>
        </div>
        <button type="button" aria-label="Delete note" title="Delete note" style={{ ...linkBtn(RED), fontSize: 15, lineHeight: '16px', flex: 'none' }} onClick={onDelete}>×</button>
        <button type="button" style={{ ...linkBtn('#005bd3'), flex: 'none' }} onClick={onEdit}>Edit</button>
      </div>
    </td>
  );
}

// Note editor for a day row or a deposit. target: { title, note }.
export function NoteModal({ target, onClose, onSave }) {
  const [text, setText] = useState(target ? target.note : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setText(target ? target.note : ''); setError(''); }, [target]);
  if (!target) return null;
  const save = async () => {
    setBusy(true); setError('');
    try { await onSave(text); onClose(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={`${target.note ? 'Edit' : 'Add'} note — ${target.title}`}
      primaryAction={{ content: 'Save', onAction: save, loading: busy, disabled: !text.trim() }}
      secondaryActions={[{ content: 'Cancel', onAction: onClose }]}
    >
      <Modal.Section>
        <BlockStack gap="300">
          {error && <Banner tone="critical">{error}</Banner>}
          <TextField label="Note" labelHidden value={text} onChange={setText} multiline={4} maxLength={1000} showCharacterCount autoComplete="off" autoFocus />
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

// Day-row notes: modal + delete, shared by Collect and the detail list.
export function useRowNotes(onSaveNote) {
  const [noteRow, setNoteRow] = useState(null);
  const del = async (row) => {
    if (!window.confirm('Delete this note?')) return;
    try { await onSaveNote(row, ''); } catch (e) { window.alert(e.message); }
  };
  const modal = noteRow && (
    <NoteModal
      target={{ title: `${noteRow.location} · ${dateParts(noteRow.date).main} ${dateParts(noteRow.date).dow}`, note: noteRow.note }}
      onClose={() => setNoteRow(null)}
      onSave={(text) => onSaveNote(noteRow, text)}
    />
  );
  return { edit: setNoteRow, del, modal };
}

export const Checkbox = ({ checked, disabled, indeterminate, onChange, label }) => (
  <input
    type="checkbox"
    aria-label={label}
    checked={checked}
    disabled={disabled}
    ref={(el) => { if (el) el.indeterminate = !!indeterminate; }}
    onChange={(e) => onChange(e.target.checked)}
    style={{ width: 16, height: 16, cursor: disabled ? 'default' : 'pointer', margin: 0 }}
  />
);

// A day can go into a deposit when it isn't deposited and isn't Pending.
// 2026-11-27: Collected days only (Counted entered, not deposited).
export const canDeposit = (row) => !row.depositId && row.status !== 'pending';
const rowKey = (r) => `${r.location}|${r.date}`;

// ─── Collect ────────────────────────────────────────────────────────────────
const C_COLS = [32, 88, 96, 92, 76, 108, 112, 92, 96, 110];

export function CollectTable({ rows, currentYear, selected, onSelect, onSaveAmount, onSaveNote, emptyText }) {
  const notes = useRowNotes(onSaveNote);
  const selectable = rows.filter(canDeposit);
  const selCount = selectable.filter(r => selected.has(rowKey(r))).length;
  const allOn = selectable.length > 0 && selCount === selectable.length;
  const toggleAll = (on) => {
    const next = new Set(selected);
    selectable.forEach(r => (on ? next.add(rowKey(r)) : next.delete(rowKey(r))));
    onSelect(next);
  };
  const toggle = (r, on) => {
    const next = new Set(selected);
    if (on) next.add(rowKey(r)); else next.delete(rowKey(r));
    onSelect(next);
  };
  return (
    <>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
          <colgroup>{C_COLS.map((w, i) => <col key={i} style={{ width: w }} />)}</colgroup>
          <thead>
            <tr>
              <th style={TH}>
                <Checkbox label="Select all" checked={allOn} indeterminate={selCount > 0 && !allOn} disabled={!selectable.length} onChange={toggleAll} />
              </th>
              <th style={TH}>Date</th>
              <th style={{ ...TH, textAlign: 'right', paddingRight: 3 }}>
                <Head pill tip="Total of Ending Cash from all drawers, minus the opening float.">Expected</Head>
              </th>
              <th style={{ ...TH, textAlign: 'left', paddingLeft: 3 }}><Head pill tip="Total of Removed Cash from all drawers.">Removed</Head></th>
              <th style={TH}><Head tip="Difference between Expected and Counted">Diff.</Head></th>
              <th style={TH}><Head pill>Counted</Head></th>
              <th style={TH}><Head tip="Removed cash backed by receipts. Leave empty when Removed is fine.">Receipted removed</Head></th>
              <th style={TH}><Head tip="Receipted removed − Removed">Removed diff.</Head></th>
              <th style={TH}>Status</th>
              <th style={TH}>Note</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={C_COLS.length} style={{ ...TD, color: SUBDUED, padding: '24px 8px' }}>{emptyText || 'Nothing to show.'}</td></tr>
            )}
            {rows.map(row => {
              const grey = row.noCash;
              const locked = !!row.depositId;
              const inputs = !locked && !grey;
              const ok = canDeposit(row);
              return (
                <tr key={rowKey(row)} style={grey ? GREY_ROW : undefined}>
                  <td style={TD}>
                    <Checkbox label={`Select ${row.date}`} checked={ok && selected.has(rowKey(row))} disabled={!ok} onChange={(on) => toggle(row, on)} />
                  </td>
                  <DateCell iso={row.date} currentYear={currentYear} />
                  {/* 0 → "-" without a pill (2026-11-20) */}
                  <td style={{ ...TD, ...NUM, textAlign: 'right', paddingRight: 3 }}><Amt cents={row.expected} pill /></td>
                  <td style={{ ...TD, ...NUM, textAlign: 'left', paddingLeft: 3 }}><Amt cents={row.removed} pill /></td>
                  <td style={{ ...TD, ...NUM }}><DiffText cents={row.diff} dim={grey} /></td>
                  <td style={{ ...TD, ...NUM }}>
                    {inputs
                      ? <AmountInput cents={row.counted} label={`Counted ${row.date}`} onCommit={(c) => onSaveAmount(row, 'counted', c)} />
                      : (row.counted === null ? <span style={{ color: '#8a8a8a' }}>-</span> : <Amt cents={row.counted} bold />)}
                  </td>
                  <td style={{ ...TD, ...NUM }}>
                    {inputs && (row.removed > 0 || row.receipted !== null)
                      ? <AmountInput cents={row.receipted} label={`Receipted removed ${row.date}`} onCommit={(c) => onSaveAmount(row, 'receipted', c)} />
                      : <Amt cents={row.receipted} bold />}
                  </td>
                  <td style={{ ...TD, ...NUM }}><DiffText cents={row.removedDiff} dim={grey} /></td>
                  <td style={TD}><StatusBadge row={row} /></td>
                  <NoteCell note={row.note} onEdit={() => notes.edit(row)} onDelete={() => notes.del(row)} />
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {notes.modal}
    </>
  );
}

// ─── Audit: shared bits (2026-11-20 layout, Hera) ────────────────────────────
// Amount shown in the Audit tables: null → nothing, 0 → "-" (no pill),
// otherwise the amount (in a pill when asked, bold when entered by finance).
export function Amt({ cents, pill, bold }) {
  if (cents === null || cents === undefined) return null;
  if (cents === 0) return <span style={{ color: '#8a8a8a' }}>-</span>;
  const style = { ...(pill ? VAL_PILL : NUM), ...(bold ? ENTERED : null) };
  return <Fit text={fmtMoney(cents)} style={style} />;
}
// "← Diff. →" header between the two columns it compares.
const ARROW_DIFF = '← Diff. →';

// ─── Audit › detail list ────────────────────────────────────────────────────
// Location | Date | Drawer · Ending · Removed | Total Ending | ← Diff. → |
// Counted | Total removed | ← Diff. → | Receipted removed | Status
// The day's note sits on its own line under the row (left), making the row
// taller; without a note, "Add note" sits under the Location pill.
// Total Ending = Expected (Σ drawer Ending − opening float), so the Diff. next
// to it is the same Diff. as in Collect.
// Sum ≈ 890 px so the list fits the normal page width (long headers wrap).
const D_COLS = [76, 84, 184, 80, 64, 84, 80, 64, 84, 92];
const TH_WRAP = { ...TH, whiteSpace: 'normal', lineHeight: '15px' };
const DRAWER_GRID = { display: 'grid', gridTemplateColumns: '48px 1fr 1fr', alignItems: 'center', columnGap: 6 };
const NO_LINE = { borderBottom: 'none' };

function DrawerBox({ drawers, grey }) {
  if (!drawers || drawers.length === 0) return <span style={{ color: '#8a8a8a' }}>-</span>;
  return (
    <div style={{ background: grey ? '#efefef' : '#f1f1f1', borderRadius: 10, padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 4 }}>
      {drawers.map(d => (
        <div key={d.id} style={DRAWER_GRID}>
          <span style={{ justifySelf: 'start', padding: '1px 8px', borderRadius: 999, background: '#e3e3e3', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>{d.name}</span>
          <span style={{ ...NUM, textAlign: 'right' }}><Amt cents={d.ending} /></span>
          <span style={{ ...NUM, textAlign: 'right' }}><Amt cents={d.removed} /></span>
        </div>
      ))}
    </div>
  );
}

export function DetailTable({ rows, currentYear, onSaveNote, emptyText }) {
  const notes = useRowNotes(onSaveNote);
  const cols = D_COLS.length;
  return (
    <>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
          <colgroup>{D_COLS.map((w, i) => <col key={i} style={{ width: w }} />)}</colgroup>
          <thead>
            <tr>
              <th style={TH_WRAP}>Location</th>
              <th style={TH_WRAP}>Date</th>
              <th style={TH_WRAP}>
                <div style={{ ...DRAWER_GRID, padding: '0 8px' }}>
                  <span style={{ justifySelf: 'start' }}>Drawer</span>
                  <span style={{ textAlign: 'right' }}><Head tip="Ending Cash counted at close (opening float included)">Ending</Head></span>
                  <span style={{ textAlign: 'right' }}><Head tip="Cash removed from the drawer during the day">Removed</Head></span>
                </div>
              </th>
              <th style={TH_WRAP}><Head tip="Total of Ending Cash from all drawers, minus the opening float.">Total Ending</Head></th>
              <th style={TH_WRAP}><Head tip="Difference between Total Ending and Counted">{ARROW_DIFF}</Head></th>
              <th style={TH_WRAP}><Head pill>Counted</Head></th>
              <th style={TH_WRAP}><Head tip="Total of Removed Cash from all drawers">Total removed</Head></th>
              <th style={TH_WRAP}><Head tip="Receipted removed − Total removed">{ARROW_DIFF}</Head></th>
              <th style={TH_WRAP}>Receipted removed</th>
              <th style={TH_WRAP}>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={cols} style={{ ...TD, color: SUBDUED, padding: '24px 8px' }}>{emptyText || 'Nothing to show.'}</td></tr>
            )}
            {rows.map(row => {
              const grey = row.noCash;
              const hasNote = !!row.note;
              const td = hasNote ? { ...TD, ...NO_LINE } : TD; // the note line carries the row's bottom line
              return (
                <React.Fragment key={rowKey(row)}>
                  <tr style={grey ? GREY_ROW : undefined}>
                    <td style={td}>
                      <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                        <LocPill name={row.location} />
                        {!hasNote && <button type="button" style={{ ...linkBtn('#8a8a8a'), fontSize: 12 }} onClick={() => notes.edit(row)}>Add note</button>}
                      </div>
                    </td>
                    <DateCellStyled iso={row.date} currentYear={currentYear} style={td} />
                    <td style={td}><DrawerBox drawers={row.drawers} grey={grey} /></td>
                    <td style={{ ...td, ...NUM }}><Amt cents={row.expected} /></td>
                    <td style={{ ...td, ...NUM }}><DiffText cents={row.diff} dim={grey} /></td>
                    <td style={{ ...td, ...NUM }}><Amt cents={row.counted} bold /></td>
                    <td style={{ ...td, ...NUM }}><Amt cents={row.removed} /></td>
                    <td style={{ ...td, ...NUM }}><DiffText cents={row.removedDiff} dim={grey} /></td>
                    <td style={{ ...td, ...NUM }}><Amt cents={row.receipted} bold /></td>
                    <td style={td}><StatusBadge row={row} /></td>
                  </tr>
                  {hasNote && (
                    <tr style={grey ? GREY_ROW : undefined}>
                      <td colSpan={cols} style={{ ...TD, textAlign: 'left', paddingTop: 0, paddingLeft: 12 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                          <button type="button" aria-label="Delete note" title="Delete note" style={{ ...linkBtn(RED), fontSize: 15, lineHeight: '16px', flex: 'none' }} onClick={() => notes.del(row)}>×</button>
                          <span style={{ fontSize: 12, lineHeight: '16px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', minWidth: 0 }}>{row.note}</span>
                          <button type="button" style={{ ...linkBtn('#005bd3'), flex: 'none' }} onClick={() => notes.edit(row)}>Edit</button>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {notes.modal}
    </>
  );
}

function DateCellStyled({ iso, currentYear, style }) {
  const p = dateParts(iso);
  return (
    <td style={{ ...style, whiteSpace: 'nowrap' }}>
      {p.year !== currentYear && <div style={{ fontSize: 11, color: SUBDUED, lineHeight: '14px' }}>{p.year}</div>}
      <span style={{ fontWeight: 600 }}>{p.main}</span>
      <span style={{ fontSize: 12, color: SUBDUED, marginLeft: 6 }}>{p.dow}</span>
    </td>
  );
}

// ─── Audit › deposit card ───────────────────────────────────────────────────
// Deposit | Date | Expected | ← Diff. → | Counted | Removed | ← Diff. → | Receipted | Note
// Deposit / Date are sized to their (fixed-length) values; the amount columns
// sit close together; Note (left-aligned) takes the rest.
// A value wider than its column is cut with "…" + tooltip (Fit), widths stay.
const P_COLS = [116, 148, 84, 64, 84, 72, 64, 80]; // Note: no width → the remaining space
const NOTE_PAD = { paddingRight: 16 };

export function DepositTable({ deposits, onSaveNote, emptyText }) {
  const [editing, setEditing] = useState(null);
  const del = async (d) => {
    if (!window.confirm('Delete this note?')) return;
    try { await onSaveNote(d, ''); } catch (e) { window.alert(e.message); }
  };
  const cols = P_COLS.length + 1;
  return (
    <>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
          <colgroup>{P_COLS.map((w, i) => <col key={i} style={{ width: w }} />)}<col /></colgroup>
          <thead>
            <tr>
              <th style={TH}>Deposit</th>
              <th style={TH}>Date</th>
              <th style={TH}><Head pill tip="Total of Ending Cash in this deposit">Expected</Head></th>
              <th style={TH}><Head tip="Counted − Expected">{ARROW_DIFF}</Head></th>
              <th style={TH}><Head pill tip="Total of Counted cash, which is the amount deposited to bank.">Counted</Head></th>
              <th style={TH}><Head pill tip="Total of Removed Cash">Removed</Head></th>
              <th style={TH}><Head tip="Total of Difference between Removed Cash and Receipted">{ARROW_DIFF}</Head></th>
              <th style={TH}><Head pill tip="Total of Receipted removed entered in Collect">Receipted</Head></th>
              {/* header centred over the column; the note text itself is left-aligned */}
              <th style={TH}>Note</th>
            </tr>
          </thead>
          <tbody>
            {deposits.length === 0 && (
              <tr><td colSpan={cols} style={{ ...TD, color: SUBDUED, padding: '24px 8px' }}>{emptyText || 'No deposits.'}</td></tr>
            )}
            {deposits.map(d => (
              <tr key={d.id}>
                <td style={{ ...TD, fontWeight: 600, whiteSpace: 'nowrap' }}>
                  <Tooltip
                    content={`${d.days} day${d.days === 1 ? '' : 's'}${d.dates && d.dates.length ? `, ${d.dates.map(x => dateParts(x).main).join(' - ')}` : ''}`}
                    preferredPosition="above"
                  ><span style={{ cursor: 'default' }}>{d.title}</span></Tooltip>
                </td>
                <td style={{ ...TD, ...NUM }}>{depositStamp(d.createdAt)}</td>
                <td style={{ ...TD, ...NUM }}><Amt cents={d.expected} pill /></td>
                <td style={{ ...TD, ...NUM }}><DiffText cents={d.counted - d.expected} /></td>
                <td style={{ ...TD, ...NUM }}><Amt cents={d.counted} pill bold /></td>
                <td style={{ ...TD, ...NUM }}><Amt cents={d.removed} pill /></td>
                <td style={{ ...TD, ...NUM }}><DiffText cents={d.removedDiff} /></td>
                <td style={{ ...TD, ...NUM }}>{d.receipted === null ? <span style={{ color: '#8a8a8a' }}>-</span> : <Amt cents={d.receipted} pill />}</td>
                {d.note ? (
                  <td style={{ ...TD, textAlign: 'left', ...NOTE_PAD }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                      <div style={{ minWidth: 0, flex: '0 1 auto' }}>
                        <Tooltip content={<div style={{ whiteSpace: 'pre-wrap', maxWidth: 320 }}>{d.note}</div>} preferredPosition="above">
                          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, lineHeight: '16px', cursor: 'default' }}>{d.note}</div>
                        </Tooltip>
                      </div>
                      <button type="button" aria-label="Delete note" title="Delete note" style={{ ...linkBtn(RED), fontSize: 15, lineHeight: '16px', flex: 'none' }} onClick={() => del(d)}>×</button>
                      <button type="button" style={{ ...linkBtn('#005bd3'), flex: 'none' }} onClick={() => setEditing(d)}>Edit</button>
                    </div>
                  </td>
                ) : (
                  <td style={{ ...TD, textAlign: 'left', ...NOTE_PAD }}>
                    <button type="button" style={linkBtn('#8a8a8a')} onClick={() => setEditing(d)}>Add</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && (
        <NoteModal
          target={{ title: editing.title, note: editing.note }}
          onClose={() => setEditing(null)}
          onSave={(text) => onSaveNote(editing, text)}
        />
      )}
    </>
  );
}
