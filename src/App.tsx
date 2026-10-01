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
  const [refreshIntervalMs, setRefreshIntervalMs] = useState<number>(800);
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
  const [selectedBox, setSelectedBox] = useState<{
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
  } | null>(null);

  const [cropFileName, setCropFileName] = useState<string>('noob.png');
  const [actionToast, setActionToast] = useState<string>('');
  const [tunnelLoading, setTunnelLoading] = useState<boolean>(false);

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
    setDragStart(null);
    setDragCurrent(null);

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
    </div>
  );
}
