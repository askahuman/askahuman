// PairScreen renders the two-tab pairing UI (Scan a code / Show my code),
// mirroring the mockup's isScan/isShow blocks.
//   - Scan: live camera via @zxing/browser; on a decoded QR -> onPaired(payload).
//           Graceful fallback text if no camera / permission denied.
//   - Show: a generated QR (qrcode lib) of a self-generated deep link + the
//           short code + a live "waiting for agent…/paired ✓" badge.
//
// The phone normally arrives via a scanned deep link (#p=), which the App
// auto-starts; this screen is the manual path.

import { useEffect, useRef, useState } from 'react';

import { type PairPayload, buildDeepLink, parseScanned } from '../lib/payload.ts';
import type { Palette } from './theme.ts';

const MONO = "'JetBrains Mono', ui-monospace, monospace";
const SANS = "'IBM Plex Sans', sans-serif";

type Tab = 'scan' | 'show';

export interface PairScreenProps {
  c: Palette;
  /** onPaired fires when a scan decodes a valid payload (phone scanning agent). */
  onScanned: (payload: PairPayload) => void;
  /** showPayload + showLink drive the "Show my code" tab; null hides it. */
  showPayload: PairPayload | null;
  /** paired flips the live badge to "paired ✓". */
  paired: boolean;
  /** webOrigin builds the deep link shown in the QR. */
  webOrigin: string;
}

export function PairScreen({ c, onScanned, showPayload, paired, webOrigin }: PairScreenProps) {
  const [tab, setTab] = useState<Tab>('scan');
  return (
    <div
      style={{
        height: '100dvh',
        width: '100%',
        background: c.bg,
        color: c.text,
        fontFamily: MONO,
        padding: '66px 22px 36px',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <div>
        <div style={{ fontSize: 11, letterSpacing: 2, color: c.muted, textTransform: 'uppercase' }}>ask-a-human</div>
        <div style={{ fontSize: 25, fontWeight: 700, marginTop: 7, color: c.text }}>Pair a device</div>
      </div>
      <div
        style={{
          marginTop: 20,
          display: 'flex',
          gap: 4,
          background: c.surface,
          border: `1px solid ${c.border}`,
          borderRadius: 12,
          padding: 4,
        }}
      >
        <TabButton c={c} active={tab === 'scan'} label="Scan a code" onClick={() => setTab('scan')} testid="tab-scan" />
        <TabButton c={c} active={tab === 'show'} label="Show my code" onClick={() => setTab('show')} testid="tab-show" />
      </div>

      {tab === 'scan' ? (
        <ScanTab c={c} onScanned={onScanned} />
      ) : (
        <ShowTab c={c} payload={showPayload} paired={paired} webOrigin={webOrigin} />
      )}
    </div>
  );
}

function TabButton({
  c,
  active,
  label,
  onClick,
  testid,
}: {
  c: Palette;
  active: boolean;
  label: string;
  onClick: () => void;
  testid: string;
}) {
  return (
    <button
      data-testid={testid}
      onClick={onClick}
      style={{
        flex: 1,
        height: 38,
        border: 'none',
        borderRadius: 8,
        cursor: 'pointer',
        fontFamily: MONO,
        fontSize: 12.5,
        background: active ? c.text : 'transparent',
        color: active ? c.page : c.muted,
      }}
    >
      {label}
    </button>
  );
}

// --- Scan tab: camera via @zxing/browser ------------------------------------

function ScanTab({ c, onScanned }: { c: Palette; onScanned: (p: PairPayload) => void }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(false);
  const controlsRef = useRef<{ stop: () => void } | null>(null);
  const doneRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    doneRef.current = false;

    (async () => {
      try {
        // Dynamic import keeps zxing out of the initial bundle; only the scan
        // tab pulls it in. No camera => graceful fallback message.
        const { BrowserQRCodeReader } = await import('@zxing/browser');
        const reader = new BrowserQRCodeReader();
        const video = videoRef.current;
        if (!video || cancelled) return;
        const controls = await reader.decodeFromVideoDevice(undefined, video, (result) => {
          if (doneRef.current || !result) return;
          const payload = parseScanned(result.getText());
          if (!payload) return; // not our QR; keep scanning
          doneRef.current = true;
          controls.stop();
          onScanned(payload);
        });
        controlsRef.current = controls;
        if (!cancelled) setActive(true);
      } catch (e) {
        if (!cancelled) setError(cameraError(e));
      }
    })();

    return () => {
      cancelled = true;
      try {
        controlsRef.current?.stop();
      } catch {
        /* ignore */
      }
    };
  }, [onScanned]);

  return (
    <div style={{ marginTop: 22, flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div
        data-testid="scan-viewport"
        style={{
          position: 'relative',
          width: '100%',
          aspectRatio: '1 / 1',
          borderRadius: 20,
          overflow: 'hidden',
          background: 'radial-gradient(circle at 50% 38%, #1b1e26, #07080a)',
          border: `1px solid ${c.border}`,
        }}
      >
        <video
          ref={videoRef}
          muted
          playsInline
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: active ? 1 : 0 }}
        />
        {/* corner brackets */}
        <Corner c={c} pos="tl" />
        <Corner c={c} pos="tr" />
        <Corner c={c} pos="bl" />
        <Corner c={c} pos="br" />
        {active && (
          <div
            style={{
              position: 'absolute',
              left: '18%',
              right: '18%',
              height: 2,
              background: c.approve,
              boxShadow: `0 0 14px ${c.approve}`,
              animation: 'scan 2.4s ease-in-out infinite',
              top: '22%',
            }}
          />
        )}
        {!active && (
          <div
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%,-50%)',
              fontSize: 11,
              color: 'rgba(255,255,255,0.4)',
              textAlign: 'center',
              width: '70%',
              lineHeight: 1.5,
            }}
          >
            {error ? (
              <span data-testid="scan-fallback">{error}</span>
            ) : (
              <>
                point at the QR
                <br />
                shown by your agent
              </>
            )}
          </div>
        )}
      </div>
      <div style={{ marginTop: 18, fontFamily: SANS, fontSize: 13.5, color: c.muted, textAlign: 'center', lineHeight: 1.55 }}>
        Or open your phone's <b style={{ color: c.text }}>Camera</b> app and point it at your agent's screen — the link opens
        ask-a-human automatically.
      </div>
      {error && (
        <div style={{ marginTop: 12, fontFamily: SANS, fontSize: 12.5, color: c.faint, textAlign: 'center', lineHeight: 1.5 }}>
          No camera here? Switch to <b style={{ color: c.text }}>Show my code</b> on this device and scan it from the agent,
          or open the agent's link directly.
        </div>
      )}
    </div>
  );
}

function Corner({ c, pos }: { c: Palette; pos: 'tl' | 'tr' | 'bl' | 'br' }) {
  const base = { position: 'absolute' as const, width: 28, height: 28 };
  const map = {
    tl: { top: '18%', left: '18%', borderTop: `3px solid ${c.approve}`, borderLeft: `3px solid ${c.approve}`, borderRadius: '9px 0 0 0' },
    tr: { top: '18%', right: '18%', borderTop: `3px solid ${c.approve}`, borderRight: `3px solid ${c.approve}`, borderRadius: '0 9px 0 0' },
    bl: { bottom: '18%', left: '18%', borderBottom: `3px solid ${c.approve}`, borderLeft: `3px solid ${c.approve}`, borderRadius: '0 0 0 9px' },
    br: { bottom: '18%', right: '18%', borderBottom: `3px solid ${c.approve}`, borderRight: `3px solid ${c.approve}`, borderRadius: '0 0 9px 0' },
  };
  return <div style={{ ...base, ...map[pos] }} />;
}

function cameraError(e: unknown): string {
  const name = (e as { name?: string })?.name;
  if (name === 'NotAllowedError') return 'Camera permission denied. Use “Show my code” instead.';
  if (name === 'NotFoundError') return 'No camera found. Use “Show my code” instead.';
  return 'Camera unavailable. Use “Show my code” instead.';
}

// --- Show tab: generated QR of a deep link + short code ----------------------

function ShowTab({
  c,
  payload,
  paired,
  webOrigin,
}: {
  c: Palette;
  payload: PairPayload | null;
  paired: boolean;
  webOrigin: string;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const link = payload ? buildDeepLink(webOrigin, payload) : '';

  useEffect(() => {
    let cancelled = false;
    if (!link) {
      setDataUrl(null);
      return;
    }
    (async () => {
      try {
        const QRCode = (await import('qrcode')).default;
        const url = await QRCode.toDataURL(link, { margin: 1, width: 344, color: { dark: '#0b0d10', light: '#ffffff' } });
        if (!cancelled) setDataUrl(url);
      } catch {
        if (!cancelled) setDataUrl(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [link]);

  return (
    <div style={{ marginTop: 22, flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', minHeight: 0 }}>
      <div style={{ background: '#fff', padding: 14, borderRadius: 18, boxShadow: '0 12px 30px rgba(0,0,0,0.35)' }}>
        <div style={{ width: 172, height: 172, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {dataUrl ? (
            <img data-testid="show-qr" src={dataUrl} alt="pairing QR" style={{ width: '100%', height: '100%' }} />
          ) : (
            <span style={{ color: '#888', fontSize: 11, fontFamily: SANS }}>generating…</span>
          )}
        </div>
      </div>
      <div style={{ marginTop: 20, fontSize: 11, letterSpacing: 2, color: c.muted, textTransform: 'uppercase' }}>pairing code</div>
      <div data-testid="show-code" style={{ marginTop: 7, fontSize: 30, fontWeight: 700, letterSpacing: 5, color: c.text }}>
        {payload?.code ?? '—'}
      </div>
      <div
        style={{
          marginTop: 16,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '7px 13px',
          borderRadius: 999,
          background: c.surface,
          border: `1px solid ${c.border}`,
        }}
      >
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: c.approve, animation: 'blink 1.4s infinite' }} />
        <span data-testid="pair-badge" style={{ fontSize: 12, color: c.muted }}>
          {paired ? 'paired ✓' : 'waiting for agent…'}
        </span>
      </div>
      <div style={{ flex: 1 }} />
      <div style={{ fontFamily: SANS, fontSize: 13, color: c.faint, textAlign: 'center', lineHeight: 1.55 }}>
        Scan this from your agent, or open the link it shows. SPAKE2 derives the key from the code — the relay can't read it.
      </div>
    </div>
  );
}
