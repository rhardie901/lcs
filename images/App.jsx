import { useState, useRef, useCallback, useEffect } from "react";

const SYS = `You are an estimator for Lewis Construction Services, Inc., a licensed DMV-area general contractor performing residential and commercial work across electrical, plumbing, roofing, tile, flooring, carpentry, drywall, and painting.

Given a job description, produce a detailed construction estimate as JSON. Use DMV-market rates.

Rules:
- Labor rates by trade (fully burdened, DMV market):
  - Electrical / Plumbing (licensed trades): $140-165/hr
  - Roofing / Tile / Flooring: $85-110/hr
  - Carpentry / Drywall / Painting: $55-70/hr
  - General labor / prep / demo: $35-45/hr
  - Match each line item's rate to the trade it belongs to — do not apply one flat rate across all line items
- Target gross margin: 20-30%
- Include realistic line items for materials, labor, permits, and contingency
- Be specific — itemize tasks, not vague categories
- Payment schedule: 33% upfront, 33% at midpoint, 34% on completion

Respond ONLY with valid JSON, no markdown, no explanation:
{
  "projectTitle": "string",
  "clientName": "string",
  "clientAddress": "string",
  "clientEmail": "string",
  "scopeSummary": "string (2-3 sentences)",
  "lineItems": [
    { "id": "1", "description": "string", "qty": number, "unit": "string", "unitPrice": number, "total": number }
  ],
  "subtotal": number,
  "tax": number,
  "total": number,
  "paySchedule": { "deposit": number, "midpoint": number, "completion": number },
  "notes": "string",
  "validDays": 30
}`;

function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) { res(); return; }
    const s = document.createElement("script");
    s.src = src;
    s.onload = res;
    s.onerror = rej;
    document.head.appendChild(s);
  });
}

// The source logo PNG isn't reliably transparent — it carries a near-white
// matte that shows up as a white plate wherever the logo sits on a dark
// background (PDF header and the on-screen header alike). This strips it on
// a canvas. Returns null (caller should fall back to the original) if canvas
// pixel access fails for any reason.
function stripWhiteMatte(img) {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = imageData.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 240 && d[i + 1] > 240 && d[i + 2] > 240) {
        d[i + 3] = 0;
      }
    }
    ctx.putImageData(imageData, 0, 0);
    return canvas.toDataURL("image/png");
  } catch (e) {
    return null;
  }
}

// Fetches the logo and strips its matte for use in the generated PDF.
// `stripMatte` should stay true for logos with a white background matte to
// clean up (the light-background lockup), but must be false for the inverse
// (dark-background) logo — it has legitimate white text, and stripWhiteMatte
// can't tell "white background artifact" apart from "intentional white
// text," so it would erase both.
function loadLogoDataURL(url, stripMatte = true) {
  return new Promise((resolve, reject) => {
    fetch(url)
      .then(r => { if (!r.ok) throw new Error("logo fetch failed"); return r.blob(); })
      .then(blob => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const img = new window.Image();
          img.onload = () => {
            const stripped = stripMatte ? stripWhiteMatte(img) : null;
            resolve({ dataUrl: stripped || reader.result, width: img.width, height: img.height });
          };
          img.onerror = reject;
          img.src = reader.result;
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      })
      .catch(reject);
  });
}

// Same matte-stripping treatment for the logo shown live in the browser
// header, so it matches the PDF instead of showing a white box on the dark
// background there too. See the note on loadLogoDataURL above — pass
// stripMatte=false for the inverse (dark-background) logo, since it has
// legitimate white text that stripWhiteMatte would otherwise erase.
function useTransparentLogo(url, stripMatte = true) {
  const [src, setSrc] = useState(url);
  useEffect(() => {
    let cancelled = false;
    fetch(url)
      .then(r => { if (!r.ok) throw new Error("logo fetch failed"); return r.blob(); })
      .then(blob => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      }))
      .then(dataUrl => new Promise((resolve, reject) => {
        const img = new window.Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = dataUrl;
      }))
      .then(img => {
        const stripped = stripMatte ? stripWhiteMatte(img) : null;
        if (!cancelled && stripped) setSrc(stripped);
      })
      .catch(() => {
        // Leave src as the original remote URL — a white matte beats no logo.
      });
    return () => { cancelled = true; };
  }, [url, stripMatte]);
  return src;
}

// Auto-grows a <textarea> to fit its content so long line-item descriptions
// wrap and stay fully visible/editable instead of scrolling inside a
// single-line input.
function autoGrowTextarea(el) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = el.scrollHeight + "px";
}

function fmt(n) {
  return "$" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function today() {
  return new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

function invNum() {
  return "LC-" + Date.now().toString().slice(-6);
}

// ── PDF layout constants ──
// Description gets roughly half the table width so long line items wrap
// onto multiple lines instead of bleeding into the Qty/Unit/Price columns.
const PAGE_W = 612, PAGE_H = 792;
const MARGIN = 50;
const HEADER_H = 80;
const FOOTER_H = 32;
const CONTENT_W = PAGE_W - MARGIN * 2;
const NAVY = [20, 20, 20];
const GOLD = [214, 40, 40];
// Bottom of the usable content area on every page — nothing should be drawn
// past this without first checking there's room, so sections never end up
// rendered off-page (invisible) or clipped behind the footer bar.
const PAGE_BOTTOM = PAGE_H - FOOTER_H - 14;
// Gap kept between the navy page header and whatever content follows it,
// including a repeated table header row on continuation pages.
const TOP_GAP = 20;

const COL_DESC_W = CONTENT_W * 0.50;
const COL_QTY_W = CONTENT_W * 0.08;
const COL_UNIT_W = CONTENT_W * 0.08;
const COL_PRICE_W = CONTENT_W * 0.16;

const X_DESC = MARGIN + 4;
const X_QTY = MARGIN + COL_DESC_W;
const X_UNIT = X_QTY + COL_QTY_W;
const X_PRICE_RIGHT = X_UNIT + COL_UNIT_W + COL_PRICE_W - 4;
const X_TOTAL_RIGHT = PAGE_W - MARGIN - 4;

function drawPdfHeader(doc, logo) {
  doc.setFillColor(...NAVY);
  doc.rect(0, 0, PAGE_W, HEADER_H, "F");

  let textX = MARGIN;
  if (logo) {
    const logoH = 46;
    const logoW = logoH * (logo.width / logo.height);
    doc.addImage(logo.dataUrl, "PNG", MARGIN, (HEADER_H - logoH) / 2, logoW, logoH);
    textX = MARGIN + logoW + 16;
  }

  doc.setTextColor(255, 255, 255);
  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.text("Licensed General Contractor  |  DMV Area  |  License #92880", textX, 40);
  doc.text("sales@lewisconstruction.design  |  lewisconstruction.design", textX, 53);
  doc.setTextColor(...GOLD);
  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.text("ESTIMATE", PAGE_W - MARGIN - 60, 45);
}

function drawPdfFooter(doc, pageNum) {
  doc.setFillColor(...NAVY);
  doc.rect(0, PAGE_H - FOOTER_H, PAGE_W, FOOTER_H, "F");
  doc.setTextColor(150, 150, 150);
  doc.setFontSize(7);
  doc.setFont("helvetica", "normal");
  doc.text(
    "Prepared by: Rob Hardie  |  sales@lewisconstruction.design  |  License #92880",
    PAGE_W / 2, PAGE_H - FOOTER_H / 2 + 3, { align: "center" }
  );
  doc.text(String(pageNum), PAGE_W - MARGIN, PAGE_H - FOOTER_H / 2 + 3, { align: "right" });
}

function drawTableHeader(doc, y) {
  doc.setFillColor(...NAVY);
  doc.rect(MARGIN, y, CONTENT_W, 18, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.text("Description", X_DESC, y + 12);
  doc.text("Qty", X_QTY, y + 12);
  doc.text("Unit", X_UNIT, y + 12);
  doc.text("Unit Price", X_PRICE_RIGHT, y + 12, { align: "right" });
  doc.text("Total", X_TOTAL_RIGHT, y + 12, { align: "right" });
  return y + 22;
}

export default function App() {
  const [phase, setPhase] = useState("input"); // input | loading | quote
  const [desc, setDesc] = useState("");
  const [clientName, setClientName] = useState("");
  const [clientAddress, setClientAddress] = useState("");
  const [clientEmail, setClientEmail] = useState("");
  const [quote, setQuote] = useState(null);
  const [inv] = useState(invNum());
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [listening, setListening] = useState(false);
  const recRef = useRef(null);
  const logoSrc = useTransparentLogo("https://www.lewisconstruction.design/images/logo-inverse.png", false);

  const startVoice = useCallback(() => {
    if (!("webkitSpeechRecognition" in window || "SpeechRecognition" in window)) {
      alert("Voice input requires Chrome.");
      return;
    }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e) => {
      const transcript = Array.from(e.results).map(r => r[0].transcript).join(" ");
      setDesc(transcript);
    };
    rec.onend = () => setListening(false);
    rec.start();
    recRef.current = rec;
    setListening(true);
  }, []);

  const stopVoice = useCallback(() => {
    recRef.current?.stop();
    setListening(false);
  }, []);

  const generate = async () => {
    if (!desc.trim()) return;
    setPhase("loading");
    setError("");
    try {
      const userMsg = `Client: ${clientName || "TBD"}\nAddress: ${clientAddress || "TBD"}\nEmail: ${clientEmail || "TBD"}\n\nJob Description:\n${desc}`;
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 4000,
          system: SYS,
          messages: [{ role: "user", content: userMsg }]
        })
      });
      const data = await res.json();
      const text = data.content?.[0]?.text || "";
      const clean = text.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);
      setQuote(parsed);
      setPhase("quote");
    } catch (e) {
      setError("Generation failed. Check your description and try again.");
      setPhase("input");
    }
  };

  const updateLine = (id, field, val) => {
    setQuote(prev => {
      const lines = prev.lineItems.map(li => {
        if (li.id !== id) return li;
        const updated = { ...li, [field]: field === "description" ? val : parseFloat(val) || 0 };
        if (field === "qty" || field === "unitPrice") updated.total = updated.qty * updated.unitPrice;
        return updated;
      });
      const subtotal = lines.reduce((s, l) => s + l.total, 0);
      const tax = subtotal * 0.06;
      const total = subtotal + tax;
      return { ...prev, lineItems: lines, subtotal, tax, total, paySchedule: { deposit: total * 0.33, midpoint: total * 0.33, completion: total * 0.34 } };
    });
  };

  const savePDF = async () => {
    setSaving(true);
    await new Promise(r => setTimeout(r, 80));
    try {
      await loadScript("https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js");
      const logo = await loadLogoDataURL("https://www.lewisconstruction.design/images/logo-inverse.png", false).catch(() => null);
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ unit: "pt", format: "letter" });

      let pageNum = 1;

      // Starts a fresh page and redraws the chrome (navy header + footer) so
      // every page looks consistent — previously only page 1 got a header,
      // so continuation pages from a long line-item list rendered blank.
      const newPage = () => {
        doc.addPage();
        pageNum += 1;
        drawPdfHeader(doc, logo);
        drawPdfFooter(doc, pageNum);
        return HEADER_H + TOP_GAP;
      };

      // Checks whether `needed` pt of vertical space remain before the
      // footer; if not, starts a new page first so content (totals, payment
      // schedule, notes, signatures) never gets positioned off-page where it
      // would silently fail to render.
      const ensureSpace = (y, needed, opts = {}) => {
        if (y + needed > PAGE_BOTTOM) {
          y = newPage();
          if (opts.redrawTableHeader) y = drawTableHeader(doc, y);
        }
        return y;
      };

      drawPdfHeader(doc, logo);
      drawPdfFooter(doc, pageNum);
      let y = HEADER_H + TOP_GAP;

      // Invoice meta
      doc.setTextColor(50, 50, 50);
      doc.setFontSize(9);
      doc.setFont("helvetica", "normal");
      doc.text(`Estimate #: ${inv}`, MARGIN, y);
      doc.text(`Date: ${today()}`, MARGIN, y + 13);
      doc.text(`Valid: ${quote.validDays} days`, MARGIN, y + 26);
      doc.setFont("helvetica", "bold");
      doc.text("Bill To:", PAGE_W / 2, y);
      doc.setFont("helvetica", "normal");
      doc.text(quote.clientName || clientName || "—", PAGE_W / 2, y + 13);
      doc.text(quote.clientAddress || clientAddress || "—", PAGE_W / 2, y + 26);
      doc.text(quote.clientEmail || clientEmail || "—", PAGE_W / 2, y + 39);
      y += 65;

      // Project title
      doc.setFillColor(245, 245, 245);
      doc.rect(MARGIN, y, CONTENT_W, 24, "F");
      doc.setFont("helvetica", "bold");
      doc.setFontSize(11);
      doc.setTextColor(20, 20, 20);
      doc.text(quote.projectTitle || "Project Estimate", MARGIN + 8, y + 16);
      y += 34;

      // Scope
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.setTextColor(80, 80, 80);
      const scopeLines = doc.splitTextToSize(quote.scopeSummary || "", CONTENT_W);
      doc.text(scopeLines, MARGIN, y);
      y += scopeLines.length * 12 + 16;

      // Line items header
      y = drawTableHeader(doc, y);

      // Line items — description wraps within its column and each row's
      // height grows to fit, instead of a single doc.text() call overflowing
      // into the Qty/Unit/Price/Total columns.
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      quote.lineItems.forEach((li, i) => {
        const descLines = doc.splitTextToSize(String(li.description ?? ""), COL_DESC_W - 10);
        const lineH = 10;
        const rowH = Math.max(16, descLines.length * lineH + 6);

        y = ensureSpace(y, rowH, { redrawTableHeader: true });

        if (i % 2 === 1) {
          doc.setFillColor(248, 248, 248);
          doc.rect(MARGIN, y - 2, CONTENT_W, rowH, "F");
        }
        doc.setTextColor(50, 50, 50);
        descLines.forEach((ln, idx) => doc.text(ln, X_DESC, y + 8 + idx * lineH));
        doc.text(String(li.qty), X_QTY, y + 8);
        doc.text(String(li.unit), X_UNIT, y + 8);
        doc.text(fmt(li.unitPrice), X_PRICE_RIGHT, y + 8, { align: "right" });
        doc.text(fmt(li.total), X_TOTAL_RIGHT, y + 8, { align: "right" });
        y += rowH;
      });

      y += 8;
      // Totals
      y = ensureSpace(y, 3 * 18 + 6);
      const totRows = [
        ["Subtotal", fmt(quote.subtotal)],
        ["Tax (6%)", fmt(quote.tax)],
        ["TOTAL", fmt(quote.total)]
      ];
      totRows.forEach(([label, val], i) => {
        if (i === 2) { doc.setFillColor(20, 20, 20); doc.rect(PAGE_W - MARGIN - 160, y - 2, 160, 16, "F"); doc.setTextColor(255,255,255); doc.setFont("helvetica","bold"); }
        else { doc.setTextColor(60,60,60); doc.setFont("helvetica", i===1?"italic":"normal"); }
        doc.setFontSize(9);
        doc.text(label, PAGE_W - MARGIN - 155, y + 9);
        doc.text(val, PAGE_W - MARGIN - 5, y + 9, { align: "right" });
        y += 18;
      });

      y += 16;
      // Payment schedule — three-column grid matching the on-screen layout:
      // a light gray box containing a header row, then a row of evenly-spaced
      // columns each with a small label on top and a bold amount below.
      const psBoxH = 14 + 12 + 10 + 18 + 8; // header + gap + label line + amount line + bottom pad
      y = ensureSpace(y, psBoxH);
      doc.setFillColor(245, 245, 245);
      doc.rect(MARGIN, y, CONTENT_W, psBoxH, "F");
      doc.setTextColor(20, 20, 20);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8);
      doc.text("PAYMENT SCHEDULE", MARGIN + 8, y + 10);

      const ps = quote.paySchedule;
      const psCols = [
        ["Deposit (at signing)", ps.deposit],
        ["Midpoint", ps.midpoint],
        ["Completion", ps.completion],
      ];
      const psColW = CONTENT_W / 3;
      const psLabelY = y + 30;
      const psAmountY = y + 46;
      psCols.forEach(([label, val], i) => {
        const colX = MARGIN + 8 + i * psColW;
        doc.setFont("helvetica", "normal");
        doc.setFontSize(8);
        doc.setTextColor(120, 120, 120);
        doc.text(label, colX, psLabelY);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(13);
        doc.setTextColor(20, 20, 20);
        doc.text(fmt(val), colX, psAmountY);
      });
      y += psBoxH + 6;

      // Notes
      if (quote.notes) {
        doc.setFont("helvetica", "italic");
        doc.setFontSize(8);
        const noteLines = doc.splitTextToSize(`Notes: ${quote.notes}`, CONTENT_W);
        const noteH = noteLines.length * 11 + 10;
        y = ensureSpace(y, noteH);
        doc.setTextColor(100, 100, 100);
        doc.text(noteLines, MARGIN, y);
        y += noteH;
      }

      // Signatures
      y = ensureSpace(y, 40);
      y += 10;
      doc.setDrawColor(180, 180, 180);
      doc.line(MARGIN, y + 20, MARGIN + 180, y + 20);
      doc.line(PAGE_W - MARGIN - 180, y + 20, PAGE_W - MARGIN, y + 20);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor(120, 120, 120);
      doc.text("Lewis Construction / Date", MARGIN, y + 30);
      doc.text("Client Signature / Date", PAGE_W - MARGIN - 180, y + 30);

      doc.save(`Lewis-Estimate-${inv}.pdf`);
    } catch (e) {
      alert("PDF save failed: " + e.message);
    }
    setSaving(false);
  };

  // ── STYLES ──
  const s = {
    wrap: { minHeight: "100vh", background: "#f4f5f7", fontFamily: "'Georgia', serif", padding: 24 },
    card: { maxWidth: 760, margin: "0 auto", background: "#fff", borderRadius: 6, boxShadow: "0 2px 16px rgba(0,0,0,0.10)", overflow: "hidden" },
    header: { background: "#141414", color: "#fff", padding: "22px 32px", display: "flex", alignItems: "center", justifyContent: "space-between" },
    headerTitle: { fontSize: 20, fontWeight: 700, letterSpacing: 1, fontFamily: "monospace" },
    headerSub: { fontSize: 10, color: "rgba(214,40,40,0.75)", marginTop: 4, letterSpacing: 2, textTransform: "uppercase" },
    red: { color: "#922b21" },
    body: { padding: "28px 32px" },
    label: { display: "block", fontSize: 10, letterSpacing: 2, textTransform: "uppercase", color: "rgba(214,40,40,0.75)", marginBottom: 6, fontFamily: "monospace" },
    input: { width: "100%", border: "1px solid #d0d5e0", borderRadius: 4, padding: "9px 12px", fontSize: 13, fontFamily: "Georgia, serif", boxSizing: "border-box", outline: "none" },
    textarea: { width: "100%", border: "1px solid #d0d5e0", borderRadius: 4, padding: "12px", fontSize: 13, fontFamily: "Georgia, serif", minHeight: 110, resize: "vertical", boxSizing: "border-box", outline: "none" },
    btn: (active, red) => ({
      background: active ? (red ? "#141414" : "#141414") : "#d0d5e0",
      color: active ? (red ? "#D62828" : "#fff") : "#888",
      border: "none", borderRadius: 4, padding: "10px 22px",
      fontFamily: "monospace", fontWeight: 700, fontSize: 10, letterSpacing: 3,
      textTransform: "uppercase", cursor: active ? "pointer" : "not-allowed"
    }),
    row: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 },
    divider: { borderBottom: "1px solid #eaecf0", margin: "20px 0" },
  };

  return (
    <div style={s.wrap}>
      <div style={s.card}>
        <div style={s.header}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <img src={logoSrc} alt="Lewis Construction Services, Inc." style={{ height: 48, width: "auto", display: "block" }} />
            <div style={s.headerSub}>Estimate Generator · DMV Area · License #92880</div>
          </div>
          <div style={{ fontSize: 9, color: "#666", textAlign: "right", fontFamily: "monospace" }}>
            sales@lewisconstruction.design<br />lewisconstruction.design
          </div>
        </div>

        <div style={s.body}>
          {phase === "input" && (
            <>
              <div style={s.row}>
                <div>
                  <label style={s.label}>Client Name</label>
                  <input style={s.input} value={clientName} onChange={e => setClientName(e.target.value)} placeholder="John Smith" />
                </div>
                <div>
                  <label style={s.label}>Client Email</label>
                  <input style={s.input} value={clientEmail} onChange={e => setClientEmail(e.target.value)} placeholder="client@email.com" />
                </div>
              </div>
              <div style={{ marginBottom: 16 }}>
                <label style={s.label}>Property / Site Address</label>
                <input style={s.input} value={clientAddress} onChange={e => setClientAddress(e.target.value)} placeholder="123 Main St, Bethesda MD 20814" />
              </div>
              <div style={s.divider} />
              <div style={{ marginBottom: 16 }}>
                <label style={s.label}>Job Description {listening && <span style={{ color: "#922b21" }}>● Recording</span>}</label>
                <textarea
                  style={s.textarea}
                  value={desc}
                  onChange={e => setDesc(e.target.value)}
                  placeholder="Describe the work needed. E.g., panel upgrade to 200A, add 4 circuits in basement, replace main shutoff..."
                />
              </div>
              <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <button style={s.btn(!!desc.trim(), true)} onClick={generate} disabled={!desc.trim()}>Generate Estimate</button>
                <button
                  style={{ ...s.btn(true, false), background: listening ? "#141414" : "#eef0f5", color: listening ? "#D62828" : "#555" }}
                  onClick={listening ? stopVoice : startVoice}
                >
                  {listening ? "■ Stop" : "🎤 Voice"}
                </button>
              </div>
              {error && <p style={{ color: "#922b21", fontSize: 12, marginTop: 12 }}>{error}</p>}
            </>
          )}

          {phase === "loading" && (
            <div style={{ textAlign: "center", padding: "40px 0", color: "rgba(214,40,40,0.85)", fontFamily: "monospace" }}>
              <div style={{ fontSize: 28, marginBottom: 12 }}>⚙</div>
              <div style={{ letterSpacing: 3, fontSize: 11, textTransform: "uppercase" }}>Building your estimate...</div>
            </div>
          )}

          {phase === "quote" && quote && (
            <>
              {/* Toolbar */}
              <div style={{ display: "flex", gap: 12, marginBottom: 24 }}>
                <button style={s.btn(true, true)} onClick={savePDF} disabled={saving}>
                  {saving ? "Generating..." : "⬇ Save PDF"}
                </button>
                <button style={s.btn(true, false)} onClick={() => { setPhase("input"); setQuote(null); setDesc(""); setClientName(""); setClientAddress(""); setClientEmail(""); }}>
                  + New Estimate
                </button>
              </div>

              {/* Quote header */}
              <div style={{ background: "#f8f9fb", border: "1px solid #eaecf0", borderRadius: 4, padding: "16px 20px", marginBottom: 20 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: "#141414" }}>{quote.projectTitle}</div>
                    <div style={{ fontSize: 11, color: "#9aa1ac", marginTop: 2 }}>Estimate #{inv} · {today()}</div>
                  </div>
                  <div style={{ textAlign: "right", fontSize: 11, color: "#555" }}>
                    <div>{quote.clientName}</div>
                    <div>{quote.clientAddress}</div>
                    <div>{quote.clientEmail}</div>
                  </div>
                </div>
                <div style={{ marginTop: 12, fontSize: 12, color: "#555", lineHeight: 1.6 }}>{quote.scopeSummary}</div>
              </div>

              {/* Line items */}
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, marginBottom: 16 }}>
                <thead>
                  <tr style={{ background: "#141414", color: "#fff" }}>
                    {["Description", "Qty", "Unit", "Unit Price", "Total"].map(h => (
                      <th key={h} style={{ padding: "8px 10px", textAlign: h === "Description" ? "left" : "right", fontFamily: "monospace", fontSize: 9, letterSpacing: 2, fontWeight: 700 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {quote.lineItems.map((li, i) => (
                    <tr key={li.id} style={{ background: i % 2 === 1 ? "#f8f9fb" : "#fff" }}>
                      <td style={{ padding: "7px 10px", verticalAlign: "top" }}>
                        <textarea
                          ref={autoGrowTextarea}
                          value={li.description}
                          onChange={e => { updateLine(li.id, "description", e.target.value); autoGrowTextarea(e.target); }}
                          rows={1}
                          style={{ border: "none", background: "transparent", width: "100%", fontSize: 12, fontFamily: "Georgia,serif", outline: "none", resize: "none", overflow: "hidden", lineHeight: 1.5, display: "block", padding: 0, margin: 0 }}
                        />
                      </td>
                      {["qty", "unit", "unitPrice"].map(f => (
                        <td key={f} style={{ padding: "7px 10px", textAlign: "right", verticalAlign: "top" }}>
                          <input value={li[f]} onChange={e => updateLine(li.id, f, e.target.value)}
                            style={{ border: "none", background: "transparent", width: f === "unit" ? 90 : 70, textAlign: "right", fontSize: 12, fontFamily: "Georgia,serif", outline: "none" }} />
                        </td>
                      ))}
                      <td style={{ padding: "7px 10px", textAlign: "right", fontWeight: 600, verticalAlign: "top" }}>{fmt(li.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Totals */}
              <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 20 }}>
                <table style={{ fontSize: 12, minWidth: 200 }}>
                  <tbody>
                    {[["Subtotal", quote.subtotal], ["Tax (6%)", quote.tax]].map(([l, v]) => (
                      <tr key={l}><td style={{ padding: "3px 12px", color: "#555" }}>{l}</td><td style={{ textAlign: "right", padding: "3px 0" }}>{fmt(v)}</td></tr>
                    ))}
                    <tr style={{ background: "#141414", color: "#fff" }}>
                      <td style={{ padding: "6px 12px", fontWeight: 700, fontFamily: "monospace", letterSpacing: 1 }}>TOTAL</td>
                      <td style={{ textAlign: "right", padding: "6px 12px 6px 20px", fontWeight: 700 }}>{fmt(quote.total)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* Payment schedule */}
              <div style={{ background: "#f8f9fb", border: "1px solid #eaecf0", borderRadius: 4, padding: "14px 20px", marginBottom: 16 }}>
                <div style={{ fontSize: 9, letterSpacing: 2, textTransform: "uppercase", color: "#A11F1F", fontFamily: "monospace", marginBottom: 10 }}>Payment Schedule</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
                  {[["Deposit (at signing)", quote.paySchedule.deposit], ["Midpoint", quote.paySchedule.midpoint], ["Completion", quote.paySchedule.completion]].map(([l, v]) => (
                    <div key={l}>
                      <div style={{ fontSize: 10, color: "#9aa1ac", marginBottom: 2 }}>{l}</div>
                      <div style={{ fontSize: 16, fontWeight: 700, color: "#141414" }}>{fmt(v)}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Notes */}
              {quote.notes && <div style={{ fontSize: 11, color: "#777", fontStyle: "italic", lineHeight: 1.6 }}>{quote.notes}</div>}

              <div style={s.divider} />
              <div style={{ fontSize: 10, color: "#aaa", fontFamily: "monospace", letterSpacing: 1 }}>
                Prepared by Rob Hardie · Valid {quote.validDays} days · License #92880
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
