// src/notion.js
// All Notion API calls go through /api/notion (proxied to avoid CORS)

const API = import.meta.env.VITE_API_BASE || "/api/notion";
const TASKS_DB = import.meta.env.VITE_TASKS_DB_ID;
const KB_DB = import.meta.env.VITE_KB_DB_ID;

async function notionFetch(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers }
  });
  const data = await res.json();
  if (data.object === "error") throw new Error(data.message);
  return data;
}

// ── Tasks ─────────────────────────────────────────────────────────────────────

export async function fetchTasks() {
  const data = await notionFetch(`/databases/${TASKS_DB}/query`, {
    method: "POST",
    body: JSON.stringify({ sorts: [{ property: "Due Date", direction: "ascending" }] })
  });
  return data.results.map(pageToTask);
}

export async function createTask(task) {
  const page = await notionFetch("/pages", {
    method: "POST",
    body: JSON.stringify(taskToPage(task))
  });
  return pageToTask(page);
}

export async function updateTask(notionId, patch) {
  const page = await notionFetch(`/pages/${notionId}`, {
    method: "PATCH",
    body: JSON.stringify({ properties: patchToProperties(patch) })
  });
  return pageToTask(page);
}

// ── Knowledge Base ────────────────────────────────────────────────────────────

export async function fetchKb() {
  const data = await notionFetch(`/databases/${KB_DB}/query`, {
    method: "POST",
    body: JSON.stringify({ sorts: [{ property: "Category", direction: "ascending" }] })
  });
  return data.results.map(pageToKb);
}

export async function createKbEntry(entry) {
  const page = await notionFetch("/pages", {
    method: "POST",
    body: JSON.stringify(kbToPage(entry))
  });
  return pageToKb(page);
}

export async function deleteKbEntry(notionId) {
  await notionFetch(`/pages/${notionId}`, {
    method: "PATCH",
    body: JSON.stringify({ archived: true })
  });
}

export async function deleteTask(notionId) {
  await notionFetch(`/pages/${notionId}`, {
    method: "PATCH",
    body: JSON.stringify({ archived: true })
  });
}

// ── Converters ────────────────────────────────────────────────────────────────

function getRichText(prop) {
  return prop?.rich_text?.map(t => t.plain_text).join("") || "";
}
function getTitle(prop) {
  return prop?.title?.map(t => t.plain_text).join("") || "";
}

function pageToTask(page) {
  const p = page.properties;
  const titleKey = Object.keys(p).find(k => p[k].type === "title") || "Name";
  const subtaskRaw = getRichText(p["Subtasks"]);
  const subtasks = subtaskRaw ? subtaskRaw.split("\n").filter(Boolean).map((line, i) => ({
    id: `st_${i}`,
    text: line.replace(/^[✅⬜]\s*/, ""),
    done: line.startsWith("✅")
  })) : [];

  return {
    id: page.id.replace(/-/g, "").slice(0, 8),
    notionId: page.id,
    title: getTitle(p[titleKey]),
    status: p["Status"]?.select?.name || "Not Started",
    priority: p["Priority"]?.select?.name || "Medium",
    dueDate: p["Due Date"]?.date?.start || null,
    description: getRichText(p["Description"]),
    subtasks,
    createdAt: page.created_time?.slice(0, 10) || new Date().toISOString().slice(0, 10)
  };
}

function taskToPage(task) {
  const subtaskText = (task.subtasks || []).map(s => `${s.done ? "✅" : "⬜"} ${s.text}`).join("\n");
  const props = {
    "Task name": { title: [{ text: { content: task.title } }] },
    "Status": { select: { name: task.status || "Not Started" } },
    "Priority": { select: { name: task.priority || "Medium" } },
    "Description": { rich_text: [{ text: { content: (task.description || "").slice(0, 2000) } }] },
    "Subtasks": { rich_text: [{ text: { content: subtaskText } }] }
  };
  if (task.dueDate) props["Due Date"] = { date: { start: task.dueDate } };
  return { parent: { database_id: TASKS_DB }, properties: props };
}

function patchToProperties(patch) {
  const props = {};
  if (patch.status) props["Status"] = { select: { name: patch.status } };
  if (patch.priority) props["Priority"] = { select: { name: patch.priority } };
  if ("dueDate" in patch) props["Due Date"] = patch.dueDate ? { date: { start: patch.dueDate } } : { date: null };
  if (patch.subtasks !== undefined) {
    const text = patch.subtasks.map(s => `${s.done ? "✅" : "⬜"} ${s.text}`).join("\n");
    props["Subtasks"] = { rich_text: [{ text: { content: text } }] };
  }
  if (patch.title) {
    props["Task name"] = { title: [{ text: { content: patch.title } }] };
  }
  return props;
}

function pageToKb(page) {
  const p = page.properties;
  const titleKey = Object.keys(p).find(k => p[k].type === "title") || "Name";
  return {
    id: page.id.replace(/-/g, "").slice(0, 8),
    notionId: page.id,
    title: getTitle(p[titleKey]),
    category: p["Category"]?.select?.name || "Other",
    content: getRichText(p["Content"]),
    createdAt: page.created_time?.slice(0, 10) || new Date().toISOString().slice(0, 10)
  };
}

function kbToPage(entry) {
  return {
    parent: { database_id: KB_DB },
    properties: {
      "Name": { title: [{ text: { content: entry.title } }] },
      "Category": { select: { name: entry.category || "Other" } },
      "Content": { rich_text: [{ text: { content: (entry.content || "").slice(0, 2000) } }] }
    }
  };
}
