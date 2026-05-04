import { useState, useEffect, useRef, useCallback } from "react";
import {
  fetchTasks, createTask, updateTask, deleteTask,
  fetchKb, createKbEntry, deleteKbEntry
} from "./notion.js";
import * as XLSX from "xlsx";
import mammoth from "mammoth";

// ── helpers ───────────────────────────────────────────────────────────────────
const uid = () => Math.random().toString(36).slice(2, 10);
const today = () => new Date().toISOString().slice(0, 10);
const fmtDate = (d) => d ? new Date(d + "T00:00:00").toLocaleDateString("en-SG", { day: "2-digit", month: "short", year: "numeric" }) : "—";
const daysUntil = (d) => {
  if (!d) return null;
  return Math.ceil((new Date(d + "T00:00:00") - new Date(today() + "T00:00:00")) / 86400000);
};

const isImage = (f) => f && ["image/jpeg","image/png","image/gif","image/webp"].includes(f.type);
const isPDF   = (f) => f && (f.type === "application/pdf" || /\.pdf$/i.test(f.name||""));
const isMsg   = (f) => f && /\.msg$/i.test(f.name||"");
const isEml   = (f) => f && (/\.eml$/i.test(f.name||"") || f.type === "message/rfc822");
const isText  = (f) => f && (["text/plain","text/html","text/csv"].includes(f.type) || /\.(txt|html?|csv|json)$/i.test(f.name||""));

const toBase64 = (file) => new Promise((res,rej) => { const r=new FileReader(); r.onload=()=>res(r.result.split(",")[1]); r.onerror=rej; r.readAsDataURL(file); });
const toText   = (file) => new Promise((res,rej) => { const r=new FileReader(); r.onload=()=>res(r.result); r.onerror=rej; r.readAsText(file,"utf-8"); });
const toAB     = (file) => new Promise((res,rej) => { const r=new FileReader(); r.onload=()=>res(r.result); r.onerror=rej; r.readAsArrayBuffer(file); });

// ── .msg CFB parser ───────────────────────────────────────────────────────────
function parseMsgAB(ab) {
  const u8=new Uint8Array(ab), dv=new DataView(ab);
  const MAGIC=[0xD0,0xCF,0x11,0xE0,0xA1,0xB1,0x1A,0xE1];
  for(let i=0;i<8;i++) if(u8[i]!==MAGIC[i]) throw new Error("Not CFB");
  const secSz=1<<dv.getUint16(0x1E,true), nFAT=dv.getUint32(0x2C,true), dirSec=dv.getUint32(0x30,true);
  const miniCut=dv.getUint32(0x38,true), mFAT0=dv.getUint32(0x3C,true);
  const fatSecs=[];
  for(let i=0;i<109&&fatSecs.length<nFAT;i++){const s=dv.getUint32(0x4C+i*4,true);if(s<0xFFFFFFFB)fatSecs.push(s);}
  const fat=new Int32Array(fatSecs.length*(secSz/4));
  fatSecs.forEach((s,idx)=>{const off=(s+1)*secSz;for(let i=0;i<secSz/4;i++)fat[idx*(secSz/4)+i]=dv.getInt32(off+i*4,true);});
  const chain=s=>{const r=[];const seen=new Set();while(s>=0&&s<0xFFFFFFFB&&!seen.has(s)){seen.add(s);r.push(s);s=fat[s];}return r;};
  const readChain=(s,sz)=>{const secs=chain(s);const buf=new Uint8Array(secs.length*secSz);secs.forEach((s,i)=>buf.set(u8.subarray((s+1)*secSz,(s+2)*secSz),i*secSz));return sz!==undefined?buf.subarray(0,sz):buf;};
  let mfs=[],ms=mFAT0;while(ms>=0&&ms<0xFFFFFFFB){mfs.push(ms);ms=fat[ms];}
  const mFAT=new Int32Array(mfs.length*(secSz/4));
  mfs.forEach((s,idx)=>{const off=(s+1)*secSz;for(let i=0;i<secSz/4;i++)mFAT[idx*(secSz/4)+i]=dv.getInt32(off+i*4,true);});
  const dir=readChain(dirSec); const msr={start:0,size:0}; const entries=[];
  for(let i=0;i<dir.length/128;i++){
    const off=i*128,nl=new DataView(dir.buffer,dir.byteOffset+off+64,2).getUint16(0,true);
    const name=String.fromCharCode(...new Uint16Array(dir.buffer,dir.byteOffset+off,nl/2)).replace(/\0/g,"");
    const type=dir[off+66],start=new DataView(dir.buffer,dir.byteOffset+off+116,4).getUint32(0,true),size=new DataView(dir.buffer,dir.byteOffset+off+120,4).getUint32(0,true);
    if(i===0){msr.start=start;msr.size=size;} entries.push({name,type,start,size});
  }
  let msd=null;const getMSD=()=>{if(!msd)msd=readChain(msr.start,msr.size);return msd;};
  const mc=s=>{const r=[];const seen=new Set();while(s>=0&&s<0xFFFFFFFB&&!seen.has(s)){seen.add(s);r.push(s);s=mFAT[s];}return r;};
  const rmc=(s,sz)=>{const d=getMSD();const secs=mc(s);const buf=new Uint8Array(secs.length*64);secs.forEach((s,i)=>buf.set(d.subarray(s*64,(s+1)*64),i*64));return sz!==undefined?buf.subarray(0,sz):buf;};
  const re=e=>e.size<miniCut&&e.start<0xFFFFFFFB?rmc(e.start,e.size):readChain(e.start,e.size);

  const d16=b=>{try{return new TextDecoder("utf-16le").decode(b).replace(/\0/g,"");}catch{return "";}};
  const d8=b=>{
    const encs=["utf-8","windows-1252","iso-8859-1"];
    for(const enc of encs){
      try{const t=new TextDecoder(enc,{fatal:true}).decode(b).replace(/\0/g,"");if(t&&!/[\uFFFD]/.test(t))return t;}catch{}
    }
    try{return new TextDecoder("utf-8").decode(b).replace(/\0/g,"");}catch{return "";}
  };

  // Use separate maps to track 001F and 0102 versions separately
  const props001F={};  // UTF-16LE - preferred
  const props0102={};  // Binary - fallback
  const props001E={};  // 8-bit string
  const TAGS={"0037":"subject","0C1A":"fromName","0C1F":"fromEmail","1000":"body","1013":"bodyHtml","0E04":"toNames","0E03":"ccNames"};

  entries.forEach(e=>{
    if(e.type!==2)return;
    const m=e.name.toUpperCase().match(/^__SUBSTG1\.0_([0-9A-F]{4})([0-9A-F]{4})$/);
    if(!m)return;
    const field=TAGS[m[1]];
    if(!field)return;
    const bytes=re(e);
    if(m[2]==="001F"){
      const t=d16(bytes);
      if(t) props001F[field]=(props001F[field]||"")+t;
    } else if(m[2]==="001E"){
      const t=d8(bytes);
      if(t) props001E[field]=(props001E[field]||"")+t;
    } else if(m[2]==="0102"){
      const t=d8(bytes);
      if(t) props0102[field]=(props0102[field]||"")+t;
    }
  });

  // Merge: prefer 001F > 001E > 0102
  const props={};
  const allFields=new Set([...Object.keys(props001F),...Object.keys(props001E),...Object.keys(props0102)]);
  allFields.forEach(f=>{
    props[f]=props001F[f]||props001E[f]||props0102[f]||"";
  });

  // Clean up body text - strip leading garbage characters
  if(props.body){
    props.body=props.body.replace(/^[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFD\uFFFE\uFFFF\u0000-\u001F]+/,"").trim();
  }

  const sh=h=>{
    try{
      const cleaned=h.replace(/<style[\s\S]*?<\/style>/gi,"").replace(/<script[\s\S]*?<\/script>/gi,"")
        .replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/&lt;/gi,"<").replace(/&gt;/gi,">");
      const d=new DOMParser().parseFromString(cleaned,"text/html");
      return (d.body.innerText||d.body.textContent||"").replace(/\n{3,}/g,"\n\n").trim();
    }catch{return h.replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();}
  };

  return {
    subject:props.subject||"(no subject)",
    from:props.fromName?(props.fromEmail?`${props.fromName} <${props.fromEmail}>`:props.fromName):(props.fromEmail||"unknown"),
    to:props.toNames||"",
    cc:props.ccNames||"",
    body:(()=>{
      // Only use bodyHtml if it produces clean readable text
      if(props001F.bodyHtml){
        const cleaned=sh(props001F.bodyHtml);
        if(cleaned && cleaned.length>10 && !/[\uFFFD\x00-\x08]/.test(cleaned)) return cleaned;
      }
      // Fall back to plain text body (001F version is always cleanest)
      return props001F.body || props.body || "(no body)";
    })()
  };
}

async function parseMsgFile(file) {
  const ab = await toAB(file);
  return parseMsgAB(ab);
}

async function parseExcel(file) {
  try {
    const ab = await toAB(file);
    const wb = XLSX.read(ab, { type:"array" });
    const parts = [];
    wb.SheetNames.forEach(name => {
      const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name], {blankrows:false});
      if(csv.trim()) parts.push(`Sheet "${name}":\n${csv.slice(0,3000)}`);
    });
    return parts.join("\n\n---\n\n") || "(empty)";
  } catch(e) { return `(Excel parse failed: ${e.message} — try CSV)`; }
}

async function parseWord(file) {
  try {
    const result = await mammoth.extractRawText({ arrayBuffer: await toAB(file) });
    return result.value?.slice(0,5000) || "(no text)";
  } catch(e) { return `(Word parse failed: ${e.message})`; }
}

async function parseAttachment(file) {
  if(isMsg(file)){
    try{
      const p=await parseMsgFile(file);
      return{type:"email",label:file.name,content:`📧 Email: ${p.subject}\nFrom: ${p.from}\nTo: ${p.to}${p.cc?"\nCC: "+p.cc:""}\n\n${p.body.slice(0,3000)}`};
    }catch(e){
      try{return{type:"email",label:file.name,content:`📧 Email (raw):\n${(await toText(file)).slice(0,3000)}`};}
      catch{return{type:"error",label:file.name,content:`Could not parse .msg: ${e.message}`};}
    }
  }
  if(isEml(file)){try{const text=await toText(file);const lines=text.split("\n");const h={};let bs=0;for(let i=0;i<lines.length;i++){if(!lines[i].trim()){bs=i+1;break;}const m=lines[i].match(/^(From|To|Subject|Date|CC):\s*(.+)/i);if(m)h[m[1].toLowerCase()]=m[2].trim();}return{type:"email",label:file.name,content:`📧 Email: ${h.subject||"(no subject)"}\nFrom: ${h.from||""}\nTo: ${h.to||""}\nDate: ${h.date||""}\n\n${lines.slice(bs).join("\n").slice(0,3000)}`};}catch{return{type:"error",label:file.name,content:"Could not parse .eml"};}}
  if(isImage(file)){return{type:"image",label:file.name,b64:await toBase64(file),mimeType:file.type};}
  if(isPDF(file)){return{type:"pdf",label:file.name,b64:await toBase64(file)};}
  if(/\.(xlsx?)$/i.test(file.name||"")){return{type:"text",label:file.name,content:`📊 Excel: ${file.name}\n\n${await parseExcel(file)}`};}
  if(/\.csv$/i.test(file.name||"")||file.type==="text/csv"){return{type:"text",label:file.name,content:`📊 CSV:\n${(await toText(file)).slice(0,5000)}`};}
  if(/\.docx?$/i.test(file.name||"")){return{type:"text",label:file.name,content:`📄 Word:\n${await parseWord(file)}`};}
  if(isText(file)){return{type:"text",label:file.name,content:(await toText(file)).slice(0,5000)};}
  return{type:"unknown",label:file.name,content:`File: ${file.name} — cannot be read directly.`};
}

function attToAPI(att, userText) {
  if(att.type==="image") return [{type:"image",source:{type:"base64",media_type:att.mimeType,data:att.b64}},{type:"text",text:userText}];
  if(att.type==="pdf")   return [{type:"document",source:{type:"base64",media_type:"application/pdf",data:att.b64}},{type:"text",text:userText}];
  return [{type:"text",text:(att.content||"")+"\n\n---\n\n"+userText}];
}

// ── Config ────────────────────────────────────────────────────────────────────
const S = { bg: { "Not Started":"#18181b","In Progress":"#0c1a2e","Pending Others":"#1c1400","Completed":"#052016" }, badge: { "Not Started":"#3f3f46 #a1a1aa","In Progress":"#1e3a5f #7dd3fc","Pending Others":"#78350f #fcd34d","Completed":"#064e3b #6ee7b7" } };
const STATUSES = ["Not Started","In Progress","Pending Others","Completed"];
const PRIORITIES = ["Low","Medium","High","Urgent"];
const PRI = { Low:"#71717a",Medium:"#38bdf8",High:"#fb923c",Urgent:"#f87171" };
const CAT_COLOR = { Process:"#5b21b6 #c4b5fd",Contact:"#065f46 #6ee7b7",Tool:"#1e3a5f #7dd3fc",SOP:"#78350f #fcd34d",Other:"#3f3f46 #a1a1aa" };

// ── MAIN APP ──────────────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState("chat");
  const [tasks, setTasks] = useState([]);
  const [kb, setKb] = useState([]);
  const [msgs, setMsgs] = useState([]);
  const [userEmail, setUserEmail] = useState(() => localStorage.getItem("vpa_email") || "");
  const [input, setInput] = useState("");
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [dataLoading, setDataLoading] = useState(true);
  const [authed, setAuthed] = useState(() => sessionStorage.getItem("vpa_auth") === "true");
  const [pinInput, setPinInput] = useState("");
  const [pinError, setPinError] = useState(false);
  const [taskFilter, setTaskFilter] = useState("All");
  const [editTask, setEditTask] = useState(null);
  const [kbSearch, setKbSearch] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const bottomRef = useRef(null);
  const fileRef = useRef(null);
  const dragCounter = useRef(0);

  const WELCOME = { role:"assistant", content:"👋 Hi Dave! I'm your AI Personal Assistant, connected to Notion.\n\nYour tasks and knowledge base are loaded from Notion and sync automatically.\n\nYou can:\n• Tell me about a task or attach an email/file — I'll create structured tasks in Notion\n• Ask for your task status or what to focus on today\n• Teach me your internal processes — I'll remember them in your KB\n• Update task status by just telling me\n\nWhat would you like to do today?" };

  // Load chat from localStorage, tasks/KB from Notion
  useEffect(() => {
    const savedMsgs = localStorage.getItem("vpa_msgs");
    setMsgs(savedMsgs ? JSON.parse(savedMsgs) : [WELCOME]);

    (async () => {
      try {
        const [t, k] = await Promise.all([fetchTasks(), fetchKb()]);
        setTasks(t);
        setKb(k);
      } catch(e) {
        console.error("Failed to load from Notion:", e);
        setMsgs([{ role:"assistant", content:`⚠️ Could not connect to Notion: ${e.message}\n\nCheck your environment variables and make sure the proxy is running.` }]);
      } finally {
        setDataLoading(false);
      }
    })();
  }, []);

  // Persist chat and email to localStorage
  useEffect(() => { if(msgs.length > 1) localStorage.setItem("vpa_msgs", JSON.stringify(msgs.slice(-60))); }, [msgs]);
  useEffect(() => { localStorage.setItem("vpa_email", userEmail); }, [userEmail]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior:"smooth" }); }, [msgs, loading]);

  // ── Task helpers (Notion-backed) ──────────────────────────────────────────
  const addTask = useCallback(async (t) => {
    setSyncing(true);
    try {
      const newTask = { id: uid(), createdAt: today(), status: "Not Started", priority: "Medium", subtasks: [], ...t };
      const saved = await createTask(newTask);
      setTasks(prev => [...prev, saved]);
      return saved;
    } catch(e) {
      console.error("addTask failed:", e);
      throw e;
    } finally { setSyncing(false); }
  }, []);

  const patchTask = useCallback(async (notionId, patch) => {
    setSyncing(true);
    try {
      // Always preserve existing subtasks if patch doesn't explicitly include them
      const existingTask = tasks.find(t => t.notionId === notionId);
      const safePatch = { ...patch };
      if (!safePatch.subtasks && existingTask?.subtasks) {
        safePatch.subtasks = existingTask.subtasks;
      }
      setTasks(prev => prev.map(t => t.notionId === notionId ? { ...t, ...safePatch } : t));
      await updateTask(notionId, safePatch);
    } finally { setSyncing(false); }
  }, [tasks]);

  const removeTask = useCallback(async (notionId) => {
    setSyncing(true);
    try {
      setTasks(prev => prev.filter(t => t.notionId !== notionId));
      await deleteTask(notionId);
    } finally { setSyncing(false); }
  }, []);

  const addKb = useCallback(async (entry) => {
    if (kb.some(k => k.title.toLowerCase() === entry.title.toLowerCase())) return;
    setSyncing(true);
    try {
      const saved = await createKbEntry({ id: uid(), createdAt: today(), ...entry });
      setKb(prev => [...prev, saved]);
    } finally { setSyncing(false); }
  }, [kb]);

  const removeKb = useCallback(async (notionId) => {
    setSyncing(true);
    try {
      setKb(prev => prev.filter(k => k.notionId !== notionId));
      await deleteKbEntry(notionId);
    } finally { setSyncing(false); }
  }, []);

  // ── System prompt ─────────────────────────────────────────────────────────
  const buildSystem = () => {
    const ts = tasks.length === 0 ? "No tasks." : tasks.map(t => `[notionId:${t.notionId}] "${t.title}" | ${t.status} | ${t.priority} | Due: ${t.dueDate||"not set"} | Subtasks: ${(t.subtasks||[]).map(s=>`${s.done?"✅":"⬜"} ${s.text}`).join(", ")||"none"}`).join("\n");
    const ks = kb.length === 0 ? "No KB entries." : kb.map(k => `[notionId:${k.notionId}] ${k.title} (${k.category}): ${k.content}`).join("\n");
    return `You are Dave's AI Virtual Personal Assistant. Connected to Notion for persistent storage.

TODAY: ${today()}
USER EMAIL: ${userEmail||"dave.loh@kuokgroup.com.sg"}

## TASKS (live from Notion)
${ts}

## KNOWLEDGE BASE (live from Notion)
${ks}

## ACTIONS — CRITICAL: output ONLY an 'actions' code block at the END of your message (not 'json'). This is parsed programmatically — wrong block type means actions are IGNORED and shown raw to user:

## SUBTASK RULES — VERY IMPORTANT:
- When updating a task, ALWAYS include the COMPLETE subtasks array in the patch
- NEVER send an update_task without the full subtasks array
- To mark a subtask done: include ALL subtasks, change the specific one from done:false to done:true
- NEVER omit subtasks from a patch — omitting them will preserve existing ones but it is safer to always include them
\`\`\`actions
[
  { "action": "create_task", "title": "...", "description": "...", "dueDate": "YYYY-MM-DD or null", "priority": "Low|Medium|High|Urgent", "subtasks": ["step 1","step 2"] },
  { "action": "update_task", "notionId": "...", "patch": { "status": "...", "dueDate": "...", "subtasks": [...] } },
  { "action": "add_kb", "title": "...", "content": "...", "category": "Process|Tool|Contact|SOP|Other" },
  { "action": "complete_subtask", "notionId": "...", "subtaskIndex": 0 }
]
\`\`\`

## RULES
1. Extract task details from emails/files and create structured tasks with smart subtasks.
2. New task type you haven't seen — ask user to explain the process BEFORE creating tasks.
3. Learn new processes/SOPs/tools/contacts — save to KB.
4. Check KB first — if process known, auto-create full subtasks.
5. When user says they completed something — update the relevant task/subtask using notionId.
6. Flag overdue tasks, what's due soon, what to focus on today.
7. Always output JSON actions block when modifying tasks or KB.
8. Use notionId (not id) when referencing existing tasks for updates.`;
  };

  // ── Send message ──────────────────────────────────────────────────────────
  const send = async () => {
    if (!input.trim() && files.length === 0) return;
    setLoading(true);
    const parsedAtts = await Promise.all(files.map(parseAttachment));
    const attLabels = parsedAtts.map(a => a.label).join(", ");
    const displayContent = input + (attLabels ? `\n📎 ${attLabels}` : "");
    const newMsgs = [...msgs, { role:"user", content: displayContent }];
    setMsgs(newMsgs);
    setInput("");
    setFiles([]);

    let userContent;
    if(parsedAtts.length === 0) userContent = input;
    else if(parsedAtts.length === 1) userContent = attToAPI(parsedAtts[0], input || "Please analyse this and help me with the relevant task.");
    else userContent = parsedAtts.map(a => a.content||`[${a.label}]`).join("\n\n---\n\n") + "\n\n---\n\n" + (input || "Please analyse these.");

    try {
      const history = newMsgs.slice(-20).map((m, i, arr) => {
        if(i === arr.length - 1 && parsedAtts.length > 0)
          return { role:"user", content: typeof userContent === "string" ? userContent : userContent };
        return { role: m.role, content: typeof m.content === "string" ? m.content : m.content };
      });

      const resp = await fetch("/api/proxy-claude", {
        method: "POST",
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify({ model:"claude-sonnet-4-20250514", max_tokens:2000, system: buildSystem(), messages: history })
      });
      const data = await resp.json();
      const raw = data.content?.find(b => b.type === "text")?.text || "Sorry, I couldn't process that.";

      // Execute actions
      // Try to find actions block - AI sometimes outputs ```actions, ```json, or plain ```
      const actMatch = raw.match(/```(?:actions|json)?\s*([\s\S]*?)```/);
      const done = [];
      // Only treat as actions if it looks like a JSON array with action objects
      let parsedActions = null;
      if(actMatch) {
        try {
          const parsed = JSON.parse(actMatch[1].trim());
          if(Array.isArray(parsed) && parsed[0]?.action) parsedActions = parsed;
        } catch(e) {}
      }
      if(parsedActions) {
        try {
          const actions = parsedActions;
          for(const act of actions) {
            if(act.action === "create_task") {
              const sub = (act.subtasks||[]).map(s => ({ id:uid(), text: typeof s === "string" ? s : (s?.text || s?.name || JSON.stringify(s)), done: s?.done || false })).filter(s => s.text);
              const t = await addTask({ title:act.title, description:act.description||"", dueDate:act.dueDate||null, priority:act.priority||"Medium", subtasks:sub });
              done.push(`✅ Task created in Notion: "${t.title}"`);
            } else if(act.action === "update_task") {
              const existingTask = tasks.find(t => t.notionId === act.notionId);
              const safePatch = { ...act.patch };
              // ALWAYS preserve existing subtasks - never let an update wipe them
              if (existingTask?.subtasks?.length > 0) {
                if (!safePatch.subtasks) {
                  // AI didn't send subtasks - use existing ones
                  safePatch.subtasks = existingTask.subtasks;
                } else {
                  // AI sent subtasks - normalize and merge with existing done states
                  const normalized = safePatch.subtasks.map(s => {
                    const text = typeof s === "string" ? s : (s?.text || s?.name || "");
                    const aiDone = typeof s === "object" ? s.done : false;
                    const existingSub = existingTask.subtasks.find(e => e.text === text);
                    return { id: existingSub?.id || uid(), text: String(text).trim(), done: aiDone !== undefined ? aiDone : (existingSub?.done || false) };
                  }).filter(s => s.text && s.text !== "undefined");
                  // If normalized is empty, keep existing subtasks
                  safePatch.subtasks = normalized.length > 0 ? normalized : existingTask.subtasks;
                }
              }
              await patchTask(act.notionId, safePatch);
              done.push(`🔄 Task updated in Notion`);
            } else if(act.action === "add_kb") {
              await addKb({ title:act.title, content:act.content, category:act.category||"Other" });
              done.push(`🧠 Saved to Notion KB: "${act.title}"`);
            } else if(act.action === "complete_subtask") {
              const task = tasks.find(t => t.notionId === act.notionId);
              if(task) {
                const subtasks = [...task.subtasks];
                if(subtasks[act.subtaskIndex]) subtasks[act.subtaskIndex] = { ...subtasks[act.subtaskIndex], done:true };
                await patchTask(act.notionId, { subtasks });
                done.push(`☑️ Subtask completed in Notion`);
              }
            }
          }
        } catch(e) { console.error("Action parse error:", e); done.push(`⚠️ Action failed: ${e.message}`); }
      }

      const clean = raw.replace(/```(?:actions|json)?[\s\S]*?```/g, "").trim();
      setMsgs(prev => [...prev, { role:"assistant", content: clean + (done.length > 0 ? "\n\n" + done.join("\n") : "") }]);
    } catch(e) {
      setMsgs(prev => [...prev, { role:"assistant", content:`⚠️ Error: ${e.message}` }]);
    }
    setLoading(false);
  };

  const handleKey = (e) => { if(e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } };
  const handleFileInput = (e) => { if(e.target.files) setFiles(prev => [...prev, ...Array.from(e.target.files)]); };
  const removeFile = (i) => setFiles(prev => prev.filter((_,idx) => idx !== i));
  const handleDragEnter = (e) => { e.preventDefault(); dragCounter.current++; setDragging(true); };
  const handleDragLeave = (e) => { e.preventDefault(); dragCounter.current--; if(dragCounter.current === 0) setDragging(false); };
  const handleDragOver = (e) => e.preventDefault();
  const handleDrop = (e) => { e.preventDefault(); dragCounter.current=0; setDragging(false); const d=Array.from(e.dataTransfer.files); if(d.length>0) setFiles(prev=>[...prev,...d]); };

  // ── Paste screenshot from clipboard ──────────────────────────────────────
  const handlePaste = (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageItems = Array.from(items).filter(item => item.type.startsWith("image/"));
    if (imageItems.length === 0) return; // no image — let normal paste work
    e.preventDefault();
    const newFiles = imageItems.map(item => item.getAsFile()).filter(Boolean);
    if (newFiles.length > 0) setFiles(prev => [...prev, ...newFiles]);
  };

  const openTasks = tasks.filter(t => t.status !== "Completed");
  const overdue = tasks.filter(t => t.status !== "Completed" && t.dueDate && daysUntil(t.dueDate) < 0);
  const dueToday = tasks.filter(t => t.status !== "Completed" && t.dueDate && daysUntil(t.dueDate) === 0);
  const filteredTasks = taskFilter === "All" ? tasks : tasks.filter(t => t.status === taskFilter);
  const filteredKb = kb.filter(k => kbSearch === "" || k.title.toLowerCase().includes(kbSearch.toLowerCase()) || k.content.toLowerCase().includes(kbSearch.toLowerCase()));

  // ── Styles ────────────────────────────────────────────────────────────────
  const s = {
    app: { display:"flex", height:"100vh", background:"var(--bg-base)", color:"var(--text-primary)", overflow:"hidden" },
    sidebar: { width:64, display:"flex", flexDirection:"column", alignItems:"center", padding:"16px 0", gap:8, background:"var(--bg-surface)", borderRight:"1px solid var(--border-subtle)" },
    logo: { width:36, height:36, borderRadius:10, background:"linear-gradient(135deg,#7c3aed,#4f46e5)", display:"flex", alignItems:"center", justifyContent:"center", color:"#fff", fontWeight:700, fontSize:13, marginBottom:8 },
    navBtn: (active) => ({ width:40, height:40, borderRadius:10, display:"flex", alignItems:"center", justifyContent:"center", fontSize:18, transition:"all .15s", background: active?"var(--accent)":"transparent", color: active?"#fff":"var(--text-muted)", boxShadow: active?"0 4px 12px rgba(124,58,237,.4)":"none" }),
    main: { flex:1, display:"flex", flexDirection:"column", overflow:"hidden" },
    header: { display:"flex", alignItems:"center", justifyContent:"space-between", padding:"12px 20px", borderBottom:"1px solid var(--border-subtle)", background:"var(--bg-surface)" },
    headerTitle: { fontSize:15, fontWeight:600 },
    headerSub: { fontSize:11, color:"var(--text-muted)", marginTop:2 },
    btn: { fontSize:12, padding:"6px 12px", borderRadius:8, background:"var(--bg-elevated)", color:"var(--text-secondary)", transition:"all .15s", cursor:"pointer" },
    btnAccent: { fontSize:12, padding:"6px 12px", borderRadius:8, background:"var(--accent)", color:"#fff", transition:"all .15s", cursor:"pointer" },
    messages: { flex:1, overflowY:"auto", padding:"20px", display:"flex", flexDirection:"column", gap:12 },
    msg: (role) => ({ display:"flex", justifyContent: role==="user"?"flex-end":"flex-start" }),
    bubble: (role) => ({ maxWidth:"80%", borderRadius: role==="user"?"18px 18px 4px 18px":"18px 18px 18px 4px", padding:"10px 14px", fontSize:13, lineHeight:1.6, whiteSpace:"pre-wrap", background: role==="user"?"var(--accent)":"var(--bg-elevated)", color: role==="user"?"#fff":"var(--text-primary)" }),
    inputArea: { padding:"0 20px 20px" },
    inputBox: { display:"flex", gap:8, alignItems:"flex-end", background:"var(--bg-elevated)", borderRadius:16, border:"1px solid var(--border)", padding:"10px 12px", transition:"border-color .15s" },
    textarea: { flex:1, background:"transparent", color:"var(--text-primary)", border:"none", outline:"none", resize:"none", fontSize:13, minHeight:36, maxHeight:120, fontFamily:"var(--font)" },
    sendBtn: { width:36, height:36, borderRadius:10, background:"var(--accent)", color:"#fff", display:"flex", alignItems:"center", justifyContent:"center", transition:"all .15s", flexShrink:0, cursor:"pointer" },
    taskCard: (status) => ({ borderRadius:16, border:"1px solid var(--border-subtle)", background: S.bg[status]||"var(--bg-surface)", padding:16, animation:"fadeIn .2s ease" }),
    badge: (status) => { const [bg,color]=(S.badge[status]||"#3f3f46 #a1a1aa").split(" "); return { fontSize:11, fontWeight:500, padding:"2px 8px", borderRadius:20, background:bg, color }; },
    kbCard: { borderRadius:16, border:"1px solid var(--border-subtle)", background:"var(--bg-surface)", padding:16 },
    catBadge: (cat) => { const [bg,color]=(CAT_COLOR[cat]||CAT_COLOR.Other).split(" "); return { fontSize:11, fontWeight:500, padding:"2px 8px", borderRadius:20, background:bg, color }; },
    progress: (pct) => ({ height:3, borderRadius:2, background:"var(--bg-elevated)", overflow:"hidden", marginBottom:8, position:"relative" }),
    progressFill: (pct) => ({ position:"absolute", left:0, top:0, height:"100%", width:`${pct}%`, background:"var(--accent)", borderRadius:2, transition:"width .3s" }),
    subtaskRow: { display:"flex", alignItems:"center", gap:8, marginBottom:4 },
    checkbox: (done) => ({ width:16, height:16, borderRadius:4, border:`1.5px solid ${done?"var(--accent)":"var(--border)"}`, background: done?"var(--accent)":"transparent", display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer", flexShrink:0, transition:"all .15s", fontSize:10, color:"#fff" }),
    filterBtn: (active) => ({ fontSize:11, padding:"4px 10px", borderRadius:8, background: active?"var(--accent)":"var(--bg-elevated)", color: active?"#fff":"var(--text-muted)", cursor:"pointer", transition:"all .15s" }),
    syncDot: (syncing) => ({ width:6, height:6, borderRadius:"50%", background: syncing?"var(--warning)":"var(--success)", flexShrink:0, animation: syncing?"spin 1s linear infinite":"none" }),
    settingsBar: { padding:"10px 20px", borderBottom:"1px solid var(--border-subtle)", background:"rgba(24,24,27,.8)", display:"flex", alignItems:"center", gap:12 },
    settingsInput: { flex:1, background:"var(--bg-elevated)", color:"var(--text-primary)", border:"1px solid var(--border)", borderRadius:8, padding:"6px 12px", fontSize:13, outline:"none" },
  };

  const APP_PIN = import.meta.env.VITE_APP_PIN || "pa2026";

  const handleDebug = async () => {
    try {
      const { debugTasksDB } = await import("./notion.js");
      const props = await debugTasksDB();
      alert("Tasks DB properties:\n" + props.join("\n"));
    } catch(e) {
      alert("Debug error: " + e.message);
    }
  };

  const handleLogin = () => {
    if(pinInput === APP_PIN) {
      sessionStorage.setItem("vpa_auth","true");
      setAuthed(true);
      setPinError(false);
    } else {
      setPinError(true);
      setPinInput("");
    }
  };

  if(!authed) return (
    <div style={{display:"flex",height:"100vh",alignItems:"center",justifyContent:"center",background:"var(--bg-base)"}}>
      <div style={{background:"var(--bg-surface)",border:"1px solid var(--border)",borderRadius:20,padding:40,width:340,display:"flex",flexDirection:"column",alignItems:"center",gap:20}}>
        <div style={{width:56,height:56,borderRadius:16,background:"linear-gradient(135deg,#7c3aed,#4f46e5)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:24}}>🤖</div>
        <div style={{textAlign:"center"}}>
          <h2 style={{fontSize:20,fontWeight:600,marginBottom:4}}>Virtual PA</h2>
          <p style={{fontSize:13,color:"var(--text-muted)"}}>Enter your access PIN to continue</p>
        </div>
        <input
          type="password"
          value={pinInput}
          onChange={e=>{setPinInput(e.target.value);setPinError(false);}}
          onKeyDown={e=>{if(e.key==="Enter")handleLogin();}}
          placeholder="Enter PIN"
          autoFocus
          style={{width:"100%",background:"var(--bg-elevated)",color:"var(--text-primary)",border:`1px solid ${pinError?"var(--danger)":"var(--border)"}`,borderRadius:12,padding:"12px 16px",fontSize:15,outline:"none",textAlign:"center",letterSpacing:4}}
        />
        {pinError && <p style={{fontSize:12,color:"var(--danger)",marginTop:-12}}>Incorrect PIN. Try again.</p>}
        <button onClick={handleLogin}
          style={{width:"100%",background:"var(--accent)",color:"#fff",border:"none",borderRadius:12,padding:"12px 16px",fontSize:14,fontWeight:500,cursor:"pointer"}}>
          Unlock
        </button>
      </div>
    </div>
  );

  if(dataLoading) return (
    <div style={{...s.app, alignItems:"center", justifyContent:"center", flexDirection:"column", gap:12}}>
      <div style={{fontSize:32}}>🤖</div>
      <p style={{color:"var(--text-secondary)", fontSize:14}}>Loading your data from Notion...</p>
    </div>
  );

  return (
    <div style={s.app}>
      {/* Sidebar */}
      <div style={s.sidebar}>
        <div style={s.logo}>PA</div>
        {[["chat","💬","Chat"],["tasks","✅","Tasks"],["kb","🧠","Knowledge"]].map(([id,icon,label]) => (
          <button key={id} onClick={() => setTab(id)} style={s.navBtn(tab===id)} title={label}>{icon}</button>
        ))}
        <div style={{flex:1}}/>
        <div style={{display:"flex", flexDirection:"column", alignItems:"center", gap:4, marginBottom:4}}>
          <div style={s.syncDot(syncing)} title={syncing?"Syncing to Notion...":"Synced with Notion"}/>
          <span style={{fontSize:9, color:"var(--text-muted)"}}>{syncing?"sync":"notion"}</span>
        </div>
        <button onClick={() => setShowSettings(s => !s)} style={s.navBtn(false)} title="Settings">⚙️</button>
      </div>

      {/* Main */}
      <div style={s.main}>
        {/* Header */}
        <div style={s.header}>
          <div>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <div style={s.headerTitle}>{tab==="chat"?"AI Personal Assistant":tab==="tasks"?"Task Board":"Knowledge Base"}</div>
              {tab==="chat"&&<span style={{fontSize:10,color:"var(--text-muted)",background:"var(--bg-elevated)",border:"1px solid var(--border)",borderRadius:6,padding:"2px 6px",fontWeight:500}}>Genesis 1.7</span>}
            </div>
            <div style={s.headerSub}>
              {tab==="chat" ? `${openTasks.length} open tasks${overdue.length>0?` · ⚠️ ${overdue.length} overdue`:""}${dueToday.length>0?` · 🔔 ${dueToday.length} due today`:""}` :
               tab==="tasks" ? `${tasks.length} tasks · ${openTasks.length} open · synced with Notion` :
               `${kb.length} entries · synced with Notion`}
            </div>
          </div>
          <div style={{display:"flex", gap:8, alignItems:"center"}}>
            {tab==="chat" && (
              <button style={s.btn} onClick={() => { if(window.confirm("Clear chat history? Tasks and KB in Notion are NOT affected.")) { setMsgs([WELCOME]); localStorage.removeItem("vpa_msgs"); } }}>🗑️ Clear Chat</button>
            )}
            {tab==="tasks" && (
              <div style={{display:"flex", gap:4}}>
                {["All",...STATUSES].map(st => (
                  <button key={st} onClick={() => setTaskFilter(st)} style={s.filterBtn(taskFilter===st)}>
                    {st==="All"?"All":st.split(" ")[0]}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Settings */}
        {showSettings && (
          <div style={s.settingsBar}>
            <label style={{fontSize:12, color:"var(--text-muted)", whiteSpace:"nowrap"}}>Your email:</label>
            <input value={userEmail} onChange={e => setUserEmail(e.target.value)} style={s.settingsInput} placeholder="your@email.com"/>
            <button style={s.btn} onClick={() => setShowSettings(false)}>Close</button>
            <button style={s.btn} onClick={handleDebug}>🔍 Debug DB</button>
          </div>
        )}

        {/* CHAT */}
        {tab==="chat" && (
          <div style={{flex:1, display:"flex", flexDirection:"column", overflow:"hidden", position:"relative"}}
            onDragEnter={handleDragEnter} onDragLeave={handleDragLeave} onDragOver={handleDragOver} onDrop={handleDrop}>
            {dragging && (
              <div style={{position:"absolute",inset:0,zIndex:50,background:"rgba(124,58,237,.8)",border:"2px dashed #a78bfa",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",pointerEvents:"none"}}>
                <div style={{fontSize:48,marginBottom:12}}>📎</div>
                <p style={{color:"#ede9fe",fontWeight:600,fontSize:16}}>Drop files here</p>
                <p style={{color:"#c4b5fd",fontSize:13,marginTop:4}}>.msg · .eml · .pdf · .docx · .xlsx · images</p>
              </div>
            )}
            <div style={s.messages}>
              {msgs.map((m,i) => (
                <div key={i} style={s.msg(m.role)}>
                  <div style={s.bubble(m.role)}>{m.content}</div>
                </div>
              ))}
              {loading && (
                <div style={s.msg("assistant")}>
                  <div style={s.bubble("assistant")}>
                    <div style={{display:"flex",gap:4,alignItems:"center",height:20}}>
                      {[0,1,2].map(i => <div key={i} style={{width:6,height:6,borderRadius:"50%",background:"var(--accent)",animation:`bounce .8s ease ${i*.15}s infinite`}}/>)}
                    </div>
                  </div>
                </div>
              )}
              <div ref={bottomRef}/>
            </div>

            {files.length > 0 && (
              <div style={{padding:"0 20px 8px",display:"flex",flexWrap:"wrap",gap:6}}>
                {files.map((f,i) => (
                  <div key={i} style={{display:"flex",alignItems:"center",gap:6,background:"var(--bg-elevated)",borderRadius:8,padding:"4px 10px",fontSize:12,color:"var(--text-secondary)"}}>
                    <span>{isImage(f)?"🖼️":isPDF(f)?"📄":isMsg(f)||isEml(f)?"📧":/\.(xlsx?|csv|docx?|pptx?)$/i.test(f.name||"")?"📊":"📎"}</span>
                    <span style={{maxWidth:120,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{f.name}</span>
                    <button onClick={() => removeFile(i)} style={{color:"var(--text-muted)",fontSize:16,lineHeight:1,cursor:"pointer"}}>×</button>
                  </div>
                ))}
              </div>
            )}

            <div style={s.inputArea}>
              <div style={s.inputBox}>
                <input type="file" ref={fileRef} onChange={handleFileInput} multiple className="hidden" style={{display:"none"}}
                  accept=".msg,.eml,.pdf,.docx,.doc,.xlsx,.xls,.csv,.txt,.html,.json,.png,.jpg,.jpeg,.gif,.webp,.pptx"/>
                <button onClick={() => fileRef.current?.click()} style={{color:"var(--text-muted)",fontSize:18,cursor:"pointer",flexShrink:0}} title="Attach file">📎</button>
                <textarea value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKey} onPaste={handlePaste}
                  placeholder="Tell me about a task, attach an email, or ask me anything..."
                  style={s.textarea} rows={1}
                  onInput={e => { e.target.style.height="auto"; e.target.style.height=e.target.scrollHeight+"px"; }}/>
                <button onClick={send} disabled={loading||(!input.trim()&&files.length===0)} style={{...s.sendBtn, opacity: loading||(!input.trim()&&files.length===0)?0.4:1}}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
                  </svg>
                </button>
              </div>
              <p style={{textAlign:"center",fontSize:10,color:"var(--text-muted)",marginTop:6}}>
                🟢 Connected to Notion · Tasks and KB save automatically · Ctrl+V to paste screenshot · Enter to send
              </p>
            </div>
          </div>
        )}

        {/* TASKS */}
        {tab==="tasks" && (
          <div style={{flex:1,overflowY:"auto",padding:20,display:"flex",flexDirection:"column",gap:12}}>
            {filteredTasks.length === 0 && (
              <div style={{textAlign:"center",padding:"80px 0",color:"var(--text-muted)"}}>
                <div style={{fontSize:40,marginBottom:12}}>✅</div>
                <p>No tasks yet. Chat with your PA to create some!</p>
              </div>
            )}
            {filteredTasks.map(task => {
              const days = daysUntil(task.dueDate);
              const doneCount = (task.subtasks||[]).filter(s => s.done).length;
              const totalCount = (task.subtasks||[]).length;
              const pct = totalCount > 0 ? Math.round(doneCount/totalCount*100) : 0;
              return (
                <div key={task.notionId||task.id} style={s.taskCard(task.status)}>
                  <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:12}}>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",marginBottom:6}}>
                        <span style={s.badge(task.status)}>{task.status}</span>
                        <span style={{fontSize:12,fontWeight:500,color:PRI[task.priority]||PRI.Medium}}>● {task.priority}</span>
                        {task.dueDate && (
                          <span style={{fontSize:11,color:days<0?"var(--danger)":days===0?"var(--warning)":"var(--text-muted)"}}>
                            {days<0?`⚠️ ${Math.abs(days)}d overdue`:days===0?"🔔 Due today":`📅 ${fmtDate(task.dueDate)}`}
                          </span>
                        )}
                      </div>
                      <div style={{fontWeight:500,fontSize:14,marginBottom:task.description?4:0}}>{task.title}</div>
                      {task.description && <p style={{fontSize:12,color:"var(--text-muted)",overflow:"hidden",display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical"}}>{task.description}</p>}
                    </div>
                    <button onClick={() => setEditTask(editTask?.notionId===task.notionId?null:task)}
                      style={{...s.btn, flexShrink:0, fontSize:11}}>
                      {editTask?.notionId===task.notionId?"Close":"Edit"}
                    </button>
                  </div>

                  {totalCount > 0 && (
                    <div style={{marginTop:12}}>
                      <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"var(--text-muted)",marginBottom:6}}>
                        <span>Subtasks</span><span>{doneCount}/{totalCount}</span>
                      </div>
                      <div style={s.progress(pct)}><div style={s.progressFill(pct)}/></div>
                      {(task.subtasks||[]).map((st,i) => (
                        <div key={st.id||i} style={s.subtaskRow}>
                          <button style={s.checkbox(st.done)} onClick={async () => {
                            const subtasks = [...task.subtasks];
                            subtasks[i] = { ...subtasks[i], done: !subtasks[i].done };
                            await patchTask(task.notionId, { subtasks });
                          }}>{st.done && "✓"}</button>
                          <span style={{fontSize:12,color:st.done?"var(--text-muted)":"var(--text-primary)",textDecoration:st.done?"line-through":"none"}}>{st.text}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {editTask?.notionId === task.notionId && (
                    <div style={{marginTop:12,paddingTop:12,borderTop:"1px solid var(--border-subtle)",display:"flex",flexDirection:"column",gap:8}}>
                      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                        <select value={task.status} onChange={e => patchTask(task.notionId, {status:e.target.value})}
                          style={{background:"var(--bg-elevated)",color:"var(--text-primary)",border:"1px solid var(--border)",borderRadius:8,padding:"4px 8px",fontSize:12}}>
                          {STATUSES.map(s => <option key={s}>{s}</option>)}
                        </select>
                        <select value={task.priority} onChange={e => patchTask(task.notionId, {priority:e.target.value})}
                          style={{background:"var(--bg-elevated)",color:"var(--text-primary)",border:"1px solid var(--border)",borderRadius:8,padding:"4px 8px",fontSize:12}}>
                          {PRIORITIES.map(p => <option key={p}>{p}</option>)}
                        </select>
                        <input type="date" value={task.dueDate||""} onChange={e => patchTask(task.notionId, {dueDate:e.target.value||null})}
                          style={{background:"var(--bg-elevated)",color:"var(--text-primary)",border:"1px solid var(--border)",borderRadius:8,padding:"4px 8px",fontSize:12}}/>
                      </div>
                      <button onClick={() => { removeTask(task.notionId); setEditTask(null); }}
                        style={{fontSize:12,color:"var(--danger)",cursor:"pointer",textAlign:"left"}}>🗑️ Delete task</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* KB */}
        {tab==="kb" && (
          <div style={{flex:1,overflowY:"auto",padding:20}}>
            <input value={kbSearch} onChange={e => setKbSearch(e.target.value)} placeholder="Search knowledge base..."
              style={{width:"100%",background:"var(--bg-elevated)",color:"var(--text-primary)",border:"1px solid var(--border)",borderRadius:12,padding:"10px 16px",fontSize:13,outline:"none",marginBottom:16}}/>
            {filteredKb.length === 0 && (
              <div style={{textAlign:"center",padding:"80px 0",color:"var(--text-muted)"}}>
                <div style={{fontSize:40,marginBottom:12}}>🧠</div>
                <p>{kb.length===0?"Teach your PA processes, tools, and contacts — stored in Notion.":"No results found."}</p>
              </div>
            )}
            <div style={{display:"flex",flexDirection:"column",gap:12}}>
              {filteredKb.map(entry => (
                <div key={entry.notionId||entry.id} style={s.kbCard}>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
                    <div style={{display:"flex",alignItems:"center",gap:8}}>
                      <span style={s.catBadge(entry.category)}>{entry.category}</span>
                      <span style={{fontWeight:500,fontSize:13}}>{entry.title}</span>
                    </div>
                    <div style={{display:"flex",alignItems:"center",gap:8}}>
                      <span style={{fontSize:11,color:"var(--text-muted)"}}>{fmtDate(entry.createdAt)}</span>
                      <button onClick={() => removeKb(entry.notionId)} style={{color:"var(--text-muted)",fontSize:14,cursor:"pointer"}}>✕</button>
                    </div>
                  </div>
                  <p style={{fontSize:12,color:"var(--text-secondary)",lineHeight:1.7,whiteSpace:"pre-wrap"}}>{entry.content}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
