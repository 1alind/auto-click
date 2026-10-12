import React, { useState, useEffect, useRef, useCallback } from 'react';

interface LiveStatusResponse {
  success: boolean;
  tunnel: {
    active: boolean;
    localUrl: string;
    publicUrl: string | null;
    startedAt: number | null;
    error: string | null;
  };
  runningMacro: string | null;
  isFindRunning: boolean;
  startState: {
    macroName: string;
    isRunning: boolean;
    resumeAfterUpdate: boolean;
    currentStep: number;
    cycleCount: number;
    totalStepsExecuted: number;
    nextFixacRemainingMs: number;
    updatedAt: string;
  };
}

interface BotStatusResponse {
  adbConnected?: boolean;
  activeDevice?: string;
  devices?: Array<{ serial: string; state: string }>;
  uptimeSeconds?: number;
}

export default function App() {
  const [liveStatus, setLiveStatus] = useState<LiveStatusResponse | null>(null);
  const [botStatus, setBotStatus] = useState<BotStatusResponse | null>(null);
  const [isStreaming, setIsStreaming] = useState<boolean>(true);
  const [refreshIntervalMs, setRefreshIntervalMs] = useState<number>(200);
  const [frameUrl, setFrameUrl] = useState<string>('');
  const [screenSize, setScreenSize] = useState<{ width: number; height: number }>({
    width: 1080,
    height: 2400
  });
  const [isCapturingFrame, setIsCapturingFrame] = useState<boolean>(false);

  // Touch mode: 'touch' = tap/swipe on phone, 'box' = select minX-maxX minY-maxY & save crop
  const [interactionMode, setInteractionMode] = useState<'touch' | 'box'>('touch');
  const [hoverCoords, setHoverCoords] = useState<{ x: number; y: number } | null>(null);
  const [lastTapMarker, setLastTapMarker] = useState<{ x: number; y: number; ts: number } | null>(null);

  // Drag / Swipe / Box state
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [dragCurrent, setDragCurrent] = useState<{ x: number; y: number } | null>(null);
  const [pointerDownTime, setPointerDownTime] = useState<number>(0);
  const [selectedBox, setSelectedBox] = useState<{
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
  } | null>(null);

  const [cropFileName, setCropFileName] = useState<string>('noob.png');
  const [actionToast, setActionToast] = useState<string>('');
  const [tunnelLoading, setTunnelLoading] = useState<boolean>(false);

  // Screen Rules (Zero AI Prompt & Screen Handlers)
  const [showRulesModal, setShowRulesModal] = useState<boolean>(false);
  const [rulesList, setRulesList] = useState<any[]>([]);
  const [latestPending, setLatestPending] = useState<any | null>(null);
  const [ruleInputId, setRuleInputId] = useState<string>('');
  const [ruleActionType, setRuleActionType] = useState<'tap' | 'hold' | 'back'>('tap');
  const [ruleTapX, setRuleTapX] = useState<string>('500');
  const [ruleTapY, setRuleTapY] = useState<string>('1000');
  const [ruleHoldMs, setRuleHoldMs] = useState<string>('1000');
  const [rulesLoading, setRulesLoading] = useState<boolean>(false);

  // Manual rule creation state
  const [showManualForm, setShowManualForm] = useState<boolean>(false);
  const [manualId, setManualId] = useState<string>('');
  const [manualKeywords, setManualKeywords] = useState<string>('');
  const [manualActionType, setManualActionType] = useState<'tap' | 'hold' | 'back'>('tap');
  const [manualTapX, setManualTapX] = useState<string>('500');
  const [manualTapY, setManualTapY] = useState<string>('1000');
  const [manualHoldMs, setManualHoldMs] = useState<string>('1000');
  const [isScanningScreen, setIsScanningScreen] = useState<boolean>(false);

  const fetchRules = useCallback(async () => {
    try {
      setRulesLoading(true);
      const res = await fetch('/api/screen-rules').then((r) => r.json());
      if (res?.success) {
        setRulesList(res.rules || []);
        setLatestPending(res.latestPending || null);
        if (res.latestPending && !ruleInputId) {
          setRuleInputId(res.latestPending.id);
        }
      }
    } catch {
      // ignore
    } finally {
      setRulesLoading(false);
    }
  }, [ruleInputId]);

  const handleSaveRule = async () => {
    const targetId = (ruleInputId || latestPending?.id || '').trim();
    if (!targetId) {
      showToast('Screen ID is required');
      return;
    }
    const action =
      ruleActionType === 'back'
        ? { type: 'back' }
        : ruleActionType === 'hold'
        ? { type: 'hold', x: Number(ruleTapX) || 500, y: Number(ruleTapY) || 1000, holdMs: Number(ruleHoldMs) || 1000 }
        : { type: 'tap', x: Number(ruleTapX) || 500, y: Number(ruleTapY) || 1000 };

    try {
      const res = await fetch('/api/screen-rules/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: targetId,
          action,
          keywords: latestPending?.keywords,
          snippet: latestPending?.ocrSnippet
        })
      }).then((r) => r.json());

      if (res?.success) {
        showToast(`Rule saved for "${targetId}"`);
        setRuleInputId('');
        await fetchRules();
      }
    } catch (err: any) {
      showToast(`Error: ${err.message}`);
    }
  };

  const handleRenameRule = async (oldId: string) => {
    const newId = prompt(`Enter new Screen ID for "${oldId}":`, oldId);
    if (!newId || newId.trim() === oldId) return;

    try {
      const res = await fetch('/api/screen-rules/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldId, newId: newId.trim() })
      }).then((r) => r.json());

      if (res?.success) {
        showToast(`Renamed to "${newId.trim()}"`);
        await fetchRules();
      } else {
        showToast(res?.message || 'Failed to rename');
      }
    } catch (err: any) {
      showToast(`Error: ${err.message}`);
    }
  };

  const handleDeleteRule = async (id: string) => {
    try {
      await fetch(`/api/screen-rules/${id}`, { method: 'DELETE' });
      showToast(`Deleted rule "${id}"`);
      await fetchRules();
    } catch (err: any) {
      showToast(`Error: ${err.message}`);
    }
  };

  const handleScanForManualKeywords = async () => {
    setIsScanningScreen(true);
    showToast('Scanning phone screen for keywords...');
    try {
      const res = await fetch('/api/screen-rules/scan', { method: 'POST' }).then((r) => r.json());
      if (res?.pending) {
        if (res.pending.keywords?.length > 0) {
          setManualKeywords(res.pending.keywords.join(', '));
        }
        if (!manualId && res.pending.id) {
          setManualId(res.pending.id);
        }
        showToast(`Scanned ${res.pending.keywords?.length || 0} keywords!`);
      } else if (res?.rule) {
        showToast(`Screen already matches rule "${res.rule.id}"`);
      }
    } catch (err: any) {
      showToast(`Scan failed: ${err.message}`);
    } finally {
      setIsScanningScreen(false);
    }
  };

  const handleSaveManualRule = async () => {
    const cleanId = manualId.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
    if (!cleanId) {
      showToast('Screen ID is required');
      return;
    }
    const keywords = manualKeywords
      .split(/[,;]+/)
      .map((k) => k.trim())
      .filter(Boolean);

    if (keywords.length === 0) {
      showToast('Please enter at least 1 keyword');
      return;
    }

    const action =
      manualActionType === 'back'
        ? { type: 'back' }
        : manualActionType === 'hold'
        ? { type: 'hold', x: Number(manualTapX) || 500, y: Number(manualTapY) || 1000, holdMs: Number(manualHoldMs) || 1000 }
        : { type: 'tap', x: Number(manualTapX) || 500, y: Number(manualTapY) || 1000 };

    try {
      const res = await fetch('/api/screen-rules/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: cleanId,
          action,
          keywords,
          snippet: `Manual: ${keywords.join(', ')}`
        })
      }).then((r) => r.json());

      if (res?.success) {
        showToast(`Created rule "${cleanId}"`);
        setManualId('');
        setManualKeywords('');
        setShowManualForm(false);
        await fetchRules();
      }
    } catch (err: any) {
      showToast(`Error: ${err.message}`);
    }
  };

  const imgRef = useRef<HTMLImageElement | null>(null);
  const frameInFlightRef = useRef<boolean>(false);

  const showToast = (msg: string) => {
    setActionToast(msg);
    setTimeout(() => {
      setActionToast((prev) => (prev === msg ? '' : prev));
    }, 3000);
  };

  const fetchStatus = useCallback(async () => {
    try {
      const [liveRes, statusRes] = await Promise.all([
        fetch('/api/live/status').then((r) => r.json()),
        fetch('/api/status').then((r) => r.json())
      ]);
      if (liveRes?.success) setLiveStatus(liveRes);
      if (statusRes?.success) setBotStatus(statusRes);
    } catch {
      // ignore network poll errors
    }
  }, []);

  const fetchFrame = useCallback(async (forceFresh = false) => {
    if (frameInFlightRef.current) return;
    frameInFlightRef.current = true;
    setIsCapturingFrame(true);

    try {
      const res = await fetch(`/api/live/frame?fresh=${forceFresh ? '1' : '0'}&t=${Date.now()}`);
      if (!res.ok) return;

      const wHeader = Number(res.headers.get('X-Screen-Width'));
      const hHeader = Number(res.headers.get('X-Screen-Height'));
      if (wHeader > 0 && hHeader > 0) {
        setScreenSize({ width: wHeader, height: hHeader });
      }

      const blob = await res.blob();
      const nextUrl = URL.createObjectURL(blob);
      setFrameUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return nextUrl;
      });
    } catch {
      // ignore frame error
    } finally {
      frameInFlightRef.current = false;
      setIsCapturingFrame(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    const statusTimer = setInterval(fetchStatus, 2500);
    return () => clearInterval(statusTimer);
  }, [fetchStatus]);

  useEffect(() => {
    if (!isStreaming || !liveStatus?.tunnel.active) return;
    fetchFrame(true);
    const timer = setInterval(() => {
      fetchFrame(false);
    }, refreshIntervalMs);
    return () => clearInterval(timer);
  }, [isStreaming, liveStatus?.tunnel.active, refreshIntervalMs, fetchFrame]);

  const clientToPhoneCoords = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const img = imgRef.current;
    if (!img) return null;
    const rect = img.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    const relX = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const relY = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));

    return {
      x: Math.round(relX * screenSize.width),
      y: Math.round(relY * screenSize.height)
    };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const pt = clientToPhoneCoords(e.clientX, e.clientY);
    if (!pt) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragStart(pt);
    setDragCurrent(pt);
    setPointerDownTime(Date.now());
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const pt = clientToPhoneCoords(e.clientX, e.clientY);
    if (!pt) return;
    setHoverCoords(pt);
    if (dragStart) {
      setDragCurrent(pt);
    }
  };

  const handlePointerUp = async (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragStart) return;
    const endPt = clientToPhoneCoords(e.clientX, e.clientY) || dragCurrent || dragStart;
    const startPt = dragStart;
    const pressDur = pointerDownTime ? Date.now() - pointerDownTime : 0;
    setDragStart(null);
    setDragCurrent(null);
    setPointerDownTime(0);

    const dx = Math.abs(endPt.x - startPt.x);
    const dy = Math.abs(endPt.y - startPt.y);

    if (interactionMode === 'box') {
      if (dx < 8 && dy < 8) {
        setHoverCoords(endPt);
        showToast(`Point: ${endPt.x} ${endPt.y}`);
        return;
      }
      const box = {
        minX: Math.min(startPt.x, endPt.x),
        maxX: Math.max(startPt.x, endPt.x),
        minY: Math.min(startPt.y, endPt.y),
        maxY: Math.max(startPt.y, endPt.y)
      };
      setSelectedBox(box);
      showToast(`Box: ${box.minX}-${box.maxX} ${box.minY}-${box.maxY}`);
      return;
    }

    if (Math.hypot(dx, dy) > 35) {
      showToast(`Swipe (${startPt.x},${startPt.y})→(${endPt.x},${endPt.y})`);
      await fetch('/api/live/swipe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          x1: startPt.x,
          y1: startPt.y,
          x2: endPt.x,
          y2: endPt.y,
          durationMs: 300
        })
      });
      setTimeout(() => fetchFrame(true), 350);
    } else if (pressDur >= 400) {
      setHoverCoords(endPt);
      setLastTapMarker({ x: endPt.x, y: endPt.y, ts: Date.now() });
      showToast(`Hold (${endPt.x}, ${endPt.y}) for ${pressDur}ms`);
      await fetch('/api/live/hold', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ x: endPt.x, y: endPt.y, durationMs: pressDur })
      });
      setTimeout(() => fetchFrame(true), 350);
    } else {
      setHoverCoords(endPt);
      setLastTapMarker({ x: endPt.x, y: endPt.y, ts: Date.now() });
      showToast(`Tap (${endPt.x}, ${endPt.y})`);
      await fetch('/api/live/tap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ x: endPt.x, y: endPt.y })
      });
      setTimeout(() => fetchFrame(true), 350);
    }
  };

  const handleSaveCrop = async () => {
    if (!selectedBox) return;
    try {
      const res = await fetch('/api/live/crop-save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...selectedBox,
          fileName: cropFileName || 'crop.png'
        })
      }).then((r) => r.json());

      if (res.success) {
        showToast(`Saved ${res.fileName} (${res.width}×${res.height})`);
      } else {
        showToast(`Error: ${res.message}`);
      }
    } catch (err: any) {
      showToast(`Save failed: ${err.message}`);
    }
  };

  const handleSendKey = async (keyCode: number, label: string) => {
    showToast(`Key: ${label}`);
    await fetch('/api/live/key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyCode })
    });
    setTimeout(() => fetchFrame(true), 400);
  };

  const handleToggleTunnel = async () => {
    setTunnelLoading(true);
    try {
      if (liveStatus?.tunnel.active) {
        await fetch('/api/live/stop', { method: 'POST' });
        showToast('Live Control OFF');
      } else {
        showToast('Starting Live Control...');
        await fetch('/api/live/start', { method: 'POST' });
        showToast('Live Control ON');
      }
      await fetchStatus();
    } finally {
      setTunnelLoading(false);
    }
  };

  const activeBox =
    interactionMode === 'box' && dragStart && dragCurrent
      ? {
          minX: Math.min(dragStart.x, dragCurrent.x),
          maxX: Math.max(dragStart.x, dragCurrent.x),
          minY: Math.min(dragStart.y, dragCurrent.y),
          maxY: Math.max(dragStart.y, dragCurrent.y)
        }
      : selectedBox;

  return (
    <div className="min-h-dvh bg-slate-950 text-slate-100 flex flex-col font-sans select-none overflow-x-hidden">
      {/* Compact Mobile-First Header */}
      <header className="border-b border-slate-800/80 bg-slate-900/90 px-2.5 py-1.5 flex flex-wrap items-center justify-between gap-1.5 text-[11px]">
        <div className="flex items-center gap-2">
          <span
            className={`h-2 w-2 rounded-full shrink-0 ${
              botStatus?.adbConnected ? 'bg-emerald-400 shadow-[0_0_6px_#34d399]' : 'bg-rose-500'
            }`}
          />
          <span className="font-semibold text-slate-200">Live Remote</span>
          <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700/80 font-mono text-[10px]">
            {botStatus?.adbConnected ? botStatus.activeDevice : 'No ADB'}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          {liveStatus?.tunnel.localUrl && (
            <button
              onClick={() => {
                navigator.clipboard.writeText(liveStatus.tunnel.localUrl);
                showToast('Copied Wi-Fi URL');
              }}
              className="px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 text-[10px]"
            >
              Wi-Fi
            </button>
          )}

          {liveStatus?.tunnel.publicUrl && (
            <button
              onClick={() => {
                navigator.clipboard.writeText(liveStatus.tunnel.publicUrl!);
                showToast('Copied Internet URL');
              }}
              className="px-1.5 py-0.5 rounded bg-indigo-600/30 hover:bg-indigo-600/50 border border-indigo-500/40 text-indigo-200 text-[10px]"
            >
              Net Link
            </button>
          )}

          <button
            onClick={handleToggleTunnel}
            disabled={tunnelLoading}
            className={`px-2 py-0.5 rounded font-medium text-[10px] transition ${
              liveStatus?.tunnel.active
                ? 'bg-rose-600 hover:bg-rose-500 text-white'
                : 'bg-indigo-600 hover:bg-indigo-500 text-white'
            }`}
          >
            {tunnelLoading ? '...' : liveStatus?.tunnel.active ? 'Stop :4444' : 'Start :4444'}
          </button>
        </div>
      </header>

      {/* Compact Toast */}
      {actionToast && (
        <div className="fixed bottom-2.5 right-2.5 z-50 bg-slate-900/95 border border-emerald-500/50 text-emerald-300 px-2.5 py-1 rounded shadow-lg text-[11px] font-mono pointer-events-none">
          {actionToast}
        </div>
      )}

      {/* Main Centered Container */}
      <main className="flex-1 flex flex-col items-center justify-start p-2 gap-2 max-w-md w-full mx-auto">
        {/* Compact Control Strip */}
        <div className="w-full flex flex-wrap items-center justify-between gap-1.5 bg-slate-900/70 border border-slate-800 rounded-lg px-2 py-1 text-[11px]">
          <div className="flex items-center gap-1">
            <button
              onClick={() => setInteractionMode('touch')}
              className={`px-2 py-0.5 rounded font-medium transition ${
                interactionMode === 'touch'
                  ? 'bg-emerald-600 text-white'
                  : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
              }`}
            >
              👆 Tap
            </button>
            <button
              onClick={() => setInteractionMode('box')}
              className={`px-2 py-0.5 rounded font-medium transition ${
                interactionMode === 'box'
                  ? 'bg-amber-600 text-white'
                  : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
              }`}
            >
              ✂️ Crop
            </button>
            <button
              onClick={() => {
                setShowRulesModal(true);
                fetchRules();
              }}
              className="px-2 py-0.5 rounded font-medium transition bg-slate-800 text-slate-300 hover:bg-slate-700 flex items-center gap-1"
            >
              <span>🛡️ Rules</span>
              {latestPending && (
                <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
              )}
            </button>
          </div>

          <span className="font-mono text-[10px] text-slate-400">
            {hoverCoords ? (
              <span className="text-emerald-400">
                {hoverCoords.x},{hoverCoords.y}
              </span>
            ) : (
              `${screenSize.width}×${screenSize.height}`
            )}
          </span>

          <div className="flex items-center gap-1">
            <button
              onClick={() => setIsStreaming((s) => !s)}
              className={`px-1.5 py-0.5 rounded font-medium text-[10px] transition ${
                isStreaming
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                  : 'bg-slate-800 text-slate-400 border border-slate-700'
              }`}
            >
              {isStreaming ? '● Live' : '○ Pause'}
            </button>

            <select
              value={refreshIntervalMs}
              onChange={(e) => setRefreshIntervalMs(Number(e.target.value))}
              className="bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-[10px] text-slate-200"
            >
              <option value={450}>0.45s</option>
              <option value={800}>0.8s</option>
              <option value={1500}>1.5s</option>
              <option value={3000}>3.0s</option>
            </select>

            <button
              onClick={() => fetchFrame(true)}
              className="px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-[10px]"
              title="Refresh frame"
            >
              {isCapturingFrame ? '·' : '↻'}
            </button>
          </div>
        </div>

        {/* Crop / Box Coordinates Drawer (Compact) */}
        {(interactionMode === 'box' || selectedBox) && (
          <div className="w-full bg-slate-900/80 border border-slate-800 rounded-lg px-2.5 py-1.5 text-[11px] space-y-1.5">
            {selectedBox ? (
              <>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-amber-300 text-[11px]">
                    {selectedBox.minX}-{selectedBox.maxX} {selectedBox.minY}-{selectedBox.maxY}
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => {
                        const coordStr = `${selectedBox.minX}-${selectedBox.maxX} ${selectedBox.minY}-${selectedBox.maxY}`;
                        navigator.clipboard.writeText(coordStr);
                        showToast(`Copied "${coordStr}"`);
                      }}
                      className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-[10px]"
                    >
                      Copy
                    </button>
                    <button
                      onClick={() => setSelectedBox(null)}
                      className="px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-400 text-[10px]"
                    >
                      ✕
                    </button>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={cropFileName}
                    onChange={(e) => setCropFileName(e.target.value)}
                    placeholder="noob.png"
                    className="flex-1 min-w-0 bg-slate-950 border border-slate-800 rounded px-2 py-1 text-slate-200 font-mono text-[11px]"
                  />
                  <button
                    onClick={handleSaveCrop}
                    className="px-2.5 py-1 rounded bg-amber-600 hover:bg-amber-500 text-white font-medium text-[11px] shrink-0"
                  >
                    Save Image
                  </button>
                </div>
              </>
            ) : (
              <div className="text-slate-400 text-[10px] text-center">
                Drag a box on the screen to get <code className="text-amber-300">minX-maxX minY-maxY</code> or save an image.
              </div>
            )}
          </div>
        )}

        {/* Responsive Phone Screen Viewport */}
        <div
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          className="relative bg-black rounded-lg overflow-hidden border border-slate-800 shadow-xl cursor-crosshair touch-none flex items-center justify-center"
        >
          {frameUrl ? (
            <img
              ref={imgRef}
              src={frameUrl}
              alt="Live Android Screen"
              draggable={false}
              className="max-h-[72dvh] sm:max-h-[78dvh] max-w-[92vw] w-auto h-auto object-contain block select-none pointer-events-none"
            />
          ) : (
            <div className="h-[60dvh] w-[28dvh] max-w-[85vw] flex items-center justify-center text-slate-500 text-[11px] text-center px-4">
              {liveStatus?.tunnel.active
                ? 'Loading live screen...'
                : 'Live Control is OFF. Send "live" in Discord or tap Start :4444.'}
            </div>
          )}

          {/* Last Tap Ripple Marker */}
          {lastTapMarker && Date.now() - lastTapMarker.ts < 2500 && (
            <div
              style={{
                left: `${(lastTapMarker.x / screenSize.width) * 100}%`,
                top: `${(lastTapMarker.y / screenSize.height) * 100}%`
              }}
              className="absolute -translate-x-1/2 -translate-y-1/2 pointer-events-none"
            >
              <div className="h-4 w-4 rounded-full border-2 border-emerald-400 bg-emerald-400/30 animate-ping" />
              <div className="h-1.5 w-1.5 rounded-full bg-emerald-400 absolute top-1 left-1" />
            </div>
          )}

          {/* Crop / Box Selection Overlay */}
          {activeBox && (
            <div
              style={{
                left: `${(activeBox.minX / screenSize.width) * 100}%`,
                top: `${(activeBox.minY / screenSize.height) * 100}%`,
                width: `${((activeBox.maxX - activeBox.minX) / screenSize.width) * 100}%`,
                height: `${((activeBox.maxY - activeBox.minY) / screenSize.height) * 100}%`
              }}
              className="absolute border-2 border-amber-400 bg-amber-400/20 pointer-events-none"
            />
          )}
        </div>

        {/* Compact Android Navigation Bar */}
        <div className="w-full max-w-[240px] grid grid-cols-3 gap-1.5">
          <button
            onClick={() => handleSendKey(4, 'BACK')}
            className="py-1 px-2 rounded bg-slate-900 hover:bg-slate-800 border border-slate-800 text-[11px] font-medium text-slate-300 active:scale-95 transition"
          >
            ◀ Back
          </button>
          <button
            onClick={() => handleSendKey(3, 'HOME')}
            className="py-1 px-2 rounded bg-slate-900 hover:bg-slate-800 border border-slate-800 text-[11px] font-medium text-slate-300 active:scale-95 transition"
          >
            ● Home
          </button>
          <button
            onClick={() => handleSendKey(187, 'RECENTS')}
            className="py-1 px-2 rounded bg-slate-900 hover:bg-slate-800 border border-slate-800 text-[11px] font-medium text-slate-300 active:scale-95 transition"
          >
            ■ Apps
          </button>
        </div>
      </main>

      {/* Screen Rules (Zero AI Prompt & Screen Handlers) Modal */}
      {showRulesModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-3">
          <div className="bg-slate-900 border border-slate-800 rounded-xl w-full max-w-lg max-h-[85vh] flex flex-col shadow-2xl text-[12px]">
            {/* Modal Header */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
              <div className="flex items-center gap-2">
                <span className="text-base">🛡️</span>
                <div>
                  <h3 className="font-semibold text-slate-100">Screen Recognition Rules</h3>
                  <p className="text-[10px] text-slate-400">Zero AI — Auto-handled via local text & coordinates</p>
                </div>
              </div>
              <button
                onClick={() => setShowRulesModal(false)}
                className="text-slate-400 hover:text-white px-2 py-1 rounded"
              >
                ✕
              </button>
            </div>

            {/* Modal Body */}
            <div className="flex-1 overflow-y-auto p-3 space-y-3">
              {/* Latest Pending Unknown Screen (If any) */}
              {latestPending && (
                <div className="bg-amber-950/30 border border-amber-500/40 rounded-lg p-2.5 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-amber-300 text-[11px] flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-full bg-amber-400 animate-ping" />
                      Pending Unknown Screen
                    </span>
                    <span className="font-mono text-[10px] text-slate-400">
                      Step {latestPending.stepNumber} ({latestPending.macroName})
                    </span>
                  </div>

                  <div className="flex items-center gap-1.5 text-[11px]">
                    <span className="text-slate-400 shrink-0">Screen ID:</span>
                    <input
                      type="text"
                      value={ruleInputId}
                      onChange={(e) => setRuleInputId(e.target.value)}
                      placeholder={latestPending.id}
                      className="flex-1 bg-slate-950 border border-slate-700 rounded px-2 py-1 font-mono text-amber-300 text-[11px]"
                    />
                  </div>

                  <div className="text-[10px] text-slate-400 line-clamp-2 bg-slate-950/60 p-1.5 rounded border border-slate-800">
                    {latestPending.ocrSnippet}
                  </div>

                  {latestPending.keywords?.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {latestPending.keywords.map((k: string) => (
                        <span key={k} className="px-1.5 py-0.5 rounded bg-slate-800 text-[10px] text-slate-300 font-mono">
                          {k}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Configure Action Form */}
                  <div className="pt-1.5 border-t border-amber-500/20 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <label className="text-[11px] text-slate-300 font-medium">Action:</label>
                      <button
                        type="button"
                        onClick={() => setRuleActionType('tap')}
                        className={`px-2 py-0.5 rounded text-[11px] font-medium transition ${
                          ruleActionType === 'tap'
                            ? 'bg-amber-600 text-white'
                            : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        Tap (X, Y)
                      </button>
                      <button
                        type="button"
                        onClick={() => setRuleActionType('hold')}
                        className={`px-2 py-0.5 rounded text-[11px] font-medium transition ${
                          ruleActionType === 'hold'
                            ? 'bg-amber-600 text-white'
                            : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        Hold (X, Y)
                      </button>
                      <button
                        type="button"
                        onClick={() => setRuleActionType('back')}
                        className={`px-2 py-0.5 rounded text-[11px] font-medium transition ${
                          ruleActionType === 'back'
                            ? 'bg-amber-600 text-white'
                            : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        Press Back
                      </button>
                    </div>

                    {(ruleActionType === 'tap' || ruleActionType === 'hold') && (
                      <div className="flex items-center gap-2">
                        <div className="flex items-center gap-1">
                          <span className="text-slate-400 text-[10px]">X:</span>
                          <input
                            type="number"
                            value={ruleTapX}
                            onChange={(e) => setRuleTapX(e.target.value)}
                            className="w-16 bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-center font-mono text-[11px]"
                          />
                        </div>
                        <div className="flex items-center gap-1">
                          <span className="text-slate-400 text-[10px]">Y:</span>
                          <input
                            type="number"
                            value={ruleTapY}
                            onChange={(e) => setRuleTapY(e.target.value)}
                            className="w-16 bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-center font-mono text-[11px]"
                          />
                        </div>
                        {ruleActionType === 'hold' && (
                          <div className="flex items-center gap-1">
                            <span className="text-slate-400 text-[10px]">Hold(ms):</span>
                            <input
                              type="number"
                              value={ruleHoldMs}
                              onChange={(e) => setRuleHoldMs(e.target.value)}
                              className="w-20 bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-center font-mono text-[11px]"
                            />
                          </div>
                        )}
                      </div>
                    )}

                    <button
                      onClick={handleSaveRule}
                      className="w-full py-1.5 rounded bg-amber-600 hover:bg-amber-500 font-semibold text-white text-[11px] transition shadow"
                    >
                      Save Rule for "{latestPending.id}"
                    </button>
                  </div>
                </div>
              )}

              {/* Manual Rule Creation Toggle & Form */}
              <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-2.5 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-slate-200 text-[11px] flex items-center gap-1.5">
                    <span>➕</span> Manually Add Screen Rule
                  </span>
                  <button
                    onClick={() => setShowManualForm(!showManualForm)}
                    className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-[10px]"
                  >
                    {showManualForm ? '▲ Hide Form' : '▼ Add Rule'}
                  </button>
                </div>

                {showManualForm && (
                  <div className="pt-2 border-t border-slate-800/80 space-y-2">
                    <div>
                      <label className="text-[10px] text-slate-400 block mb-0.5">Screen ID / Name:</label>
                      <input
                        type="text"
                        value={manualId}
                        onChange={(e) => setManualId(e.target.value)}
                        placeholder="e.g. daily_reward or vip_modal"
                        className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 font-mono text-[11px] text-slate-200"
                      />
                    </div>

                    <div>
                      <div className="flex items-center justify-between mb-0.5">
                        <label className="text-[10px] text-slate-400">Identifying Keywords (comma separated):</label>
                        <button
                          type="button"
                          onClick={handleScanForManualKeywords}
                          disabled={isScanningScreen}
                          className="text-[10px] text-indigo-400 hover:text-indigo-300 underline"
                        >
                          {isScanningScreen ? 'Scanning...' : '🔍 Scan Phone Screen'}
                        </button>
                      </div>
                      <input
                        type="text"
                        value={manualKeywords}
                        onChange={(e) => setManualKeywords(e.target.value)}
                        placeholder="e.g. reward, claim, daily"
                        className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 font-mono text-[11px] text-slate-200"
                      />
                    </div>

                    <div className="flex items-center gap-2">
                      <label className="text-[11px] text-slate-300 font-medium">Action:</label>
                      <button
                        type="button"
                        onClick={() => setManualActionType('tap')}
                        className={`px-2 py-0.5 rounded text-[11px] font-medium transition ${
                          manualActionType === 'tap'
                            ? 'bg-indigo-600 text-white'
                            : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        Tap (X, Y)
                      </button>
                      <button
                        type="button"
                        onClick={() => setManualActionType('hold')}
                        className={`px-2 py-0.5 rounded text-[11px] font-medium transition ${
                          manualActionType === 'hold'
                            ? 'bg-indigo-600 text-white'
                            : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        Hold (X, Y)
                      </button>
                      <button
                        type="button"
                        onClick={() => setManualActionType('back')}
                        className={`px-2 py-0.5 rounded text-[11px] font-medium transition ${
                          manualActionType === 'back'
                            ? 'bg-indigo-600 text-white'
                            : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        Press Back
                      </button>
                    </div>

                    {(manualActionType === 'tap' || manualActionType === 'hold') && (
                      <div className="flex items-center gap-2">
                        <div className="flex items-center gap-1">
                          <span className="text-slate-400 text-[10px]">X:</span>
                          <input
                            type="number"
                            value={manualTapX}
                            onChange={(e) => setManualTapX(e.target.value)}
                            className="w-16 bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-center font-mono text-[11px]"
                          />
                        </div>
                        <div className="flex items-center gap-1">
                          <span className="text-slate-400 text-[10px]">Y:</span>
                          <input
                            type="number"
                            value={manualTapY}
                            onChange={(e) => setManualTapY(e.target.value)}
                            className="w-16 bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-center font-mono text-[11px]"
                          />
                        </div>
                        {manualActionType === 'hold' && (
                          <div className="flex items-center gap-1">
                            <span className="text-slate-400 text-[10px]">Hold(ms):</span>
                            <input
                              type="number"
                              value={manualHoldMs}
                              onChange={(e) => setManualHoldMs(e.target.value)}
                              className="w-20 bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-center font-mono text-[11px]"
                            />
                          </div>
                        )}
                      </div>
                    )}

                    <button
                      onClick={handleSaveManualRule}
                      className="w-full py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 font-semibold text-white text-[11px] transition shadow"
                    >
                      Save New Rule
                    </button>
                  </div>
                )}
              </div>

              {/* Active Rules List */}
              <div className="space-y-2">
                <div className="flex items-center justify-between text-[11px] text-slate-400">
                  <span>Saved Rules ({rulesList.length})</span>
                  <button
                    onClick={fetchRules}
                    disabled={rulesLoading}
                    className="hover:text-slate-200"
                  >
                    {rulesLoading ? '...' : '↻ Refresh'}
                  </button>
                </div>

                {rulesList.length === 0 ? (
                  <div className="text-center py-6 text-slate-500 text-[11px]">
                    No custom rules saved yet. When an unknown dialog appears, the bot will notify you in Discord and here to set its action!
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {rulesList.map((rule) => (
                      <div
                        key={rule.id}
                        className="bg-slate-950 border border-slate-800 rounded-lg p-2 flex items-center justify-between gap-2"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="font-mono text-emerald-400 text-[11px] truncate">
                            {rule.id}
                          </div>
                          <div className="text-[10px] text-slate-300">
                            {rule.action.type === 'tap'
                              ? `Tap (${rule.action.x}, ${rule.action.y})`
                              : rule.action.type === 'back'
                              ? 'Press Back button'
                              : `Tap range ${rule.action.minX}-${rule.action.maxX}`}
                            <span className="text-slate-500 ml-2">
                              • Used {rule.timesTriggered || 0}x
                            </span>
                          </div>
                          {rule.keywords?.length > 0 && (
                            <div className="text-[9px] text-slate-500 truncate">
                              Keywords: {rule.keywords.join(', ')}
                            </div>
                          )}
                        </div>

                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            onClick={() => handleRenameRule(rule.id)}
                            className="px-2 py-1 rounded bg-slate-900 hover:bg-slate-800 text-slate-300 hover:text-white text-[10px] border border-slate-800"
                            title="Rename Screen ID"
                          >
                            Rename
                          </button>
                          <button
                            onClick={() => handleDeleteRule(rule.id)}
                            className="px-2 py-1 rounded bg-slate-900 hover:bg-rose-900/60 text-slate-400 hover:text-rose-200 text-[10px] border border-slate-800"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Modal Footer with Discord Instructions */}
            <div className="px-3 py-2 border-t border-slate-800 bg-slate-950/50 text-[10px] text-slate-400 flex items-center justify-between">
              <span>Discord command: <code className="text-amber-300">rule set &lt;id&gt; tap &lt;x&gt; &lt;y&gt;</code></span>
              <button
                onClick={() => setShowRulesModal(false)}
                className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px]"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
