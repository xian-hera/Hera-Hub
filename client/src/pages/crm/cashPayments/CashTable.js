import React, { useEffect, useState } from 'react';
import { Badge, Tooltip, Modal, TextField, BlockStack, Banner } from '@shopify/polaris';
import { LocPill } from '../../warehouse/whShared';
import { fmtMoney, fmtDiff, parseMoney, dateParts, depositStamp, depositDay, SUBDUED, GREEN, RED } from './cashShared';

// Cash Payments tables (2026-11-19, Hera; drawer-based since 2026-11-20).
//
//   CollectTable  ☐ | Date | Expected | Removed | Diff. | Counted | Receipted removed | Removed diff. | Status | Note
//   DetailTable   Location | Date | Drawer · Ending · Removed (one line per drawer) | Diff. | Counted |
//                 Receipted removed | Removed diff. | Status | Note          (Audit, read-only but notes)
//   DepositTable  Deposit | Date | Expected | Counted | Removed | Removed Diff. | Note   (Audit)
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

function DiffText({ cents, dim }) {
  const t = fmtDiff(cents);
  if (!t) return null;
  return <span style={{ ...NUM, color: dim ? '#8a8a8a' : (cents > 0 ? GREEN : RED) }}>{t}</span>;
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

function AmountInput({ cents, onCommit, label, width = 92 }) {
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

const linkBtn = (color) => ({ border: 'none', background: 'none', padding: 0, cursor: 'pointer', font: 'inherit', fontSize: 13, color });

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
function useRowNotes(onSaveNote) {
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

const Checkbox = ({ checked, disabled, indeterminate, onChange, label }) => (
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
                  <td style={{ ...TD, ...NUM, textAlign: 'right', paddingRight: 3 }}><span style={VAL_PILL}>{fmtMoney(row.expected)}</span></td>
                  <td style={{ ...TD, ...NUM, textAlign: 'left', paddingLeft: 3 }}><span style={VAL_PILL}>{fmtMoney(row.removed)}</span></td>
                  <td style={{ ...TD, ...NUM }}><DiffText cents={row.diff} dim={grey} /></td>
                  <td style={{ ...TD, ...NUM }}>
                    {inputs
                      ? <AmountInput cents={row.counted} label={`Counted ${row.date}`} onCommit={(c) => onSaveAmount(row, 'counted', c)} />
                      : (row.counted === null ? '—' : <span style={ENTERED}>{fmtMoney(row.counted)}</span>)}
                  </td>
                  <td style={{ ...TD, ...NUM }}>
                    {inputs && (row.removed > 0 || row.receipted !== null)
                      ? <AmountInput cents={row.receipted} label={`Receipted removed ${row.date}`} onCommit={(c) => onSaveAmount(row, 'receipted', c)} />
                      : (row.receipted === null ? '' : <span style={ENTERED}>{fmtMoney(row.receipted)}</span>)}
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

// ─── Audit › detail list ────────────────────────────────────────────────────
const D_COLS = [74, 88, 214, 76, 90, 96, 88, 96, 110];
const DRAWER_GRID = { display: 'grid', gridTemplateColumns: '52px 1fr 1fr', alignItems: 'center', columnGap: 6 };

function DrawerBox({ drawers, grey }) {
  if (!drawers || drawers.length === 0) return <span style={{ color: '#8a8a8a' }}>—</span>;
  return (
    <div style={{ background: grey ? '#efefef' : '#f1f1f1', borderRadius: 10, padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 4 }}>
      {drawers.map(d => (
        <div key={d.id} style={DRAWER_GRID}>
          <span style={{ justifySelf: 'start', padding: '1px 8px', borderRadius: 999, background: '#e3e3e3', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>{d.name}</span>
          <span style={{ ...NUM, textAlign: 'right' }}>{d.ending === null ? '—' : fmtMoney(d.ending)}</span>
          <span style={{ ...NUM, textAlign: 'right' }}>{fmtMoney(d.removed)}</span>
        </div>
      ))}
    </div>
  );
}

export function DetailTable({ rows, currentYear, onSaveNote, emptyText }) {
  const notes = useRowNotes(onSaveNote);
  return (
    <>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
          <colgroup>{D_COLS.map((w, i) => <col key={i} style={{ width: w }} />)}</colgroup>
          <thead>
            <tr>
              <th style={TH}>Location</th>
              <th style={TH}>Date</th>
              <th style={TH}>
                <div style={{ ...DRAWER_GRID, padding: '0 8px' }}>
                  <span style={{ justifySelf: 'start' }}>Drawer</span>
                  <span style={{ textAlign: 'right' }}><Head tip="Ending Cash counted at close (opening float included)">Ending</Head></span>
                  <span style={{ textAlign: 'right' }}><Head tip="Cash removed from the drawer during the day">Removed</Head></span>
                </div>
              </th>
              <th style={TH}><Head tip="Difference between Expected and Counted">Diff.</Head></th>
              <th style={TH}><Head pill>Counted</Head></th>
              <th style={TH}>Receipted removed</th>
              <th style={TH}><Head tip="Receipted removed − Removed">Removed diff.</Head></th>
              <th style={TH}>Status</th>
              <th style={TH}>Note</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={D_COLS.length} style={{ ...TD, color: SUBDUED, padding: '24px 8px' }}>{emptyText || 'Nothing to show.'}</td></tr>
            )}
            {rows.map(row => {
              const grey = row.noCash;
              return (
                <tr key={rowKey(row)} style={grey ? GREY_ROW : undefined}>
                  <td style={TD}><LocPill name={row.location} /></td>
                  <DateCell iso={row.date} currentYear={currentYear} />
                  <td style={TD}><DrawerBox drawers={row.drawers} grey={grey} /></td>
                  <td style={{ ...TD, ...NUM }}><DiffText cents={row.diff} dim={grey} /></td>
                  <td style={{ ...TD, ...NUM }}>{row.counted === null ? (grey ? '—' : '') : <span style={ENTERED}>{fmtMoney(row.counted)}</span>}</td>
                  <td style={{ ...TD, ...NUM }}>{row.receipted === null ? '' : <span style={ENTERED}>{fmtMoney(row.receipted)}</span>}</td>
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

// ─── Audit › deposit card ───────────────────────────────────────────────────
const P_COLS = [150, 170, 104, 104, 96, 110, 160];

export function DepositTable({ deposits, onSaveNote, emptyText }) {
  const [editing, setEditing] = useState(null);
  const del = async (d) => {
    if (!window.confirm('Delete this note?')) return;
    try { await onSaveNote(d, ''); } catch (e) { window.alert(e.message); }
  };
  return (
    <>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
          <colgroup>{P_COLS.map((w, i) => <col key={i} style={{ width: w }} />)}</colgroup>
          <thead>
            <tr>
              <th style={TH}>Deposit</th>
              <th style={TH}>Date</th>
              <th style={TH}><Head pill tip="Total of Ending Cash in this deposit">Expected</Head></th>
              <th style={TH}><Head pill tip="Total of Counted cash, which is the amount deposited to bank.">Counted</Head></th>
              <th style={TH}><Head pill tip="Total of Removed Cash">Removed</Head></th>
              <th style={TH}><Head tip="Total of Difference between Removed Cash and Receipted">Removed Diff.</Head></th>
              <th style={TH}>Note</th>
            </tr>
          </thead>
          <tbody>
            {deposits.length === 0 && (
              <tr><td colSpan={P_COLS.length} style={{ ...TD, color: SUBDUED, padding: '24px 8px' }}>{emptyText || 'No deposits.'}</td></tr>
            )}
            {deposits.map(d => (
              <tr key={d.id}>
                <td style={{ ...TD, fontWeight: 600, whiteSpace: 'nowrap' }}>
                  <Tooltip content={`${d.days} day${d.days === 1 ? '' : 's'}`} preferredPosition="above"><span style={{ cursor: 'default' }}>{d.title}</span></Tooltip>
                </td>
                <td style={{ ...TD, ...NUM }}>{depositStamp(d.createdAt)}</td>
                <td style={{ ...TD, ...NUM }}><span style={VAL_PILL}>{fmtMoney(d.expected)}</span></td>
                <td style={{ ...TD, ...NUM }}><span style={{ ...VAL_PILL, ...ENTERED }}>{fmtMoney(d.counted)}</span></td>
                <td style={{ ...TD, ...NUM }}><span style={VAL_PILL}>{fmtMoney(d.removed)}</span></td>
                <td style={{ ...TD, ...NUM }}><DiffText cents={d.removedDiff} /></td>
                <NoteCell note={d.note} onEdit={() => setEditing(d)} onDelete={() => del(d)} />
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
