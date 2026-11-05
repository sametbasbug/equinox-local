// Local output-only sprite renderer. No imports, Node, backend or private configuration.
export {};
type NyxSnapshot = { state: string; language: "en" | "tr"; paused: boolean; speech: string; speechId: number; maxWidth: number; tailBottom: boolean; tailX: number };
type NyxBridge = { subscribe: (callback: (value: NyxSnapshot) => void) => () => void; action: (value: string) => void; pointer: (phase: string) => void; activate: () => void; measureSpeech: (id: number, width: number, height: number) => void };
const bridge = (window as unknown as { equinoxCompanion: NyxBridge }).equinoxCompanion;
const surface = new URLSearchParams(location.search).get("surface");
if (surface === "pet" || surface === "actions" || surface === "speech") document.body.dataset.surface = surface;
const pet = document.getElementById("pet") as HTMLButtonElement;
const petState = document.getElementById("pet-state")!;
const stateDescriptions: Record<string, [string, string]> = {
  idle: ["Idle", "Boşta"], running: ["Working", "Çalışıyor"], waiting: ["Waiting", "Bekliyor"],
  review: ["Reviewing", "Gözden geçiriyor"], failed: ["Needs attention", "Dikkat gerekiyor"],
  jumping: ["Jumping", "Zıplıyor"], waving: ["Waving", "El sallıyor"],
  "running-right": ["Moving right", "Sağa gidiyor"], "running-left": ["Moving left", "Sola gidiyor"],
};
function describeState() {
  const description = stateDescriptions[selected]?.[document.documentElement.lang === "tr" ? 1 : 0] ?? selected;
  if (petState.textContent !== description) petState.textContent = description;
}
const motion = matchMedia("(prefers-reduced-motion: reduce)");
const animations: Record<string, { row: number; durations: number[] }> = {
  idle: { row: 0, durations: [1680, 660, 660, 840, 840, 1920] },
  "running-right": { row: 1, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  "running-left": { row: 2, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  waving: { row: 3, durations: [140, 140, 140, 280] },
  jumping: { row: 4, durations: [140, 140, 140, 140, 280] },
  failed: { row: 5, durations: [140, 140, 140, 140, 140, 140, 140, 240] },
  waiting: { row: 6, durations: [150, 150, 150, 150, 150, 260] },
  running: { row: 7, durations: [120, 120, 120, 120, 120, 220] },
  review: { row: 8, durations: [150, 150, 150, 150, 150, 280] },
};
let base = "failed", selected = base, visual = base;
let frame = 0, cycles = 0;
let fallback = false, hovered = false, dragging = false, paused = true;
let look: { row: number; column: number } | null = null;
let point: { x: number; y: number } | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let pointerId: number | null = null;
let dragEndTimer: ReturnType<typeof setTimeout> | null = null;
let lastScreenX = 0;
function stop() { if (timer) clearTimeout(timer); timer = null; }
function draw() {
  const animation = animations[motion.matches ? selected : visual]!;
  const cell = look ?? { row: animation.row, column: motion.matches ? 0 : frame };
  pet.style.backgroundPosition = `${-cell.column * (142 * 192 / 208)}px ${-cell.row * 142}px`;
  describeState();
}
function schedule() {
  stop();
  if (surface !== "pet" || paused || motion.matches || look) return;
  const animation = animations[visual]!;
  timer = setTimeout(() => {
    timer = null;
    frame += 1;
    if (frame >= animation.durations.length) {
      frame = 0;
      if (visual !== "idle" && ++cycles >= 3) {
        fallback = true; visual = "idle"; cycles = 0;
        if (hovered && selected === "jumping" && !dragging) { updateLook(); if (look) return; }
      }
    }
    draw(); schedule();
  }, animation.durations[frame]!);
}
function restart() { stop(); look = null; visual = selected; frame = 0; cycles = 0; fallback = false; draw(); schedule(); }
function updateLook() {
  if (!point) return;
  const dx = point.x - pet.clientWidth / 2, dy = pet.clientHeight / 2 - point.y;
  if (Math.hypot(dx, dy) <= 1) { look = null; visual = "idle"; frame = 0; draw(); schedule(); return; }
  let angle = Math.atan2(dx, dy) * 180 / Math.PI;
  if (angle < 0) angle += 360;
  const slot = Math.round(angle / 22.5) % 16;
  look = { row: slot < 8 ? 9 : 10, column: slot % 8 }; stop(); draw();
}
function mousePoint(event: PointerEvent) { const rect = pet.getBoundingClientRect(); point = { x: event.clientX - rect.x, y: event.clientY - rect.y }; }
pet.addEventListener("pointerenter", event => { hovered = true; mousePoint(event); if (!dragging) { selected = "jumping"; restart(); } });
pet.addEventListener("pointerleave", () => { hovered = false; point = null; look = null; if (!dragging) { selected = base; restart(); } });
pet.addEventListener("pointerdown", event => {
  if (!event.isTrusted || event.button !== 0 || paused || pointerId !== null) return;
  event.preventDefault(); pointerId = event.pointerId; lastScreenX = event.screenX;
  pet.setPointerCapture(event.pointerId); bridge.pointer("begin");
});
pet.addEventListener("pointermove", event => {
  mousePoint(event);
  if (pointerId === event.pointerId) {
    if (!event.isTrusted) return;
    if (Math.abs(event.screenX - lastScreenX) >= 0.5) {
      dragging = true; look = null;
      const next = event.screenX > lastScreenX ? "running-right" : "running-left";
      if (next !== selected) { selected = next; restart(); }
    }
    lastScreenX = event.screenX;
    if (dragEndTimer) clearTimeout(dragEndTimer);
    dragEndTimer = setTimeout(() => {
      dragEndTimer = null;
      if (!dragging) return;
      dragging = false; look = null; selected = hovered ? "jumping" : base; restart();
    }, 180);
    bridge.pointer("move");
  } else if (hovered && !dragging && (fallback || motion.matches)) updateLook();
});
function endPointer(event: PointerEvent, cancelled: boolean) {
  if (event.pointerId !== pointerId) return;
  pointerId = null; bridge.pointer(cancelled ? "cancel" : "end");
  look = null;
  const rect = pet.getBoundingClientRect();
  hovered = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
  if (cancelled) {
    if (dragEndTimer) clearTimeout(dragEndTimer);
    dragEndTimer = null; dragging = false; selected = hovered ? "jumping" : base; restart();
  }
  if (pet.hasPointerCapture(event.pointerId)) pet.releasePointerCapture(event.pointerId);
}
pet.addEventListener("pointerup", event => endPointer(event, false));
pet.addEventListener("pointercancel", event => endPointer(event, true));
pet.addEventListener("lostpointercapture", event => { if (pointerId === event.pointerId) endPointer(event, true); });
pet.addEventListener("click", event => { if (event.isTrusted && event.detail === 0 && !paused) bridge.activate(); });
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-action]")) button.addEventListener("click", event => { if (event.isTrusted) bridge.action(button.dataset.action!); });
motion.addEventListener("change", restart);
let lastSpeechId = -1;
const unsubscribe = bridge.subscribe(snapshot => {
  if (!snapshot || !["en", "tr"].includes(snapshot.language)) return;
  document.documentElement.lang = snapshot.language;
  describeState();
  const tr = snapshot.language === "tr";
  document.getElementById("new-chat-label")!.textContent = tr ? "Yeni Sohbet" : "New Chat";
  document.getElementById("control-center-label")!.textContent = tr ? "Kontrol Merkezi" : "Control Center";
  document.getElementById("hide-label")!.textContent = tr ? "Nyx'i Gizle" : "Hide Nyx";
  document.getElementById("actions")!.setAttribute("aria-label", tr ? "Nyx Hızlı Eylemler" : "Nyx Quick Actions");
  if (surface === "speech") {
    const label = document.getElementById("speech-text")!;
    label.textContent = typeof snapshot.speech === "string" ? snapshot.speech.slice(0, 240) : "";
    document.getElementById("speech")!.classList.toggle("top-tail", !snapshot.tailBottom);
    if (Number.isFinite(snapshot.tailX)) document.getElementById("tail")!.style.left = `${Math.min(334, Math.max(20, snapshot.tailX - 6))}px`;
    if (label.textContent && Number.isSafeInteger(snapshot.speechId) && snapshot.speechId !== lastSpeechId
      && Number.isFinite(snapshot.maxWidth) && snapshot.maxWidth >= 1 && snapshot.maxWidth <= 360) {
      lastSpeechId = snapshot.speechId;
      const context = document.createElement("canvas").getContext("2d");
      if (context) {
        context.font = `500 13px ${getComputedStyle(document.getElementById("speech-body")!).fontFamily}`;
        const width = Math.ceil(Math.min(snapshot.maxWidth, Math.max(252, context.measureText(label.textContent).width + 34)));
        label.style.maxWidth = "none"; label.style.width = `${Math.max(1, width - 34)}px`;
        const height = Math.min(512, Math.max(58, Math.ceil(label.getBoundingClientRect().height) + 32));
        bridge.measureSpeech(snapshot.speechId, width, height);
      }
    }
  }
  if (surface !== "pet") return;
  const next = snapshot.state === "working" ? "running" : snapshot.state === "waiting" ? "waiting" : snapshot.state === "success" ? "review"
    : ["needs_attention", "emergency_stopped", "offline"].includes(snapshot.state) ? "failed" : "idle";
  const pausedChanged = paused !== snapshot.paused;
  paused = snapshot.paused;
  const baseChanged = base !== next; base = next;
  if (baseChanged && !hovered && !dragging) { selected = base; restart(); }
  else if (pausedChanged) { if (paused) stop(); else restart(); }
});
window.addEventListener("pagehide", () => { stop(); if (dragEndTimer) clearTimeout(dragEndTimer); unsubscribe(); if (pointerId !== null) bridge.pointer("cancel"); });
draw();
