import { spawn, ChildProcess } from 'child_process';
import http from 'http';
import express, { Express, Request } from 'express';
import os from 'os';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { Jimp } from 'jimp';
import { MacroManager } from './macroManager';
import { TemplateMatcher } from './matcher';

export const LIVE_PORT = 4444;
export type LiveMode = 'local' | 'net' | 'all';

export interface LiveTunnelStatus {
  active: boolean;
  mode: LiveMode | null;
  port: number;
  localUrl: string | null;
  publicUrl: string | null;
  startedAt: number | null;
  error: string | null;
}

interface CachedFrame {
  rawScreen: { data: Buffer; width: number; height: number };
  rawRgbaLowGzip: { gzipBuf: Buffer; w: number; h: number } | null;
  rawRgbaMedGzip: { gzipBuf: Buffer; w: number; h: number } | null;
  fastJpegLow: Buffer | null;
  fastJpegMed: Buffer | null;
  fullPng: Buffer | null;
  width: number;
  height: number;
  timestamp: number;
}

const STANDALONE_LIVE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <title>ADB Live Remote</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; user-select: none; }
    body {
      background: #020617;
      color: #f1f5f9;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      min-height: 100dvh;
      display: flex;
      flex-direction: column;
      overflow-x: hidden;
    }
    header {
      background: #0f172a;
      border-bottom: 1px solid #1e293b;
      padding: 6px 10px;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      font-size: 11px;
    }
    .row { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #f43f5e; display: inline-block; }
    .dot.ok { background: #34d399; box-shadow: 0 0 6px #34d399; }
    .badge {
      background: #1e293b;
      border: 1px solid #334155;
      color: #cbd5e1;
      padding: 2px 6px;
      border-radius: 4px;
      font-family: monospace;
      font-size: 10px;
    }
    button, select, input {
      font-family: inherit;
      font-size: 11px;
      border-radius: 5px;
      border: 1px solid #334155;
      background: #1e293b;
      color: #e2e8f0;
      padding: 3px 7px;
      cursor: pointer;
    }
    button:active { transform: scale(0.96); }
    .btn-green { background: #059669; border-color: #10b981; color: #fff; font-weight: 600; }
    .btn-amber { background: #d97706; border-color: #f59e0b; color: #fff; font-weight: 600; }
    .btn-red { background: #e11d48; border-color: #f43f5e; color: #fff; font-weight: 600; }
    main {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 6px;
      gap: 6px;
      max-width: 460px;
      width: 100%;
      margin: 0 auto;
    }
    .toolbar {
      width: 100%;
      background: #0f172a;
      border: 1px solid #1e293b;
      border-radius: 8px;
      padding: 5px 8px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 5px;
      font-size: 11px;
    }
    .coords { font-family: monospace; font-size: 10px; color: #94a3b8; }
    .crop-drawer {
      width: 100%;
      background: #0f172a;
      border: 1px solid #1e293b;
      border-radius: 8px;
      padding: 6px 8px;
      display: none;
      flex-direction: column;
      gap: 6px;
      font-size: 11px;
    }
    .crop-drawer.show { display: flex; }
    .viewport {
      position: relative;
      background: #000;
      border: 1px solid #1e293b;
      border-radius: 8px;
      overflow: hidden;
      touch-action: none;
      cursor: crosshair;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .viewport img, .viewport canvas, .viewport video {
      max-height: 74dvh;
      max-width: 94vw;
      width: auto;
      height: auto;
      display: block;
      pointer-events: none;
    }
    .tap-marker {
      position: absolute;
      width: 14px;
      height: 14px;
      border: 2px solid #34d399;
      background: rgba(52, 211, 153, 0.3);
      border-radius: 50%;
      transform: translate(-50%, -50%);
      pointer-events: none;
      display: none;
    }
    .box-overlay {
      position: absolute;
      border: 2px solid #fbbf24;
      background: rgba(251, 191, 36, 0.2);
      pointer-events: none;
      display: none;
    }
    .nav-bar {
      width: 100%;
      max-width: 240px;
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 6px;
    }
    .nav-bar button { padding: 4px 0; font-weight: 500; }
    .toast {
      position: fixed;
      bottom: 10px;
      right: 10px;
      background: rgba(15, 23, 42, 0.95);
      border: 1px solid #10b981;
      color: #6ee7b7;
      padding: 4px 9px;
      border-radius: 6px;
      font-family: monospace;
      font-size: 11px;
      pointer-events: none;
      display: none;
      z-index: 50;
    }
  </style>
</head>
<body>
  <header>
    <div class="row">
      <span id="adbDot" class="dot"></span>
      <strong>Live Remote</strong>
      <span id="adbBadge" class="badge">Connecting...</span>
    </div>
    <div class="row">
      <button id="btnStopServer" class="btn-red">Stop :4444</button>
    </div>
  </header>

  <main>
    <div class="toolbar">
      <div class="row">
        <button id="btnTouch" class="btn-green">👆 Tap</button>
        <button id="btnBox">✂️ Crop</button>
      </div>
      <span id="coordText" class="coords">1080×2400</span>
      <div class="row">
        <button id="btnStream" class="btn-green">● Live</button>
        <select id="selQuality" title="Stream Mode">
          <option value="h264" selected>⚡ 60FPS Video (Low 368p)</option>
          <option value="low">🚀 Ultra-Low Frame (270p 12KB)</option>
          <option value="auto">🖼️ Medium Frame (540p)</option>
        </select>
        <button id="btnRefresh" title="Reconnect / Refresh">↻</button>
      </div>
    </div>

    <div id="cropDrawer" class="crop-drawer">
      <div class="row" style="justify-content: space-between;">
        <span id="boxRangeText" style="font-family: monospace; color: #fcd34d;">Drag box on screen...</span>
        <div class="row">
          <button id="btnCopyRange">Copy</button>
          <button id="btnClearBox">✕</button>
        </div>
      </div>
      <div class="row">
        <input id="inpFileName" type="text" value="noob.png" placeholder="noob.png" style="flex:1; min-width:0; font-family:monospace;" />
        <button id="btnSaveCrop" class="btn-amber">Save Image (Full HD)</button>
      </div>
    </div>

    <div id="viewport" class="viewport">
      <video id="liveVideo" autoplay muted playsinline style="display:none;"></video>
      <canvas id="liveCanvas" style="display:none;"></canvas>
      <img id="screenImg" alt="Live Screen" />
      <div id="tapMarker" class="tap-marker"></div>
      <div id="boxOverlay" class="box-overlay"></div>
    </div>

    <div class="nav-bar">
      <button onclick="sendKey(4, 'BACK')">◀ Back</button>
      <button onclick="sendKey(3, 'HOME')">● Home</button>
      <button onclick="sendKey(187, 'APPS')">■ Apps</button>
    </div>
  </main>

  <div id="toast" class="toast"></div>

  <script src="https://cdn.jsdelivr.net/npm/jmuxer@2.0.5/dist/jmuxer.min.js"></script>
  <script>
    let mode = 'touch';
    let streaming = true;
    let intervalMs = 150;
    let quality = 'h264';
    let screenW = 1080, screenH = 2400;
    let inFlight = false;
    let dragStart = null, dragCur = null, selectedBox = null, pointerDownTime = 0;
    let jmuxer = null;
    let h264Abort = null;

    const videoEl = document.getElementById('liveVideo');
    const liveCanvas = document.getElementById('liveCanvas');
    const liveCtx = liveCanvas.getContext('2d');
    const imgEl = document.getElementById('screenImg');
    const viewport = document.getElementById('viewport');
    const coordText = document.getElementById('coordText');
    const tapMarker = document.getElementById('tapMarker');
    const boxOverlay = document.getElementById('boxOverlay');
    const cropDrawer = document.getElementById('cropDrawer');
    const boxRangeText = document.getElementById('boxRangeText');
    const toastEl = document.getElementById('toast');

    function toast(msg) {
      toastEl.textContent = msg;
      toastEl.style.display = 'block';
      clearTimeout(toastEl._t);
      toastEl._t = setTimeout(() => { toastEl.style.display = 'none'; }, 2500);
    }

    async function fetchStatus() {
      try {
        const r = await fetch('/api/status').then(x => x.json());
        const dot = document.getElementById('adbDot');
        const badge = document.getElementById('adbBadge');
        if (r.adbConnected) {
          dot.className = 'dot ok';
          badge.textContent = r.activeDevice || 'Connected';
        } else {
          dot.className = 'dot';
          badge.textContent = 'No ADB';
        }
      } catch {}
    }

    let webCodecsDecoder = null;

    function stopH264Stream() {
      if (h264Abort) {
        try { h264Abort.abort(); } catch {}
        h264Abort = null;
      }
      if (webCodecsDecoder) {
        try { webCodecsDecoder.close(); } catch {}
        webCodecsDecoder = null;
      }
      if (jmuxer) {
        try { jmuxer.destroy(); } catch {}
        jmuxer = null;
      }
      videoEl.style.display = 'none';
      liveCanvas.style.display = 'none';
      imgEl.style.display = 'block';
    }

    // Helper: splits a byte buffer into complete H.264 Annex-B NAL units (starting with 00 00 00 01)
    function extractCompleteNals(buffer) {
      const starts = [];
      for (let i = 0; i <= buffer.length - 4; i++) {
        if (buffer[i] === 0 && buffer[i + 1] === 0 && buffer[i + 2] === 0 && buffer[i + 3] === 1) {
          starts.push(i);
          i += 3;
        }
      }
      if (starts.length <= 1) {
        return { nals: [], remainder: buffer };
      }
      const nals = [];
      for (let k = 0; k < starts.length - 1; k++) {
        nals.push(buffer.subarray(starts[k], starts[k + 1]));
      }
      const lastStart = starts[starts.length - 1];
      return {
        nals,
        completeBytes: buffer.subarray(0, lastStart),
        remainder: buffer.subarray(lastStart)
      };
    }

    async function startH264Stream() {
      stopH264Stream();
      const canUseWebCodecs = typeof window.VideoDecoder !== 'undefined';
      const canUseMse = typeof JMuxer !== 'undefined' && (window.MediaSource || window.ManagedMediaSource);
      if (!streaming || quality !== 'h264') {
        return;
      }
      if (!canUseWebCodecs && !canUseMse) {
        quality = 'low';
        document.getElementById('selQuality').value = 'low';
        fetchFrame(true);
        return;
      }

      // Show 1 initial snapshot immediately so the screen isn't blank before first H.264 frame
      fetchFrame(true);

      try {
        let useWebCodecs = canUseWebCodecs;
        let spsNal = null;
        let ppsNal = null;
        let decoderConfigured = false;
        let timestampUs = 0;

        if (useWebCodecs) {
          webCodecsDecoder = new VideoDecoder({
            output: (frame) => {
              if (quality === 'h264' && streaming) {
                if (liveCanvas.width !== frame.displayWidth || liveCanvas.height !== frame.displayHeight) {
                  liveCanvas.width = frame.displayWidth;
                  liveCanvas.height = frame.displayHeight;
                }
                if (liveCanvas.style.display === 'none') {
                  liveCanvas.style.display = 'block';
                  videoEl.style.display = 'none';
                  imgEl.style.display = 'none';
                }
                liveCtx.drawImage(frame, 0, 0);
              }
              frame.close();
            },
            error: () => {
              useWebCodecs = false;
            }
          });
        }

        if (canUseMse) {
          jmuxer = new JMuxer({
            node: 'liveVideo',
            mode: 'video',
            flushingTime: 0,
            clearBuffer: true,
            debug: false
          });
        }

        h264Abort = new AbortController();
        const res = await fetch('/api/live/h264-stream?t=' + Date.now(), {
          signal: h264Abort.signal
        });
        if (!res.ok || !res.body) return;

        const reader = res.body.getReader();
        let pending = new Uint8Array(0);
        let lastFeedAt = Date.now();
        let gotFirstVideo = false;

        while (streaming && quality === 'h264') {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || value.byteLength === 0) continue;

          const merged = new Uint8Array(pending.length + value.length);
          merged.set(pending, 0);
          merged.set(value, pending.length);

          const parsed = extractCompleteNals(merged);
          pending = parsed.remainder;
          if (parsed.nals.length === 0) continue;

          if (useWebCodecs && webCodecsDecoder && webCodecsDecoder.state !== 'closed') {
            for (const nal of parsed.nals) {
              const nalType = nal[4] & 0x1f;
              if (nalType === 7) {
                spsNal = nal;
              } else if (nalType === 8) {
                ppsNal = nal;
              }
              if (!decoderConfigured && spsNal && spsNal.length >= 8) {
                const profileHex =
                  spsNal[5].toString(16).padStart(2, '0') +
                  spsNal[6].toString(16).padStart(2, '0') +
                  spsNal[7].toString(16).padStart(2, '0');
                try {
                  webCodecsDecoder.configure({
                    codec: 'avc1.' + profileHex,
                    optimizeForLatency: true
                  });
                  decoderConfigured = true;
                } catch {
                  useWebCodecs = false;
                  break;
                }
              }
              if (decoderConfigured && (nalType === 5 || nalType === 1)) {
                let dataToFeed = nal;
                if (nalType === 5 && spsNal && ppsNal) {
                  dataToFeed = new Uint8Array(spsNal.length + ppsNal.length + nal.length);
                  dataToFeed.set(spsNal, 0);
                  dataToFeed.set(ppsNal, spsNal.length);
                  dataToFeed.set(nal, spsNal.length + ppsNal.length);
                }
                try {
                  webCodecsDecoder.decode(
                    new EncodedVideoChunk({
                      type: nalType === 5 ? 'key' : 'delta',
                      timestamp: (timestampUs += 16666),
                      data: dataToFeed
                    })
                  );
                } catch {}
              }
            }
          } else if (jmuxer && parsed.completeBytes) {
            const now = Date.now();
            const deltaMs = Math.max(16, Math.min(200, now - lastFeedAt));
            lastFeedAt = now;
            if (!gotFirstVideo) {
              gotFirstVideo = true;
              videoEl.style.display = 'block';
              liveCanvas.style.display = 'none';
              imgEl.style.display = 'none';
              videoEl.play().catch(() => {});
            }
            jmuxer.feed({ video: parsed.completeBytes, duration: deltaMs });
            try {
              if (videoEl.buffered && videoEl.buffered.length > 0) {
                const end = videoEl.buffered.end(videoEl.buffered.length - 1);
                if (end - videoEl.currentTime > 0.12) {
                  videoEl.currentTime = end - 0.01;
                }
              }
            } catch {}
          }
        }
      } catch (e) {
        // Reconnect if stream ended
      }
      if (streaming && quality === 'h264') {
        setTimeout(() => { if (streaming && quality === 'h264') startH264Stream(); }, 300);
      }
    }

    async function fetchFrame(fresh = false) {
      if (inFlight) return;
      inFlight = true;
      try {
        const qParam = quality === 'h264' ? 'low' : quality;
        const res = await fetch('/api/live/frame?fresh=' + (fresh ? '1' : '0') + '&q=' + qParam + '&t=' + Date.now());
        if (!res.ok) return;
        const w = Number(res.headers.get('X-Screen-Width'));
        const h = Number(res.headers.get('X-Screen-Height'));
        if (w > 0 && h > 0) { screenW = w; screenH = h; }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const old = imgEl.src;
        imgEl.src = url;
        if (old && old.startsWith('blob:')) URL.revokeObjectURL(old);
      } catch {} finally {
        inFlight = false;
      }
    }

    function toPhone(clientX, clientY) {
      const activeEl =
        liveCanvas.style.display !== 'none'
          ? liveCanvas
          : videoEl.style.display !== 'none'
          ? videoEl
          : imgEl;
      const rect = activeEl.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      const rx = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const ry = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
      return { x: Math.round(rx * screenW), y: Math.round(ry * screenH) };
    }

    function renderBox(b) {
      if (!b) { boxOverlay.style.display = 'none'; return; }
      boxOverlay.style.display = 'block';
      boxOverlay.style.left = ((b.minX / screenW) * 100) + '%';
      boxOverlay.style.top = ((b.minY / screenH) * 100) + '%';
      boxOverlay.style.width = (((b.maxX - b.minX) / screenW) * 100) + '%';
      boxOverlay.style.height = (((b.maxY - b.minY) / screenH) * 100) + '%';
    }

    viewport.addEventListener('pointerdown', (e) => {
      const pt = toPhone(e.clientX, e.clientY);
      if (!pt) return;
      viewport.setPointerCapture(e.pointerId);
      dragStart = pt;
      dragCur = pt;
      pointerDownTime = Date.now();
    });

    viewport.addEventListener('pointermove', (e) => {
      const pt = toPhone(e.clientX, e.clientY);
      if (!pt) return;
      coordText.textContent = pt.x + ',' + pt.y;
      if (dragStart) {
        dragCur = pt;
        if (mode === 'box') {
          renderBox({
            minX: Math.min(dragStart.x, dragCur.x),
            maxX: Math.max(dragStart.x, dragCur.x),
            minY: Math.min(dragStart.y, dragCur.y),
            maxY: Math.max(dragStart.y, dragCur.y)
          });
        }
      }
    });

    viewport.addEventListener('pointercancel', (e) => {
      try {
        if (viewport.hasPointerCapture && viewport.hasPointerCapture(e.pointerId)) {
          viewport.releasePointerCapture(e.pointerId);
        }
      } catch (err) {}
      dragStart = null;
      dragCur = null;
      pointerDownTime = 0;
    });

    viewport.addEventListener('pointerup', async (e) => {
      try {
        if (viewport.hasPointerCapture && viewport.hasPointerCapture(e.pointerId)) {
          viewport.releasePointerCapture(e.pointerId);
        }
      } catch (err) {}
      if (!dragStart) return;
      const sPt = dragStart;
      const endPt = dragCur || toPhone(e.clientX, e.clientY) || dragStart;
      const pressDur = pointerDownTime ? Date.now() - pointerDownTime : 0;
      dragStart = null; dragCur = null; pointerDownTime = 0;
      const dx = Math.abs(endPt.x - sPt.x), dy = Math.abs(endPt.y - sPt.y);
      const dist = Math.hypot(dx, dy);

      if (mode === 'box') {
        if (dx < 8 && dy < 8) { toast('Point: ' + endPt.x + ' ' + endPt.y); return; }
        selectedBox = {
          minX: Math.min(sPt.x, endPt.x),
          maxX: Math.max(sPt.x, endPt.x),
          minY: Math.min(sPt.y, endPt.y),
          maxY: Math.max(sPt.y, endPt.y)
        };
        renderBox(selectedBox);
        const str = selectedBox.minX + '-' + selectedBox.maxX + ' ' + selectedBox.minY + '-' + selectedBox.maxY;
        boxRangeText.textContent = str;
        cropDrawer.classList.add('show');
        toast('Box: ' + str);
        return;
      }

      if (dist > 25) {
        const swipeDur = Math.max(120, Math.min(600, pressDur || 250));
        toast('Swipe (' + sPt.x + ',' + sPt.y + ')→(' + endPt.x + ',' + endPt.y + ')');
        await fetch('/api/live/swipe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ x1: sPt.x, y1: sPt.y, x2: endPt.x, y2: endPt.y, durationMs: swipeDur })
        }).catch((err) => { toast('Swipe error: ' + err.message); });
        if (quality !== 'h264') setTimeout(() => fetchFrame(true), 250);
      } else if (pressDur >= 400) {
        tapMarker.style.display = 'block';
        tapMarker.style.left = ((endPt.x / screenW) * 100) + '%';
        tapMarker.style.top = ((endPt.y / screenH) * 100) + '%';
        setTimeout(() => { tapMarker.style.display = 'none'; }, 1200);
        toast('Hold (' + endPt.x + ', ' + endPt.y + ') for ' + pressDur + 'ms');
        await fetch('/api/live/hold', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ x: endPt.x, y: endPt.y, durationMs: pressDur })
        }).catch((err) => { toast('Hold error: ' + err.message); });
        if (quality !== 'h264') setTimeout(() => fetchFrame(true), 250);
      } else {
        tapMarker.style.display = 'block';
        tapMarker.style.left = ((endPt.x / screenW) * 100) + '%';
        tapMarker.style.top = ((endPt.y / screenH) * 100) + '%';
        setTimeout(() => { tapMarker.style.display = 'none'; }, 1200);
        toast('Tap (' + endPt.x + ', ' + endPt.y + ')');
        await fetch('/api/live/tap', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ x: endPt.x, y: endPt.y })
        }).catch((err) => { toast('Tap error: ' + err.message); });
        if (quality !== 'h264') setTimeout(() => fetchFrame(true), 250);
      }
    });

    document.getElementById('btnTouch').onclick = () => {
      mode = 'touch';
      document.getElementById('btnTouch').className = 'btn-green';
      document.getElementById('btnBox').className = '';
      if (!selectedBox) cropDrawer.classList.remove('show');
    };
    document.getElementById('btnBox').onclick = () => {
      mode = 'box';
      document.getElementById('btnBox').className = 'btn-amber';
      document.getElementById('btnTouch').className = '';
      cropDrawer.classList.add('show');
    };
    document.getElementById('btnStream').onclick = (e) => {
      streaming = !streaming;
      e.target.textContent = streaming ? '● Live' : '○ Pause';
      e.target.className = streaming ? 'btn-green' : '';
      if (!streaming) stopH264Stream();
      else if (quality === 'h264') startH264Stream();
    };
    document.getElementById('selQuality').onchange = (e) => {
      quality = e.target.value;
      if (quality === 'h264') {
        startH264Stream();
      } else {
        stopH264Stream();
        fetchFrame(true);
      }
    };
    document.getElementById('btnRefresh').onclick = () => {
      if (quality === 'h264') startH264Stream();
      else fetchFrame(true);
    };
    document.getElementById('btnCopyRange').onclick = () => {
      if (!selectedBox) return;
      const s = selectedBox.minX + '-' + selectedBox.maxX + ' ' + selectedBox.minY + '-' + selectedBox.maxY;
      navigator.clipboard.writeText(s);
      toast('Copied ' + s);
    };
    document.getElementById('btnClearBox').onclick = () => {
      selectedBox = null;
      renderBox(null);
      boxRangeText.textContent = 'Drag box on screen...';
      if (mode !== 'box') cropDrawer.classList.remove('show');
    };
    document.getElementById('btnSaveCrop').onclick = async () => {
      if (!selectedBox) { toast('Drag a box first'); return; }
      const fileName = document.getElementById('inpFileName').value || 'crop.png';
      const r = await fetch('/api/live/crop-save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...selectedBox, fileName })
      }).then(x => x.json());
      if (r.success) toast('Saved ' + r.fileName);
      else toast('Error: ' + r.message);
    };
    document.getElementById('btnStopServer').onclick = async () => {
      toast('Stopping Live Server (:4444)...');
      await fetch('/api/live/stop', { method: 'POST' });
      streaming = false;
      toast('Live Server Stopped');
    };

    async function sendKey(keyCode, label) {
      toast('Key: ' + label);
      await fetch('/api/live/key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyCode })
      });
      setTimeout(() => fetchFrame(true), 350);
    }

    let loopTimer = null;
    function resetTimer() {
      if (loopTimer) clearInterval(loopTimer);
      // NEVER run screencap polling while H.264 video stream is active!
      loopTimer = setInterval(() => {
        if (streaming && quality !== 'h264') {
          fetchFrame(false);
        }
      }, intervalMs);
    }

    fetchStatus();
    startH264Stream();
    resetTimer();
    setInterval(fetchStatus, 3000);
  </script>
</body>
</html>`;

export class LiveController {
  private static liveServer: http.Server | null = null;
  private static currentMode: LiveMode | null = null;
  private static tunnelProcess: ChildProcess | null = null;
  private static publicUrl: string | null = null;
  private static startedAt: number | null = null;
  private static lastError: string | null = null;
  private static framePromise: Promise<CachedFrame> | null = null;
  private static lastFrame: CachedFrame | null = null;
  private static requestHandler: Express | null = null;
  private static activeH264Proc: ChildProcess | null = null;
  private static workingH264SizeIdx = 0;

  /**
   * Streams raw H.264 NAL units directly from Android's hardware MediaCodec encoder.
   * Automatically verifies the 0x00 0x00 0x00 0x01 Annex-B start code so if a phone's MediaCodec
   * rejects a resolution (and prints an error text to stdout), it immediately switches to the next
   * supported resolution without sending corrupt text to the browser!
   */
  public static async streamH264(req: Request, res: express.Response): Promise<void> {
    if (this.activeH264Proc) {
      try {
        this.activeH264Proc.kill('SIGTERM');
      } catch {}
      this.activeH264Proc = null;
    }

    const { botManager } = await import('./botManager');
    const adb = botManager.getAdbController();
    const devices = await adb.getDevices();
    const online =
      devices.find((d) => d.state === 'device' && d.serial.startsWith('127.0.0.1:')) ||
      devices.find((d) => d.state === 'device');
    const baseArgs: string[] = [];
    if (online?.serial) {
      baseArgs.push('-s', online.serial);
    }

    res.setHeader('Content-Type', 'video/h264');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Connection', 'keep-alive');

    const sizeProfiles: Array<string | null> = ['540x1200', '720x1600', '720x1280', '540x960', null];
    let closed = false;

    const trySpawnProfile = (profileIdx: number) => {
      if (closed || profileIdx >= sizeProfiles.length) {
        if (!res.writableEnded) res.end();
        return;
      }

      const sizeArg = sizeProfiles[profileIdx];
      const args = [
        ...baseArgs,
        'exec-out',
        'screenrecord',
        '--output-format=h264',
        ...(sizeArg ? ['--size', sizeArg] : []),
        '--bit-rate',
        '4000000',
        '-'
      ];

      const proc = spawn('adb', args, { stdio: ['ignore', 'pipe', 'ignore'] });
      this.activeH264Proc = proc;

      let verifiedH264 = false;
      let headerBuf = Buffer.alloc(0);

      // Nudge SurfaceFlinger once after 150ms so static screens emit an immediate keyframe
      setTimeout(() => {
        if (!closed && this.activeH264Proc === proc) {
          spawn('adb', [...baseArgs, 'shell', 'input', 'motionevent', 'CANCEL', '0', '0'], {
            stdio: 'ignore'
          });
        }
      }, 150);

      proc.stdout?.on('data', (chunk: Buffer) => {
        if (closed || res.writableEnded) return;

        if (!verifiedH264) {
          headerBuf = Buffer.concat([headerBuf, chunk]);
          if (headerBuf.length < 4) return;

          // Every valid H.264 Annex-B stream starts with 00 00 00 01 (or 00 00 01)
          const isAnnexB =
            (headerBuf[0] === 0x00 &&
              headerBuf[1] === 0x00 &&
              headerBuf[2] === 0x00 &&
              headerBuf[3] === 0x01) ||
            (headerBuf[0] === 0x00 && headerBuf[1] === 0x00 && headerBuf[2] === 0x01);

          if (!isAnnexB) {
            // `screenrecord` printed an error message (e.g. unsupported resolution) -> try next size!
            try {
              proc.kill('SIGTERM');
            } catch {}
            return;
          }

          verifiedH264 = true;
          this.workingH264SizeIdx = profileIdx;
          res.write(headerBuf);
          headerBuf = Buffer.alloc(0);
          return;
        }

        res.write(chunk);
      });

      proc.on('exit', () => {
        if (this.activeH264Proc === proc) {
          this.activeH264Proc = null;
        }
        if (!closed && !verifiedH264) {
          trySpawnProfile(profileIdx + 1);
          return;
        }
        if (!res.writableEnded) {
          res.end();
        }
      });

      proc.on('error', () => {
        if (!closed && !verifiedH264) {
          trySpawnProfile(profileIdx + 1);
          return;
        }
        if (!res.writableEnded) {
          res.end();
        }
      });
    };

    trySpawnProfile(this.workingH264SizeIdx);

    req.on('close', () => {
      closed = true;
      if (this.activeH264Proc) {
        try {
          this.activeH264Proc.kill('SIGTERM');
        } catch {}
        this.activeH264Proc = null;
      }
      if (!res.writableEnded) {
        res.end();
      }
    });
  }

  /**
   * Returns 'hd' (lossless PNG), 'med' (2x downsampled JPEG), or 'low' (4x downsampled 270x600 ~12KB JPEG).
   */
  public static getStreamQualityMode(req: Request): 'low' | 'med' | 'hd' {
    const q = String(req.query.q || 'low').toLowerCase();
    if (q === 'hd') return 'hd';
    if (q === 'auto' || q === 'med') return 'med';
    return 'low';
  }

  /**
   * Downsamples the raw RGBA buffer directly in RAM (skipping PNG encode/decode completely!)
   * and encodes a tiny ~12KB JPEG (step=4, 270x600, quality=35) in ~4ms.
   */
  public static async getOrCreateFastJpeg(frame: CachedFrame, mode: 'low' | 'med' = 'low'): Promise<Buffer> {
    if (mode === 'low' && frame.fastJpegLow) return frame.fastJpegLow;
    if (mode === 'med' && frame.fastJpegMed) return frame.fastJpegMed;

    const srcW = frame.width;
    const srcH = frame.height;
    const step = mode === 'low' ? 4 : 2; // 4x = 270x600 (~12 KB JPEG!), 2x = 540x1200 (~40 KB JPEG)
    const dstW = Math.max(1, Math.floor(srcW / step));
    const dstH = Math.max(1, Math.floor(srcH / step));

    const dst = new Jimp({ width: dstW, height: dstH, color: 0x000000ff });
    const srcData = frame.rawScreen.data;
    const dstData = dst.bitmap.data;

    let dstIdx = 0;
    for (let y = 0; y < dstH; y++) {
      const srcRowOffset = y * step * srcW;
      for (let x = 0; x < dstW; x++) {
        const srcIdx = (srcRowOffset + x * step) * 4;
        dstData[dstIdx] = srcData[srcIdx];
        dstData[dstIdx + 1] = srcData[srcIdx + 1];
        dstData[dstIdx + 2] = srcData[srcIdx + 2];
        dstData[dstIdx + 3] = 255;
        dstIdx += 4;
      }
    }

    const jpegQuality = mode === 'low' ? 35 : 60;
    const jpegBuf = await dst.getBuffer('image/jpeg', { quality: jpegQuality });
    if (mode === 'low') {
      frame.fastJpegLow = jpegBuf;
    } else {
      frame.fastJpegMed = jpegBuf;
    }
    return jpegBuf;
  }

  public static async getOrCreateFullPng(frame: CachedFrame): Promise<Buffer> {
    if (frame.fullPng) return frame.fullPng;
    const pngBuf = await TemplateMatcher.cropRawToPng(frame.rawScreen);
    frame.fullPng = pngBuf;
    return pngBuf;
  }

  /**
   * Subsamples the raw RGBA buffer in RAM (~1ms) and compresses with native C++ zlib level 1 (~2ms)
   * with ZERO PNG/JPEG encoding on the phone! The browser gunzips natively and renders via <canvas> putImageData().
   */
  public static getOrCreateRawRgbaGzip(
    frame: CachedFrame,
    mode: 'low' | 'med' | 'hd' = 'med'
  ): { gzipBuf: Buffer; w: number; h: number } {
    if (mode === 'low' && frame.rawRgbaLowGzip) return frame.rawRgbaLowGzip;
    if (mode !== 'low' && frame.rawRgbaMedGzip) return frame.rawRgbaMedGzip;

    const srcW = frame.width;
    const srcH = frame.height;
    const step = mode === 'low' ? 3 : mode === 'hd' ? 1 : 2;
    const dstW = Math.max(1, Math.floor(srcW / step));
    const dstH = Math.max(1, Math.floor(srcH / step));

    const srcData = frame.rawScreen.data;
    let rawOut: Buffer;

    if (step === 1) {
      rawOut = srcData;
    } else {
      rawOut = Buffer.allocUnsafe(dstW * dstH * 4);
      let dstIdx = 0;
      for (let y = 0; y < dstH; y++) {
        const srcRowOffset = y * step * srcW;
        for (let x = 0; x < dstW; x++) {
          const srcIdx = (srcRowOffset + x * step) * 4;
          rawOut[dstIdx] = srcData[srcIdx];
          rawOut[dstIdx + 1] = srcData[srcIdx + 1];
          rawOut[dstIdx + 2] = srcData[srcIdx + 2];
          rawOut[dstIdx + 3] = 255;
          dstIdx += 4;
        }
      }
    }

    const gzipBuf = zlib.gzipSync(rawOut, { level: 1 });
    const result = { gzipBuf, w: dstW, h: dstH };
    if (mode === 'low') {
      frame.rawRgbaLowGzip = result;
    } else if (mode === 'med') {
      frame.rawRgbaMedGzip = result;
    }
    return result;
  }

  private static getOrCreateExpressApp(): Express {
    if (this.requestHandler) return this.requestHandler;

    const app = express();
    app.use(express.json({ limit: '50mb' }));

    app.get('/api/status', async (_req, res) => {
      try {
        const { botManager } = await import('./botManager');
        const status = await botManager.getStatus();
        res.json({ success: true, ...status });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
      }
    });

    app.get('/api/live/status', (_req, res) => {
      res.json({
        success: true,
        tunnel: this.getStatus(),
        runningMacro: MacroManager.getRunningMacro(),
        isFindRunning: MacroManager.isFindRunning(),
        startState: MacroManager.loadStartState()
      });
    });

    app.post('/api/live/stop', async (_req, res) => {
      const status = await this.stopLiveTunnel();
      res.json({ success: true, tunnel: status });
    });

    app.get('/api/live/h264-stream', async (req, res) => {
      try {
        await this.streamH264(req, res);
      } catch (err: any) {
        if (!res.headersSent) {
          res.status(500).json({ success: false, message: err.message });
        }
      }
    });

    app.get('/api/live/raw-frame', async (req, res) => {
      try {
        const forceFresh = req.query.fresh === '1';
        const frame = await this.captureLiveFrame(forceFresh);
        const qMode = this.getStreamQualityMode(req);
        const rawData = this.getOrCreateRawRgbaGzip(frame, qMode);

        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('X-Screen-Width', String(frame.width));
        res.setHeader('X-Screen-Height', String(frame.height));
        res.setHeader('X-Raw-Width', String(rawData.w));
        res.setHeader('X-Raw-Height', String(rawData.h));
        res.send(rawData.gzipBuf);
      } catch (err: any) {
        res.status(500).json({ success: false, message: err.message });
      }
    });

    app.get('/api/live/frame', async (req, res) => {
      try {
        const forceFresh = req.query.fresh === '1';
        const frame = await this.captureLiveFrame(forceFresh);
        const qMode = this.getStreamQualityMode(req);

        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('X-Screen-Width', String(frame.width));
        res.setHeader('X-Screen-Height', String(frame.height));

        if (qMode !== 'hd') {
          const jpegBuf = await this.getOrCreateFastJpeg(frame, qMode);
          res.setHeader('Content-Type', 'image/jpeg');
          res.send(jpegBuf);
        } else {
          const pngBuf = await this.getOrCreateFullPng(frame);
          res.setHeader('Content-Type', 'image/png');
          res.send(pngBuf);
        }
      } catch (err: any) {
        res.status(500).json({ success: false, message: err.message });
      }
    });

    app.post('/api/live/tap', async (req, res) => {
      try {
        const { botManager } = await import('./botManager');
        const x = Math.round(Number(req.body.x) || 0);
        const y = Math.round(Number(req.body.y) || 0);
        const durationMs = Math.round(Number(req.body.durationMs || req.body.holdMs) || 0);
        let result;
        if (durationMs >= 100) {
          result = await botManager.getAdbController().hold(x, y, durationMs);
        } else {
          result = await botManager.getAdbController().tap(x, y);
        }
        res.json({ success: true, result });
      } catch (err: any) {
        res.status(500).json({ success: false, message: err.message });
      }
    });

    app.post('/api/live/hold', async (req, res) => {
      try {
        const { botManager } = await import('./botManager');
        const x = Math.round(Number(req.body.x) || 0);
        const y = Math.round(Number(req.body.y) || 0);
        const durationMs = Math.max(50, Math.round(Number(req.body.durationMs || req.body.holdMs) || 1000));
        const result = await botManager.getAdbController().hold(x, y, durationMs);
        res.json({ success: true, result });
      } catch (err: any) {
        res.status(500).json({ success: false, message: err.message });
      }
    });

    app.post('/api/live/swipe', async (req, res) => {
      try {
        const { botManager } = await import('./botManager');
        const x1 = Math.round(Number(req.body.x1) || 0);
        const y1 = Math.round(Number(req.body.y1) || 0);
        const x2 = Math.round(Number(req.body.x2) || 0);
        const y2 = Math.round(Number(req.body.y2) || 0);
        const durationMs = Math.max(80, Math.round(Number(req.body.durationMs) || 300));
        await botManager.getAdbController().swipe(x1, y1, x2, y2, durationMs);
        res.json({ success: true, x1, y1, x2, y2, durationMs });
      } catch (err: any) {
        res.status(500).json({ success: false, message: err.message });
      }
    });

    app.post('/api/live/key', async (req, res) => {
      try {
        const { botManager } = await import('./botManager');
        const keyCode = req.body.keyCode ?? 4;
        await botManager.getAdbController().keyEvent(keyCode);
        res.json({ success: true, keyCode });
      } catch (err: any) {
        res.status(500).json({ success: false, message: err.message });
      }
    });

    app.post('/api/live/crop-save', async (req, res) => {
      try {
        const minX = Math.round(Number(req.body.minX) || 0);
        const maxX = Math.round(Number(req.body.maxX) || 100);
        const minY = Math.round(Number(req.body.minY) || 0);
        const maxY = Math.round(Number(req.body.maxY) || 100);
        const rawName = String(req.body.fileName || `crop_${Date.now()}.png`).trim();
        const cleanName = path.basename(rawName);
        const savedFileName = /\.(png|jpg|jpeg)$/i.test(cleanName) ? cleanName : `${cleanName}.png`;

        // Always crop directly from the original 100% lossless full-res raw RGBA buffer in RAM!
        const last = this.getLastFrame() || (await this.captureLiveFrame(true));
        const lowX = Math.max(0, Math.min(minX, maxX));
        const highX = Math.min(last.width, Math.max(minX, maxX));
        const lowY = Math.max(0, Math.min(minY, maxY));
        const highY = Math.min(last.height, Math.max(minY, maxY));
        const croppedBuffer = await TemplateMatcher.cropRawToPng(last.rawScreen, {
          minX: lowX,
          maxX: highX,
          minY: lowY,
          maxY: highY
        });
        const cropped = {
          buffer: croppedBuffer,
          width: Math.max(1, highX - lowX),
          height: Math.max(1, highY - lowY)
        };

        const homeDir = process.env.HOME || os.homedir() || '';
        const sharedDirs = [
          path.resolve(homeDir, 'storage/shared/autoclick'),
          '/sdcard/autoclick',
          '/storage/emulated/0/autoclick'
        ];
        let targetDir = sharedDirs[0];
        for (const dir of sharedDirs) {
          if (fs.existsSync(dir) || fs.existsSync(path.dirname(dir))) {
            targetDir = dir;
            break;
          }
        }
        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true });
        }

        const fullSavePath = path.join(targetDir, savedFileName);
        await fs.promises.writeFile(fullSavePath, cropped.buffer);

        res.json({
          success: true,
          fileName: savedFileName,
          path: fullSavePath,
          width: cropped.width,
          height: cropped.height
        });
      } catch (err: any) {
        res.status(500).json({ success: false, message: err.message });
      }
    });

    app.get('*', (_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(STANDALONE_LIVE_HTML);
    });

    this.requestHandler = app;
    return app;
  }

  public static isActive(): boolean {
    return Boolean(this.liveServer);
  }

  public static getLocalUrl(port = LIVE_PORT): string {
    try {
      const interfaces = os.networkInterfaces();
      const preferredNames = ['wlan0', 'eth0', 'en0', 'wlan1', 'ap0'];

      for (const name of preferredNames) {
        const list = interfaces[name];
        if (!list) continue;
        for (const iface of list) {
          if (iface.family === 'IPv4' && !iface.internal) {
            return `http://${iface.address}:${port}`;
          }
        }
      }

      for (const list of Object.values(interfaces)) {
        if (!list) continue;
        for (const iface of list) {
          if (iface.family === 'IPv4' && !iface.internal) {
            return `http://${iface.address}:${port}`;
          }
        }
      }
    } catch {
      // ignore interface errors
    }
    return `http://127.0.0.1:${port}`;
  }

  public static async stopAllLocalScriptsForLive(logFn?: (msg: string) => void): Promise<string | null> {
    const { stopSub, getRunningSubOption } = await import('./commands/sub');
    const { stopHold, stopFarm } = await import('./commands/index');
    const { botManager } = await import('./botManager');
    const adb = botManager.getAdbController();

    const subOpt = getRunningSubOption();
    if (subOpt) {
      logFn?.(`🛑 Stopping running "sub ${subOpt}" before starting Live Control...`);
      stopSub();
    }
    stopHold();
    stopFarm();
    await adb.stopAllTaps();

    if (MacroManager.isFindRunning()) {
      logFn?.('⏳ Waiting for "find" to finish before starting Live Control...');
      await MacroManager.waitForFind();
    }
    const running = MacroManager.getRunningMacro();
    if (running) {
      logFn?.(`🛑 Stopping running macro "${running}" at safe boundary before starting Live Control...`);
      await MacroManager.stopAllAndWait();
      return running;
    }
    return subOpt ? `sub ${subOpt}` : null;
  }

  private static async startPort4444Server(port = LIVE_PORT, bindHost = '0.0.0.0'): Promise<void> {
    if (this.liveServer) return;
    const handler = this.getOrCreateExpressApp();

    await new Promise<void>((resolve, reject) => {
      const srv = http.createServer(handler);
      srv.on('error', (err) => {
        reject(err);
      });
      srv.listen(port, bindHost, () => {
        this.liveServer = srv;
        resolve();
      });
    });
  }

  /**
   * Starts Live Control on port 4444 in the requested mode:
   * - 'local': Local Wi-Fi only (0.0.0.0:4444, no cloudflared)
   * - 'net': Internet only (127.0.0.1:4444 + cloudflared tunnel)
   * - 'all': Both Local Wi-Fi and Internet (0.0.0.0:4444 + cloudflared tunnel)
   */
  public static async startLiveTunnel(
    port = LIVE_PORT,
    logFn?: (msg: string) => void,
    mode: LiveMode = 'all'
  ): Promise<LiveTunnelStatus> {
    await this.stopAllLocalScriptsForLive(logFn);

    await this.stopLiveTunnel();
    this.currentMode = mode;
    this.lastError = null;
    this.startedAt = Date.now();

    const bindHost = mode === 'net' ? '127.0.0.1' : '0.0.0.0';
    const localUrl = mode === 'net' ? null : this.getLocalUrl(port);

    try {
      await this.startPort4444Server(port, bindHost);
      logFn?.(`🟢 Started Live Control server (${mode}) on ${bindHost}:${port}`);
    } catch (err: any) {
      this.lastError = `Failed to bind port ${port}: ${err.message}`;
      return {
        active: false,
        mode: null,
        port,
        localUrl,
        publicUrl: null,
        startedAt: null,
        error: this.lastError
      };
    }

    // If 'local' only, return immediately without spawning cloudflared!
    if (mode === 'local') {
      return {
        active: true,
        mode: 'local',
        port,
        localUrl,
        publicUrl: null,
        startedAt: this.startedAt,
        error: null
      };
    }

    // For 'net' or 'all', start cloudflared tunnel
    return await new Promise<LiveTunnelStatus>((resolve) => {
      let resolved = false;
      const finish = (status: LiveTunnelStatus) => {
        if (!resolved) {
          resolved = true;
          resolve(status);
        }
      };

      try {
        const proc = spawn(
          'cloudflared',
          ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`],
          {
            stdio: ['ignore', 'pipe', 'pipe']
          }
        );

        this.tunnelProcess = proc;

        const handleOutput = (data: Buffer) => {
          const text = data.toString('utf-8');
          const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
          if (match && match[0]) {
            this.publicUrl = match[0];
            finish({
              active: true,
              mode,
              port,
              localUrl,
              publicUrl: this.publicUrl,
              startedAt: this.startedAt,
              error: null
            });
          }
        };

        proc.stdout?.on('data', handleOutput);
        proc.stderr?.on('data', handleOutput);

        proc.on('error', (err) => {
          this.lastError = `cloudflared error: ${err.message}`;
          this.tunnelProcess = null;
          this.publicUrl = null;
          finish({
            active: Boolean(this.liveServer),
            mode,
            port,
            localUrl,
            publicUrl: null,
            startedAt: this.startedAt,
            error: this.lastError
          });
        });

        proc.on('exit', () => {
          if (this.tunnelProcess === proc) {
            this.tunnelProcess = null;
            this.publicUrl = null;
          }
          if (!resolved) {
            finish({
              active: Boolean(this.liveServer),
              mode,
              port,
              localUrl,
              publicUrl: null,
              startedAt: this.startedAt,
              error: this.lastError || 'cloudflared exited'
            });
          }
        });

        setTimeout(() => {
          if (!resolved) {
            finish({
              active: Boolean(this.liveServer),
              mode,
              port,
              localUrl,
              publicUrl: this.publicUrl,
              startedAt: this.startedAt,
              error: this.publicUrl ? null : 'Timed out waiting for trycloudflare.com URL'
            });
          }
        }, 12000);
      } catch (err: any) {
        this.lastError = err.message;
        finish({
          active: Boolean(this.liveServer),
          mode,
          port,
          localUrl,
          publicUrl: null,
          startedAt: this.startedAt,
          error: err.message
        });
      }
    });
  }

  public static async stopLiveTunnel(): Promise<LiveTunnelStatus> {
    if (this.tunnelProcess) {
      try {
        this.tunnelProcess.kill('SIGTERM');
      } catch {
        // ignore
      }
      this.tunnelProcess = null;
    }

    if (this.liveServer) {
      const srv = this.liveServer;
      this.liveServer = null;
      await new Promise<void>((resolve) => {
        try {
          srv.closeAllConnections?.();
          srv.close(() => resolve());
        } catch {
          resolve();
        }
      });
    }

    this.currentMode = null;
    this.publicUrl = null;
    this.startedAt = null;
    this.lastFrame = null;

    return {
      active: false,
      mode: null,
      port: LIVE_PORT,
      localUrl: this.getLocalUrl(LIVE_PORT),
      publicUrl: null,
      startedAt: null,
      error: null
    };
  }

  public static getStatus(): LiveTunnelStatus {
    return {
      active: Boolean(this.liveServer),
      mode: this.currentMode,
      port: LIVE_PORT,
      localUrl: this.currentMode === 'net' ? null : this.getLocalUrl(LIVE_PORT),
      publicUrl: this.publicUrl,
      startedAt: this.startedAt,
      error: this.lastError
    };
  }

  public static async captureLiveFrame(forceFresh = false): Promise<CachedFrame> {
    if (!forceFresh && this.lastFrame && Date.now() - this.lastFrame.timestamp < 80) {
      return this.lastFrame;
    }

    if (this.framePromise) {
      return await this.framePromise;
    }

    this.framePromise = (async () => {
      try {
        const { botManager } = await import('./botManager');
        const adb = botManager.getAdbController();
        const rawScreen = await adb.screencapRaw();

        const frame: CachedFrame = {
          rawScreen,
          rawRgbaLowGzip: null,
          rawRgbaMedGzip: null,
          fastJpegLow: null,
          fastJpegMed: null,
          fullPng: null,
          width: rawScreen.width,
          height: rawScreen.height,
          timestamp: Date.now()
        };
        this.lastFrame = frame;
        return frame;
      } finally {
        this.framePromise = null;
      }
    })();

    return await this.framePromise;
  }

  public static getLastFrame() {
    return this.lastFrame;
  }
}
