const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env'), override: true });
const nodeFetch = require('node-fetch');
if (!globalThis.fetch) {
  globalThis.fetch = nodeFetch;
  globalThis.Headers = nodeFetch.Headers;
  globalThis.Request = nodeFetch.Request;
  globalThis.Response = nodeFetch.Response;
}
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const rateLimit = require('express-rate-limit');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const store = new Map(); // almacén temporal en memoria: id -> Buffer

const descriptionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  keyGenerator: (req) => req.ip,
  skip: (req) => !(req.body && req.body.productName && req.body.productName.trim()),
  handler: (req, res) => {
    res.status(429).json({ error: 'Límite alcanzado: máximo 10 descripciones por hora. Inténtalo más tarde.' });
  },
});

// ─── SPA ──────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Redimensionador de Imágenes</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg:            #07091c;
      --surface:       rgba(13,17,48,.85);
      --frame:         #080c22;
      --ink:           #f1f5f9;
      --ghost:         #94a3b8;
      --muted:         #475569;
      --pixel:         #818cf8;
      --pixel-dim:     rgba(129,140,248,.12);
      --pixel-border:  rgba(129,140,248,.32);
      --pad:           rgba(148,163,184,.1);
      --pad-soft:      rgba(148,163,184,.06);
      --signal:        #34d399;
      --signal-dim:    rgba(52,211,153,.12);
      --signal-border: rgba(52,211,153,.3);
    }

    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: var(--bg);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px 16px;
      position: relative;
      overflow-x: hidden;
    }

    /* Radial indigo glow */
    body::before {
      content: '';
      position: fixed;
      inset: 0;
      background: radial-gradient(ellipse 80% 65% at 50% 45%,
        rgba(99,102,241,.2) 0%,
        rgba(67,56,202,.08) 38%,
        transparent 70%);
      pointer-events: none;
    }

    /* Subtle dot-grid texture */
    body::after {
      content: '';
      position: fixed;
      inset: 0;
      background-image: radial-gradient(circle, rgba(255,255,255,.018) 1px, transparent 1px);
      background-size: 36px 36px;
      pointer-events: none;
    }

    .card {
      position: relative;
      z-index: 1;
      background: var(--surface);
      backdrop-filter: blur(24px);
      -webkit-backdrop-filter: blur(24px);
      border: 1px solid var(--pad);
      border-radius: 20px;
      padding: 40px;
      width: 100%;
      max-width: 500px;
      box-shadow:
        0 0 0 1px rgba(129,140,248,.05),
        0 24px 64px rgba(0,0,0,.55);
    }

    /* ── Panels ── */
    #formPanel, #resultsPanel {
      transition: opacity 0.18s ease;
    }

    #resultsPanel {
      display: none;
      opacity: 0;
    }

    /* ── Badge ── */
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 4px 12px;
      background: var(--pixel-dim);
      border: 1px solid var(--pixel-border);
      border-radius: 100px;
      font-size: .7rem;
      font-weight: 700;
      color: var(--pixel);
      letter-spacing: .07em;
      text-transform: uppercase;
      margin-bottom: 20px;
    }

    .badge-dot {
      width: 6px;
      height: 6px;
      background: var(--pixel);
      border-radius: 50%;
      box-shadow: 0 0 6px var(--pixel);
      flex-shrink: 0;
    }

    h1 {
      font-size: 1.45rem;
      font-weight: 700;
      color: var(--ink);
      letter-spacing: -.025em;
      line-height: 1.3;
      margin-bottom: 8px;
    }

    .subtitle {
      font-size: .875rem;
      color: var(--ghost);
      line-height: 1.55;
      margin-bottom: 32px;
    }

    .field { margin-bottom: 20px; }

    .field-label {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: .72rem;
      font-weight: 700;
      color: var(--ghost);
      letter-spacing: .07em;
      text-transform: uppercase;
      margin-bottom: 8px;
    }

    .optional {
      font-weight: 400;
      color: var(--muted);
      text-transform: none;
      letter-spacing: 0;
      font-size: .72rem;
    }

    input[type="text"] {
      width: 100%;
      padding: 11px 14px;
      background: rgba(255,255,255,.05);
      border: 1.5px solid rgba(148,163,184,.35);
      border-radius: 10px;
      font-size: .9rem;
      color: var(--ink);
      outline: none;
      font-family: inherit;
      box-shadow: inset 0 1px 3px rgba(0,0,0,.3);
      transition: border-color .15s, box-shadow .15s;
    }

    input[type="text"]::placeholder { color: var(--muted); }

    input[type="text"]:focus {
      border-color: var(--pixel-border);
      box-shadow: 0 0 0 3px var(--pixel-dim);
    }

    /* Hidden native file input */
    input[type="file"] { display: none; }

    .file-zone {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 6px;
      width: 100%;
      padding: 22px 16px;
      background: rgba(255,255,255,.04);
      border: 1.5px dashed rgba(148,163,184,.4);
      border-radius: 10px;
      cursor: pointer;
      text-align: center;
      transition: border-color .15s, background .15s;
    }

    .file-zone:hover {
      border-color: var(--pixel-border);
      background: var(--pixel-dim);
    }

    .file-zone-icon { font-size: 1.3rem; opacity: .45; line-height: 1; }

    .file-zone-text {
      font-size: .85rem;
      color: var(--ghost);
    }

    .file-zone-hint {
      font-size: .75rem;
      color: var(--muted);
    }

    .file-zone-preview {
      display: none;
      width: 100%;
      max-height: 160px;
      object-fit: contain;
      border-radius: 8px;
      margin-bottom: 6px;
    }

    .file-zone-name {
      font-size: .75rem;
      color: var(--pixel);
      display: none;
      margin-top: 2px;
    }

    .file-zone-wrap { position: relative; }

    .file-zone--drag {
      border-color: var(--pixel-border);
      background: var(--pixel-dim);
    }

    .fz-clear {
      display: none;
      position: absolute;
      top: 8px;
      right: 8px;
      width: 22px;
      height: 22px;
      padding: 0;
      background: rgba(0,0,0,.55);
      border: none;
      border-radius: 50%;
      color: #fff;
      font-size: .75rem;
      line-height: 22px;
      text-align: center;
      cursor: pointer;
      z-index: 2;
      transition: background .15s;
    }
    .fz-clear:hover { background: rgba(220,38,38,.8); }

    button[type="submit"] {
      width: 100%;
      padding: 13px;
      background: linear-gradient(135deg, #6366f1 0%, #818cf8 100%);
      color: #fff;
      border: none;
      border-radius: 10px;
      font-size: .95rem;
      font-weight: 600;
      cursor: pointer;
      font-family: inherit;
      letter-spacing: -.01em;
      margin-top: 8px;
      transition: opacity .15s, box-shadow .15s;
      box-shadow: 0 0 22px rgba(99,102,241,.35);
    }

    button[type="submit"]:hover:not(:disabled) {
      opacity: .9;
      box-shadow: 0 0 36px rgba(99,102,241,.5);
    }

    button[type="submit"]:active:not(:disabled) { opacity: .8; }

    button[type="submit"]:disabled {
      opacity: .55;
      cursor: not-allowed;
    }

    /* ── Error message ── */
    .error-msg {
      display: none;
      font-size: .8rem;
      color: #f87171;
      margin-top: 10px;
      text-align: center;
    }

    /* ── Results panel ── */
    .card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 28px;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--pad-soft);
    }

    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 12px;
      background: var(--signal-dim);
      border: 1px solid var(--signal-border);
      border-radius: 100px;
      font-size: .7rem;
      font-weight: 700;
      color: var(--signal);
      letter-spacing: .06em;
      text-transform: uppercase;
    }

    .status-dot {
      width: 6px;
      height: 6px;
      background: var(--signal);
      border-radius: 50%;
      box-shadow: 0 0 6px var(--signal);
      flex-shrink: 0;
    }

    .section { margin-bottom: 28px; }

    .section-label {
      font-size: .7rem;
      font-weight: 700;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: .08em;
      margin-bottom: 10px;
    }

    .description {
      background: var(--frame);
      border: 1px solid var(--pad);
      border-left: 3px solid var(--pixel);
      border-radius: 0 10px 10px 0;
      padding: 14px 16px;
      font-size: .9rem;
      line-height: 1.65;
      color: var(--ink);
    }

    .copy-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-top: 12px;
      background: transparent;
      border: 1px solid var(--pixel-border);
      color: var(--pixel);
      border-radius: 8px;
      padding: 7px 14px;
      font-size: .8rem;
      font-weight: 500;
      cursor: pointer;
      font-family: inherit;
      transition: background .15s;
    }

    .copy-btn:hover { background: var(--pixel-dim); }

    #resultsPanel img {
      width: 100%;
      border-radius: 12px;
      border: 1px solid var(--pad);
      margin-bottom: 14px;
      display: block;
    }

    a.download {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 13px;
      background: var(--signal-dim);
      border: 1px solid var(--signal-border);
      color: var(--signal);
      border-radius: 10px;
      font-weight: 600;
      font-size: .9rem;
      text-decoration: none;
      transition: background .15s;
    }

    a.download:hover { background: rgba(52,211,153,.2); }

    /* ── Back button ── */
    .back-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      width: 100%;
      background: transparent;
      border: none;
      color: var(--ghost);
      font-size: .85rem;
      font-family: inherit;
      cursor: pointer;
      padding: 10px;
      transition: color .15s;
    }

    .back-btn:hover { color: var(--ink); }

    /* ── Dimension inputs ── */
    .dim-row {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .dim-input {
      width: 90px;
      padding: 11px 14px;
      background: rgba(255,255,255,.05);
      border: 1.5px solid rgba(148,163,184,.35);
      border-radius: 10px;
      font-size: .9rem;
      color: var(--ink);
      outline: none;
      font-family: inherit;
      box-shadow: inset 0 1px 3px rgba(0,0,0,.3);
      transition: border-color .15s, box-shadow .15s;
      -moz-appearance: textfield;
    }

    .dim-input::-webkit-outer-spin-button,
    .dim-input::-webkit-inner-spin-button {
      -webkit-appearance: none;
      margin: 0;
    }

    .dim-input:focus {
      border-color: var(--pixel-border);
      box-shadow: 0 0 0 3px var(--pixel-dim);
    }

    .dim-sep {
      color: var(--ghost);
      font-size: 1.1rem;
      font-weight: 600;
      user-select: none;
    }

    .dim-hint {
      margin-top: 8px;
      font-size: .75rem;
      color: var(--muted);
    }

    /* ── Alert overlay ── */
    .alert-overlay {
      position: fixed;
      inset: 0;
      z-index: 100;
      display: none;
      align-items: center;
      justify-content: center;
      background: rgba(0,0,0,.55);
      backdrop-filter: blur(4px);
    }

    .alert-overlay.visible {
      display: flex;
    }

    .alert-box {
      background: var(--surface);
      border: 1px solid rgba(251,191,36,.3);
      border-top: 3px solid #f59e0b;
      border-radius: 16px;
      padding: 32px 28px;
      max-width: 360px;
      width: 90%;
      text-align: center;
      box-shadow: 0 24px 64px rgba(0,0,0,.6);
    }

    .alert-icon {
      font-size: 2rem;
      margin-bottom: 12px;
    }

    .alert-title {
      font-size: 1rem;
      font-weight: 700;
      color: var(--ink);
      margin-bottom: 10px;
    }

    .alert-desc {
      font-size: .875rem;
      color: var(--ghost);
      line-height: 1.6;
      margin-bottom: 20px;
    }

    .alert-desc strong { color: var(--ink); }

    .alert-confirm {
      padding: 10px 28px;
      background: linear-gradient(135deg, #f59e0b 0%, #fbbf24 100%);
      color: #07091c;
      border: none;
      border-radius: 8px;
      font-size: .9rem;
      font-weight: 700;
      cursor: pointer;
      font-family: inherit;
      transition: opacity .15s;
    }

    .alert-confirm:hover { opacity: .88; }

    /* ── Neon sign ── */
    .wrapper {
      position: relative;
      z-index: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      width: 100%;
      max-width: 500px;
    }

    .neon-sign {
      text-align: center;
      margin-bottom: 18px;
      user-select: none;
    }

    .neon-sign span {
      font-family: 'Impact', 'Arial Black', sans-serif;
      font-size: 8rem;
      letter-spacing: 0.12em;
      color: #fff0f6;
      animation: neon-flicker 7s infinite;
      text-shadow:
        0 0 2px #fff,
        0 0 6px #fff,
        0 0 12px #ff2d78,
        0 0 24px #ff2d78;
    }

    @keyframes neon-flicker {
      0%, 18%, 22%, 25%, 53%, 57%, 100% {
        color: #fff0f6;
        text-shadow:
          0 0 2px #fff,
          0 0 6px #fff,
          0 0 12px #ff2d78,
          0 0 24px #ff2d78;
      }
      20%, 24%, 55% {
        color: rgba(255, 45, 120, 0.12);
        text-shadow: none;
      }
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="neon-sign"><span>CRAZYSTORE</span></div>
    <div class="card">

    <!-- ── Form panel ── -->
    <div id="formPanel">
      <div class="badge">
        <span class="badge-dot"></span>
        IA + Imágenes
      </div>
      <h1>Redimensionador de Imágenes</h1>
      <p class="subtitle">Redimensiona tu imagen y genera descripciones de producto con IA. Completa uno o ambos campos.</p>

      <form id="uploadForm" enctype="multipart/form-data">
        <div class="field">
          <div class="field-label">
            Nombre del producto
            <span class="optional">(opcional)</span>
          </div>
          <input type="text" id="productName" name="productName"
                 placeholder="ej. Auriculares Inalámbricos con Cancelación de Ruido"
                 maxlength="100" />
          <span id="nameCounter" style="font-size:.72rem;color:var(--muted);float:right;margin-top:4px;">0 / 100</span>
        </div>

        <div class="field">
          <div class="field-label">
            Imagen
            <span class="optional">(opcional)</span>
          </div>
          <div class="file-zone-wrap">
            <label class="file-zone" for="image" id="fileZone">
              <img id="fzPreview" class="file-zone-preview" alt="" />
              <span class="file-zone-icon" id="fzIcon">🖼</span>
              <span class="file-zone-text" id="fzText">Haz clic, arrastra o pega una imagen</span>
              <span class="file-zone-hint" id="fzHint">JPG, PNG, WebP, etc.</span>
              <span class="file-zone-name" id="fzName"></span>
            </label>
            <button type="button" class="fz-clear" id="fzClear" title="Quitar imagen">✕</button>
          </div>
          <input type="file" id="image" name="image" accept="image/*" />
        </div>

        <div class="field">
          <div class="field-label">Área de imagen</div>
          <div class="dim-row">
            <input type="number" class="dim-input" id="resizeWidth"
                   name="resizeWidth" value="800" min="100" max="1000" />
            <span class="dim-sep">×</span>
            <input type="number" class="dim-input" id="resizeHeight"
                   name="resizeHeight" value="800" min="100" max="1000" />
          </div>
          <p class="dim-hint">Lienzo final: 1000 × 1000 px</p>
        </div>

        <button type="submit" id="submitBtn">Procesar →</button>
        <p class="error-msg" id="formError"></p>
      </form>
    </div>

    <!-- ── Results panel ── -->
    <div id="resultsPanel">
      <div class="card-header">
        <h1>Resultado</h1>
        <span class="status-badge">
          <span class="status-dot"></span>
          Procesado
        </span>
      </div>
      <div id="resultsContent"></div>
      <button class="back-btn" id="backBtn">← Volver</button>
    </div>

  </div>
  </div>

  <script>
    function fallbackCopy(text) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }

    function copyText(btn, text) {
      const feedback = () => {
        const original = btn.textContent;
        btn.textContent = '✓ Copiado';
        btn.style.background = 'var(--signal-dim)';
        btn.style.borderColor = 'var(--signal-border)';
        btn.style.color = 'var(--signal)';
        setTimeout(() => {
          btn.textContent = original;
          btn.style.background = '';
          btn.style.borderColor = '';
          btn.style.color = '';
        }, 1800);
      };

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(feedback).catch(() => {
          fallbackCopy(text);
          feedback();
        });
      } else {
        fallbackCopy(text);
        feedback();
      }
    }

    function escapeHtml(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function switchTo(show, hide) {
      hide.style.opacity = '0';
      setTimeout(() => {
        hide.style.display = 'none';
        show.style.display = 'block';
        void show.offsetHeight; // force reflow to trigger CSS transition
        show.style.opacity = '1';
      }, 180);
    }

    const formPanel    = document.getElementById('formPanel');
    const resultsPanel = document.getElementById('resultsPanel');
    const uploadForm   = document.getElementById('uploadForm');
    const submitBtn    = document.getElementById('submitBtn');
    const formError    = document.getElementById('formError');
    const backBtn      = document.getElementById('backBtn');

    // File zone helpers
    const imageInput = document.getElementById('image');
    const fileZone   = document.getElementById('fileZone');
    const fzClear    = document.getElementById('fzClear');

    function setFile(file) {
      if (!file || !file.type.startsWith('image/')) return;
      const dt = new DataTransfer();
      dt.items.add(file);
      imageInput.files = dt.files;
      const preview = document.getElementById('fzPreview');
      preview.src = URL.createObjectURL(file);
      preview.style.display = 'block';
      document.getElementById('fzIcon').style.display = 'none';
      document.getElementById('fzHint').style.display = 'none';
      document.getElementById('fzText').textContent = file.name;
      fzClear.style.display = 'block';
    }

    function clearFile() {
      imageInput.value = '';
      const preview = document.getElementById('fzPreview');
      preview.style.display = 'none';
      preview.src = '';
      document.getElementById('fzIcon').style.display = '';
      document.getElementById('fzHint').style.display = '';
      document.getElementById('fzText').textContent = 'Haz clic, arrastra o pega una imagen';
      fzClear.style.display = 'none';
    }

    // Native file picker
    imageInput.addEventListener('change', function () {
      if (this.files.length > 0) setFile(this.files[0]);
    });

    // Drag and drop
    fileZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      fileZone.classList.add('file-zone--drag');
    });
    fileZone.addEventListener('dragleave', () => fileZone.classList.remove('file-zone--drag'));
    fileZone.addEventListener('drop', (e) => {
      e.preventDefault();
      fileZone.classList.remove('file-zone--drag');
      const file = e.dataTransfer.files[0];
      if (file) setFile(file);
    });

    // Paste (global, skips when typing in text inputs)
    document.addEventListener('paste', (e) => {
      const tag = document.activeElement.tagName;
      const type = document.activeElement.type;
      if (tag === 'INPUT' && type !== 'file') return;
      if (tag === 'TEXTAREA') return;
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) {
          setFile(items[i].getAsFile());
          break;
        }
      }
    });

    // Clear button
    fzClear.addEventListener('click', clearFile);

    // Form submit
    uploadForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      const name = document.getElementById('productName').value.trim();
      const file = document.getElementById('image').files[0];

      if (!name && !file) {
        formError.textContent = 'Debes ingresar al menos un campo: nombre de producto o imagen.';
        formError.style.display = 'block';
        return;
      }

      formError.style.display = 'none';
      submitBtn.disabled = true;
      submitBtn.textContent = 'Procesando...';

      try {
        const res = await fetch('/resize', {
          method: 'POST',
          body: new FormData(uploadForm),
        });

        const data = await res.json();

        if (!res.ok) {
          throw new Error(data.error || 'Error desconocido');
        }

        // Build results HTML
        let html = '';

        if (data.description != null) {
          html += \`
            <div class="section">
              <p class="section-label">Opciones generadas por IA</p>\`;
              
          if (Array.isArray(data.description)) {
            data.description.forEach((opt, idx) => {
               html += \`
               <div style="margin-bottom: 20px;">
                 <div class="description" id="desc-\${idx}">\${escapeHtml(opt)}</div>
                 <button type="button" class="copy-btn" onclick="copyText(this, document.getElementById('desc-\${idx}').innerText)">Copiar Opción \${idx+1}</button>
               </div>\`;
            });
          } else {
             html += \`
               <div style="margin-bottom: 20px;">
                 <div class="description" id="desc-0">\${escapeHtml(data.description)}</div>
                 <button type="button" class="copy-btn" onclick="copyText(this, document.getElementById('desc-0').innerText)">Copiar</button>
               </div>\`;
          }
          html += \`</div>\`;
        }

        if (data.previewBase64 != null) {
          html += \`
            <div class="section">
              <p class="section-label">Vista previa</p>
              <img src="data:image/jpeg;base64,\${data.previewBase64}" alt="Vista previa de imagen redimensionada" />
              <a class="download" href="/download/\${escapeHtml(data.imageId)}">↓ Descargar JPG</a>
            </div>\`;
        }

        document.getElementById('resultsContent').innerHTML = html;
        switchTo(resultsPanel, formPanel);

      } catch (err) {
        formError.textContent = err.message;
        formError.style.display = 'block';
        submitBtn.disabled = false;
        submitBtn.textContent = 'Procesar →';
      }
    });

    // Back button
    backBtn.addEventListener('click', () => {
      switchTo(formPanel, resultsPanel);
      uploadForm.reset();
      clearFile();
      formError.style.display = 'none';
      submitBtn.disabled = false;
      submitBtn.textContent = 'Procesar →';
      document.getElementById('resizeWidth').value  = 800;
      document.getElementById('resizeHeight').value = 800;
    });

    // Character counter
    const nameInput   = document.getElementById('productName');
    const nameCounter = document.getElementById('nameCounter');
    nameInput.addEventListener('input', () => {
      const len = nameInput.value.length;
      nameCounter.textContent = len + ' / 100';
      nameCounter.style.color = len >= 90 ? '#f87171' : 'var(--muted)';
    });

  </script>
</body>
</html>`);
});

// ─── Procesar carga (JSON) ────────────────────────────────────────────────────
app.post('/resize', upload.single('image'), descriptionLimiter, async (req, res) => {
  try {
    const { productName } = req.body;
    const resizeWidth  = Math.min(1000, Math.max(100, parseInt(req.body.resizeWidth)  || 800));
    const resizeHeight = Math.min(1000, Math.max(100, parseInt(req.body.resizeHeight) || 800));
    const padH = 1000 - resizeWidth;
    const padV = 1000 - resizeHeight;
    const padLeft   = Math.floor(padH / 2);
    const padRight  = padH - padLeft;
    const padTop    = Math.floor(padV / 2);
    const padBottom = padV - padTop;
    const hasImage = !!req.file;
    const hasName = !!(productName && productName.trim());

    if (!hasImage && !hasName) {
      return res.status(400).json({ error: 'Debes ingresar al menos un campo: nombre de producto o imagen.' });
    }

    if (hasName && productName.trim().length > 100) {
      return res.status(400).json({ error: 'El nombre del producto no puede superar los 100 caracteres.' });
    }

    // 1. Redimensionar imagen (si se proporcionó)
    let resizedBuffer = null;
    let imageId = null;
    if (hasImage) {
      resizedBuffer = await sharp(req.file.buffer)
        .resize(resizeWidth, resizeHeight, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 }, withoutEnlargement: true })
        .extend({
          top: padTop, bottom: padBottom, left: padLeft, right: padRight,
          background: { r: 255, g: 255, b: 255, alpha: 1 },
        })
        .toFormat('jpeg', { quality: 90 })
        .toBuffer();

      imageId = uuidv4();

      // Build output filename
      const rawName = hasName
        ? productName.trim()
        : (req.file.originalname.replace(/\.[^.]+$/, '') || 'imagen');
      const slug = rawName
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9\-_]/g, '')
        .slice(0, 80);
      const outputFilename = (slug || 'imagen') + '.jpg';

      store.set(imageId, { buffer: resizedBuffer, filename: outputFilename });
      setTimeout(() => store.delete(imageId), 10 * 60 * 1000);
    }

    // 2. Generar descripción con Gemini (si se proporcionó nombre)
    let description = null;
    if (hasName) {
      try {
        const model = genAI.getGenerativeModel({
          model: 'gemini-2.5-flash',
          generationConfig: { responseMimeType: 'application/json' }
        });
        const prompt = `Eres un experto en copywriting para e-commerce, especializado en listings de Amazon y eBay. Para el producto: "${productName.trim()}", escribe 2 descripciones cortas (1-2 oraciones cada una) en el estilo exacto de Amazon/eBay: comienza con un claim técnico fuerte, nombra la tecnología o especificación clave (tamaño del driver, códec, batería, número de micrófonos, materiales, watios, etc.) y luego tradúcelo al beneficio concreto para el comprador. Usa estructuras como "[Tecnología/Especificación] — [beneficio directo]". Nunca uses lenguaje poético, metáforas ni frases vacías como "eleva tu experiencia", "sumérgete" o "oasis". Sé directo, técnico y orientado al valor real. Si no conoces las especificaciones exactas del producto, infiere valores realistas y representativos del tipo de producto. Devuelve ESTRICTAMENTE un array JSON de 2 strings, sin markdown, sin explicaciones.`;
        const result = await model.generateContent(prompt);
        const text = result.response.text().trim();
        try {
          description = JSON.parse(text);
        } catch (e) {
          description = [text];
        }
      } catch (aiErr) {
        console.error('Error de Gemini:', aiErr.message);
        description = '(Descripción de IA no disponible — verifica GEMINI_API_KEY en .env)';
      }
    }

    // 3. Vista previa en base64 (si hay imagen)
    const previewBase64 = resizedBuffer ? resizedBuffer.toString('base64') : null;

    res.json({ description, imageId, previewBase64 });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Descarga ──────────────────────────────────────────────────────────────────
app.get('/download/:id', (req, res) => {
  const entry = store.get(req.params.id);
  if (!entry) return res.status(404).send('Archivo no encontrado o ya descargado.');
  store.delete(req.params.id);
  res.set({
    'Content-Type': 'image/jpeg',
    'Content-Disposition': `attachment; filename="${entry.filename}"`,
  });
  res.send(entry.buffer);
});

// ─── Inicio ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Redimensionador de imágenes corriendo en http://localhost:${PORT}`);
});
