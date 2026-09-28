const DATE = "2026-09-17";
const MAP = "data/dail-2026-09-17-openai/video-map.json";
const STREAM = "https://media.heanet.ie/m3u8/16ea7b8d7be04c46ad664b6299e24121";
const CAPTIONS = "data/dail-2026-09-17-openai/subtitles.vtt";

function parseVtt(source) {
  return source.replace(/^WEBVTT[^\n]*\n+/i, "").trim().split(/\n\s*\n/).flatMap(block => {
    const lines = block.trim().split("\n"); const timing = lines.find(line => line.includes("-->"));
    if (!timing) return [];
    const toSeconds = value => { const p=value.trim().split(":").map(Number); return p[0]*3600+p[1]*60+p[2]; };
    const [start,end] = timing.split("-->").map(value => toSeconds(value.trim().split(/\s+/)[0]));
    return Number.isFinite(start) && Number.isFinite(end) ? [{start,end,text:lines.slice(lines.indexOf(timing)+1).join(" ")}] : [];
  });
}

function mount(map) {
  if (document.getElementById("videoSync")) return;
  const toggle = document.createElement("button"); toggle.id = "videoToggle"; toggle.type = "button"; toggle.textContent = "Video";
  toggle.setAttribute("aria-controls", "videoSync"); document.body.append(toggle);
  const panel = document.createElement("aside"); panel.id = "videoSync";
  panel.innerHTML = `<div class="vs-head"><div><strong>Watch this debate</strong><span>Video-linked edition</span></div><div class="vs-actions"><label class="vs-follow"><input id="vsFollow" type="checkbox" checked> Follow text</label><button id="vsCaptions" type="button" aria-pressed="false">CC</button><button id="vsClose" type="button" aria-label="Close video panel">×</button></div></div><div class="vs-stage"><video id="vsVideo" controls playsinline preload="metadata" aria-label="Dáil Éireann sitting video"></video></div><div id="vsCaptionsDisplay" hidden aria-live="polite"></div><p id="vsStatus" aria-live="polite">Select a highlighted paragraph to play from that point.</p>`;
  document.body.append(panel);
  const video = panel.querySelector("video"), follow = panel.querySelector("input"), status = panel.querySelector("p");
  const setOpen = open => { panel.hidden = !open; toggle.setAttribute("aria-expanded", String(open)); toggle.textContent = open ? "Hide video" : "Video"; localStorage.setItem("dv_video_open", String(open)); };
  setOpen(localStorage.getItem("dv_video_open") !== "false");
  toggle.addEventListener("click", () => setOpen(panel.hidden));
  panel.querySelector("#vsClose").addEventListener("click", () => setOpen(false));
  video.src = STREAM;
  const captionsButton = panel.querySelector("#vsCaptions"), captionsDisplay = panel.querySelector("#vsCaptionsDisplay");
  let captions = [], captionsVisible = false;
  fetch(CAPTIONS).then(r => r.ok ? r.text() : Promise.reject()).then(text => { captions = parseVtt(text); captionsButton.disabled = !captions.length; }).catch(() => { captionsButton.disabled = true; });
  captionsButton.addEventListener("click", () => { captionsVisible = !captionsVisible; captionsButton.setAttribute("aria-pressed", String(captionsVisible)); captionsDisplay.hidden = !captionsVisible; });
  const entries = map.paragraphs.sort((a,b)=>a.start-b.start);
  const lookup = id => entries.find(x=>x.id===id);
  document.querySelectorAll(".speech p[id]").forEach(p => {
    const entry=lookup(p.id); if(!entry) return;
    p.classList.add("vs-mapped"); p.title="Play from this paragraph";
    p.addEventListener("click", e => { if(e.target.closest("a")) return; video.currentTime=entry.start; video.play().catch(()=>{}); });
  });
  let active;
  video.addEventListener("timeupdate", () => {
    const t=video.currentTime; const caption = captions.find(c => t >= c.start && t <= c.end);
    if (captionsVisible) captionsDisplay.textContent = caption?.text || "";
    let lo=0,hi=entries.length;
    while(lo<hi){const mid=(lo+hi)>>1;if(entries[mid].start<=t)lo=mid+1;else hi=mid;}
    const next=entries[lo-1]; if(!next || t>next.end+15) return;
    if(active?.id===next.id) return; active?.classList.remove("vs-active");
    active=document.getElementById(next.id); active?.classList.add("vs-active"); status.textContent=`Now reading: ${next.speaker}`;
    if(follow.checked) active?.scrollIntoView({block:"center",behavior:"smooth"});
  });
}
document.addEventListener("debate-rendered", async e => { if(e.detail.date!==DATE) return; try { mount(await fetch(MAP).then(r=>r.json())); } catch(e) { console.warn("Video map unavailable",e); } });
