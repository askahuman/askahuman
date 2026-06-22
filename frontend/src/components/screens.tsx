// screens renders the nine PWA states as full-viewport content, mirroring the
// inline styles of frontend/initial-design/ask-a-human.dc.html (the visual
// source of truth). These are presentational: they take a Palette + data +
// callbacks and render. The swipe card owns its own pointer-event drag, exactly
// like the mockup's onDown/onMove/onUp.

import { useRef, useState } from 'react';
import type { CSSProperties } from 'react';

import type { AgentSummary } from '../lib/manager.ts';
import type { Request } from '../lib/wire.ts';
import { type Palette, catColor, countdown } from './theme.ts';

const MONO = "'JetBrains Mono', ui-monospace, monospace";
const SANS = "'IBM Plex Sans', sans-serif";

// Display bounds for untrusted request strings. React escapes text by default
// (no dangerouslySetInnerHTML/innerHTML anywhere), so XSS isn't the risk here;
// these caps stop a hostile/oversized request from breaking layout or hanging
// the render. Keep them as display-only clamps — the wire payload is unchanged.
const MAX_TITLE = 120;
const MAX_SUMMARY = 600;
const MAX_CATEGORY = 24;
const MAX_OPTION = 80;
const MAX_OPTIONS = 12;
const MAX_PLACEHOLDER = 80;

/** clip truncates s to n chars (with an ellipsis) for safe display. */
function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Frame fills the viewport with the screen's bg (no device bezel). */
function Frame({ c, children, style }: { c: Palette; children: React.ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        height: '100dvh',
        width: '100%',
        background: c.bg,
        color: c.text,
        fontFamily: MONO,
        position: 'relative',
        overflow: 'hidden',
        // Yield horizontal to the card's own drag; allow vertical page scroll.
        touchAction: 'pan-y',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// --- lock -------------------------------------------------------------------

export function LockScreen({ c, agent, onOpen }: { c: Palette; agent: string; onOpen: () => void }) {
  return (
    <Frame
      c={c}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: 'calc(100px + env(safe-area-inset-top)) 22px 44px',
        boxSizing: 'border-box',
        background: `radial-gradient(125% 80% at 50% 0%, ${c.surface2} 0%, ${c.bg} 68%)`,
      }}
    >
      <div style={{ fontSize: 13, letterSpacing: 2, color: c.muted, textTransform: 'uppercase' }}>
        New request
      </div>
      <div
        style={{
          fontSize: 80,
          fontWeight: 500,
          letterSpacing: -2,
          marginTop: 2,
          color: c.text,
          fontVariantNumeric: 'tabular-nums',
          lineHeight: 1,
        }}
      >
        9:41
      </div>
      <div style={{ flex: 1 }} />
      <div
        data-testid="lock-banner"
        onClick={onOpen}
        style={{
          width: '100%',
          cursor: 'pointer',
          animation: 'slideDown .5s ease',
          background: c.glass,
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          border: `1px solid ${c.border}`,
          borderRadius: 22,
          padding: '14px 15px',
          display: 'flex',
          gap: 12,
          alignItems: 'flex-start',
          boxShadow: '0 12px 40px rgba(0,0,0,0.4)',
        }}
      >
        <div
          style={{
            width: 38,
            height: 38,
            borderRadius: 10,
            background: '#0b0d10',
            border: `1px solid ${c.border}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <span style={{ fontWeight: 700, fontSize: 19, color: c.approve }}>?</span>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 11, letterSpacing: 1.5, color: c.muted, textTransform: 'uppercase' }}>
              ask-a-human
            </span>
            <span style={{ fontSize: 11, color: c.faint }}>now</span>
          </div>
          <div style={{ fontFamily: SANS, fontWeight: 600, fontSize: 15, marginTop: 4, color: c.text }}>
            New approval request
          </div>
          <div style={{ fontFamily: SANS, fontSize: 13.5, marginTop: 1, color: c.muted }}>
            {agent} · tap to review
          </div>
        </div>
      </div>
      <div style={{ marginTop: 16, fontSize: 11, color: c.faint, letterSpacing: 1 }}>
        end-to-end encrypted · tap to open
      </div>
    </Frame>
  );
}

// --- home -------------------------------------------------------------------

export function HomeScreen({ c, unread, onOpen }: { c: Palette; unread: number; onOpen: () => void }) {
  const glyphs = ['~', '$', '✦', '▤', '◇', '⌘', '◐'];
  return (
    <Frame
      c={c}
      style={{
        padding: 'calc(88px + env(safe-area-inset-top)) 26px 44px',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        background: `radial-gradient(125% 90% at 50% 0%, ${c.surface2} 0%, ${c.bg} 72%)`,
      }}
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '24px 16px' }}>
        <div
          data-testid="home-app-icon"
          onClick={onOpen}
          style={{ cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}
        >
          <div
            style={{
              position: 'relative',
              width: 62,
              height: 62,
              borderRadius: 15,
              background: 'linear-gradient(160deg,#16181f,#0a0b0e)',
              border: `1px solid ${c.border}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 8px 18px rgba(0,0,0,0.4)',
            }}
          >
            <span style={{ fontWeight: 700, fontSize: 30, color: c.approve }}>?</span>
            {unread > 0 && (
              <div
                style={{
                  position: 'absolute',
                  top: -7,
                  right: -7,
                  minWidth: 23,
                  height: 23,
                  padding: '0 5px',
                  boxSizing: 'border-box',
                  borderRadius: 12,
                  background: c.decline,
                  color: '#fff',
                  fontSize: 12,
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  border: `2px solid ${c.bg}`,
                }}
              >
                {unread}
              </div>
            )}
          </div>
          <span style={{ fontFamily: SANS, fontSize: 11, color: c.text }}>ask-a-human</span>
        </div>
        {glyphs.map((glyph, i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
            <div
              style={{
                width: 62,
                height: 62,
                borderRadius: 15,
                background: c.surface2,
                border: `1px solid ${c.borderSoft}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 8px 18px rgba(0,0,0,0.22)',
              }}
            >
              <span style={{ fontSize: 22, color: c.faint }}>{glyph}</span>
            </div>
            <span style={{ height: 11, width: 34, borderRadius: 3, background: c.borderSoft }} />
          </div>
        ))}
      </div>
      <div style={{ flex: 1 }} />
      <div style={{ textAlign: 'center', fontSize: 11, color: c.faint, letterSpacing: 0.5, lineHeight: 1.6 }}>
        added to Home Screen · opens full-screen,
        <br />
        no browser bar, push enabled
      </div>
    </Frame>
  );
}

// --- listening --------------------------------------------------------------

export function ListeningScreen({
  c,
  agent,
  roomID,
}: {
  c: Palette;
  agent: string;
  roomID: string;
}) {
  return (
    <Frame c={c} style={{ padding: 'calc(66px + env(safe-area-inset-top)) 26px 40px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 11, letterSpacing: 2, color: c.muted, textTransform: 'uppercase' }}>ask-a-human</div>
        <div
          data-testid="listening-badge"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            padding: '5px 11px',
            borderRadius: 999,
            background: c.approveDim,
          }}
        >
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: c.approve }} />
          <span style={{ fontSize: 11, color: c.approve, letterSpacing: 0.5 }}>connected</span>
        </div>
      </div>
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 20,
        }}
      >
        <div style={{ position: 'relative', width: 78, height: 78, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: c.approve, animation: 'pulse 2.6s ease-out infinite' }} />
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 17,
              background: c.surface,
              border: `1px solid ${c.border}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <span style={{ fontWeight: 700, fontSize: 25, color: c.approve }}>?</span>
          </div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 15, color: c.text }}>
            Listening for requests
            <span style={{ animation: 'blink 1.1s steps(1) infinite' }}>▌</span>
          </div>
          <div style={{ fontFamily: SANS, fontSize: 13.5, color: c.muted, marginTop: 10, lineHeight: 1.55, maxWidth: 240 }}>
            Approvals from your agents land here and wake your phone. Nothing is stored.
          </div>
        </div>
      </div>
      <div
        style={{
          borderTop: `1px solid ${c.borderSoft}`,
          paddingTop: 14,
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: 11,
          color: c.faint,
        }}
      >
        <span>paired · {agent}</span>
        <span>room {roomID.slice(0, 4) || '----'}</span>
      </div>
    </Frame>
  );
}

// --- request card (yesno / choice / text) -----------------------------------

function CardHeader({ c, req, expiresIn }: { c: Palette; req: Request; expiresIn: number | null }) {
  const cat = (req.category as string) || 'other';
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 9, height: 9, borderRadius: '50%', background: catColor(cat) }} />
        <span style={{ fontSize: 11, letterSpacing: 1.5, color: c.muted, textTransform: 'uppercase' }}>
          {clip(cat, MAX_CATEGORY)}
        </span>
      </div>
      {expiresIn !== null && <span style={{ fontSize: 11, color: c.faint }}>expires {countdown(expiresIn)}</span>}
    </div>
  );
}

function CardBody({ c, req }: { c: Palette; req: Request }) {
  return (
    <>
      <div style={{ fontWeight: 700, fontSize: 26, lineHeight: 1.15, marginTop: 20, color: c.text }}>
        {clip(req.title, MAX_TITLE)}
      </div>
      <div style={{ fontFamily: SANS, fontSize: 17, lineHeight: 1.5, marginTop: 12, color: c.text, textWrap: 'pretty' }}>
        {clip(req.summary, MAX_SUMMARY)}
      </div>
    </>
  );
}

function CardFooter({ c, req, marginTop }: { c: Palette; req: Request; marginTop?: number }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        fontSize: 11,
        color: c.faint,
        borderTop: `1px solid ${c.borderSoft}`,
        paddingTop: 14,
        marginTop,
      }}
    >
      <span>from {req.agent || 'your agent'}</span>
      <span>{req.id}</span>
    </div>
  );
}

const COMMIT_PX = 110;

/**
 * swipeOutcome decides what a horizontal drag commits to. Pure so the commit
 * math is unit-testable without a DOM env (vitest here has no jsdom). Same rule
 * for pointerup and pointercancel: |dx| past commitPx wins, else reset — a real
 * past-threshold drag still commits even when iOS cancels the gesture at release.
 */
export function swipeOutcome(dx: number, commitPx: number): 'approve' | 'decline' | 'reset' {
  if (dx > commitPx) return 'approve';
  if (dx < -commitPx) return 'decline';
  return 'reset';
}

export function YesNoScreen({
  c,
  req,
  expiresIn,
  onApprove,
  onDecline,
}: {
  c: Palette;
  req: Request;
  expiresIn: number | null;
  onApprove: () => void;
  onDecline: () => void;
}) {
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const startX = useRef(0);
  const committed = useRef(false);

  const onDown = (e: React.PointerEvent) => {
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    startX.current = e.clientX;
    setDragging(true);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!dragging) return;
    // Stop iOS from reclaiming the drag as scroll/edge-pan. Cancelable on a
    // touch-action:none element; guard in case an ancestor re-enables touch.
    if (e.cancelable) e.preventDefault();
    setDx(e.clientX - startX.current);
  };
  const commit = (approve: boolean) => {
    if (committed.current) return;
    committed.current = true;
    setDragging(false);
    setDx(approve ? 560 : -560);
    setTimeout(() => (approve ? onApprove() : onDecline()), 330);
  };
  // settle handles both pointerup and pointercancel: iOS fires pointercancel
  // mid/at-release when it hijacks the gesture, so a past-threshold swipe must
  // still commit. commit() is idempotent (committed.current) -> no double-fire.
  const settle = () => {
    if (!dragging) return;
    setDragging(false);
    switch (swipeOutcome(dx, COMMIT_PX)) {
      case 'approve':
        commit(true);
        break;
      case 'decline':
        commit(false);
        break;
      default:
        setDx(0);
    }
  };

  const approveOpacity = Math.max(0, Math.min(1, dx / COMMIT_PX));
  const declineOpacity = Math.max(0, Math.min(1, -dx / COMMIT_PX));

  return (
    <Frame c={c} style={{ padding: 'calc(60px + env(safe-area-inset-top)) 20px 28px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div
          data-testid="yesno-card"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={settle}
          onPointerCancel={settle}
          style={{
            flex: 1,
            touchAction: 'none',
            cursor: 'grab',
            userSelect: 'none',
            WebkitUserSelect: 'none',
            WebkitTouchCallout: 'none',
            transform: `translateX(${dx}px) rotate(${dx * 0.04}deg)`,
            transition: dragging ? 'none' : 'transform .38s cubic-bezier(.2,.85,.25,1)',
            background: c.surface,
            border: `1px solid ${c.border}`,
            borderRadius: 24,
            padding: '24px 22px',
            display: 'flex',
            flexDirection: 'column',
            boxShadow: '0 18px 50px rgba(0,0,0,0.4)',
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              position: 'absolute',
              top: 22,
              right: 20,
              opacity: approveOpacity,
              border: `3px solid ${c.approve}`,
              color: c.approve,
              borderRadius: 10,
              padding: '5px 12px',
              transform: 'rotate(12deg)',
              fontWeight: 700,
              fontSize: 18,
              letterSpacing: 1,
              pointerEvents: 'none',
            }}
          >
            APPROVE
          </div>
          <div
            style={{
              position: 'absolute',
              top: 22,
              left: 20,
              opacity: declineOpacity,
              border: `3px solid ${c.decline}`,
              color: c.decline,
              borderRadius: 10,
              padding: '5px 12px',
              transform: 'rotate(-12deg)',
              fontWeight: 700,
              fontSize: 18,
              letterSpacing: 1,
              pointerEvents: 'none',
            }}
          >
            DECLINE
          </div>
          <CardHeader c={c} req={req} expiresIn={expiresIn} />
          <CardBody c={c} req={req} />
          <div style={{ flex: 1 }} />
          <CardFooter c={c} req={req} />
        </div>
        <div style={{ textAlign: 'center', fontSize: 11, color: c.faint, margin: '14px 0 12px', letterSpacing: 0.5 }}>
          ← swipe to decline · swipe to approve →
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <button
            data-testid="decline-button"
            onClick={() => commit(false)}
            style={{
              flex: 1,
              height: 54,
              borderRadius: 16,
              background: c.declineDim,
              border: `1px solid ${c.decline}`,
              color: c.decline,
              fontFamily: MONO,
              fontWeight: 700,
              fontSize: 15,
              cursor: 'pointer',
            }}
          >
            DECLINE
          </button>
          <button
            data-testid="approve-button"
            onClick={() => commit(true)}
            style={{
              flex: 1,
              height: 54,
              borderRadius: 16,
              background: c.approve,
              border: 'none',
              color: '#04140c',
              fontFamily: MONO,
              fontWeight: 700,
              fontSize: 15,
              cursor: 'pointer',
            }}
          >
            APPROVE
          </button>
        </div>
      </div>
    </Frame>
  );
}

export function ChoiceScreen({
  c,
  req,
  expiresIn,
  onChoose,
}: {
  c: Palette;
  req: Request;
  expiresIn: number | null;
  onChoose: (label: string) => void;
}) {
  // Cap the option count so a hostile request can't render thousands of buttons.
  const options = (req.response.options ?? []).slice(0, MAX_OPTIONS);
  return (
    <Frame c={c} style={{ padding: 'calc(60px + env(safe-area-inset-top)) 20px 28px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div
          style={{
            background: c.surface,
            border: `1px solid ${c.border}`,
            borderRadius: 24,
            padding: '24px 22px',
            boxShadow: '0 18px 50px rgba(0,0,0,0.4)',
          }}
        >
          <CardHeader c={c} req={req} expiresIn={expiresIn} />
          <CardBody c={c} req={req} />
          <CardFooter c={c} req={req} marginTop={20} />
        </div>
        <div style={{ marginTop: 18, fontSize: 11, color: c.faint, textAlign: 'center', letterSpacing: 0.5 }}>tap an answer</div>
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {options.map((label, i) => (
            <button
              key={i}
              data-testid="choice-option"
              onClick={() => onChoose(label)}
              style={{
                height: 54,
                borderRadius: 16,
                background: c.surface,
                border: `1px solid ${c.border}`,
                color: c.text,
                fontFamily: MONO,
                fontWeight: 500,
                fontSize: 15,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '0 18px',
              }}
            >
              <span>{clip(label, MAX_OPTION)}</span>
              <span style={{ color: c.faint }}>→</span>
            </button>
          ))}
        </div>
      </div>
    </Frame>
  );
}

export function TextScreen({
  c,
  req,
  expiresIn,
  onSend,
}: {
  c: Palette;
  req: Request;
  expiresIn: number | null;
  onSend: (text: string) => void;
}) {
  const maxLen = req.response.max_len ?? 200;
  const [value, setValue] = useState('');
  const send = () => {
    if (value.trim()) onSend(value);
  };
  return (
    <Frame c={c} style={{ padding: 'calc(60px + env(safe-area-inset-top)) 20px 28px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div
          style={{
            background: c.surface,
            border: `1px solid ${c.border}`,
            borderRadius: 24,
            padding: '24px 22px',
            boxShadow: '0 18px 50px rgba(0,0,0,0.4)',
          }}
        >
          <CardHeader c={c} req={req} expiresIn={expiresIn} />
          <CardBody c={c} req={req} />
          <CardFooter c={c} req={req} marginTop={20} />
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ fontSize: 11, color: c.faint, marginBottom: 9 }}>your reply · sealed before it leaves the phone</div>
        <div
          style={{
            background: c.surface,
            border: `1px solid ${c.border}`,
            borderRadius: 16,
            padding: '4px 6px 4px 14px',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <input
            data-testid="text-input"
            value={value}
            onChange={(e) => setValue(e.target.value.slice(0, maxLen))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') send();
            }}
            placeholder={clip(req.response.placeholder ?? '', MAX_PLACEHOLDER)}
            maxLength={maxLen}
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: c.text,
              fontFamily: MONO,
              fontSize: 15,
              padding: '12px 0',
              minWidth: 0,
            }}
          />
          <button
            data-testid="text-send"
            onClick={send}
            style={{
              width: 46,
              height: 46,
              borderRadius: 12,
              background: c.approve,
              border: 'none',
              color: '#04140c',
              fontSize: 21,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            ↑
          </button>
        </div>
        <div style={{ textAlign: 'right', fontSize: 11, color: c.faint, marginTop: 7 }}>
          {value.length}/{maxLen}
        </div>
      </div>
    </Frame>
  );
}

// --- confirmed --------------------------------------------------------------

export function ConfirmedScreen({
  c,
  icon,
  label,
  approved,
  detail,
  agent,
}: {
  c: Palette;
  icon: string;
  label: string;
  approved: boolean;
  detail: string;
  agent: string;
}) {
  const color = approved ? c.approve : c.decline;
  return (
    <Frame
      c={c}
      style={{
        padding: 'calc(60px + env(safe-area-inset-top)) 26px 40px',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
      }}
    >
      <div
        data-testid="confirmed-screen"
        style={{
          width: 96,
          height: 96,
          borderRadius: '50%',
          border: `2px solid ${color}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <span style={{ fontSize: 46, color, lineHeight: 1 }}>{icon}</span>
      </div>
      <div style={{ fontWeight: 700, fontSize: 24, marginTop: 24, color }}>{label}</div>
      <div style={{ fontFamily: SANS, fontSize: 15, marginTop: 11, color: c.muted, maxWidth: 260, lineHeight: 1.55 }}>
        {detail}
      </div>
      <div
        style={{
          marginTop: 22,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '7px 13px',
          borderRadius: 999,
          background: c.surface,
          border: `1px solid ${c.border}`,
        }}
      >
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: 1,
            color: c.approve,
            border: `1px solid ${c.approve}`,
            borderRadius: 5,
            padding: '2px 5px',
          }}
        >
          E2E
        </span>
        <span style={{ fontSize: 11, color: c.muted }}>sealed &amp; sent to {agent}</span>
      </div>
      <div style={{ position: 'absolute', bottom: 48, left: 0, right: 0, fontSize: 11, color: c.faint }}>
        returning to listening
        <span style={{ animation: 'blink 1.1s steps(1) infinite' }}>…</span>
      </div>
    </Frame>
  );
}

// --- offline ----------------------------------------------------------------

export function OfflineScreen({ c, attempt, onRetry }: { c: Palette; attempt: number; onRetry: () => void }) {
  return (
    <Frame c={c} style={{ padding: 'calc(66px + env(safe-area-inset-top)) 26px 40px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column' }}>
      <div
        data-testid="offline-badge"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '5px 11px',
          borderRadius: 999,
          background: c.declineDim,
          alignSelf: 'flex-start',
        }}
      >
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: c.decline }} />
        <span style={{ fontSize: 11, color: c.decline }}>disconnected</span>
      </div>
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          gap: 20,
        }}
      >
        <div
          style={{
            width: 54,
            height: 54,
            border: `2px solid ${c.border}`,
            borderTopColor: c.decline,
            borderRadius: '50%',
            animation: 'spin 1s linear infinite',
          }}
        />
        <div>
          <div style={{ fontSize: 16, color: c.text }}>Reconnecting…</div>
          <div style={{ fontFamily: SANS, fontSize: 13.5, color: c.muted, marginTop: 9, lineHeight: 1.55, maxWidth: 250 }}>
            The relay or your agent is offline. Retrying — attempt {attempt}.
          </div>
        </div>
      </div>
      <div
        style={{
          background: c.surface,
          border: `1px solid ${c.border}`,
          borderRadius: 16,
          padding: '14px 16px',
          display: 'flex',
          gap: 11,
          alignItems: 'flex-start',
        }}
      >
        <span style={{ color: c.approve, fontSize: 13, marginTop: 1 }}>✓</span>
        <span style={{ fontFamily: SANS, fontSize: 13, color: c.muted, lineHeight: 1.55 }}>
          No answer is sent while you're offline. Your agent keeps waiting — nothing is auto-approved.
        </span>
      </div>
      <button
        data-testid="retry-button"
        onClick={onRetry}
        style={{
          marginTop: 12,
          height: 52,
          borderRadius: 16,
          background: 'transparent',
          border: `1px solid ${c.border}`,
          color: c.text,
          fontFamily: MONO,
          fontWeight: 500,
          fontSize: 14,
          cursor: 'pointer',
        }}
      >
        Retry now
      </button>
    </Frame>
  );
}

// --- roster (multi-agent switcher strip) ------------------------------------

/** dotColor maps a roster chip's state to its status-dot color.
 *  Exported for the pure unit test (mirrors swipeOutcome). */
export function dotColor(c: Palette, status: AgentSummary['status']): string {
  if (status === 'paired') return c.approve;
  if (status === 'offline') return c.decline;
  return '#f5a524'; // connecting | waiting -> amber (matches deploy cat)
}

/**
 * Roster is the compact agent switcher above the active screen. One chip per
 * agent: status dot + label + unread badge; tap => onSelect(id). A trailing "+"
 * chip => onAdd opens the add-agent (PairScreen) flow. With a single agent the
 * strip stays minimal; the nine-screen flow below is unchanged (ADR 0003).
 */
export function Roster({
  c,
  agents,
  onSelect,
  onAdd,
  onRemove,
}: {
  c: Palette;
  agents: AgentSummary[];
  onSelect: (id: string) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
}) {
  return (
    <div
      data-testid="roster"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 10,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        // Safe-area inset so the strip clears the iOS status bar/notch in the
        // standalone PWA (viewport-fit=cover + black-translucent status bar).
        padding: 'calc(8px + env(safe-area-inset-top)) 12px 8px',
        overflowX: 'auto',
        background: c.glass,
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        borderBottom: `1px solid ${c.borderSoft}`,
        // Roster scrolls horizontally; let it own the horizontal gesture here.
        touchAction: 'pan-x',
        fontFamily: MONO,
      }}
    >
      {agents.map((a) => (
        // Pill wrapper holds the select button + an overlaid × so neither button
        // nests inside the other (nested <button> is invalid HTML).
        <div key={a.id} style={{ position: 'relative', flexShrink: 0, display: 'flex' }}>
          <button
            data-testid={`roster-chip-${a.id}`}
            onClick={() => onSelect(a.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              padding: '5px 28px 5px 11px', // right room reserved for the × button
              borderRadius: 999,
              cursor: 'pointer',
              fontFamily: MONO,
              fontSize: 12,
              color: a.active ? c.text : c.muted,
              background: a.active ? c.surface2 : 'transparent',
              border: `1px solid ${a.active ? c.border : 'transparent'}`,
            }}
          >
            {a.hasRequest && (
              <span
                data-testid={`roster-request-${a.id}`}
                aria-label="has a pending request"
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  flexShrink: 0,
                  background: c.decline,
                  color: c.decline,
                  animation: 'requestPulse 1.4s ease-in-out infinite',
                }}
              />
            )}
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: dotColor(c, a.status) }} />
            <span style={{ whiteSpace: 'nowrap' }}>{a.label}</span>
            {a.unread > 0 && (
              <span
                data-testid={`roster-unread-${a.id}`}
                style={{
                  minWidth: 16,
                  height: 16,
                  padding: '0 4px',
                  borderRadius: 999,
                  background: c.decline,
                  color: '#fff',
                  fontSize: 10,
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {a.unread}
              </span>
            )}
          </button>
          <button
            data-testid={`roster-remove-${a.id}`}
            aria-label={`Close ${a.label}`}
            onClick={(e) => {
              e.stopPropagation();
              onRemove(a.id);
            }}
            style={{
              position: 'absolute',
              right: 5,
              top: '50%',
              transform: 'translateY(-50%)',
              width: 17,
              height: 17,
              borderRadius: 999,
              cursor: 'pointer',
              background: 'transparent',
              border: 'none',
              color: c.faint,
              fontFamily: MONO,
              fontSize: 14,
              lineHeight: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            ×
          </button>
        </div>
      ))}
      <button
        data-testid="roster-add"
        onClick={onAdd}
        aria-label="Add agent"
        style={{
          flexShrink: 0,
          width: 28,
          height: 28,
          borderRadius: 999,
          cursor: 'pointer',
          background: 'transparent',
          border: `1px solid ${c.border}`,
          color: c.muted,
          fontFamily: MONO,
          fontSize: 16,
          lineHeight: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        +
      </button>
    </div>
  );
}
