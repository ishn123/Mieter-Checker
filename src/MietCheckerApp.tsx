import React, { useEffect, useMemo, useState } from "react";
import Papa from "papaparse";
import { format, parse, isSameMonth } from "date-fns";
import { de } from "date-fns/locale";
import {
  Button, Card, CardContent, CardDescription, CardHeader, CardTitle,
  Input, Label, Badge, Tabs, TabsContent, TabsList, TabsTrigger,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea
} from "./ui";
import {
  Save, FileDown, CheckCircle2, XCircle, AlertTriangle, Settings2,
  CalendarDays, PlusCircle, FileSignature, Bot, Upload, Inbox
} from "lucide-react";

// ---------- PDF + OCR (robuste Version für iPhone/PWA) ----------
import * as pdfjs from "pdfjs-dist/legacy/build/pdf";
import pdfjsWorker from "pdfjs-dist/legacy/build/pdf.worker.min.js?url";
import Tesseract from "tesseract.js";
pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorker;

/** @typedef {{id:string; name:string; address:string}} Property */
/** @typedef {{id:string; propertyId:string; label:string; rooms:number}} Unit */
/** @typedef {{id:string; unitId:string; tenantName:string; tenantIban:string; expected:number; dueDay:number; reference?:string; startDate?:string; endDate?:string; deposit?:number; roomNumber?:string}} Contract */
/** @typedef {{date:Date; amount:number; name?:string; iban?:string; reference?:string}} Tx */

const uid = () => Math.random().toString(36).slice(2, 9);
const parseNumber = (v:any) => { if (typeof v === "number") return v; if (!v) return NaN; const s=String(v).trim().replace(/\./g,"").replace(",","."); const n=Number(s); return Number.isFinite(n)?n:NaN; };
const tryParseDate = (v:any) => { if (v instanceof Date && !isNaN(v as any)) return v; if (typeof v!=="string") return new Date(NaN); const s=v.trim(); const fmts=["dd.MM.yyyy","yyyy-MM-dd","dd.MM.yy","dd/MM/yyyy","MM/dd/yyyy"]; for (const f of fmts){ const d=parse(s,f,new Date()); if(!isNaN(d as any)) return d;} return new Date(s); };
const monthKey = (d:Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;

// ---------- Parser & Normalisierung ----------
function parseEuro(s: string){
  const m = String(s).replace(/\./g,'').replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : NaN;
}
function parseDateDE(s: string){
  const m = String(s).match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
  if(!m) return null;
  let [_,d,mo,y] = m;
  if (y.length === 2) y = '20' + y;
  return new Date(`${y}-${mo}-${d}`);
}
function findLineIndex(lines: string[], anchor: string){
  return lines.findIndex(l => new RegExp(anchor, 'i').test(l));
}
function grabNumberNear(lines: string[], idx: number, span = 8){
  for (let i = idx; i <= Math.min(idx + span, lines.length - 1); i++){
    const n = parseEuro(lines[i]);
    if (Number.isFinite(n)) return n!;
  }
  return null;
}
function grabDateNear(lines: string[], idx: number, span = 8){
  for (let i = idx; i <= Math.min(idx + span, lines.length - 1); i++){
    const d = parseDateDE(lines[i]);
    if (d) return d;
  }
  return null;
}
function grabTextAfter(lines: string[], idx: number, span = 3){
  for (let i = idx + 1; i <= Math.min(idx + span, lines.length - 1); i++){
    const s = lines[i].trim();
    if (s) return s;
  }
  return null;
}
function pickRoomNumber(s?: string){
  if (!s) return "";
  const m = String(s).match(/\b(Zimmer|Zi|Whg|Wohnung)\s*[-.:]*\s*(\d{1,3})\b/i) || String(s).match(/\b(\d{1,3})\b/);
  return m ? (m[2] || m[1]) : "";
}
function norm(s?: string){
  return (s||"").normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase().replace(/[^a-z0-9\s]/g,' ')
    .replace(/\s+/g,' ').trim();
}
function tokens(name: string){ return norm(name).split(' ').filter(t => t.length >= 2); }
function tokenOverlap(a: string, b: string){
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0; for (const t of A) if (B.has(t)) inter++;
  return inter / Math.max(A.size, B.size);
}

// ---------- Mapping (Anker stabil, Werte variabel) ----------
const DEFAULT_MAPPING = {
  fields: {
    tenantName: { anchors: ["^\\s*Name\\s*:", "\\bMieter(?:in)?\\b"], mode: "nameGuess" },
    rent:       { anchors: ["\\bMiete\\b", "\\bGrundmiete\\b", "^\\s*§?2\\b"], mode: "numberNear" },
    deposit:    { anchors: ["\\bKaution\\b", "Mietsicherheit"], mode: "numberNear" },
    startDate:  { anchors: ["beginnt am", "Mietbeginn", "Beginn des Mietverh"], mode: "dateNear" },
    address:    { anchors: ["straße|strasse|weg|platz|allee|gasse|ring|damm|ufer"], mode: "addressSmart" },
    roomLabel:  { anchors: ["Zimmernummer|Zimmer|Zi\\b|Wohnung|Whg"], mode: "textNear" }
  }
};

// ===================================================================
// === PATCH REGION: ProgressBar (UI-Komponente) — START
// ===================================================================
function ProgressBar({ value }: { value: number }) {
  const v = Math.min(100, Math.max(0, Math.round(value || 0)));
  return (
    <div className="w-full mt-2">
      <div className="h-2 bg-gray-200 rounded">
        <div
          className="h-2 bg-blue-500 rounded transition-all"
          style={{ width: `${v}%` }}
        />
      </div>
      <p className="text-xs text-muted-foreground mt-1">{v}%</p>
    </div>
  );
}
// ===================================================================
// === PATCH REGION: ProgressBar — END
// ===================================================================


// ===================================================================
// === PATCH REGION: PDF/OCR Funktionen (mit Progress) — START
// ===================================================================
async function readPdfText(file: File, onProgress?: (n:number)=>void){
  const data = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data }).promise;
  let full = '';
  for (let p=1; p<=pdf.numPages; p++){
    const page = await pdf.getPage(p);
    const content = await page.getTextContent({ includeMarkedContent: true });
    const pageText = (content.items as any[]).map(it=> (it as any).str).filter(Boolean).join('\n');
    full += pageText + '\n';
    onProgress?.(Math.round((p/pdf.numPages)*100));  // Seiten-Fortschritt
  }
  return full.trim();
}

async function ocrPdfFirstPage(file: File, onProgress?: (n:number)=>void){
  const data = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data }).promise;
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 2.5 });
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  canvas.width = viewport.width; canvas.height = viewport.height;
  await page.render({ canvasContext: ctx as any, viewport }).promise;

  const opts:any = {
    langPath: "https://tessdata.projectnaptha.com/4.0.0",
    logger: (m:any) => {
      if (m?.status === 'recognizing text' && typeof m.progress === 'number'){
        onProgress?.(Math.round(m.progress * 100));  // OCR-Fortschritt
      }
    }
  };

  try {
    const { data: ocr } = await (Tesseract as any).recognize(canvas, 'deu', opts);
    return (ocr?.text || '');
  } catch {
    const { data: ocrEng } = await (Tesseract as any).recognize(canvas, 'eng', opts);
    return (ocrEng?.text || '');
  }
}
// ===================================================================
// === PATCH REGION: PDF/OCR Funktionen — END
// ===================================================================


// ---------- Robuster Contract-Extractor ----------
function extractWithMapping(text: string, mapping = DEFAULT_MAPPING){
  const rawLines = text.split(/\r?\n/);
  const lines = rawLines.map(l => l.trim()).filter(Boolean);

  const findByAnchors = (anchors: string[]) => {
    for (const a of anchors){ const i = findLineIndex(lines, a); if (i !== -1) return i; }
    return -1;
  };

  function guessName(){
    const idx = findByAnchors(["^\\s*Name\\s*:", "\\bMieter(?:in)?\\b"]);
    if (idx !== -1) {
      const after = lines[idx].replace(/^Name\s*:\s*/i, '').trim() || grabTextAfter(lines, idx, 2) || '';
      if (after && !/Vermieter/i.test(after)) return after;
    }
    for (const s of lines){
      if (/\d|EURO|§/i.test(s)) continue;
      const parts = s.split(/\s+/);
      if (parts.length >= 2 && /^[A-ZÄÖÜ][a-zäöüß\-]+$/.test(parts[0]) && /^[A-ZÄÖÜ][a-zäöüß\-]+$/.test(parts[1])){
        return s;
      }
    }
    return "";
  }

  function findAddress(){
    const streetIdx = lines.findIndex(l => /\b(\d{1,4})([a-zA-Z]?)\b/.test(l) && /(straße|strasse|weg|platz|allee|gasse|ring|damm|ufer)/i.test(l));
    if (streetIdx === -1) return "";
    let adr = lines[streetIdx];
    const next = lines[streetIdx + 1] || "";
    if (/\b\d{5}\b/.test(next)) adr = adr + ", " + next;
    return adr;
  }

  const f = mapping.fields;
  const tenantName = f.tenantName?.mode === "nameGuess" ? guessName() : "";
  const rentIdx    = findByAnchors(f.rent.anchors);
  const depositIdx = findByAnchors(f.deposit.anchors);
  const startIdx   = findByAnchors(f.startDate.anchors);
  const roomIdx    = findByAnchors(f.roomLabel.anchors);

  const expected = rentIdx    !== -1 ? (grabNumberNear(lines, rentIdx, 8)   ?? 0) : 0;
  const deposit  = depositIdx !== -1 ? (grabNumberNear(lines, depositIdx,8) ?? 0) : 0;
  const start    = startIdx   !== -1 ?  grabDateNear(lines, startIdx, 8)      : null;

  const roomSource = roomIdx !== -1 ? (grabTextAfter(lines, roomIdx, 2) || lines[roomIdx]) : "";
  const unitLabel  = roomSource || "";
  const roomNumber = pickRoomNumber(roomSource);

  const address = findAddress();

  return {
    tenantName,
    expected,
    deposit,
    startDate: start ? start.toISOString().slice(0,10) : null,
    unitLabel,
    roomNumber,
    iban: "",
    address
  };
}

// ------------------ App ------------------
export default function MietCheckerApp(){
  const [properties, setProperties] = useState<any[]>([]);
  const [units, setUnits] = useState<any[]>([]);
  const [contracts, setContracts] = useState<any[]>([]);
  const [txs, setTxs] = useState<any[]>([]);
  const [pending, setPending] = useState<any[]>([]); // Posteingang (Entwürfe)

  const [selectedMonth, setSelectedMonth] = useState(() => monthKey(new Date()));
  const [graceDays, setGraceDays] = useState(3);
  const [amountTolerance, setAmountTolerance] = useState(2);
  const [settings, setSettings] = useState<any>(()=>{ 
    try { return JSON.parse(localStorage.getItem('mc-settings')||'{}'); } catch { return {}; } 
  });

  // Defaults
  useEffect(()=> {
    setSettings((s:any)=>({
      autoDraftOnUpload: s?.autoDraftOnUpload ?? true,
      autoCreatePropertyUnit: s?.autoCreatePropertyUnit ?? true,
      rentLabel: s?.rentLabel ?? "Miete",
      ...s
    }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persistenzen
  useEffect(()=>{ 
    const raw=localStorage.getItem('mc-data'); 
    if(raw){ try{ const s=JSON.parse(raw); setProperties(s.properties||[]); setUnits(s.units||[]); setContracts(s.contracts||[]); setTxs((s.txs||[]).map((t:any)=>({...t,date:new Date(t.date)}))); }catch{} } 
    const rawP = localStorage.getItem('mc-pending');
    if(rawP){ try{ setPending(JSON.parse(rawP)||[]); } catch{} }
  },[]);
  useEffect(()=>{ localStorage.setItem('mc-data', JSON.stringify({properties,units,contracts,txs})); },[properties,units,contracts,txs]);
  useEffect(()=>{ localStorage.setItem('mc-settings', JSON.stringify(settings||{})); },[settings]);
  useEffect(()=>{ localStorage.setItem('mc-pending', JSON.stringify(pending||[])); },[pending]);

  // Tenant-Records
  const tenants = useMemo(()=> contracts.map((c:any)=>{ 
    const u = units.find((x:any)=>x.id===c.unitId); 
    const p = u? properties.find((pp:any)=>pp.id===u.propertyId):undefined; 
    return { 
      name: c.tenantName, 
      iban: c.tenantIban, 
      expected: c.expected, 
      dueDay: c.dueDay, 
      reference: c.reference || (p? `Miete ${p.name}`: "Miete"), 
      propertyName: p?.name, 
      unitLabel: u?.label, 
      roomNumber: c.roomNumber || "" 
    }; 
  }), [contracts, units, properties]);

  // Bank-Abgleich
  const { monthDate, matches, missing, partial, overpaid } = useMemo(()=>{
    const [year, m] = selectedMonth.split("-").map(Number);
    const monthDate = new Date(year, m-1, 1);
    const monthTxs = txs.filter((tx:any)=> isSameMonth(tx.date, monthDate));

    const matches = tenants.map((ten:any)=>{
      const due = new Date(year, m-1, Math.min(ten.dueDay + graceDays, 28));
      const lo = ten.expected - amountTolerance, hi = ten.expected + amountTolerance;

      const candidate = monthTxs.find((tx:any)=>{
        const amountOk = tx.amount < 0 && -tx.amount >= lo && -tx.amount <= hi;
        if (!amountOk) return false;

        const ibanOk = ten.iban && tx.iban && ten.iban.replace(/\s+/g,'') === tx.iban.replace(/\s+/g,'');

        const strongName =
          tokenOverlap(ten.name || "", tx.name || "") >= 0.6 ||
          tokenOverlap(ten.name || "", tx.reference || "") >= 0.6;

        const ref = norm(tx.reference);
        const roomNum = ten.roomNumber ? norm(ten.roomNumber) : "";
        const unitNorm = norm(ten.unitLabel || "");
        const propNorm = norm(ten.propertyName || "");
        const addressRoomOk = ref && (
          (unitNorm && ref.includes(unitNorm)) ||
          (propNorm && ref.includes(propNorm)) ||
          (roomNum && ref.includes(roomNum))
        );

        return ibanOk || strongName || addressRoomOk;
      });

      let status = "missing", info = "Keine Zahlung gefunden";
      if (candidate){
        const amt = -candidate.amount;
        if (Math.abs(amt - ten.expected) <= amountTolerance){
          status = "ok"; info = `Bezahlt am ${format(candidate.date,"dd.MM.yyyy",{locale:de})} (${amt.toFixed(2)} €)`;
        } else if (amt < ten.expected){
          status = "partial"; info = `Teilzahlung ${amt.toFixed(2)} € (erwartet ${ten.expected.toFixed(2)} €)`;
        } else {
          status = "over"; info = `Überzahlung ${amt.toFixed(2)} € (erwartet ${ten.expected.toFixed(2)} €)`;
        }
      }
      return { tenant: ten, tx: candidate, status, info, due };
    });

    const missing  = matches.filter((m:any)=>m.status==="missing");
    const partial  = matches.filter((m:any)=>m.status==="partial");
    const overpaid = matches.filter((m:any)=>m.status==="over");
    return { monthDate, matches, missing, partial, overpaid };
  }, [selectedMonth, txs, tenants, graceDays, amountTolerance]);

  // CSV Import
  const [txHeaders, setTxHeaders] = useState<string[]>([]);
  const [txMap, setTxMap] = useState<any>({ date: "date", amount: "amount", name: "name", iban: "iban", reference: "reference" });
  const onUploadTxs = (file: File) => {
    Papa.parse(file, { header:true, skipEmptyLines:true, complete:(res:any)=>{
      const rows = res.data||[]; if(rows.length) setTxHeaders(Object.keys(rows[0]));
      const t = rows.map((r:any)=>({ date: tryParseDate(r[txMap.date]), amount: parseNumber(r[txMap.amount]), name: r[txMap.name]?.toString()?.trim(), iban: r[txMap.iban]?.toString()?.replace(/\s+/g, ""), reference: r[txMap.reference]?.toString()?.trim() })).filter((x:any)=>!isNaN(x.date as any)&&Number.isFinite(x.amount));
      setTxs(t);
    }});
  };

  // Auto-Draft (Posteingang)
  const ensurePropertyByAddress = (address: string) => {
    if (!address) return null;
    const p = properties.find((pp:any) => (pp.address||"").toLowerCase() === address.toLowerCase() || (pp.name||"").toLowerCase() === address.toLowerCase());
    if (p) return p;
    if (!settings?.autoCreatePropertyUnit) return null;
    const np = { id: uid(), name: address, address };
    setProperties((prev:any[])=> [...prev, np]);
    return np;
  };
  const ensureUnitByLabel = (propertyId: string, label: string) => {
    if (!propertyId || !label) return null;
    const u = units.find((uu:any)=> uu.propertyId===propertyId && uu.label.toLowerCase()===label.toLowerCase());
    if (u) return u;
    if (!settings?.autoCreatePropertyUnit) return null;
    const nu = { id: uid(), propertyId, label, rooms: 1 };
    setUnits((prev:any[])=> [...prev, nu]);
    return nu;
  };

  const createDraftsFromExtraction = (previews: any[]) => {
    const drafts = previews.map((r:any) => {
      const ex = r.extracted || {};
      let prop = ensurePropertyByAddress(ex.address||"");
      const label = (ex.unitLabel && String(ex.unitLabel).trim()) || (ex.roomNumber ? `Zi ${ex.roomNumber}` : "");
      let unit = null;
      if (prop && label) unit = ensureUnitByLabel(prop.id, label);
      if (!unit && r.matchedUnit) unit = r.matchedUnit;
      return { fileName: r.fileName, textLength: r.textLength, extracted: ex, matchedProperty: prop || null, matchedUnit: unit || null };
    });
    setPending((prev:any[]) => [...prev, ...drafts]);
  };

  const confirmDraft = (idx:number) => {
    const d = pending[idx]; if (!d) return;
    const u = d.matchedUnit; if (!u) { alert('Entwurf hat keine Einheit. Bitte im Posteingang bearbeiten.'); return; }
    const ref = d.extracted.unitLabel
      ? `Miete ${d.extracted.unitLabel}${d.extracted.roomNumber ? ' (Zi ' + d.extracted.roomNumber + ')' : ''} — ${d.extracted.address || 'Objekt'}`
      : `Miete${d.extracted.roomNumber ? ' (Zi ' + d.extracted.roomNumber + ')' : ''} — ${d.extracted.address || 'Objekt'}`;
    const c:any = {
      id: uid(), unitId: u.id,
      tenantName: d.extracted.tenantName || '', tenantIban: d.extracted.iban || '',
      expected: Number(d.extracted.expected)||0, dueDay: 3, reference: ref,
      startDate: d.extracted.startDate || '', endDate: '',
      deposit: Number(d.extracted.deposit)||0, roomNumber: d.extracted.roomNumber || ''
    };
    setContracts((cs:any[]) => [...cs, c]);
    setPending((all:any[]) => all.filter((_:any, i:number)=> i!==idx));
  };
  const rejectDraft = (idx:number) => { setPending((all:any[]) => all.filter((_:any, i:number)=> i!==idx)); };
  const confirmAllDrafts = () => {
    const withUnit = pending.filter((d:any)=> d.matchedUnit);
    if (withUnit.length === 0){ alert('Keine übernahmefähigen Entwürfe.'); return; }
    const additions = withUnit.map((d:any)=> {
      const ref = d.extracted.unitLabel
        ? `Miete ${d.extracted.unitLabel}${d.extracted.roomNumber ? ' (Zi ' + d.extracted.roomNumber + ')' : ''} — ${d.extracted.address || 'Objekt'}`
        : `Miete${d.extracted.roomNumber ? ' (Zi ' + d.extracted.roomNumber + ')' : ''} — ${d.extracted.address || 'Objekt'}`;
      return {
        id: uid(), unitId: d.matchedUnit.id,
        tenantName: d.extracted.tenantName || '', tenantIban: d.extracted.iban || '',
        expected: Number(d.extracted.expected)||0, dueDay: 3, reference: ref,
        startDate: d.extracted.startDate || '', endDate: '',
        deposit: Number(d.extracted.deposit)||0, roomNumber: d.extracted.roomNumber || ''
      };
    });
    setContracts((cs:any[]) => [...cs, ...additions]);
    setPending((all:any[]) => all.filter((d:any)=> !d.matchedUnit));
  };

  // UI Hilfsfunktionen
  const downloadCsv = (rows:any[], name:string) => { const csv = Papa.unparse(rows); const blob = new Blob([csv], {type:"text/csv;charset=utf-8;"}); const url = URL.createObjectURL(blob); const a=document.createElement("a"); a.href=url; a.download=name; a.click(); URL.revokeObjectURL(url); };
  const exportOpen = () => downloadCsv(missing.map(({tenant,due}:any)=>({ property: tenant.propertyName||"-", unit: tenant.unitLabel||"-", room: tenant.roomNumber||"", name: tenant.name, iban: tenant.iban, expected: tenant.expected, dueDay: tenant.dueDay, month: format(monthDate,"MM.yyyy"), dueUntil: format(due,"dd.MM.yyyy"), reference: tenant.reference||"" })), `offene-mieten-${selectedMonth}.csv`);
  const exportAll = () => downloadCsv(matches.map(({tenant,tx,status,info}:any)=>({ property: tenant.propertyName||"-", unit: tenant.unitLabel||"-", room: tenant.roomNumber||"", tenant: tenant.name, iban: tenant.iban, expected: tenant.expected, status, info, tx_date: tx? format(tx.date,"dd.MM.yyyy"):"", tx_amount: tx? tx.amount: "", tx_name: tx?.name||"", tx_reference: tx?.reference||"" })), `mietabgleich-${selectedMonth}.csv`);

  const rentLabel = settings?.rentLabel || "Miete";

  return (
    <div>
      {pending.length>0 && (
        <div style={{background:'#fff7ed', border:'1px solid #fed7aa', borderRadius:12, padding:'10px 12px', marginBottom:12, display:'flex', gap:8, alignItems:'center', justifyContent:'space-between'}}>
          <div style={{display:'flex', alignItems:'center', gap:8}}><Inbox size={16}/><b>{pending.length}</b> neue Vertrag-Entwürfe aus PDF erkannt. Jetzt bestätigen.</div>
          <div style={{display:'flex', gap:8}}>
            <Button variant="outline" onClick={confirmAllDrafts}><CheckCircle2 size={16}/> Alle übernehmen</Button>
          </div>
        </div>
      )}

      <header style={{display:'flex', gap:12, alignItems:'flex-end', justifyContent:'space-between', marginBottom:12}}>
        <div>
          <h1 style={{fontSize:24, fontWeight:700}}>Miet-Checker PRO (PWA + KI)</h1>
          <p className="muted">Installierbar · Offline · KI-Vertragsimport (PDF/Scan) · Auto-Posteingang</p>
        </div>
        <div style={{display:'flex', gap:8, alignItems:'center'}}>
          <div style={{display:'flex', gap:6, alignItems:'center'}}>
            <CalendarDays size={16} />
            <Select value={selectedMonth} onValueChange={setSelectedMonth}>
              <SelectTrigger><SelectValue placeholder="Monat"/></SelectTrigger>
              <SelectContent>
                {Array.from({length:13}).map((_,i)=>{ const d=new Date(); d.setMonth(d.getMonth()-i); const key=monthKey(d); return <SelectItem key={key} value={key}>{format(d, "MMMM yyyy", {locale:de})}</SelectItem>; })}
              </SelectContent>
            </Select>
          </div>
          <Button variant="outline" onClick={exportOpen}><FileDown size={16}/>Offene als CSV</Button>
          <Button onClick={exportAll}><Save size={16}/>Abgleich exportieren</Button>
        </div>
      </header>

      <Tabs defaultValue="eingang">
        <TabsList>
          <TabsTrigger value="eingang"><Inbox size={16}/> Posteingang</TabsTrigger>
          <TabsTrigger value="objekte">Objekte & Zimmer</TabsTrigger>
          <TabsTrigger value="vertraege">Verträge</TabsTrigger>
          <TabsTrigger value="bank">Bankdaten</TabsTrigger>
          <TabsTrigger value="uebersicht">Übersicht</TabsTrigger>
          <TabsTrigger value="kiimport"><Bot size={16}/>Verträge importieren (KI)</TabsTrigger>
          <TabsTrigger value="einstellungen"><Settings2 size={16}/>Einstellungen</TabsTrigger>
        </TabsList>

        <TabsContent value="eingang"><InboxSection pending={pending} confirmDraft={confirmDraft} rejectDraft={rejectDraft} /></TabsContent>
        <TabsContent value="objekte"><ObjectsUnitsSection properties={properties} setProperties={setProperties} units={units} setUnits={setUnits} /></TabsContent>
        <TabsContent value="vertraege"><ContractsSection units={units} properties={properties} contracts={contracts} setContracts={setContracts} rentLabel={rentLabel} /></TabsContent>
        <TabsContent value="bank"><BankSection txHeaders={txHeaders} txMap={txMap} setTxMap={setTxMap} onUploadTxs={onUploadTxs} /></TabsContent>
        <TabsContent value="uebersicht"><OverviewSection matches={matches} missing={missing} partial={partial} overpaid={overpaid} selectedMonth={selectedMonth} /></TabsContent>

        {/* ===================================================================
            === PATCH REGION: KI-IMPORT SECTION (mit Ladebalken) — START
            =================================================================== */}
        <TabsContent value="kiimport">
          <KiImportSectionWithProgress onAutoDraft={createDraftsFromExtraction} settings={settings}/>
        </TabsContent>
        {/* ===================================================================
            === PATCH REGION: KI-IMPORT SECTION — END
            =================================================================== */}

        <TabsContent value="einstellungen"><SettingsSection
          graceDays={graceDays} amountTolerance={amountTolerance}
          setGraceDays={setGraceDays} setAmountTolerance={setAmountTolerance}
          settings={settings} setSettings={setSettings}
        /></TabsContent>
      </Tabs>
    </div>
  );
}

// ------------------ Sections ------------------
function InboxSection({ pending, confirmDraft, rejectDraft }:{pending:any[]; confirmDraft:(i:number)=>void; rejectDraft:(i:number)=>void;}){
  return (
    <Card>
      <CardHeader><CardTitle>Posteingang</CardTitle><CardDescription>Automatisch erkannte Verträge (prüfen & bestätigen)</CardDescription></CardHeader>
      <CardContent>
        {pending.length===0 ? <p className="muted">Keine Entwürfe vorhanden.</p> : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Datei</TableHead>
                <TableHead>Mieter</TableHead>
                <TableHead>Miete (€)</TableHead>
                <TableHead>Kaution (€)</TableHead>
                <TableHead>Start</TableHead>
                <TableHead>Adresse</TableHead>
                <TableHead>Einheit</TableHead>
                <TableHead>Zimmer</TableHead>
                <TableHead>Aktion</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pending.map((r:any,i:number)=>(
                <TableRow key={i}>
                  <TableCell className="text-sm">{r.fileName}</TableCell>
                  <TableCell>{r.extracted.tenantName||'–'}</TableCell>
                  <TableCell>{Number(r.extracted.expected||0).toFixed(2)}</TableCell>
                  <TableCell>{Number(r.extracted.deposit||0).toFixed(2)}</TableCell>
                  <TableCell>{r.extracted.startDate||'–'}</TableCell>
                  <TableCell>{r.extracted.address||'–'}</TableCell>
                  <TableCell>{r.matchedUnit? r.matchedUnit.label: (r.extracted.unitLabel||'–')}</TableCell>
                  <TableCell>{r.extracted.roomNumber||'–'}</TableCell>
                  <TableCell>
                    <div style={{display:'flex', gap:8}}>
                      <Button onClick={()=>confirmDraft(i)}><CheckCircle2 size={16}/>Übernehmen</Button>
                      <Button variant="outline" onClick={()=>rejectDraft(i)}><XCircle size={16}/>Verwerfen</Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function ObjectsUnitsSection({ properties, setProperties, units, setUnits }:{properties:any[];setProperties:any;units:any[];setUnits:any;}){
  const [propSel, setPropSel] = useState('');
  return (
    <div style={{display:'grid', gap:16}}>
      <Card>
        <CardHeader><CardTitle>Objekt anlegen</CardTitle><CardDescription>Adresse optional</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          <div style={{display:'grid', gap:12}}>
            <div><Label>Objektname</Label><Input id="prop-name" placeholder="Haus Müllerstr. 10"/></div>
            <div><Label>Adresse</Label><Input id="prop-addr" placeholder="Straße, PLZ Ort"/></div>
          </div>
          <Button onClick={()=>{ const name=(document.getElementById('prop-name') as HTMLInputElement).value?.trim(); const addr=(document.getElementById('prop-addr') as HTMLInputElement).value?.trim(); if(!name) return; setProperties((p:any[])=>[...p,{id:uid(), name, address:addr||""}]); (document.getElementById('prop-name') as HTMLInputElement).value=""; (document.getElementById('prop-addr') as HTMLInputElement).value=""; }}>Hinzufügen</Button>
          <Table className="mt-4"><TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Adresse</TableHead><TableHead>Einheiten</TableHead></TableRow></TableHeader><TableBody>{properties.map((p:any)=> (<TableRow key={p.id}><TableCell>{p.name}</TableCell><TableCell className="text-sm muted">{p.address||"–"}</TableCell><TableCell>{units.filter((u:any)=>u.propertyId===p.id).length}</TableCell></TableRow>))}</TableBody></Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Zimmer/Einheit anlegen</CardTitle><CardDescription>Bezeichnung & Zimmerzahl</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          <div style={{display:'grid', gap:12}}>
            <div><Label>Objekt</Label>
              <Select id="unit-prop" value={propSel} onValueChange={setPropSel}>
                <SelectTrigger><SelectValue placeholder="Objekt wählen"/></SelectTrigger>
                <SelectContent>
                  {properties.map((p:any)=> <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div><Label>Bezeichnung</Label><Input id="unit-label" placeholder="Whg 3 links / Zi 5"/></div>
            <div><Label>Zimmer</Label><Input id="unit-rooms" type="number" min={1} defaultValue={1}/></div>
          </div>
          <Button onClick={()=>{ const label=(document.getElementById('unit-label') as HTMLInputElement).value?.trim(); const rooms=Number((document.getElementById('unit-rooms') as HTMLInputElement).value||1); if(!propSel||!label) return; setUnits((u:any[])=>[...u,{id:uid(), propertyId:propSel, label, rooms: rooms||1}]); (document.getElementById('unit-label') as HTMLInputElement).value=""; (document.getElementById('unit-rooms') as HTMLInputElement).value="1"; }}>Hinzufügen</Button>
          <Table className="mt-4"><TableHeader><TableRow><TableHead>Objekt</TableHead><TableHead>Einheit</TableHead><TableHead>Zimmer</TableHead></TableRow></TableHeader><TableBody>{units.map((u:any)=>{ const p=properties.find((pp:any)=>pp.id===u.propertyId); return (<TableRow key={u.id}><TableCell>{p?.name||"-"}</TableCell><TableCell>{u.label}</TableCell><TableCell>{u.rooms}</TableCell></TableRow>); })}</TableBody></Table>
        </CardContent>
      </Card>
    </div>
  );
}

function ContractsSection({ units, properties, contracts, setContracts, rentLabel }:{units:any[];properties:any[];contracts:any[];setContracts:any;rentLabel:string;}){
  const [cUnit, setCUnit] = useState('');
  return (
    <Card>
      <CardHeader><CardTitle>Mietvertrag hinzufügen</CardTitle><CardDescription>Mieter:in einer Einheit zuordnen</CardDescription></CardHeader>
      <CardContent className="space-y-3">
        <div style={{display:'grid', gap:12}}>
          <div><Label>Einheit</Label>
            <Select id="c-unit" value={cUnit} onValueChange={setCUnit}>
              <SelectTrigger><SelectValue placeholder="Einheit wählen"/></SelectTrigger>
              <SelectContent>{units.map((u:any)=>{ const p=properties.find((pp:any)=>pp.id===u.propertyId); return <SelectItem key={u.id} value={u.id}>{(p?.name||"?")+" — "+u.label}</SelectItem>; })}</SelectContent>
            </Select>
          </div>
          <div><Label>Mietername</Label><Input id="c-name" placeholder="Vor- und Nachname"/></div>
          <div><Label>IBAN</Label><Input id="c-iban" placeholder="DE.."/></div>
          <div><Label>{rentLabel} (€)</Label><Input id="c-expected" type="number" min={0} step="0.5"/></div>
          <div><Label>Fälligkeit (Tag)</Label><Input id="c-dueday" type="number" min={1} max={28} defaultValue={3}/></div>
          <div><Label>Verwendungszweck</Label><Input id="c-ref" placeholder="z. B. Miete Whg 3 / Zi 5"/></div>
          <div><Label>Start</Label><Input id="c-start" type="date"/></div>
          <div><Label>Ende (optional)</Label><Input id="c-end" type="date"/></div>
          <div><Label>Kaution (€, optional)</Label><Input id="c-dep" type="number" min={0} step="0.5"/></div>
          <div><Label>Zimmernummer (optional)</Label><Input id="c-room" type="text" placeholder="z. B. 5"/></div>
        </div>
        <Button onClick={()=>{ 
          const name=(document.getElementById('c-name') as HTMLInputElement).value?.trim(); 
          const iban=(document.getElementById('c-iban') as HTMLInputElement).value?.replace(/\s+/g,""); 
          const expected=parseNumber((document.getElementById('c-expected') as HTMLInputElement).value); 
          const dueDay=Number((document.getElementById('c-dueday') as HTMLInputElement).value||3); 
          const reference=(document.getElementById('c-ref') as HTMLInputElement).value?.trim(); 
          const startDate=(document.getElementById('c-start') as HTMLInputElement).value; 
          const endDate=(document.getElementById('c-end') as HTMLInputElement).value; 
          const deposit=parseNumber((document.getElementById('c-dep') as HTMLInputElement).value); 
          const roomNumber=(document.getElementById('c-room') as HTMLInputElement).value?.trim(); 
          if(!cUnit||!name||!iban||!Number.isFinite(expected)) return; 
          setContracts((cs:any[])=>[...cs,{id:uid(), unitId:cUnit, tenantName:name, tenantIban:iban, expected, dueDay, reference, startDate, endDate, deposit, roomNumber}]); 
          ['c-name','c-iban','c-expected','c-dueday','c-ref','c-start','c-end','c-dep','c-room'].forEach(id=>{ const el=document.getElementById(id) as HTMLInputElement|null; if(el) el.value=""; }); 
        }}><PlusCircle size={16} />Vertrag speichern</Button>

        <Table className="mt-4"><TableHeader><TableRow><TableHead>Objekt</TableHead><TableHead>Einheit</TableHead><TableHead>Zimmer</TableHead><TableHead>Mieter</TableHead><TableHead>{rentLabel}</TableHead><TableHead>Fälligkeit</TableHead></TableRow></TableHeader><TableBody>{contracts.map((c:any)=>{ const u=units.find((x:any)=>x.id===c.unitId); const p=properties.find((pp:any)=>pp.id===u?.propertyId); return (<TableRow key={c.id}><TableCell>{p?.name||"-"}</TableCell><TableCell>{u?.label||"-"}</TableCell><TableCell>{c.roomNumber||""}</TableCell><TableCell>{c.tenantName}</TableCell><TableCell>{Number(c.expected).toFixed(2)} €</TableCell><TableCell>{c.dueDay}.</TableCell></TableRow>); })}</TableBody></Table>
      </CardContent>
    </Card>
  );
}

function BankSection({ txHeaders, txMap, setTxMap, onUploadTxs }:{txHeaders:string[];txMap:any;setTxMap:any;onUploadTxs:(f:File)=>void;}){
  return (
    <Card>
      <CardHeader><CardTitle>Bankumsätze importieren</CardTitle><CardDescription>CSV-Export deiner Bank (Einnahmen meist als negative Beträge)</CardDescription></CardHeader>
      <CardContent className="space-y-4">
        <Label htmlFor="txs">CSV-Datei</Label>
        <Input id="txs" type="file" accept=".csv" onChange={(e)=> e.target.files && onUploadTxs(e.target.files[0])} />
        {txHeaders.length>0 && (
          <div style={{display:'grid', gap:10, gridTemplateColumns:'1fr 1fr'}}>
            {Object.keys(txMap).map((key)=> (
              <div key={key} style={{display:'flex', flexDirection:'column', gap:6}}>
                <Label>{key}</Label>
                <Select value={txMap[key]} onValueChange={(v)=> setTxMap((m:any)=>({...m, [key]: v}))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{txHeaders.map((h)=> (<SelectItem key={h} value={h}>{h}</SelectItem>))}</SelectContent>
                </Select>
              </div>
            ))}
          </div>
        )}
        <div style={{display:'flex', gap:8}}>
          <Button variant="outline" onClick={()=>{ const sample=`date,amount,name,iban,reference\n2025-08-03,-950,Max Mustermann,DE02100100109307118603,Miete Max August\n2025-08-06,-720,Erika Musterfrau,DE12500105170648489890,Miete Erika August`; const blob=new Blob([sample],{type:"text/csv"}); const url=URL.createObjectURL(blob); const a=document.createElement("a"); a.href=url; a.download="bank-beispiel.csv"; a.click(); URL.revokeObjectURL(url); }}><FileDown size={16}/>Beispiel-CSV</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function OverviewSection({ matches, missing, partial, overpaid, selectedMonth }:{matches:any[];missing:any[];partial:any[];overpaid:any[];selectedMonth:string;}){
  return (
    <Card>
      <CardHeader><CardTitle>Übersicht</CardTitle><CardDescription>Abgleich für {format(new Date(selectedMonth+"-01"), "MMMM yyyy", {locale:de})}</CardDescription></CardHeader>
      <CardContent>
        <div style={{display:'flex', gap:8, flexWrap:'wrap', paddingBottom:12}}>
          <Badge>OK: {matches.filter((m:any)=>m.status==="ok").length}</Badge>
          <Badge>Offen: {missing.length}</Badge>
          <Badge>Teilzahlungen: {partial.length}</Badge>
          <Badge>Überzahlungen: {overpaid.length}</Badge>
        </div>
        <Table>
          <TableHeader><TableRow><TableHead>Objekt</TableHead><TableHead>Einheit</TableHead><TableHead>Zimmer</TableHead><TableHead>Mieter</TableHead><TableHead>Erwartet (€)</TableHead><TableHead>Status</TableHead><TableHead>Info</TableHead></TableRow></TableHeader>
          <TableBody>{matches.map(({ tenant, status, info }:any, i:number)=> (
            <TableRow key={i}>
              <TableCell>{tenant.propertyName || "-"}</TableCell>
              <TableCell>{tenant.unitLabel || "-"}</TableCell>
              <TableCell>{tenant.roomNumber || ""}</TableCell>
              <TableCell style={{fontWeight:600}}>{tenant.name}</TableCell>
              <TableCell>{tenant.expected.toFixed(2)}</TableCell>
              <TableCell>
                {status==="ok" && <span style={{display:'inline-flex', alignItems:'center', gap:6}}><CheckCircle2 size={16}/>Bezahlt</span>}
                {status==="missing" && <span style={{display:'inline-flex', alignItems:'center', gap:6}}><XCircle size={16}/>Offen</span>}
                {status==="partial" && <span style={{display:'inline-flex', alignItems:'center', gap:6}}><AlertTriangle size={16}/>Teilzahlung</span>}
                {status==="over" && <span style={{display:'inline-flex', alignItems:'center', gap:6}}><CheckCircle2 size={16}/>Überzahlung</span>}
              </TableCell>
              <TableCell style={{fontSize:14}} className="muted">{info}</TableCell>
            </TableRow>
          ))}</TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function SettingsSection({
  graceDays, amountTolerance, setGraceDays, setAmountTolerance, settings, setSettings
}:{graceDays:number;amountTolerance:number;setGraceDays:any;setAmountTolerance:any;settings:any;setSettings:any;}){
  return (
    <Card>
      <CardHeader><CardTitle>Einstellungen</CardTitle><CardDescription>Fälligkeit, Toleranzen & Automatik</CardDescription></CardHeader>
      <CardContent className="space-y-4">
        <div style={{display:'grid', gap:12, gridTemplateColumns:'1fr 1fr 1fr'}}>
          <div><Label>Nachfrist (Tage)</Label><Input type="number" min={0} max={10} value={graceDays} onChange={(e)=> setGraceDays(Number((e.target as HTMLInputElement).value)||0)}/></div>
          <div><Label>Betrags-Toleranz (€)</Label><Input type="number" min={0} step="0.5" value={amountTolerance} onChange={(e)=> setAmountTolerance(Number((e.target as HTMLInputElement).value)||0)}/></div>
          <div><Label>Anzeigename für Miete</Label><Input value={settings?.rentLabel||"Miete"} onChange={(e)=> setSettings({...settings, rentLabel: (e.target as HTMLInputElement).value})} /></div>
        </div>
        <div style={{display:'grid', gap:12, gridTemplateColumns:'1fr 1fr'}}>
          <label style={{display:'flex', gap:8, alignItems:'center'}}>
            <input type="checkbox" checked={!!settings?.autoDraftOnUpload}
                   onChange={(e)=> setSettings({...settings, autoDraftOnUpload: e.currentTarget.checked})}/>
            <span>PDF-Upload erzeugt automatisch Entwürfe (Posteingang)</span>
          </label>
          <label style={{display:'flex', gap:8, alignItems:'center'}}>
            <input type="checkbox" checked={!!settings?.autoCreatePropertyUnit}
                   onChange={(e)=> setSettings({...settings, autoCreatePropertyUnit: e.currentTarget.checked})}/>
            <span>Objekt/Einheit automatisch anlegen (aus Adresse/Zimmer)</span>
          </label>
        </div>
      </CardContent>
    </Card>
  );
}

// ===================================================================
// === PATCH REGION: KI-IMPORT SECTION (mit Ladebalken) — START
// ===================================================================
function KiImportSectionWithProgress({ onAutoDraft, settings }:{ onAutoDraft:(previews:any[])=>void; settings:any;}){
  const [results, setResults] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);

  const detectPdf = (file: File) => {
    const t = (file.type||"").toLowerCase();
    return t.includes("pdf") || /\.pdf$/i.test(file.name||"");
  };

  const onFiles = async (files: File[]) => {
    setBusy(true);
    setProgress(0);
    try{
      const previews: any[] = [];

      for (let idx=0; idx<files.length; idx++){
        const file = files[idx];
        let text = "";
        setProgress(1);

        try {
          if (detectPdf(file)) {
            // 1) PDF-Text mit Seiten-Fortschritt
            text = await readPdfText(file, (p)=> setProgress(Math.max(p, 5)));
            // 2) Falls leer -> OCR (mit echtem Fortschritt)
            if (!text || text.length < 10) {
              setProgress(0);
              text = await ocrPdfFirstPage(file, (p)=> setProgress(p));
            }
          } else if ((file.type||"").startsWith("text/") || /\.txt$/i.test(file.name||"")){
            text = await file.text();
            setProgress(100);
          } else {
            // MIME unbekannt -> vorsichtig PDF versuchen
            try { text = await readPdfText(file, (p)=> setProgress(p)); } catch {}
            if (!text || text.length < 10) {
              setProgress(0);
              try { text = await ocrPdfFirstPage(file, (p)=> setProgress(p)); } catch {}
            }
          }
        } catch (err) {
          console.error("PDF/Scan lesen fehlgeschlagen:", err);
        }

        if (!text || text.length < 1) text = "(kein Text erkannt – ggf. OCR nötig)";
        const extracted = extractWithMapping(text||"", DEFAULT_MAPPING);

        previews.push({
          fileName: file.name,
          textLength: (text||"").length,
          extracted,
          matchedUnit: null
        });

        if (idx < files.length - 1) setProgress(0);
      }

      setResults(previews);
      if (settings?.autoDraftOnUpload) onAutoDraft(previews);
      setProgress(100);
    }catch(e:any){
      console.error('KI-Import Fehler:', e);
      alert('Analyse fehlgeschlagen: ' + (e?.message || e));
      setProgress(0);
    } finally { 
      setBusy(false); 
      setTimeout(()=> setProgress(0), 800);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Verträge importieren (KI)</CardTitle>
        <CardDescription>PDF/Scan hochladen → Entwürfe im Posteingang bestätigen</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Input type="file" accept="application/pdf,text/plain" multiple
               onChange={(e)=> e.target.files && onFiles([...(e.target.files as any)])} />
        <Button disabled={busy} variant="outline"
                onClick={()=> (document.querySelector('input[type=file]') as HTMLInputElement)?.click()}>
          <Upload size={16}/>Dateien wählen
        </Button>

        {busy && <ProgressBar value={progress} />}

        {(!settings?.autoDraftOnUpload && results.length>0) && (
          <Table className="mt-3">
            <TableHeader>
              <TableRow>
                <TableHead>Datei</TableHead>
                <TableHead>Mieter</TableHead>
                <TableHead>Miete (EUR)</TableHead>
                <TableHead>Kaution</TableHead>
                <TableHead>Start</TableHead>
                <TableHead>Einheit</TableHead>
                <TableHead>Zimmer</TableHead>
                <TableHead>Adresse</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {results.map((r:any,i:number)=> (
                <TableRow key={i}>
                  <TableCell className="text-sm">{r.fileName}</TableCell>
                  <TableCell>{r.extracted.tenantName||'–'}</TableCell>
                  <TableCell>{Number(r.extracted.expected||0).toFixed(2)}</TableCell>
                  <TableCell>{Number(r.extracted.deposit||0).toFixed(2)}</TableCell>
                  <TableCell>{r.extracted.startDate||'–'}</TableCell>
                  <TableCell>{r.extracted.unitLabel||'–'}</TableCell>
                  <TableCell>{r.extracted.roomNumber||'–'}</TableCell>
                  <TableCell>{r.extracted.address||'–'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
// ===================================================================
// === PATCH REGION: KI-IMPORT SECTION — END
// ===================================================================
