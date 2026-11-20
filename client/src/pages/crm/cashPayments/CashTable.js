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

const TH = { padding: '10px 8px', fontSize: 12, fontWeight: 450, color: SUBDUED, textAlign: 'left', whiteSpace: 'nowrap', borderBottom: '1px solid #e1e3e5' };
const TD = { padding: '10px 8px', fontSize: 13, color: '#303030', verticalAlign: 'middle', borderBottom: '1px solid #ebebeb' };
const NUM = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };

function DiffCell({ cents, dim }) {
  const t = fmtDiff(cents);
  if (!t) return <td style={{ ...TD, ...NUM }} />;
  return <td style={{ ...TD, ...NUM, color: dim ? '#8a8a8a' : (cents > 0 ? GREEN : RED) }}>{t}</td>;
}

function StatusCell({ row }) {
  let badge = null;
  if (row.status === 'archived') badge = <Badge>Archived</Badge>;
  else if (row.status === 'matched') badge = <Badge tone="success">Matched</Badge>;
  else if (row.status === 'mismatch') badge = <Badge tone="critical">Mismatch</Badge>;
  else if (row.status === 'pending') badge = <Badge tone="attention">Pending</Badge>;
  else if (row.status === 'nocash') badge = <span style={{ fontSize: 12, color: '#8a8a8a' }}>No cash</span>;
  return <td style={{ ...TD, whiteSpace: 'nowrap' }}>{badge}</td>;
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

function AmountInput({ cents, onCommit, label }) {
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
        width: 104, height: 32, boxSizing: 'border-box', padding: '0 8px', textAlign: 'right',
        border: `1px solid ${bad ? RED : '#c9cccf'}`, borderRadius: 8, font: 'inherit', fontSize: 13,
        fontVariantNumeric: 'tabular-nums', background: saving ? '#f6f6f7' : '#fff', outline: 'none',
      }}
    />
  );
}

const linkBtn = (color) => ({ border: 'none', background: 'none', padding: 0, cursor: 'pointer', font: 'inherit', fontSize: 13, color });

function NoteCell({ row, onEdit, onDelete }) {
  if (!row.note) {
    return (
      <td style={{ ...TD, textAlign: 'right' }}>
        <button type="button" style={linkBtn('#8a8a8a')} onClick={onEdit}>Add</button>
      </td>
    );
  }
  return (
    <td style={{ ...TD, width: 260, maxWidth: 260 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Tooltip content={<div style={{ whiteSpace: 'pre-wrap', maxWidth: 320 }}>{row.note}</div>} preferredPosition="above">
            <div style={{
              display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
              fontSize: 12, lineHeight: '16px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', cursor: 'default',
            }}>{row.note}</div>
          </Tooltip>
        </div>
        <button type="button" aria-label="Delete note" title="Delete note" style={{ ...linkBtn(RED), fontSize: 15, lineHeight: '16px' }} onClick={onDelete}>×</button>
        <button type="button" style={linkBtn('#005bd3')} onClick={onEdit}>Edit</button>
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
export default function CashTable({ rows, currentYear, showLocation, editable, onSaveAmount, onSaveNote, emptyText }) {
  const [noteRow, setNoteRow] = useState(null);
  const del = async (row) => {
    if (!window.confirm('Delete this note?')) return;
    try { await onSaveNote(row, ''); } catch (e) { window.alert(e.message); }
  };
  return (
    <>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {showLocation && <th style={TH}>Location</th>}
              <th style={TH}>Date</th>
              <th style={{ ...TH, textAlign: 'right' }}>System</th>
              <th style={{ ...TH, textAlign: 'right' }}>← Diff. →</th>
              <th style={{ ...TH, textAlign: 'right' }}>Declared</th>
              <th style={{ ...TH, textAlign: 'right' }}>← Diff. →</th>
              <th style={{ ...TH, textAlign: 'right' }}>Counted</th>
              <th style={{ ...TH, textAlign: 'right' }}>← Diff. → SYS</th>
              <th style={TH}>Status</th>
              <th style={{ ...TH, textAlign: 'right' }}>Note</th>
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
              const plain = (cents) => (grey && cents === null ? '—' : fmtMoney(cents));
              return (
                <tr key={`${row.location}|${row.date}`} style={rowStyle}>
                  {showLocation && <td style={TD}><LocPill name={row.location} /></td>}
                  <DateCell iso={row.date} currentYear={currentYear} />
                  <td style={{ ...TD, ...NUM, color: grey ? '#8a8a8a' : SUBDUED }}>{fmtMoney(row.system)}</td>
                  <DiffCell cents={row.diffs.declaredVsSystem} dim={grey} />
                  <td style={{ ...TD, ...NUM, color: grey ? '#8a8a8a' : undefined }}>
                    {inputs
                      ? <AmountInput cents={row.declared} label={`Declared ${row.location} ${row.date}`} onCommit={(c) => onSaveAmount(row, 'declared', c)} />
                      : plain(row.declared)}
                  </td>
                  <DiffCell cents={row.diffs.countedVsDeclared} dim={grey} />
                  <td style={{ ...TD, ...NUM, color: grey ? '#8a8a8a' : undefined }}>
                    {inputs
                      ? <AmountInput cents={row.counted} label={`Counted ${row.location} ${row.date}`} onCommit={(c) => onSaveAmount(row, 'counted', c)} />
                      : plain(row.counted)}
                  </td>
                  <DiffCell cents={row.diffs.countedVsSystem} dim={grey} />
                  <StatusCell row={row} />
                  <NoteCell row={row} onEdit={() => setNoteRow(row)} onDelete={() => del(row)} />
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
