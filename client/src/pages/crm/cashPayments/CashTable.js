import React, { useEffect, useState } from 'react';
import { Badge, Tooltip, Modal, TextField, BlockStack, Banner } from '@shopify/polaris';
import { LocPill } from '../../warehouse/whShared';
import { fmtMoney, fmtDiff, parseMoney, dateParts, SUBDUED, GREEN, RED } from './cashShared';

// The Cash Payments table (Collect and Audit) — 2026-11-19, Hera.
//   Date | System | Diff | Declared | Diff | Counted | Diff → SYS | Status | Note
//   (+ Location first in Audit)
// Diff after System  = Declared − System
// Diff after Declared = Counted − Declared
// Diff → SYS          = Counted − System
// Green "+x" = more than expected, red "-x" = less; 0 is left empty.
// Collect: Declared / Counted are inputs (saved when leaving the box; Enter
// jumps to the next box). Archived rows and Audit show plain numbers.
// System 0 = no cash that day: grey row, nothing to enter.
// Layout (2026-11-20, Hera): fixed column widths (typing never makes the
// table jump), Note column half as wide with one line + tooltip, System /
// Declared / Counted headers in light pills, System value in a light grey
// pill, entered amounts bold. `center` (Collect): every header / value centred.

const TH = { padding: '10px 8px', fontSize: 12, fontWeight: 450, color: SUBDUED, textAlign: 'left', whiteSpace: 'nowrap', borderBottom: '1px solid #e1e3e5' };
const TD = { padding: '10px 8px', fontSize: 13, color: '#303030', verticalAlign: 'middle', borderBottom: '1px solid #ebebeb' };
const NUM = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const HEAD_PILL = { display: 'inline-block', padding: '2px 10px', borderRadius: 999, background: '#ebebeb', color: '#303030', fontWeight: 500 };
const SYS_PILL = { display: 'inline-block', padding: '2px 8px', borderRadius: 999, background: '#f1f1f1', fontVariantNumeric: 'tabular-nums' };
const ENTERED = { fontWeight: 600 };
// Column widths (px). The table fills the card; spare width is shared out
// proportionally, so the gaps between the amount columns grow with it.
// Sum ≈ 930 px with Location (Audit), so it fits the normal page width.
const COLS = { location: 74, date: 90, system: 92, diff: 72, amount: 108, diffSys: 100, status: 92, note: 120 };

function DiffCell({ cents, dim, align }) {
  const t = fmtDiff(cents);
  if (!t) return <td style={{ ...TD, ...NUM, textAlign: align }} />;
  return <td style={{ ...TD, ...NUM, textAlign: align, color: dim ? '#8a8a8a' : (cents > 0 ? GREEN : RED) }}>{t}</td>;
}

function StatusCell({ row, align }) {
  let badge = null;
  if (row.status === 'archived') badge = <Badge>Archived</Badge>;
  else if (row.status === 'matched') badge = <Badge tone="success">Matched</Badge>;
  else if (row.status === 'mismatch') badge = <Badge tone="critical">Mismatch</Badge>;
  else if (row.status === 'pending') badge = <Badge tone="attention">Pending</Badge>;
  else if (row.status === 'nocash') badge = <span style={{ fontSize: 12, color: '#8a8a8a' }}>No cash</span>;
  return <td style={{ ...TD, whiteSpace: 'nowrap', textAlign: align }}>{badge}</td>;
}

function DateCell({ iso, currentYear, align }) {
  const p = dateParts(iso);
  return (
    <td style={{ ...TD, whiteSpace: 'nowrap', textAlign: align }}>
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

function AmountInput({ cents, onCommit, label, align = 'right' }) {
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
        width: 92, maxWidth: '100%', height: 32, boxSizing: 'border-box', padding: '0 8px', textAlign: align,
        border: `1px solid ${bad ? RED : '#c9cccf'}`, borderRadius: 8, font: 'inherit', fontSize: 13,
        fontVariantNumeric: 'tabular-nums', background: saving ? '#f6f6f7' : '#fff', outline: 'none',
      }}
    />
  );
}

const linkBtn = (color) => ({ border: 'none', background: 'none', padding: 0, cursor: 'pointer', font: 'inherit', fontSize: 13, color });

// One line, cut with "…"; the whole note in a tooltip on hover (2026-11-20:
// was two lines in a column twice as wide).
function NoteCell({ row, onEdit, onDelete, align }) {
  if (!row.note) {
    return (
      <td style={{ ...TD, textAlign: align === 'center' ? 'center' : 'right' }}>
        <button type="button" style={linkBtn('#8a8a8a')} onClick={onEdit}>Add</button>
      </td>
    );
  }
  return (
    <td style={TD}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Tooltip content={<div style={{ whiteSpace: 'pre-wrap', maxWidth: 320 }}>{row.note}</div>} preferredPosition="above">
            <div style={{
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              fontSize: 12, lineHeight: '16px', cursor: 'default',
            }}>{row.note}</div>
          </Tooltip>
        </div>
        <button type="button" aria-label="Delete note" title="Delete note" style={{ ...linkBtn(RED), fontSize: 15, lineHeight: '16px', flex: 'none' }} onClick={onDelete}>×</button>
        <button type="button" style={{ ...linkBtn('#005bd3'), flex: 'none' }} onClick={onEdit}>Edit</button>
      </div>
    </td>
  );
}

function NoteModal({ row, onClose, onSave }) {
  const [text, setText] = useState(row ? row.note : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setText(row ? row.note : ''); setError(''); }, [row]);
  if (!row) return null;
  const p = dateParts(row.date);
  const save = async () => {
    setBusy(true); setError('');
    try { await onSave(row, text); onClose(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={`${row.note ? 'Edit' : 'Add'} note — ${row.location} · ${p.main} ${p.dow}`}
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

// rows: from GET /rows. editable: Collect (amount inputs on non-archived rows).
// onSaveAmount(row, field, cents) → Promise<boolean>; onSaveNote(row, text) → Promise (throws on error).
export default function CashTable({ rows, currentYear, showLocation, editable, center, onSaveAmount, onSaveNote, emptyText }) {
  const [noteRow, setNoteRow] = useState(null);
  const del = async (row) => {
    if (!window.confirm('Delete this note?')) return;
    try { await onSaveNote(row, ''); } catch (e) { window.alert(e.message); }
  };
  // Alignment: everything centred in Collect and Audit (2026-11-20, Hera);
  // `center` is passed by both. Without it: text left, amounts right.
  const txt = center ? 'center' : 'left';
  const amt = center ? 'center' : 'right';
  const noteHead = center ? 'center' : 'right';
  return (
    <>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
          <colgroup>
            {showLocation && <col style={{ width: COLS.location }} />}
            <col style={{ width: COLS.date }} />
            <col style={{ width: COLS.system }} />
            <col style={{ width: COLS.diff }} />
            <col style={{ width: COLS.amount }} />
            <col style={{ width: COLS.diff }} />
            <col style={{ width: COLS.amount }} />
            <col style={{ width: COLS.diffSys }} />
            <col style={{ width: COLS.status }} />
            <col style={{ width: COLS.note }} />
          </colgroup>
          <thead>
            <tr>
              {showLocation && <th style={{ ...TH, textAlign: txt }}>Location</th>}
              <th style={{ ...TH, textAlign: txt }}>Date</th>
              <th style={{ ...TH, textAlign: amt }}><span style={HEAD_PILL}>System</span></th>
              <th style={{ ...TH, textAlign: amt }}>← Diff. →</th>
              <th style={{ ...TH, textAlign: amt }}><span style={HEAD_PILL}>Declared</span></th>
              <th style={{ ...TH, textAlign: amt }}>← Diff. →</th>
              <th style={{ ...TH, textAlign: amt }}><span style={HEAD_PILL}>Counted</span></th>
              <th style={{ ...TH, textAlign: amt }}>← Diff. → SYS</th>
              <th style={{ ...TH, textAlign: txt }}>Status</th>
              <th style={{ ...TH, textAlign: noteHead }}>Note</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={showLocation ? 10 : 9} style={{ ...TD, textAlign: 'center', color: SUBDUED, padding: '24px 8px' }}>{emptyText || 'Nothing to show.'}</td></tr>
            )}
            {rows.map(row => {
              const grey = row.noCash;
              const inputs = editable && !row.archived && !row.noCash;
              const rowStyle = grey ? { background: '#f7f7f7', color: '#8a8a8a' } : undefined;
              // Entered amounts shown as text (Audit, archived rows): bold.
              const plain = (cents) => (grey && cents === null ? '—' : <span style={ENTERED}>{fmtMoney(cents)}</span>);
              return (
                <tr key={`${row.location}|${row.date}`} style={rowStyle}>
                  {showLocation && <td style={{ ...TD, textAlign: txt }}><LocPill name={row.location} /></td>}
                  <DateCell iso={row.date} currentYear={currentYear} align={txt} />
                  <td style={{ ...TD, ...NUM, textAlign: amt, color: grey ? '#8a8a8a' : '#303030' }}><span style={SYS_PILL}>{fmtMoney(row.system)}</span></td>
                  <DiffCell cents={row.diffs.declaredVsSystem} dim={grey} align={amt} />
                  <td style={{ ...TD, ...NUM, textAlign: amt, color: grey ? '#8a8a8a' : undefined }}>
                    {inputs
                      ? <AmountInput cents={row.declared} label={`Declared ${row.location} ${row.date}`} onCommit={(c) => onSaveAmount(row, 'declared', c)} align={amt} />
                      : plain(row.declared)}
                  </td>
                  <DiffCell cents={row.diffs.countedVsDeclared} dim={grey} align={amt} />
                  <td style={{ ...TD, ...NUM, textAlign: amt, color: grey ? '#8a8a8a' : undefined }}>
                    {inputs
                      ? <AmountInput cents={row.counted} label={`Counted ${row.location} ${row.date}`} onCommit={(c) => onSaveAmount(row, 'counted', c)} align={amt} />
                      : plain(row.counted)}
                  </td>
                  <DiffCell cents={row.diffs.countedVsSystem} dim={grey} align={amt} />
                  <StatusCell row={row} align={txt} />
                  <NoteCell row={row} onEdit={() => setNoteRow(row)} onDelete={() => del(row)} align={txt} />
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {noteRow && <NoteModal row={noteRow} onClose={() => setNoteRow(null)} onSave={onSaveNote} />}
    </>
  );
}
